"""Simulation job management API endpoints."""

from collections import deque
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.db.models import Experiment, SimulationJob, SimulationResult
from app.config import settings
from app.main import get_session
from app.services.job_queue import sync_experiment_status
from app.services.sim_runner_client import RunnerClient, RunnerError

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
    runner_task_id: str = ""
    worker_id: str = ""
    heartbeat_at: str = ""
    lease_expires_at: str = ""
    attempt: int = 0


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

    If the job has a runner task, stop only that subprocess.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    if job.status in ("done", "failed", "cancelled"):
        raise HTTPException(409, f"Job is already {job.status}")

    now = datetime.now(timezone.utc).isoformat()
    if job.status == "pending":
        job.status = "cancelled"
        job.phase = "Cancelled"
        job.error_message = "Cancelled by user"
        job.finished_at = now
        job.lease_expires_at = ""
        session.add(job)
        sync_experiment_status(session, job.experiment_id)
        session.commit()
        return

    job.status = "cancelling"
    job.phase = "Cancellation requested"
    job.error_message = "Cancelled by user"
    session.add(job)
    sync_experiment_status(session, job.experiment_id)
    session.commit()

    if job.runner_task_id:
        try:
            RunnerClient(settings.sim_runner_socket).cancel(job.runner_task_id)
        except RunnerError as exc:
            # Durable cancelling state is reconciled by the worker; retaining
            # runner_task_id prevents an untracked subprocess from continuing.
            job.phase = "Cancellation pending runner reconnection"
            job.error_message = "Cancelled by user; runner cancellation pending: " + str(exc)
            session.add(job)
            session.commit()


# POST /api/jobs/{id}/retry

@router.post("/jobs/{job_id}/retry", response_model=JobOut)
def retry_job(job_id: int, session: Session = Depends(get_session)):
    """Retry a failed job by resetting it to pending.

    Clears the error state and log tail so the worker picks it up again.
    Failed and cancelled jobs can be retried.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    if job.status not in {"failed", "cancelled"}:
        raise HTTPException(409, f"Can only retry failed or cancelled jobs (current: {job.status})")

    job.status = "pending"
    job.phase = "Queued (retry)"
    job.error_message = ""
    job.log_tail = ""
    job.started_at = ""
    job.finished_at = ""
    job.sim_dir = ""
    job.runner_task_id = ""
    job.worker_id = ""
    job.heartbeat_at = ""
    job.lease_expires_at = ""
    session.add(job)
    sync_experiment_status(session, job.experiment_id)
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

    if job.status not in ("failed", "cancelled"):
        raise HTTPException(
            409, f"Can only delete failed or cancelled jobs (current: {job.status}). Cancel it first."
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
    from app.services.sim_worker import _collect_results

    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    if not job.sim_dir:
        raise HTTPException(400, "Job has no simulation directory")
    experiment = session.get(Experiment, job.experiment_id)
    if not experiment:
        raise HTTPException(404, "Job experiment not found")

    try:
        new_results = _collect_results(job, experiment, deque(maxlen=settings.log_tail_lines))
    except Exception as exc:
        raise HTTPException(422, "Output validation failed: " + str(exc)) from exc

    # Replace only after all output has been validated and parsed.
    old_results = session.exec(
        select(SimulationResult).where(SimulationResult.job_id == job_id)
    ).all()
    for r in old_results:
        session.delete(r)
    for result in new_results:
        session.add(result)

    session.commit()
    return [JobResultOut.model_validate(r, from_attributes=True) for r in new_results]
