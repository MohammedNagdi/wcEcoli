"""SLURM campaign controller: dispatch pending jobs, reconcile finished ones.

This replaces ``sim_worker.poll_loop`` on a cluster. The original loop runs a
``ThreadPoolExecutor`` that holds one thread per in-flight job for that job's entire ~25-minute
duration (``sim_worker.py:1131`` -> ``_execute_owned_job`` -> ``_run_runner_task``, which blocks
on the runner socket until the task is terminal). That cannot hold hundreds of concurrent jobs.

Here the same lifecycle is split into two non-blocking halves:

    dispatch()    claim pending rows -> write a manifest -> sbatch one array -> record task ids
    reconcile()   read sentinels -> insert results / fail / requeue; ask the scheduler only
                  about tasks that vanished without leaving one

Both are ordinary functions. Run them by hand for a small tier, or from ``scrontab`` for a large
one; the array task script is identical either way.

Single-writer discipline: this module is the *only* process that writes the database, and every
entry point takes an exclusive ``flock`` first. SQLite's WAL mode is unsafe on GPFS, so set
SQLITE_JOURNAL_MODE=TRUNCATE (see cluster/RUN_SLURM.md). Array tasks never open the database.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import shutil
import sys
import time
import uuid
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlmodel import Session, col, select

from app.config import settings
from app.db.engine import make_sqlite_engine
from app.db.models import Experiment, SimulationJob, SimulationResult
from app.services import slurm_backend
from app.services.slurm_backend import DEAD_SLURM_STATES, LIVE_SLURM_STATES, SlurmResources
from app.services.sim_worker import (
    ACTIVE_EXECUTION_STATUSES,
    JobOwnershipLost,
    _build_sim_command,
    _commit_results_and_complete,
    _fail_owned_job,
    _make_run_id,
    _now,
    _owned_transition,
    _parca_run_id_for_experiment,
    _requeue_lost_runner_task,
    claim_next_pending_job,
)
from app.services.slurm_ingest import sentinel_path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("slurm_campaign")

# A stable identity, unlike sim_worker's per-process uuid: dispatch and reconcile run in
# separate processes and must both satisfy the fenced-write ownership checks.
SLURM_WORKER_ID = "slurm-dispatcher"

# How long after dispatch a task may be absent from squeue before we treat it as lost.
# Covers the gap between sbatch returning and the controller registering the array.
MISSING_TASK_GRACE_SEC = 180

REPO_ROOT = Path(__file__).resolve().parents[4]
TASK_SCRIPT = REPO_ROOT / "cluster" / "task.sbatch"


# ── Paths ────────────────────────────────────────────────────────────────────

def campaign_root() -> Path:
    return Path(os.environ.get(
        "WCECOLI_CAMPAIGN_ROOT", str(settings.sim_output_dir.parent)
    )).resolve()


def state_dir() -> Path:
    path = campaign_root() / "state"
    path.mkdir(parents=True, exist_ok=True)
    return path


def manifest_dir() -> Path:
    path = state_dir() / "manifests"
    path.mkdir(parents=True, exist_ok=True)
    return path


def log_dir() -> Path:
    path = campaign_root() / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def dispatch_log() -> Path:
    return state_dir() / "dispatch_log.jsonl"


@contextmanager
def db_lock(timeout: int = 600):
    """Serialize every database writer through one advisory lock.

    submit_campaign, dispatch and reconcile all write the same SQLite file on GPFS. Rather
    than rely on SQLite's own locking (which GPFS implements poorly), they queue here.
    """
    lock_path = state_dir() / "wcecoli.db.lock"
    deadline = time.monotonic() + timeout
    handle = lock_path.open("w")
    try:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "could not acquire {} within {}s".format(lock_path, timeout)
                    )
                time.sleep(1.0)
        yield
    finally:
        try:
            fcntl.flock(handle, fcntl.LOCK_UN)
        finally:
            handle.close()


def _engine():
    return make_sqlite_engine(settings.database_path)


# ── Parca ────────────────────────────────────────────────────────────────────

def resolve_parca_run_id(experiment: Experiment | None = None) -> str:
    """Name the shared Parca cache directory.

    ``_parca_run_id_for_experiment`` hashes the whole reconstruction/ and models/ trees. That
    is fine once per controller process (it is lru_cached) but must never run per task, which
    is why the array task script does not call it at all. WCECOLI_PARCA_RUN_ID pins the name
    outright once the cache has been built and frozen.
    """
    pinned = os.environ.get("WCECOLI_PARCA_RUN_ID", "")
    if pinned:
        return pinned
    return _parca_run_id_for_experiment("", experiment)


def verify_parca(parca_run_id: str) -> Path:
    """Fail loudly if the frozen Parca cache is missing or incomplete."""
    from app.services.sim_worker import PARCA_EXPECTED_FILES

    kb_path = settings.sim_output_dir / parca_run_id / "kb"
    missing = [name for name in PARCA_EXPECTED_FILES if not (kb_path / name).is_file()]
    if missing:
        raise RuntimeError(
            "Parca cache {} is incomplete; missing: {}. Build it first with:\n"
            "    sbatch cluster/parca.sbatch".format(kb_path, ", ".join(missing))
        )
    return kb_path


# ── Dispatch ─────────────────────────────────────────────────────────────────

def _active_task_ids(session: Session) -> list[str]:
    rows = session.exec(
        select(SimulationJob).where(
            col(SimulationJob.status).in_(sorted(ACTIVE_EXECUTION_STATUSES)),
            SimulationJob.worker_id == SLURM_WORKER_ID,
        )
    ).all()
    return [job.runner_task_id for job in rows if job.runner_task_id]


def dispatch(limit: int, resources: SlurmResources, *, max_in_flight: int) -> dict:
    """Claim up to ``limit`` pending jobs and submit them as one array."""
    engine = _engine()
    parca_run_id = resolve_parca_run_id()
    verify_parca(parca_run_id)

    with db_lock():
        with Session(engine) as session:
            in_flight = len(_active_task_ids(session))
        capacity = max(0, min(limit, max_in_flight - in_flight))
        if capacity == 0:
            logger.info("At capacity: %d task(s) in flight, cap %d", in_flight, max_in_flight)
            return {"submitted": 0, "in_flight": in_flight}

        claimed: list[dict] = []
        while len(claimed) < capacity:
            job_id = claim_next_pending_job(engine, SLURM_WORKER_ID)
            if job_id is None:
                break
            try:
                claimed.append(_prepare_job(engine, job_id, parca_run_id))
            except Exception:
                logger.exception("Could not prepare job %d; returning it to the queue", job_id)
                _release_job(engine, job_id)

        if not claimed:
            logger.info("Nothing pending to dispatch")
            return {"submitted": 0, "in_flight": in_flight}

        dispatch_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
        manifest = manifest_dir() / (dispatch_id + ".jsonl")
        with manifest.open("w", encoding="utf-8") as stream:
            for index, entry in enumerate(claimed):
                entry["index"] = index
                stream.write(json.dumps(entry, sort_keys=True) + "\n")

        try:
            array_job_id = slurm_backend.submit_array(
                TASK_SCRIPT, manifest, len(claimed), resources,
                log_dir=log_dir(), job_name="wce-" + dispatch_id[-6:],
            )
        except Exception as exc:
            logger.error("sbatch failed (%s); returning %d job(s) to the queue", exc, len(claimed))
            for entry in claimed:
                _release_job(engine, entry["job_id"])
            raise

        with Session(engine) as session:
            for entry in claimed:
                task = slurm_backend.task_id(array_job_id, entry["index"])
                try:
                    _owned_transition(
                        session, entry["job_id"], SLURM_WORKER_ID, entry["attempt"],
                        {"running_sim"},
                        runner_task_id=task,
                        phase="Queued on SLURM as {}".format(task),
                    )
                except JobOwnershipLost:
                    logger.warning("Lost ownership of job %d during dispatch", entry["job_id"])

        with dispatch_log().open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "array_job_id": array_job_id,
                "dispatch_id": dispatch_id,
                "manifest": str(manifest),
                "count": len(claimed),
                "submitted_at": _now(),
                "account": resources.account,
                "partition": resources.partition,
                "throttle": resources.throttle,
            }, sort_keys=True) + "\n")

        logger.info(
            "Submitted array %s with %d task(s) (throttle %d) from %s",
            array_job_id, len(claimed), resources.throttle, manifest.name,
        )
        return {
            "submitted": len(claimed),
            "array_job_id": array_job_id,
            "manifest": str(manifest),
            "in_flight": in_flight + len(claimed),
        }


def _prepare_job(engine, job_id: int, parca_run_id: str) -> dict:
    """Turn one claimed row into a manifest entry and move it to running_sim."""
    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        experiment = session.get(Experiment, job.experiment_id)
        if experiment is None:
            raise RuntimeError("job {} has no experiment".format(job_id))
        attempt = job.attempt
        run_id = _make_run_id(job, experiment)
        log_buffer: deque[str] = deque(maxlen=settings.log_tail_lines)
        sim_args, sim_env = _build_sim_command(session, job, experiment, run_id, log_buffer)

        job = _owned_transition(
            session, job_id, SLURM_WORKER_ID, attempt, {"claimed"},
            status="running_sim",
            phase="Preparing SLURM submission",
            sim_dir=run_id,
            started_at=_now(),
            # Reconciliation is driven by sentinels and the scheduler, not by wall-clock
            # leases; keep the lease far in the future so nothing else reclaims the row.
            lease_expires_at=(
                datetime.now(timezone.utc) + timedelta(days=365)
            ).isoformat(),
            heartbeat_at=_now(),
            log_tail="\n".join(log_buffer),
        )
        return {
            "job_id": job_id,
            "experiment_id": job.experiment_id,
            "attempt": attempt,
            "run_id": run_id,
            "sim_dir": run_id,
            "parca_run_id": parca_run_id,
            "seed": job.seed,
            "generations": job.generations,
            "argv": sim_args,
            "env": sim_env,
        }


def _release_job(engine, job_id: int):
    """Return a claimed-but-unsubmitted row to the pending queue."""
    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        if job is None or job.worker_id != SLURM_WORKER_ID:
            return
        job.status = "pending"
        job.phase = "Returned to queue (dispatch aborted)"
        job.worker_id = ""
        job.runner_task_id = ""
        job.started_at = ""
        job.heartbeat_at = ""
        job.lease_expires_at = ""
        session.add(job)
        session.commit()


# ── Reconcile ────────────────────────────────────────────────────────────────

def _manifest_for_array(array_job_id: str) -> Path | None:
    if not dispatch_log().exists():
        return None
    for line in reversed(dispatch_log().read_text().splitlines()):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("array_job_id") == array_job_id:
            return Path(record["manifest"])
    return None


def _purge_run_dir(sim_dir: str):
    """Delete a superseded attempt's output.

    /gscratch/amath is at ~98% of its inode allocation, so abandoned attempts are not free to
    leave lying around: every preemption retry would otherwise strand a full simOut tree.
    """
    if not sim_dir:
        return
    target = settings.sim_output_dir / sim_dir
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
        logger.info("Purged superseded output %s", target)


def reconcile() -> dict:
    engine = _engine()
    counts = {"done": 0, "failed": 0, "requeued": 0, "running": 0, "unknown": 0}

    with db_lock():
        with Session(engine) as session:
            active = session.exec(
                select(SimulationJob).where(
                    col(SimulationJob.status).in_(sorted(ACTIVE_EXECUTION_STATUSES)),
                    SimulationJob.worker_id == SLURM_WORKER_ID,
                )
            ).all()
            rows = [
                {
                    "id": job.id, "attempt": job.attempt, "task": job.runner_task_id,
                    "sim_dir": job.sim_dir, "started_at": job.started_at,
                }
                for job in active if job.runner_task_id
            ]

        if not rows:
            logger.info("Nothing in flight")
            return counts

        without_sentinel: list[dict] = []
        for row in rows:
            array_job_id, _, index = row["task"].partition("_")
            manifest = _manifest_for_array(array_job_id)
            if manifest is None:
                counts["unknown"] += 1
                continue
            sentinel = sentinel_path(manifest, int(index))
            if not sentinel.exists():
                without_sentinel.append(row)
                continue
            try:
                payload = json.loads(sentinel.read_text())
            except (OSError, json.JSONDecodeError):
                without_sentinel.append(row)
                continue
            if payload.get("attempt") != row["attempt"]:
                # A stale sentinel from an earlier attempt; ignore it.
                without_sentinel.append(row)
                continue
            _apply_sentinel(engine, row, payload, counts)

        if without_sentinel:
            _reconcile_missing(engine, without_sentinel, counts)

    logger.info(
        "Reconciled: %d done, %d failed, %d requeued, %d still running, %d unknown",
        counts["done"], counts["failed"], counts["requeued"], counts["running"], counts["unknown"],
    )
    return counts


def _apply_sentinel(engine, row: dict, payload: dict, counts: dict):
    job_id, attempt = row["id"], row["attempt"]
    log_buffer: deque[str] = deque(payload.get("log_tail", "").splitlines(), maxlen=settings.log_tail_lines)

    if payload.get("status") != "done":
        _fail_owned_job(
            engine, job_id, SLURM_WORKER_ID, attempt, log_buffer,
            payload.get("error", "simulation failed"),
        )
        counts["failed"] += 1
        return

    results = [
        SimulationResult(
            job_id=entry["job_id"],
            experiment_id=entry["experiment_id"],
            seed=entry["seed"],
            generation=entry["generation"],
            division_time_sec=entry["division_time_sec"],
            final_mass_fg=entry["final_mass_fg"],
            growth_rate=entry["growth_rate"],
            doubling_time_min=entry["doubling_time_min"],
            divided=entry["divided"],
            created_at=entry["created_at"] or _now(),
        )
        for entry in payload.get("results", [])
    ]
    try:
        with Session(engine) as session:
            _owned_transition(
                session, job_id, SLURM_WORKER_ID, attempt, {"running_sim"},
                status="ingesting", phase="Committing validated results...",
            )
        _commit_results_and_complete(engine, job_id, SLURM_WORKER_ID, attempt, results, log_buffer)
        counts["done"] += 1
    except JobOwnershipLost as exc:
        logger.warning("Job %d ownership changed during commit: %s", job_id, exc)
        counts["unknown"] += 1


def _reconcile_missing(engine, rows: list[dict], counts: dict):
    """Explain in-flight rows that have not written a sentinel."""
    task_ids = [row["task"] for row in rows]
    try:
        live = slurm_backend.live_task_states(task_ids)
    except slurm_backend.SlurmError as exc:
        logger.warning("squeue unavailable, deferring: %s", exc)
        counts["running"] += len(rows)
        return

    still_missing = []
    for row in rows:
        state = live.get(row["task"], "")
        if state in LIVE_SLURM_STATES:
            counts["running"] += 1
        else:
            still_missing.append(row)

    if not still_missing:
        return

    try:
        accounted = slurm_backend.accounted_task_states([r["task"] for r in still_missing])
    except slurm_backend.SlurmError as exc:
        logger.warning("sacct unavailable, deferring: %s", exc)
        counts["unknown"] += len(still_missing)
        return

    now = datetime.now(timezone.utc)
    for row in still_missing:
        state = accounted.get(row["task"], "")
        if not state:
            # Not yet visible to either squeue or sacct. Give sbatch time to register.
            started = _parse_iso(row["started_at"])
            if started and (now - started).total_seconds() < MISSING_TASK_GRACE_SEC:
                counts["running"] += 1
            else:
                counts["unknown"] += 1
                logger.warning("Task %s is unknown to SLURM", row["task"])
            continue
        if state in LIVE_SLURM_STATES:
            counts["running"] += 1
            continue
        if state == "COMPLETED":
            # Exited zero but wrote no sentinel: the task died between the simulation and
            # ingestion. Retry rather than record a success we cannot substantiate.
            _purge_run_dir(row["sim_dir"])
            _requeue_lost_runner_task(
                engine, row["id"], SLURM_WORKER_ID, row["attempt"],
                "Array task completed without writing a result sentinel",
            )
            counts["requeued"] += 1
        elif state in {"PREEMPTED", "NODE_FAIL", "REQUEUED", "BOOT_FAIL", "REVOKED"}:
            _purge_run_dir(row["sim_dir"])
            _requeue_lost_runner_task(
                engine, row["id"], SLURM_WORKER_ID, row["attempt"],
                "SLURM reported {}; queued for a new attempt".format(state),
            )
            counts["requeued"] += 1
        elif state in DEAD_SLURM_STATES:
            log_buffer: deque[str] = deque(maxlen=settings.log_tail_lines)
            _fail_owned_job(
                engine, row["id"], SLURM_WORKER_ID, row["attempt"], log_buffer,
                "SLURM reported {}".format(state),
            )
            counts["failed"] += 1
        else:
            counts["unknown"] += 1


def _parse_iso(value: str):
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ── Status ───────────────────────────────────────────────────────────────────

def status() -> dict:
    engine = _engine()
    with Session(engine) as session:
        rows = session.exec(select(SimulationJob)).all()
    tally: dict[str, int] = {}
    for job in rows:
        tally[job.status] = tally.get(job.status, 0) + 1
    return tally


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SLURM campaign controller")
    sub = parser.add_subparsers(dest="command", required=True)

    dispatch_parser = sub.add_parser("dispatch", help="submit pending jobs as a SLURM array")
    dispatch_parser.add_argument("--limit", type=int, default=1,
                                 help="maximum jobs to submit in this array (default: 1)")
    dispatch_parser.add_argument("--max-in-flight", type=int,
                                 default=int(os.environ.get("WCECOLI_MAX_IN_FLIGHT", "800")),
                                 help="cap on simultaneously active tasks (klone limit is 2000)")

    sub.add_parser("reconcile", help="ingest sentinels and reconcile against the scheduler")
    sub.add_parser("status", help="show job status counts")
    sub.add_parser("verify-parca", help="check that the frozen Parca cache is complete")
    sub.add_parser("parca-id", help="print the content-addressed Parca cache directory name")

    tick_parser = sub.add_parser("tick", help="reconcile then dispatch (for scrontab)")
    tick_parser.add_argument("--limit", type=int, default=200)
    tick_parser.add_argument("--max-in-flight", type=int,
                             default=int(os.environ.get("WCECOLI_MAX_IN_FLIGHT", "800")))

    args = parser.parse_args(argv)
    resources = SlurmResources.from_env()

    if args.command == "parca-id":
        print(resolve_parca_run_id())
    elif args.command == "status":
        print(json.dumps(status(), indent=2, sort_keys=True))
    elif args.command == "verify-parca":
        parca_run_id = resolve_parca_run_id()
        print("Parca cache OK: {}".format(verify_parca(parca_run_id)))
    elif args.command == "reconcile":
        reconcile()
    elif args.command == "dispatch":
        resources.throttle = min(resources.throttle, args.limit)
        dispatch(args.limit, resources, max_in_flight=args.max_in_flight)
    elif args.command == "tick":
        reconcile()
        dispatch(args.limit, resources, max_in_flight=args.max_in_flight)
    return 0


if __name__ == "__main__":
    sys.exit(main())
