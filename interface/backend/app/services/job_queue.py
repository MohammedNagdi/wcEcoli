"""Shared simulation job queueing helpers."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session
from sqlmodel import select

from app.db.models import Experiment, SimulationJob
from app.services.timelines import infer_condition_from_timeline, resolve_timeline_definition


class RunResponse(BaseModel):
    job_ids: list[int]
    message: str


class RunJobRequest(BaseModel):
    condition: str = ""
    seeds: Optional[int | list[int]] = None
    seed_count: Optional[int] = None
    seed_values: Optional[list[int]] = None
    generations: Optional[int] = None


ACTIVE_JOB_STATUSES = {
    "pending", "claimed", "waiting_parca", "running_parca", "running_sim", "ingesting", "cancelling", "recovering"
}


def sync_experiment_status(session: Session, experiment_id: int) -> str:
    """Derive an experiment's state from all of its jobs."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        return ""
    jobs = session.exec(
        select(SimulationJob).where(SimulationJob.experiment_id == experiment_id)
    ).all()
    if not jobs:
        status = "draft"
    elif any(job.status in ACTIVE_JOB_STATUSES - {"pending"} for job in jobs):
        status = "running"
    elif any(job.status == "pending" for job in jobs):
        status = "queued"
    elif all(job.status == "done" for job in jobs):
        status = "done"
    elif all(job.status in {"done", "failed", "cancelled"} for job in jobs) and any(
        job.status == "failed" for job in jobs
    ):
        status = "failed"
    elif all(job.status in {"done", "cancelled"} for job in jobs):
        status = "cancelled"
    else:
        status = experiment.status
    experiment.status = status
    experiment.updated_at = datetime.now(timezone.utc).isoformat()
    session.add(experiment)
    return status


def create_simulation_jobs_for_experiment(
    experiment: Experiment,
    body: RunJobRequest,
    session: Session,
) -> RunResponse:
    """Submit an experiment for simulation.

    Creates one SimulationJob per seed specified in the experiment's
    sim_params. Each job runs independently through Parca -> Sim -> Ingest.
    """
    if experiment.status == "running":
        raise HTTPException(409, "Experiment already has running jobs")

    try:
        params = json.loads(experiment.sim_params) if experiment.sim_params else {}
    except json.JSONDecodeError:
        params = {}

    if body.seed_values is not None:
        seed_values = [int(seed) for seed in body.seed_values]
    else:
        seed_spec = body.seed_count if body.seed_count is not None else body.seeds
        if seed_spec is None:
            seed_spec = params.get("seed_values", params.get("seeds", 1))
        if isinstance(seed_spec, list):
            seed_values = [int(seed) for seed in seed_spec]
        else:
            seed_values = list(range(int(seed_spec)))
    generations = body.generations if body.generations is not None else params.get("generations", 1)
    timeline = resolve_timeline_definition(session, experiment.timeline) if experiment.timeline else ""
    condition = body.condition or experiment.condition or "basal"
    if timeline:
        condition = infer_condition_from_timeline(session, timeline, condition)
    now = datetime.now(timezone.utc).isoformat()

    job_ids = []
    for seed in seed_values:
        job = SimulationJob(
            experiment_id=experiment.id,
            status="pending",
            phase="Queued",
            created_at=now,
            variant_type=experiment.variant_type,
            variant_index=experiment.variant_index,
            condition=condition,
            seed=seed,
            generations=generations,
            timeline=timeline,
        )
        session.add(job)
        session.flush()
        job_ids.append(job.id)

    experiment.status = "queued"
    experiment.updated_at = now
    session.add(experiment)
    session.commit()

    return RunResponse(
        job_ids=job_ids,
        message=f"Queued {len(job_ids)} simulation job(s)",
    )
