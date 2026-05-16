"""
Simulation worker — polls simulation_jobs table and executes Docker commands.

Run as a standalone process:
    python -m app.services.sim_worker

The worker picks up the oldest 'pending' job, runs Parca (if needed) then
runSim inside the wcEcoli Docker container, captures log output, and updates
the job status through its lifecycle:

    pending → running_parca → running_sim → ingesting → done
                                                      ↘ failed
"""

import json
import logging
import signal
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session, col, create_engine, select

from app.config import settings
from app.db.models import Experiment, SimulationJob, SimulationResult, Timeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sim_worker")

# ── Globals ──────────────────────────────────────────────────────────────────

_shutdown = False


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
    label = experiment.gene_symbol or experiment.variant_type
    return ts + "_" + label + "_job" + str(job.id)


def _run_docker(
    args: list[str],
    sim_dir: str,
    log_buffer: deque,
    phase_label: str,
) -> subprocess.CompletedProcess:
    """Run a command inside the wcEcoli Docker container."""
    import os
    output_volume = os.environ.get("SIM_OUTPUT_VOLUME", "interface_sim-output")

    docker_cmd = [
        "docker", "run", "--rm",
        "-v", output_volume + ":/wcEcoli/out:rw",
        "-e", "PYTHONPATH=/wcEcoli",
        "-w", "/wcEcoli",
        settings.docker_image,
    ] + args

    logger.info("[%s] %s", phase_label, " ".join(docker_cmd))
    log_buffer.append("--- " + phase_label + " ---")
    log_buffer.append("$ " + " ".join(args))

    proc = subprocess.Popen(
        docker_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    for line in proc.stdout:
        line = line.rstrip("\n")
        log_buffer.append(line)
        logger.info("[%s] %s", phase_label, line)

    proc.wait()
    log_buffer.append("--- " + phase_label + " exited with code " + str(proc.returncode) + " ---")
    return subprocess.CompletedProcess(docker_cmd, proc.returncode)


def _parca_cached(sim_dir: str) -> bool:
    """Check if Parca output already exists for this run directory."""
    kb_path = settings.sim_output_dir / sim_dir / "kb" / "simData.cPickle"
    return kb_path.exists()


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

def execute_job(engine, job_id: int):
    """Execute a single simulation job through the full pipeline."""
    log_buffer: deque[str] = deque(maxlen=settings.log_tail_lines)

    with Session(engine) as session:
        job = session.get(SimulationJob, job_id)
        experiment = session.get(Experiment, job.experiment_id)
        if not job or not experiment:
            logger.error("Job %d or its experiment not found", job_id)
            return

        # Build run directory name
        run_id = _make_run_id(job, experiment)
        job.sim_dir = run_id
        job.started_at = _now()

        # Update experiment status to running
        experiment.status = "running"
        experiment.updated_at = _now()
        session.add(experiment)

        # Phase 1: Parca
        job.status = "running_parca"
        job.phase = "Running parameter calculator (Parca)..."
        job.log_tail = "\n".join(log_buffer)
        session.add(job)
        session.commit()

        if _parca_cached(run_id):
            log_buffer.append("Parca output cached — skipping")
            logger.info("Job %d: Parca cached, skipping", job_id)
        else:
            result = _run_docker(
                ["python", "runscripts/manual/runParca.py", run_id],
                run_id,
                log_buffer,
                "parca",
            )
            if result.returncode != 0:
                _fail_job(session, job, log_buffer, "Parca failed")
                return

        # Phase 2: Simulation
        job.status = "running_sim"
        job.phase = "Running simulation (seed=" + str(job.seed) + ", gen=" + str(job.generations) + ")..."
        job.log_tail = "\n".join(log_buffer)
        session.add(job)
        session.commit()

        sim_args = [
            "python", "runscripts/manual/runSim.py", run_id,
            "--variant", job.variant_type, str(job.variant_index), str(job.variant_index),
            "--seed", str(job.seed),
            "--generations", str(job.generations),
        ]
        if job.timeline:
            # Explicit timeline takes precedence over condition.
            # The --timeline CLI flag expects the raw events string
            # (e.g. "0 minimal, 1200 minimal_plus_amino_acids"), not
            # the timeline name (e.g. "000002_add_aa").  Resolve via DB.
            timeline_events = _resolve_timeline(session, job.timeline)
            sim_args.extend(["--timeline", timeline_events])
        elif job.condition and job.condition != "basal":
            # Non-basal condition with no explicit timeline: convert
            # the condition to a single-step timeline so the simulation
            # uses the correct nutrient environment.
            condition_timeline = _resolve_condition_timeline(session, job.condition)
            sim_args.extend(["--timeline", condition_timeline])
            log_buffer.append("Condition '" + job.condition + "' → timeline: " + condition_timeline)

        result = _run_docker(sim_args, run_id, log_buffer, "sim")
        if result.returncode != 0:
            _fail_job(session, job, log_buffer, "Simulation failed")
            return

        # Phase 3: Ingest results
        job.status = "ingesting"
        job.phase = "Ingesting simulation results..."
        job.log_tail = "\n".join(log_buffer)
        session.add(job)
        session.commit()

        try:
            _ingest_results(session, job, experiment, log_buffer)
        except Exception as exc:
            _fail_job(session, job, log_buffer, "Ingestion error: " + str(exc))
            return

        # Done
        job.status = "done"
        job.phase = "Complete"
        job.finished_at = _now()
        job.log_tail = "\n".join(log_buffer)
        session.add(job)

        # Update experiment status
        experiment.status = "done"
        experiment.updated_at = _now()
        session.add(experiment)
        session.commit()

        logger.info("Job %d completed successfully — %s", job_id, run_id)


def _fail_job(session: Session, job: SimulationJob, log_buffer: deque, message: str):
    """Mark a job as failed and persist the error."""
    logger.error("Job %d failed: %s", job.id, message)
    job.status = "failed"
    job.phase = "Failed"
    job.error_message = message
    job.finished_at = _now()
    job.log_tail = "\n".join(log_buffer)
    session.add(job)

    # Reset experiment status so the user can re-run
    experiment = session.get(Experiment, job.experiment_id)
    if experiment:
        experiment.status = "failed"
        experiment.updated_at = _now()
        session.add(experiment)

    session.commit()


def _ingest_results(
    session: Session,
    job: SimulationJob,
    experiment: Experiment,
    log_buffer: deque,
):
    """Parse simOut directories using TableReader and write summary + Parquet."""
    from app.services.table_reader_bridge import SimOutReader, find_sim_outs, parse_sim_out_path

    sim_out_base = settings.sim_output_dir / job.sim_dir
    sim_outs = find_sim_outs(sim_out_base)
    log_buffer.append("Found " + str(len(sim_outs)) + " simOut directories")

    if not sim_outs:
        log_buffer.append("WARNING: No simOut directories found — creating placeholder result")
        result = SimulationResult(
            job_id=job.id,
            experiment_id=job.experiment_id,
            seed=job.seed,
            generation=0,
            created_at=_now(),
        )
        session.add(result)
        session.commit()
        return

    for sim_out_path in sim_outs:
        path_info = parse_sim_out_path(sim_out_path)
        log_buffer.append(
            "Ingesting: seed=" + str(path_info['seed']) + ", gen=" + str(path_info['generation'])
            + ", variant=" + str(path_info['variant_dir'])
        )

        try:
            reader = SimOutReader(sim_out_path)
            summary = reader.extract_summary()
            if summary['final_mass_fg']:
                log_buffer.append(
                    "  Mass: %.1f fg, div time: %.0fs, growth rate: %.4f" % (
                        summary['final_mass_fg'],
                        summary['division_time_sec'],
                        summary['growth_rate'],
                    )
                )
            else:
                log_buffer.append("  (no mass data)")
        except Exception as exc:
            log_buffer.append("  WARNING: TableReader failed: " + str(exc))
            summary = {
                "division_time_sec": None,
                "final_mass_fg": None,
                "growth_rate": None,
                "doubling_time_min": None,
            }

        result = SimulationResult(
            job_id=job.id,
            experiment_id=job.experiment_id,
            seed=path_info.get("seed", job.seed),
            generation=path_info.get("generation", 0),
            division_time_sec=summary["division_time_sec"],
            final_mass_fg=summary["final_mass_fg"],
            growth_rate=summary["growth_rate"],
            doubling_time_min=summary["doubling_time_min"],
            created_at=_now(),
        )
        session.add(result)

        # Export Parquet for HuggingFace (best effort)
        try:
            export_dir = sim_out_base / "export"
            parquet_path = export_dir / (
                "timeseries_seed" + str(path_info['seed'])
                + "_gen" + str(path_info['generation']) + ".parquet"
            )
            reader.export_parquet(parquet_path)
            log_buffer.append("  Exported: " + parquet_path.name)
        except Exception as exc:
            log_buffer.append("  Parquet export skipped: " + str(exc))

    session.commit()
    log_buffer.append("Ingested " + str(len(sim_outs)) + " result(s)")


# Worker loop

def _repair_stale_statuses(engine):
    """One-time startup repair: fix jobs and experiments stuck in active
    states from a prior crash or unclean shutdown."""
    with Session(engine) as session:
        # 1. Reset orphaned jobs (stuck in active state) back to pending
        active_statuses = ["running_parca", "running_sim", "ingesting"]
        stuck_jobs = session.exec(
            select(SimulationJob).where(
                col(SimulationJob.status).in_(active_statuses)
            )
        ).all()
        for job in stuck_jobs:
            logger.info("Resetting stuck job %d (%s → pending)", job.id, job.status)
            job.status = "pending"
            job.phase = "Reset after worker restart"
            job.started_at = ""
            job.log_tail = ""
            session.add(job)
        if stuck_jobs:
            session.commit()
            logger.info("Reset %d stuck job(s) to pending", len(stuck_jobs))

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
            elif all(j.status in ("done", "failed") for j in jobs):
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


def poll_loop():
    """Main worker loop — poll for pending jobs and execute them."""
    engine = create_engine("sqlite:///" + str(settings.database_path), echo=False)
    logger.info("Simulation worker started — polling every %ds", settings.worker_poll_interval)
    logger.info("Database: %s", settings.database_path)
    logger.info("Docker image: %s", settings.docker_image)
    logger.info("Output directory: %s", settings.sim_output_dir)

    # Fix any experiments stuck in stale states from prior crashes
    _repair_stale_statuses(engine)

    while not _shutdown:
        try:
            with Session(engine) as session:
                job = session.exec(
                    select(SimulationJob)
                    .where(SimulationJob.status == "pending")
                    .order_by(col(SimulationJob.id).asc())
                    .limit(1)
                ).first()

            if job:
                logger.info("Picked up job %d (experiment %d)", job.id, job.experiment_id)
                execute_job(engine, job.id)
            else:
                time.sleep(settings.worker_poll_interval)

        except Exception:
            logger.exception("Worker loop error")
            time.sleep(settings.worker_poll_interval)

    logger.info("Worker shut down cleanly")


if __name__ == "__main__":
    poll_loop()
