"""SLURM execution backend for the campaign runner.

This module is the SLURM counterpart to ``sim_runner_client.RunnerClient``: it owns every
interaction with the scheduler and nothing else. It knows how to submit a job array, ask
which array tasks are still alive, and cancel them. It does not touch the database.

Why arrays rather than one ``sbatch`` per job: this cluster's ``SchedulerParameters`` sets
``bf_max_job_user=100``, so the backfill scheduler only ever considers 100 of a user's jobs
per cycle. Hundreds of individually submitted pending jobs would backfill badly, and backfill
is precisely how throughput is harvested from a preemptible partition. One array is one
scheduler object.

Liveness is deliberately asymmetric. The happy path costs *zero* scheduler queries: each array
task writes a sentinel file when it finishes, and the reconciler reads those. ``squeue``/``sacct``
are consulted only to explain tasks that vanished *without* leaving a sentinel.
"""

from __future__ import annotations

import logging
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("slurm_backend")

# States meaning "the scheduler still intends to run this"; anything else is over.
LIVE_SLURM_STATES = {
    "PENDING", "RUNNING", "SUSPENDED", "COMPLETING", "CONFIGURING",
    "RESIZING", "REQUEUED", "REQUEUE_HOLD", "REQUEUE_FED", "RESV_DEL_HOLD",
    "SIGNALING", "STAGE_OUT", "STOPPED",
}

# Terminal states that mean "SLURM will not retry this on its own".
DEAD_SLURM_STATES = {
    "COMPLETED", "FAILED", "TIMEOUT", "OUT_OF_MEMORY", "CANCELLED",
    "BOOT_FAIL", "DEADLINE", "NODE_FAIL", "PREEMPTED", "SPECIAL_EXIT", "REVOKED",
}


class SlurmError(RuntimeError):
    """sbatch/squeue/sacct was unusable or returned something unparseable."""


@dataclass
class SlurmResources:
    """Per-array-task resource request.

    Defaults are the plan's starting point, not measured values: klone's ``DefMemPerCPU`` is
    1024 MB, which will OOM a wcEcoli generation, so memory must always be set explicitly.
    Retune ``mem`` and ``time_limit`` from ``sacct -o MaxRSS,Elapsed`` after the first tier.
    """

    account: str = "ckpt-stf"
    partition: str = "ckpt"
    cpus: int = 1
    mem: str = "8G"
    time_limit: str = "02:00:00"
    throttle: int = 1
    requeue: bool = True

    @classmethod
    def from_env(cls) -> "SlurmResources":
        return cls(
            account=os.environ.get("WCECOLI_SLURM_ACCOUNT", cls.account),
            partition=os.environ.get("WCECOLI_SLURM_PARTITION", cls.partition),
            cpus=int(os.environ.get("WCECOLI_SLURM_CPUS", cls.cpus)),
            mem=os.environ.get("WCECOLI_SLURM_MEM", cls.mem),
            time_limit=os.environ.get("WCECOLI_SLURM_TIME", cls.time_limit),
            throttle=int(os.environ.get("WCECOLI_SLURM_THROTTLE", cls.throttle)),
            requeue=os.environ.get("WCECOLI_SLURM_REQUEUE", "1") != "0",
        )


def _run(argv: list[str], *, timeout: int = 120) -> str:
    logger.debug("$ %s", " ".join(shlex.quote(a) for a in argv))
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SlurmError("{} failed: {}".format(argv[0], exc)) from exc
    if proc.returncode != 0:
        raise SlurmError(
            "{} exited {}: {}".format(argv[0], proc.returncode, proc.stderr.strip())
        )
    return proc.stdout


def submit_array(
    script: Path,
    manifest: Path,
    count: int,
    resources: SlurmResources,
    *,
    log_dir: Path,
    job_name: str = "wcecoli",
    dependency: str = "",
    script_args: list[str] | None = None,
) -> str:
    """Submit ``count`` array tasks for ``manifest`` and return the array job id."""
    if count < 1:
        raise ValueError("count must be at least 1")
    # MaxArraySize is 10001 on klone; the caller is responsible for chunking above that.
    argv = [
        "sbatch", "--parsable",
        "--job-name", job_name,
        "--account", resources.account,
        "--partition", resources.partition,
        "--array", "0-{}%{}".format(count - 1, max(1, resources.throttle)),
        "--cpus-per-task", str(resources.cpus),
        "--mem", resources.mem,
        "--time", resources.time_limit,
        "--output", str(log_dir / "%x-%A_%a.out"),
        "--error", str(log_dir / "%x-%A_%a.out"),
    ]
    if resources.requeue:
        # ckpt is PreemptMode=REQUEUE with GraceTime=0: a preempted task is killed instantly
        # and re-run from the start. The task script wipes its own output directory on entry
        # so that re-run is always clean. See cluster/task.sbatch.
        argv.append("--requeue")
    if dependency:
        argv.extend(["--dependency", dependency])
    argv.extend([str(script), str(manifest), *(script_args or [])])

    stdout = _run(argv).strip()
    if not stdout:
        raise SlurmError("sbatch returned no job id")
    # --parsable yields "<jobid>" or "<jobid>;<cluster>".
    return stdout.split(";", 1)[0].strip()


def live_task_states(job_ids: list[str]) -> dict[str, str]:
    """Return {task_id: state} for array tasks the *controller* still knows about.

    Queries ``squeue`` only — cheap, hits slurmctld rather than slurmdbd. Tasks absent from
    the result are either finished or never existed; ``accounted_task_states`` disambiguates.
    """
    if not job_ids:
        return {}
    stdout = _run([
        "squeue", "--noheader", "--array",
        "--jobs", ",".join(sorted({j.split("_", 1)[0] for j in job_ids})),
        "--format", "%i|%T",
    ])
    states: dict[str, str] = {}
    for line in stdout.splitlines():
        if "|" not in line:
            continue
        task_id, _, state = line.strip().partition("|")
        states[task_id.strip()] = state.strip()
    return states


def accounted_task_states(job_ids: list[str]) -> dict[str, str]:
    """Return {task_id: state} from ``sacct`` for tasks that left squeue.

    Only called for tasks missing a sentinel, so this stays off the happy path.
    """
    if not job_ids:
        return {}
    stdout = _run([
        "sacct", "--noheader", "--parsable2", "--allocations",
        "--jobs", ",".join(sorted(set(job_ids))),
        "--format", "JobID,State,ExitCode",
    ])
    states: dict[str, str] = {}
    for line in stdout.splitlines():
        parts = line.strip().split("|")
        if len(parts) < 2:
            continue
        # sacct renders cancellations as "CANCELLED by 12345"; keep the leading token.
        states[parts[0].strip()] = parts[1].strip().split()[0] if parts[1].strip() else ""
    return states


def cancel(job_ids: list[str]):
    if job_ids:
        _run(["scancel", *sorted(set(job_ids))])


def task_id(array_job_id: str, index: int) -> str:
    return "{}_{}".format(array_job_id, index)
