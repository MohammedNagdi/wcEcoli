"""Simulation job management API endpoints."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.db.models import Experiment, SimulationJob, SimulationResult
from app.main import get_session
from app.services.job_queue import RunJobRequest, RunResponse, create_simulation_jobs_for_experiment

router = APIRouter(prefix="/api", tags=["jobs"])


# Response models

class JobOut(BaseModel):
    id: int
    experiment_id: int
    status: str
    phase: str
    sim_dir: str
    log_tail: str
    started_at: str
    finished_at: str
    error_message: str
    created_at: str
    variant_type: str
    variant_index: int
    condition: str
    seed: int
    generations: int
    timeline: str


class JobResultOut(BaseModel):
    id: int
    job_id: int
    experiment_id: int
    seed: int
    generation: int
    division_time_sec: Optional[float]
    final_mass_fg: Optional[float]
    growth_rate: Optional[float]
    doubling_time_min: Optional[float]
    divided: bool = True
    created_at: str

# GET /api/jobs

@router.get("/jobs", response_model=list[JobOut])
def list_jobs(
    experiment_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    session: Session = Depends(get_session),
):
    """List simulation jobs, optionally filtered by experiment or status."""
    stmt = select(SimulationJob).order_by(col(SimulationJob.id).desc())
    if experiment_id is not None:
        stmt = stmt.where(SimulationJob.experiment_id == experiment_id)
    if status:
        stmt = stmt.where(SimulationJob.status == status)
    jobs = session.exec(stmt).all()
    return [JobOut.model_validate(j, from_attributes=True) for j in jobs]


# GET /api/jobs/failed

class FailedJobSummary(BaseModel):
    id: int
    experiment_id: int
    experiment_name: str
    gene_symbol: str
    variant_type: str
    variant_index: int
    condition: str
    seed: int
    phase: str
    error_message: str
    started_at: str
    finished_at: str
    created_at: str


@router.get("/jobs/failed", response_model=list[FailedJobSummary])
def list_failed_jobs(session: Session = Depends(get_session)):
    """List all failed jobs with structured error info for triage."""
    jobs = session.exec(
        select(SimulationJob)
        .where(SimulationJob.status == "failed")
        .order_by(col(SimulationJob.finished_at).desc())
    ).all()

    results = []
    for job in jobs:
        experiment = session.get(Experiment, job.experiment_id)
        results.append(FailedJobSummary(
            id=job.id,
            experiment_id=job.experiment_id,
            experiment_name=experiment.name if experiment else f"Experiment #{job.experiment_id}",
            gene_symbol=experiment.gene_symbol if experiment else "",
            variant_type=job.variant_type,
            variant_index=job.variant_index,
            condition=job.condition,
            seed=job.seed,
            phase=job.phase,
            error_message=job.error_message,
            started_at=job.started_at,
            finished_at=job.finished_at,
            created_at=job.created_at,
        ))
    return results


# GET /api/jobs/{id}

@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: int, session: Session = Depends(get_session)):
    """Get a single job with its current status and log tail."""
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return JobOut.model_validate(job, from_attributes=True)


# GET /api/jobs/{id}/results

@router.get("/jobs/{job_id}/results", response_model=list[JobResultOut])
def get_job_results(job_id: int, session: Session = Depends(get_session)):
    """Get summary metrics from a completed simulation job."""
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    results = session.exec(
        select(SimulationResult)
        .where(SimulationResult.job_id == job_id)
        .order_by(SimulationResult.seed, SimulationResult.generation)
    ).all()
    return [JobResultOut.model_validate(r, from_attributes=True) for r in results]


# DELETE /api/jobs/{id}

@router.delete("/jobs/{job_id}", status_code=204)
def cancel_job(job_id: int, session: Session = Depends(get_session)):
    """Cancel a running or pending job.

    If the job has a Docker container, attempts to stop it. Otherwise
    just marks the job as failed with a cancellation message.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    if job.status in ("done", "failed"):
        raise HTTPException(409, f"Job is already {job.status}")

    # Try to stop Docker container if running
    if job.docker_container_id:
        import subprocess
        try:
            subprocess.run(
                ["docker", "stop", job.docker_container_id],
                timeout=10,
                capture_output=True,
            )
        except Exception:
            pass  # best effort

    job.status = "failed"
    job.phase = "Cancelled"
    job.error_message = "Cancelled by user"
    job.finished_at = datetime.now(timezone.utc).isoformat()
    session.add(job)
    session.commit()


# POST /api/jobs/{id}/retry

@router.post("/jobs/{job_id}/retry", response_model=JobOut)
def retry_job(job_id: int, session: Session = Depends(get_session)):
    """Retry a failed job by resetting it to pending.

    Clears the error state and log tail so the worker picks it up again.
    Only jobs in 'failed' status can be retried.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    if job.status != "failed":
        raise HTTPException(409, f"Can only retry failed jobs (current: {job.status})")

    job.status = "pending"
    job.phase = "Queued (retry)"
    job.error_message = ""
    job.log_tail = ""
    job.started_at = ""
    job.finished_at = ""
    job.sim_dir = ""
    session.add(job)

    # Also reset parent experiment to queued so it's tracked correctly
    experiment = session.get(Experiment, job.experiment_id)
    if experiment and experiment.status == "failed":
        experiment.status = "queued"
        experiment.updated_at = datetime.now(timezone.utc).isoformat()
        session.add(experiment)

    session.commit()
    return JobOut.model_validate(job, from_attributes=True)


# DELETE /api/jobs/{id}/permanent

@router.delete("/jobs/{job_id}/permanent", status_code=204)
def delete_job_permanent(job_id: int, session: Session = Depends(get_session)):
    """Permanently delete a failed or cancelled job and its results.

    Only jobs in 'failed' status can be permanently deleted.
    Running or pending jobs must be cancelled first.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    if job.status not in ("failed",):
        raise HTTPException(
            409, f"Can only delete failed jobs (current: {job.status}). Cancel it first."
        )

    # Delete associated results
    results = session.exec(
        select(SimulationResult).where(SimulationResult.job_id == job_id)
    ).all()
    for r in results:
        session.delete(r)

    session.delete(job)
    session.commit()


# POST /api/jobs/{id}/reingest

@router.post("/jobs/{job_id}/reingest", response_model=list[JobResultOut])
def reingest_job(job_id: int, session: Session = Depends(get_session)):
    """Re-ingest results from a completed job's simOut directory.

    Deletes existing SimulationResult rows and re-extracts summary
    stats using the latest TableReader bridge code. Useful after
    fixing extraction bugs without re-running the simulation.
    """
    from app.config import settings
    from app.services.table_reader_bridge import SimOutReader, find_sim_outs, parse_sim_out_path

    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    if not job.sim_dir:
        raise HTTPException(400, "Job has no simulation directory")

    sim_out_base = settings.sim_output_dir / job.sim_dir
    sim_outs = find_sim_outs(sim_out_base)
    if not sim_outs:
        raise HTTPException(404, f"No simOut directories found in {sim_out_base}")

    # Delete old results
    old_results = session.exec(
        select(SimulationResult).where(SimulationResult.job_id == job_id)
    ).all()
    for r in old_results:
        session.delete(r)
    session.flush()

    # Re-ingest
    now = datetime.now(timezone.utc).isoformat()
    new_results = []
    for sim_out_path in sim_outs:
        path_info = parse_sim_out_path(sim_out_path)
        try:
            reader = SimOutReader(sim_out_path)
            summary = reader.extract_summary()
        except Exception:
            summary = {
                "division_time_sec": None,
                "final_mass_fg": None,
                "growth_rate": None,
                "doubling_time_min": None,
                "divided": False,
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
            divided=summary.get("divided", False),
            created_at=now,
        )
        session.add(result)
        new_results.append(result)

    session.commit()
    return [JobResultOut.model_validate(r, from_attributes=True) for r in new_results]
