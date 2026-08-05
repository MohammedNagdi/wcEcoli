"""
Simulation worker - polls simulation_jobs and schedules persistent-runner tasks.

Run as a standalone process:
    python -m app.services.sim_worker

The worker picks up the oldest 'pending' job, runs Parca (if needed) then
runSim inside the persistent wcEcoli container, captures log output, and updates
the job status through its lifecycle:

    pending -> claimed -> waiting_parca -> running_parca -> running_sim -> ingesting -> done
                                                                                  -> failed/cancelled
    Expired claims enter recovering until runner termination is confirmed.
"""

import hashlib
import argparse
import json
import logging
import shutil
import signal
import subprocess
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from sqlalchemy import delete, update
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, col, select

from app.db.engine import make_sqlite_engine

from app.config import settings
from app.db.models import Experiment, SimulationJob, SimulationResult, Timeline
from app.services.multi_gene_knockout import (
    MULTI_GENE_KNOCKOUT_TYPE,
    ko_indices_from_sim_params,
)
from app.services.job_queue import sync_experiment_status
from app.services.sim_runner_client import RunnerClient, RunnerError, RunnerTaskNotFound
from app.services.timelines import infer_condition_from_timeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sim_worker")

# ── Globals ──────────────────────────────────────────────────────────────────

_shutdown = False
_worker_id = "worker-" + uuid.uuid4().hex[:12]
ACTIVE_EXECUTION_STATUSES = {
    "claimed", "waiting_parca", "running_parca", "running_sim", "ingesting", "cancelling"
}
TERMINAL_RUNNER_STATES = {"done", "failed", "cancelled"}


class JobOwnershipLost(RuntimeError):
    pass


class JobCancelled(RuntimeError):
    pass


class RunnerUnavailable(RuntimeError):
    pass


class RunnerTaskLost(RuntimeError):
    pass


class LeaseHeartbeat:
    """Renew a fenced job lease from an independent session for its full lifecycle."""

    def __init__(self, engine, job_id: int, worker_id: str, attempt: int, log_buffer: deque):
        self.engine = engine
        self.job_id = job_id
        self.worker_id = worker_id
        self.attempt = attempt
        self.log_buffer = log_buffer
        self.stop_event = threading.Event()
        self.lost_event = threading.Event()
        self.thread = threading.Thread(
            target=self._run,
            name="job-heartbeat-{}-{}".format(job_id, attempt),
            daemon=True,
        )

    def start(self):
        if not self._renew():
            raise JobOwnershipLost("job ownership was lost before heartbeat startup")
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=max(2.0, settings.runner_poll_interval * 2))

    def ensure_owned(self):
        if self.lost_event.is_set():
            raise JobOwnershipLost("job lease fencing token is no longer valid")

    def _renew(self) -> bool:
        for retry in range(5):
            now = datetime.now(timezone.utc)
            try:
                with Session(self.engine) as heartbeat_session:
                    result = heartbeat_session.exec(
                        update(SimulationJob)
                        .where(
                            SimulationJob.id == self.job_id,
                            SimulationJob.worker_id == self.worker_id,
                            SimulationJob.attempt == self.attempt,
                            col(SimulationJob.status).in_(ACTIVE_EXECUTION_STATUSES),
                        )
                        .values(
                            heartbeat_at=now.isoformat(),
                            lease_expires_at=(
                                now + timedelta(seconds=settings.worker_lease_timeout)
                            ).isoformat(),
                            log_tail="\n".join(self.log_buffer.copy()),
                        )
                    )
                    heartbeat_session.commit()
                    return getattr(result, "rowcount", 0) == 1
            except OperationalError:
                if retry == 4:
                    logger.exception("Heartbeat failed for job %d", self.job_id)
                    return False
                time.sleep(0.1 * (retry + 1))
            except Exception:
                logger.exception("Unexpected heartbeat failure for job %d", self.job_id)
                return False
        return False

    def _run(self):
        interval = min(60.0, max(0.1, settings.worker_lease_timeout / 3.0))
        interval += ((self.job_id or 0) % 7) / 10.0
        while not self.stop_event.wait(interval):
            if not self._renew():
                self.lost_event.set()
                return


def _owned_transition(
    session: Session,
    job_id: int,
    owner_id: str,
    attempt: int,
    expected_statuses: set[str] | tuple[str, ...],
    **values,
) -> SimulationJob:
    """Apply a lifecycle update only while the exact claim token still owns the job."""
    result = session.exec(
        update(SimulationJob)
        .where(
            SimulationJob.id == job_id,
            SimulationJob.worker_id == owner_id,
            SimulationJob.attempt == attempt,
            col(SimulationJob.status).in_(expected_statuses),
        )
        .values(**values)
    )
    session.commit()
    if getattr(result, "rowcount", 0) != 1:
        raise JobOwnershipLost(
            "job {} attempt {} is no longer owned by {}".format(job_id, attempt, owner_id)
        )
    job = session.get(SimulationJob, job_id)
    if job is None:
        raise JobOwnershipLost("job was deleted while it was running")
    session.refresh(job)
    return job


def _check_job_control(engine, job_id: int, worker_id: str, attempt: int) -> SimulationJob:
    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        if job is None or job.worker_id != worker_id or job.attempt != attempt:
            raise JobOwnershipLost("job fencing token no longer matches")
        if job.status == "cancelling":
            raise JobCancelled("job cancellation requested")
        if job.status not in ACTIVE_EXECUTION_STATUSES:
            raise JobOwnershipLost("job is no longer active")
        return job


def _handle_signal(signum, frame):
    global _shutdown
    logger.info("Received signal %s — shutting down after current job", signum)
    _shutdown = True


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_run_id(job: SimulationJob, experiment: Experiment) -> str:
    """Create a unique, human-readable run directory name."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    label = (
        MULTI_GENE_KNOCKOUT_TYPE
        if experiment.variant_type == MULTI_GENE_KNOCKOUT_TYPE
        else experiment.gene_symbol or experiment.variant_type
    )
    return ts + "_" + label + "_job" + str(job.id) + "_attempt" + str(job.attempt)


PARCA_CACHE_VERSION = 1
PARCA_EXPECTED_FILES = (
    "rawData.cPickle",
    "simData.cPickle",
    "metricsData.cPickle",
    "rawValidationData.cPickle",
    "validationData.cPickle",
)
PARCA_MANIFEST = "parca_manifest.json"


def _hash_tree(hasher, root: Path):
    """Add a deterministic directory tree digest to a cache-key hasher."""
    if not root.exists():
        hasher.update(("missing:" + str(root)).encode())
        return
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        if "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        hasher.update(str(path.relative_to(root)).encode())
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                hasher.update(chunk)


@lru_cache(maxsize=1)
def _parca_cache_key() -> str:
    """Hash inputs that can affect the interface worker's default Parca output."""
    hasher = hashlib.sha256()
    config = {
        "version": PARCA_CACHE_VERSION,
        "docker_image": settings.docker_image,
        "options": {
            "operons": "on",
            "new_genes": "off",
            "protein_degradation_combo": "PDR_combo_2022",
            "ribosome_fitting": True,
            "rnapoly_fitting": True,
            "variable_elongation_transcription": True,
            "variable_elongation_translation": False,
            "remove_rrna_operons": False,
            "remove_rrff": False,
            "stable_rrna": False,
        },
    }
    hasher.update(json.dumps(config, sort_keys=True).encode())
    _hash_tree(hasher, settings.reconstruction_path / "ecoli")
    _hash_tree(hasher, settings.models_path / "ecoli")
    return hasher.hexdigest()


def _parca_run_id_for_experiment(run_id: str, experiment: Experiment) -> str:
    """Return the content-addressed Parca cache directory used by every job."""
    return "parca_cache_" + _parca_cache_key()[:24]


def _append_runner_log(log_path: Path, offset: int, log_buffer: deque, phase_label: str) -> int:
    if not log_path.exists():
        return offset
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as stream:
            stream.seek(offset)
            for line in stream:
                line = line.rstrip("\n")
                log_buffer.append(line)
                logger.info("[%s] %s", phase_label, line)
            return stream.tell()
    except OSError:
        return offset


def _run_runner_task(
    args: list[str],
    log_buffer: deque,
    phase_label: str,
    env_vars: dict[str, str] | None = None,
    *,
    engine,
    job_id: int,
    worker_id: str,
    attempt: int,
    heartbeat: LeaseHeartbeat,
    task_id: str,
    kind: str,
    cpu_slots: int,
    replace_terminal: bool = False,
) -> subprocess.CompletedProcess:
    """Submit a command to the persistent simulation container and wait."""
    client = RunnerClient(settings.sim_runner_socket)
    logger.info("[%s] runner task %s: %s", phase_label, task_id, " ".join(args))
    log_buffer.append("--- " + phase_label + " ---")
    log_buffer.append("$ " + " ".join(args))
    if kind == "sim":
        with Session(engine) as session:
            _owned_transition(
                session,
                job_id,
                worker_id,
                attempt,
                {"running_sim"},
                runner_task_id=task_id,
            )

    deadline = time.monotonic() + min(60, settings.worker_lease_timeout)
    while True:
        heartbeat.ensure_owned()
        _check_job_control(engine, job_id, worker_id, attempt)
        try:
            state = client.submit(
                task_id=task_id,
                kind=kind,
                args=args,
                env=env_vars or {},
                cpu_slots=cpu_slots,
                replace_terminal=replace_terminal,
            )
            break
        except RunnerError as exc:
            if time.monotonic() >= deadline:
                raise RunnerUnavailable(str(exc)) from exc
            time.sleep(settings.runner_poll_interval)

    log_path = settings.sim_output_dir / state["log_path"]
    log_offset = 0
    unavailable_since: float | None = None
    cancellation_requested = False
    while state["status"] not in TERMINAL_RUNNER_STATES:
        log_offset = _append_runner_log(log_path, log_offset, log_buffer, phase_label)
        heartbeat.ensure_owned()
        try:
            _check_job_control(engine, job_id, worker_id, attempt)
        except JobCancelled:
            if kind == "sim":
                try:
                    client.cancel(task_id)
                    cancellation_requested = True
                except RunnerError:
                    time.sleep(settings.runner_poll_interval)
                    continue
            else:
                raise
        time.sleep(settings.runner_poll_interval)
        try:
            state = client.status(task_id)
            unavailable_since = None
        except RunnerTaskNotFound as exc:
            raise RunnerTaskLost(str(exc)) from exc
        except RunnerError as exc:
            unavailable_since = unavailable_since or time.monotonic()
            if time.monotonic() - unavailable_since >= settings.worker_lease_timeout:
                raise RunnerUnavailable(str(exc)) from exc
            continue

    _append_runner_log(log_path, log_offset, log_buffer, phase_label)
    if cancellation_requested:
        raise JobCancelled("runner confirmed simulation cancellation")
    returncode = state.get("returncode")
    if returncode is None:
        returncode = 1
    log_buffer.append("--- " + phase_label + " exited with code " + str(returncode) + " ---")
    return subprocess.CompletedProcess(args, int(returncode))


SINUSOIDAL_ENV_KEYS = {"SINE_MEDIA_A", "SINE_MEDIA_B"}


def _sinusoidal_env_from_sim_params(raw_sim_params: str) -> dict[str, str]:
    try:
        params = json.loads(raw_sim_params or "{}")
    except json.JSONDecodeError:
        return {}
    if not isinstance(params, dict):
        return {}

    sinusoidal = params.get("sinusoidal_media", {})
    if not isinstance(sinusoidal, dict):
        return {}

    return {
        key: str(value)
        for key, value in sinusoidal.items()
        if key in SINUSOIDAL_ENV_KEYS and value not in ("", None)
    }


def _parca_cached(sim_dir: str) -> bool:
    """Check that a Parca cache entry was completely and successfully written."""
    run_path = settings.sim_output_dir / sim_dir
    kb_path = run_path / "kb"
    manifest_path = run_path / PARCA_MANIFEST
    if not manifest_path.exists():
        return False
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return (
        manifest.get("complete") is True
        and manifest.get("cache_key") == _parca_cache_key()
        and all((kb_path / filename).exists() for filename in PARCA_EXPECTED_FILES)
    )


def _write_parca_manifest(sim_dir: str, duration_seconds: float):
    run_path = settings.sim_output_dir / sim_dir
    kb_path = run_path / "kb"
    missing = [name for name in PARCA_EXPECTED_FILES if not (kb_path / name).is_file()]
    if missing:
        raise RuntimeError("Parca output is incomplete; missing: " + ", ".join(missing))
    manifest = {
        "complete": True,
        "cache_key": _parca_cache_key(),
        "docker_image": settings.docker_image,
        "cpus": settings.parca_cpus,
        "duration_seconds": round(duration_seconds, 3),
        "completed_at": _now(),
    }
    manifest_path = run_path / PARCA_MANIFEST
    temporary_path = run_path / (PARCA_MANIFEST + "." + uuid.uuid4().hex + ".tmp")
    temporary_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    temporary_path.replace(manifest_path)


def _prepare_shared_parca_kb(job_run_id: str, parca_run_id: str, log_buffer: deque):
    """Expose a content-addressed Parca kb/ directory inside a job directory."""
    job_path = settings.sim_output_dir / job_run_id
    job_path.mkdir(parents=True, exist_ok=True)
    kb_path = job_path / "kb"

    if kb_path.is_symlink():
        if kb_path.exists():
            log_buffer.append("Using shared Parca cache: " + parca_run_id)
            return
        kb_path.unlink()

    if kb_path.exists():
        if (kb_path / "simData.cPickle").exists():
            raise RuntimeError(
                "Job already has a private Parca kb; restart this job to use shared Parca cache"
            )
        raise RuntimeError("Job kb directory exists but does not contain simData.cPickle")

    relative_target = Path("..") / parca_run_id / "kb"
    try:
        kb_path.symlink_to(relative_target, target_is_directory=True)
        log_buffer.append("Linked job kb to shared Parca cache: " + str(relative_target))
    except OSError as exc:
        log_buffer.append("Could not link shared Parca cache, copying instead: " + str(exc))
        shutil.copytree(settings.sim_output_dir / parca_run_id / "kb", kb_path)


def _resolve_timeline(session: Session, timeline_name: str) -> str:
    """Resolve a timeline name (e.g. '000002_add_aa') to the raw events
    string expected by runSim.py's --timeline flag
    (e.g. '0 minimal, 1200 minimal_plus_amino_acids').

    If the name is already in events-string format (contains a space),
    return it as-is for backward compatibility.
    """
    # If it already looks like an events string, pass through
    if " " in timeline_name:
        return timeline_name

    tl = session.exec(
        select(Timeline).where(Timeline.name == timeline_name)
    ).first()
    if tl and tl.definition:
        # Strip surrounding quotes that may remain from TSV ingestion
        return tl.definition.strip('"').strip("'")

    # Fallback: try reading directly from the flat TSV
    logger.warning("Timeline '%s' not in DB — trying TSV fallback", timeline_name)
    try:
        import csv
        with open(settings.timelines_def_tsv) as f:
            reader = csv.reader(f, delimiter="\t")
            for row in reader:
                if len(row) >= 2 and row[0].strip('"') == timeline_name:
                    return row[1].strip('"')
    except Exception as exc:
        logger.warning("TSV fallback failed: %s", exc)

    # Last resort: return as-is and let the sim fail with a clear error
    logger.error("Could not resolve timeline '%s' — passing as-is", timeline_name)
    return timeline_name


def _resolve_condition_timeline(session: Session, condition_name: str) -> str:
    """Convert a growth condition name (e.g. 'acetate') to a timeline string
    (e.g. '0 minimal_acetate') by looking up the condition's nutrients field.

    The WCM's --timeline flag accepts "time nutrients" pairs. A static
    condition is just a single-entry timeline at time 0.
    """
    from app.db.models import Condition as ConditionModel
    cond = session.exec(
        select(ConditionModel).where(ConditionModel.name == condition_name)
    ).first()
    if cond and cond.nutrients:
        timeline_str = "0 " + cond.nutrients
        logger.info("Condition '%s' → timeline '%s'", condition_name, timeline_str)
        return timeline_str

    logger.warning("Condition '%s' not found in DB — falling back to basal", condition_name)
    return "0 minimal"


# ── Main job execution ───────────────────────────────────────────────────────

ENVIRONMENT_MANAGED_VARIANTS = {
    "condition",
    "add_one_aa",
    "remove_one_aa",
    "add_one_aa_shift",
    "remove_one_aa_shift",
    "remove_aas_shift",
    "ppgpp_conc",
    "sinusoidal_media",
    "new_gene_internal_shift",
}


def _variant_manages_environment(job: SimulationJob) -> bool:
    if job.variant_type in ENVIRONMENT_MANAGED_VARIANTS:
        return True
    if job.variant_type == "tf_activity" and job.variant_index != 0:
        return True
    if job.variant_type in {"rrna_location", "rrna_orientation", "rrna_operon_knockout"}:
        return job.variant_index != 0
    return False


_parca_locks: dict[str, threading.Lock] = {}
_parca_locks_guard = threading.Lock()


def _parca_lock(cache_id: str) -> threading.Lock:
    with _parca_locks_guard:
        return _parca_locks.setdefault(cache_id, threading.Lock())


def execute_job(engine, job_id: int):
    """Execute one claimed job while fencing every write by owner and attempt."""
    log_buffer: deque[str] = deque(maxlen=settings.log_tail_lines)
    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        if not job or job.status != "claimed" or job.worker_id != _worker_id:
            logger.info("Job %d is no longer claimed by this worker", job_id)
            return
        experiment = session.get(Experiment, job.experiment_id)
        if not experiment:
            logger.error("Job %d experiment is missing", job_id)
            return
        attempt = job.attempt
        worker_id = job.worker_id

    heartbeat = LeaseHeartbeat(engine, job_id, worker_id, attempt, log_buffer)
    try:
        heartbeat.start()
        _execute_owned_job(engine, job_id, worker_id, attempt, heartbeat, log_buffer)
    except JobCancelled:
        _finalize_cancelled(engine, job_id, worker_id, attempt, log_buffer)
    except RunnerTaskLost as exc:
        _requeue_lost_runner_task(engine, job_id, worker_id, attempt, str(exc))
    except RunnerUnavailable as exc:
        logger.error("Job %d runner unavailable; lease recovery will reconcile it: %s", job_id, exc)
    except JobOwnershipLost as exc:
        logger.info("Job %d stopped after ownership loss: %s", job_id, exc)
        _finalize_cancelled(engine, job_id, worker_id, attempt, log_buffer)
    except Exception as exc:
        logger.exception("Job %d failed", job_id)
        _fail_owned_job(engine, job_id, worker_id, attempt, log_buffer, str(exc))
    finally:
        heartbeat.stop()


def _execute_owned_job(engine, job_id, worker_id, attempt, heartbeat, log_buffer):
    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        experiment = session.get(Experiment, job.experiment_id)
        run_id = _make_run_id(job, experiment)
        parca_run_id = _parca_run_id_for_experiment(run_id, experiment)
        log_buffer.append("Shared Parca cache: " + parca_run_id)
        job = _owned_transition(
            session, job_id, worker_id, attempt, {"claimed"},
            status="waiting_parca",
            phase="Checking shared parameter calculator (Parca) cache...",
            sim_dir=run_id,
            started_at=_now(),
            log_tail="\n".join(log_buffer),
        )
        experiment.status = "running"
        experiment.updated_at = _now()
        session.add(experiment)
        session.commit()

    with _parca_lock(parca_run_id):
        heartbeat.ensure_owned()
        _check_job_control(engine, job_id, worker_id, attempt)
        if _parca_cached(parca_run_id):
            log_buffer.append("Parca cache hit - skipping")
        else:
            with Session(engine) as session:
                _owned_transition(
                    session, job_id, worker_id, attempt,
                    {"waiting_parca", "running_parca"},
                    status="running_parca",
                    phase="Running or waiting for shared Parca task...",
                )
            parca_task_id = "parca-" + parca_run_id.removeprefix("parca_cache_")
            last_error = "Parca failed"
            for retry in range(2):
                heartbeat.ensure_owned()
                _check_job_control(engine, job_id, worker_id, attempt)
                if retry:
                    shutil.rmtree(settings.sim_output_dir / parca_run_id, ignore_errors=True)
                    log_buffer.append("Retrying Parca after incomplete or failed output")
                started = time.monotonic()
                result = _run_runner_task(
                    ["python", "runscripts/manual/runParca.py", "-c", str(settings.parca_cpus), parca_run_id],
                    log_buffer,
                    "parca",
                    engine=engine,
                    job_id=job_id,
                    worker_id=worker_id,
                    attempt=attempt,
                    heartbeat=heartbeat,
                    task_id=parca_task_id,
                    kind="parca",
                    cpu_slots=settings.parca_cpus,
                    replace_terminal=True,
                )
                if result.returncode != 0:
                    last_error = "Parca failed with exit code {}".format(result.returncode)
                    continue
                try:
                    _write_parca_manifest(parca_run_id, time.monotonic() - started)
                except RuntimeError as exc:
                    last_error = str(exc)
                    try:
                        RunnerClient(settings.sim_runner_socket).forget(parca_task_id)
                    except RunnerError:
                        pass
                    continue
                if _parca_cached(parca_run_id):
                    break
            else:
                try:
                    RunnerClient(settings.sim_runner_socket).forget(parca_task_id)
                except RunnerError:
                    pass
                raise RuntimeError(last_error)

    heartbeat.ensure_owned()
    _check_job_control(engine, job_id, worker_id, attempt)
    _prepare_shared_parca_kb(run_id, parca_run_id, log_buffer)

    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        experiment = session.get(Experiment, job.experiment_id)
        job = _owned_transition(
            session, job_id, worker_id, attempt,
            {"waiting_parca", "running_parca"},
            status="running_sim",
            phase="Running simulation (seed={}, gen={})...".format(job.seed, job.generations),
            log_tail="\n".join(log_buffer),
        )
        sim_args, sim_env_vars = _build_sim_command(session, job, experiment, run_id, log_buffer)

    sim_task_id = "sim-job{}-attempt{}".format(job_id, attempt)
    result = _run_runner_task(
        sim_args, log_buffer, "sim", env_vars=sim_env_vars,
        engine=engine, job_id=job_id, worker_id=worker_id, attempt=attempt,
        heartbeat=heartbeat, task_id=sim_task_id, kind="sim",
        cpu_slots=settings.sim_cpus_per_job,
    )
    if result.returncode != 0:
        raise RuntimeError("Simulation failed with exit code {}".format(result.returncode))

    with Session(engine) as session:
        job = _owned_transition(
            session, job_id, worker_id, attempt, {"running_sim"},
            status="ingesting", phase="Validating and ingesting simulation results...",
            log_tail="\n".join(log_buffer),
        )
        experiment = session.get(Experiment, job.experiment_id)

    results = _collect_results(
        job, experiment, log_buffer,
        check_control=lambda: (
            heartbeat.ensure_owned(),
            _check_job_control(engine, job_id, worker_id, attempt),
        ),
    )
    _commit_results_and_complete(engine, job_id, worker_id, attempt, results, log_buffer)
    try:
        RunnerClient(settings.sim_runner_socket).forget(sim_task_id)
    except RunnerError:
        pass
    logger.info("Job %d completed successfully - %s", job_id, run_id)


def _build_sim_command(session, job, experiment, run_id, log_buffer):
    variant_type = job.variant_type
    variant_start = variant_end = str(job.variant_index)
    multi_ko_indices: list[int] = []
    if job.variant_type == "timelines":
        variant_type, variant_start, variant_end = "wildtype", "0", "0"
    elif job.variant_type == MULTI_GENE_KNOCKOUT_TYPE:
        multi_ko_indices = ko_indices_from_sim_params(experiment.sim_params)
        variant_start = variant_end = "0"
    sim_args = [
        "python", "runscripts/manual/runSim.py", run_id,
        "--variant", variant_type, variant_start, variant_end,
        "--seed", str(job.seed), "--generations", str(job.generations),
    ]
    if multi_ko_indices:
        sim_args.extend(["--multi-ko-indices", *(str(index) for index in multi_ko_indices)])
    if _variant_manages_environment(job):
        log_buffer.append("Variant '{}' manages its environment".format(job.variant_type))
    elif job.timeline:
        timeline_events = _resolve_timeline(session, job.timeline)
        sim_args.extend(["--timeline", timeline_events])
    elif job.condition and job.condition != "basal":
        sim_args.extend(["--timeline", _resolve_condition_timeline(session, job.condition)])
    sim_env_vars = (
        _sinusoidal_env_from_sim_params(experiment.sim_params)
        if job.variant_type == "sinusoidal_media" else {}
    )
    return sim_args, sim_env_vars


def _fail_owned_job(engine, job_id, worker_id, attempt, log_buffer, message):
    logger.error("Job %d failed: %s", job_id, message)
    with Session(engine) as session:
        current = session.get(SimulationJob, job_id)
        runner_task_id = (
            current.runner_task_id
            if current and current.worker_id == worker_id and current.attempt == attempt
            else ""
        )
        try:
            job = _owned_transition(
                session, job_id, worker_id, attempt, ACTIVE_EXECUTION_STATUSES,
                status="failed", phase="Failed", error_message=message,
                finished_at=_now(), log_tail="\n".join(log_buffer),
                runner_task_id="", lease_expires_at="", heartbeat_at="",
            )
        except JobOwnershipLost:
            return
        sync_experiment_status(session, job.experiment_id)
        session.commit()
    _forget_terminal_runner_task(runner_task_id)


def _finalize_cancelled(engine, job_id, worker_id, attempt, log_buffer):
    with Session(engine) as session:
        current = session.get(SimulationJob, job_id)
        runner_task_id = (
            current.runner_task_id
            if current and current.worker_id == worker_id and current.attempt == attempt
            else ""
        )
        try:
            job = _owned_transition(
                session, job_id, worker_id, attempt, {"cancelling"},
                status="cancelled", phase="Cancelled", error_message="Cancelled by user",
                finished_at=_now(), log_tail="\n".join(log_buffer),
                runner_task_id="", lease_expires_at="", heartbeat_at="",
            )
        except JobOwnershipLost:
            return
        sync_experiment_status(session, job.experiment_id)
        session.commit()
    _forget_terminal_runner_task(runner_task_id)


def _forget_terminal_runner_task(task_id: str):
    if not task_id:
        return
    client = RunnerClient(settings.sim_runner_socket)
    try:
        state = client.status(task_id)
        if state["status"] in TERMINAL_RUNNER_STATES:
            client.forget(task_id)
    except (RunnerError, RunnerTaskNotFound):
        pass


def _requeue_lost_runner_task(engine, job_id, worker_id, attempt, message):
    with Session(engine) as session:
        try:
            job = _owned_transition(
                session, job_id, worker_id, attempt, ACTIVE_EXECUTION_STATUSES,
                status="pending", phase="Runner restarted; queued for a new attempt",
                error_message=message, runner_task_id="", worker_id="",
                heartbeat_at="", lease_expires_at="", started_at="",
            )
        except JobOwnershipLost:
            return
        sync_experiment_status(session, job.experiment_id)
        session.commit()


def _ingest_results(
    session: Session,
    job: SimulationJob,
    experiment: Experiment,
    log_buffer: deque,
):
    """Compatibility wrapper used by re-ingestion tests and maintenance code."""
    results = _collect_results(job, experiment, log_buffer)
    for result in session.exec(
        select(SimulationResult).where(SimulationResult.job_id == job.id)
    ).all():
        session.delete(result)
    for result in results:
        session.add(result)
    session.commit()
    return results


def _collect_results(job, experiment, log_buffer, check_control=None):
    """Validate and parse outputs without holding a SQLite write transaction."""
    from app.services.table_reader_bridge import SimOutReader, find_sim_outs, parse_sim_out_path

    sim_out_base = settings.sim_output_dir / job.sim_dir
    sim_outs = find_sim_outs(sim_out_base)
    log_buffer.append("Found " + str(len(sim_outs)) + " simOut directories")

    if not sim_outs:
        raise RuntimeError("Simulation completed without producing any simOut directories")

    expected_generations = set(range(job.generations))
    observed: dict[tuple[int, int], Path] = {}
    for sim_out_path in sim_outs:
        path_info = parse_sim_out_path(sim_out_path)
        key = (path_info.get("seed", job.seed), path_info.get("generation", 0))
        if key in observed:
            raise RuntimeError("Duplicate simOut for seed {} generation {}".format(*key))
        observed[key] = sim_out_path
    wrong_seeds = sorted({seed for seed, _ in observed if seed != job.seed})
    observed_generations = {generation for seed, generation in observed if seed == job.seed}
    if wrong_seeds:
        raise RuntimeError("Unexpected output seed(s): {}".format(wrong_seeds))
    if observed_generations != expected_generations:
        raise RuntimeError(
            "Generation output mismatch: expected {}, found {}".format(
                sorted(expected_generations), sorted(observed_generations)
            )
        )

    results = []
    exports = []
    for (seed, generation), sim_out_path in sorted(observed.items()):
        if check_control:
            check_control()
        path_info = parse_sim_out_path(sim_out_path)
        log_buffer.append(
            "Ingesting: seed=" + str(path_info['seed']) + ", gen=" + str(path_info['generation'])
            + ", variant=" + str(path_info['variant_dir'])
        )

        try:
            reader = SimOutReader(sim_out_path)
            summary = reader.extract_summary()
        except Exception as exc:
            raise RuntimeError("TableReader failed for {}: {}".format(sim_out_path, exc)) from exc
        if summary.get("final_mass_fg") is None:
            raise RuntimeError("TableReader returned no mass summary for {}".format(sim_out_path))

        result = SimulationResult(
            job_id=job.id,
            experiment_id=job.experiment_id,
            seed=path_info.get("seed", job.seed),
            generation=path_info.get("generation", 0),
            division_time_sec=summary["division_time_sec"],
            final_mass_fg=summary["final_mass_fg"],
            growth_rate=summary["growth_rate"],
            doubling_time_min=summary["doubling_time_min"],
            divided=summary.get("divided", False),
            created_at=_now(),
        )
        results.append(result)
        exports.append((seed, generation, reader))

    # Export only after every requested summary was parsed successfully.
    for seed, generation, reader in exports:
        if check_control:
            check_control()
        try:
            export_dir = sim_out_base / "export"
            parquet_path = export_dir / (
                "timeseries_seed" + str(seed)
                + "_gen" + str(generation) + ".parquet"
            )
            reader.export_parquet(parquet_path)
            log_buffer.append("  Exported: " + parquet_path.name)
        except Exception as exc:
            log_buffer.append("QC: Parquet export failed for generation {}: {}".format(generation, exc))

    log_buffer.append("Ingested " + str(len(sim_outs)) + " result(s)")
    return results


def _commit_results_and_complete(engine, job_id, worker_id, attempt, results, log_buffer):
    """Replace summaries and finalize under one fenced SQLite transaction."""
    with Session(engine) as session:
        result = session.exec(
            update(SimulationJob)
            .where(
                SimulationJob.id == job_id,
                SimulationJob.worker_id == worker_id,
                SimulationJob.attempt == attempt,
                SimulationJob.status == "ingesting",
            )
            .values(phase="Finalizing validated results...")
        )
        if getattr(result, "rowcount", 0) != 1:
            session.rollback()
            raise JobOwnershipLost("ownership changed before result finalization")
        session.exec(delete(SimulationResult).where(SimulationResult.job_id == job_id))
        for simulation_result in results:
            session.add(simulation_result)
        job = session.get(SimulationJob, job_id)
        job.status = "done"
        job.phase = "Complete"
        job.finished_at = _now()
        job.runner_task_id = ""
        job.lease_expires_at = ""
        job.heartbeat_at = ""
        job.log_tail = "\n".join(log_buffer)
        session.add(job)
        sync_experiment_status(session, job.experiment_id)
        session.commit()


# Worker loop

def _repair_stale_statuses(engine):
    """Requeue only active jobs whose worker lease has expired."""
    with Session(engine) as session:
        active_statuses = sorted(ACTIVE_EXECUTION_STATUSES | {"recovering"})
        active_jobs = session.exec(
            select(SimulationJob).where(
                col(SimulationJob.status).in_(active_statuses)
            )
        ).all()
        now = _now()
        stuck_jobs = [
            job for job in active_jobs
            if job.status == "recovering"
            or not job.lease_expires_at
            or job.lease_expires_at <= now
        ]
        for job in stuck_jobs:
            user_cancellation = job.status == "cancelling"
            if job.status not in {"recovering", "cancelling"}:
                result = session.exec(
                    update(SimulationJob)
                    .where(
                        SimulationJob.id == job.id,
                        SimulationJob.worker_id == job.worker_id,
                        SimulationJob.attempt == job.attempt,
                        SimulationJob.status == job.status,
                        SimulationJob.lease_expires_at == job.lease_expires_at,
                        SimulationJob.lease_expires_at <= now,
                    )
                    .values(
                        status="recovering",
                        phase="Stopping task from expired worker lease",
                        error_message="Worker lease expired; runner reconciliation pending",
                    )
                )
                session.commit()
                if getattr(result, "rowcount", 0) != 1:
                    continue
                job = session.get(SimulationJob, job.id)

            logger.info("Reconciling expired job %d (%s)", job.id, job.status)
            if not _confirm_runner_task_stopped(job.runner_task_id):
                continue

            target_status = "cancelled" if user_cancellation else "pending"
            expected_status = "cancelling" if user_cancellation else "recovering"
            result = session.exec(
                update(SimulationJob)
                .where(
                    SimulationJob.id == job.id,
                    SimulationJob.worker_id == job.worker_id,
                    SimulationJob.attempt == job.attempt,
                    SimulationJob.status == expected_status,
                    SimulationJob.runner_task_id == job.runner_task_id,
                )
                .values(
                    status=target_status,
                    phase=(
                        "Cancelled after worker lease expired"
                        if user_cancellation else "Reset after worker lease expired"
                    ),
                    started_at="",
                    finished_at=_now() if user_cancellation else "",
                    log_tail="",
                    runner_task_id="",
                    worker_id="",
                    heartbeat_at="",
                    lease_expires_at="",
                )
            )
            session.commit()
            if getattr(result, "rowcount", 0) == 1:
                sync_experiment_status(session, job.experiment_id)
                session.commit()
        if stuck_jobs:
            logger.info("Reconciled %d expired job candidate(s)", len(stuck_jobs))

        # 2. Fix experiments stuck in queued/running when all jobs terminated
        stale = session.exec(
            select(Experiment).where(
                col(Experiment.status).in_(["queued", "running"])
            )
        ).all()
        fixed = 0
        for exp in stale:
            jobs = session.exec(
                select(SimulationJob).where(SimulationJob.experiment_id == exp.id)
            ).all()
            if not jobs:
                # No jobs at all — revert to draft
                exp.status = "draft"
                exp.updated_at = _now()
                session.add(exp)
                fixed += 1
            elif all(j.status in ("done", "failed", "cancelled") for j in jobs):
                # All jobs finished — pick the worst outcome
                if any(j.status == "failed" for j in jobs):
                    exp.status = "failed"
                else:
                    exp.status = "done"
                exp.updated_at = _now()
                session.add(exp)
                fixed += 1
        if fixed:
            session.commit()
            logger.info("Repaired %d stale experiment(s)", fixed)


def _confirm_runner_task_stopped(task_id: str) -> bool:
    """Cancel and confirm a stale task before its durable ID may be cleared."""
    if not task_id:
        return True
    client = RunnerClient(settings.sim_runner_socket)
    try:
        state = client.cancel(task_id)
    except RunnerTaskNotFound:
        return True
    except RunnerError as exc:
        logger.warning("Runner unavailable while reconciling %s: %s", task_id, exc)
        return False

    deadline = time.monotonic() + 15
    while state["status"] not in TERMINAL_RUNNER_STATES and time.monotonic() < deadline:
        time.sleep(min(settings.runner_poll_interval, 1))
        try:
            state = client.status(task_id)
        except RunnerTaskNotFound:
            return True
        except RunnerError:
            return False
    return state["status"] in TERMINAL_RUNNER_STATES


def claim_next_pending_job(engine, worker_id: str | None = None) -> int | None:
    """Atomically claim the oldest pending job for this worker."""
    owner = worker_id or _worker_id
    now = datetime.now(timezone.utc)
    lease_expires_at = (now + timedelta(seconds=settings.worker_lease_timeout)).isoformat()
    with Session(engine) as session:
        pending = session.exec(
            select(SimulationJob.id)
            .where(SimulationJob.status == "pending")
            .order_by(col(SimulationJob.id).asc())
            .limit(1)
        ).first()
        if pending is None:
            return None
        job_id = int(pending[0] if isinstance(pending, tuple) else pending)
        result = session.exec(
            update(SimulationJob)
            .where(SimulationJob.id == job_id, SimulationJob.status == "pending")
            .values(
                status="claimed",
                phase="Claimed by worker",
                started_at=now.isoformat(),
                worker_id=owner,
                heartbeat_at=now.isoformat(),
                lease_expires_at=lease_expires_at,
                attempt=SimulationJob.attempt + 1,
            )
        )
        session.commit()
        if getattr(result, "rowcount", 0) != 1:
            return None
        return job_id


def poll_loop():
    """Claim and execute jobs up to the configured runner concurrency."""
    if settings.sim_runner_concurrency < 1:
        raise ValueError("SIM_RUNNER_CONCURRENCY must be at least 1")
    if settings.sim_cpus_per_job < 1:
        raise ValueError("SIM_CPUS_PER_JOB must be at least 1")
    if settings.sim_cpus_per_job > settings.sim_runner_cpu_budget:
        raise ValueError("SIM_CPUS_PER_JOB cannot exceed SIM_RUNNER_CPU_BUDGET")
    if settings.parca_cpus > settings.sim_runner_cpu_budget:
        raise ValueError("PARCA_CPUS cannot exceed SIM_RUNNER_CPU_BUDGET")

    engine = make_sqlite_engine(settings.database_path)
    logger.info("Simulation worker started — polling every %ds", settings.worker_poll_interval)
    logger.info("Database: %s", settings.database_path)
    logger.info("Runner socket: %s", settings.sim_runner_socket)
    logger.info("Runner concurrency: %d", settings.sim_runner_concurrency)
    logger.info("Output directory: %s", settings.sim_output_dir)
    executor = ThreadPoolExecutor(
        max_workers=settings.sim_runner_concurrency,
        thread_name_prefix="simulation-job",
    )
    futures: dict[int, object] = {}
    last_repair = 0.0
    try:
        while not _shutdown:
            try:
                finished = [job_id for job_id, future in futures.items() if future.done()]
                for job_id in finished:
                    future = futures.pop(job_id)
                    try:
                        future.result()
                    except Exception:
                        logger.exception("Unhandled execution error for job %d", job_id)

                if time.monotonic() - last_repair >= max(30, settings.worker_lease_timeout // 2):
                    _repair_stale_statuses(engine)
                    last_repair = time.monotonic()

                claimed_any = False
                while len(futures) < settings.sim_runner_concurrency and not _shutdown:
                    job_id = claim_next_pending_job(engine, _worker_id)
                    if job_id is None:
                        break
                    logger.info("Claimed job %d", job_id)
                    futures[job_id] = executor.submit(execute_job, engine, job_id)
                    claimed_any = True

                if not claimed_any:
                    time.sleep(min(settings.worker_poll_interval, 1))

            except OperationalError as exc:
                if "no such table" in str(exc).lower():
                    logger.info(
                        "Database schema not ready yet; retrying in %ds",
                        settings.worker_poll_interval,
                    )
                else:
                    logger.exception("Worker database error")
                time.sleep(settings.worker_poll_interval)
            except Exception:
                logger.exception("Worker loop error")
                time.sleep(settings.worker_poll_interval)
    finally:
        logger.info("Worker draining %d active job(s)", len(futures))
        _, unfinished = wait(
            list(futures.values()),
            timeout=settings.worker_shutdown_grace_sec,
        )
        if unfinished:
            with Session(engine) as session:
                active_jobs = session.exec(
                    select(SimulationJob).where(
                        SimulationJob.worker_id == _worker_id,
                        col(SimulationJob.status).in_(ACTIVE_EXECUTION_STATUSES),
                    )
                ).all()
                client = RunnerClient(settings.sim_runner_socket)
                for job in active_jobs:
                    if job.runner_task_id:
                        try:
                            client.cancel(job.runner_task_id)
                        except RunnerError:
                            pass
        executor.shutdown(wait=False, cancel_futures=True)
        engine.dispose()
        logger.info("Worker shut down cleanly")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="wcEcoli persistent-runner scheduler")
    parser.add_argument("--workers", type=int, help="override SIM_RUNNER_CONCURRENCY")
    parser.add_argument("--cpu-budget", type=int, help="override SIM_RUNNER_CPU_BUDGET")
    cli_args = parser.parse_args()
    if cli_args.workers is not None:
        settings.sim_runner_concurrency = cli_args.workers
    if cli_args.cpu_budget is not None:
        settings.sim_runner_cpu_budget = cli_args.cpu_budget
    poll_loop()
