"""Shared simulation job queueing helpers."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.db.models import Experiment, SimulationJob
from app.services.timelines import infer_condition_from_timeline, resolve_timeline_definition


class RunResponse(BaseModel):
    job_ids: list[int]
    message: str


class RunJobRequest(BaseModel):
    condition: str = ""
    seeds: Optional[int | list[int]] = None
    generations: Optional[int] = None


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

    seed_spec = body.seeds if body.seeds is not None else params.get("seeds", 1)
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
