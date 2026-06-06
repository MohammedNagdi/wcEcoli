"""Batch experiment creation and deletion helpers."""

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.db.models import Experiment, Gene, SimulationJob, SimulationResult, Variant
from app.services.multi_gene_knockout import (
    MULTI_GENE_KNOCKOUT_TYPE,
    strip_multi_gene_targets,
    with_multi_gene_targets,
)
from app.services.timelines import infer_condition_from_timeline, resolve_timeline_definition


MAX_BATCH_RECORDS = 5000
DEFAULT_LENGTH_SEC = 10800

ACTIVE_EXPERIMENT_STATUSES = {"queued", "running", "running_parca", "running_sim", "ingesting"}
ACTIVE_JOB_STATUSES = {"pending", "running_parca", "running_sim", "ingesting"}


class BatchRecord(BaseModel):
    variant_index: int = 0
    gene_symbol: str = ""
    gene_symbols: list[str] = []
    timeline: str = ""
    seed: int
    generations: int
    sim_params: str = "{}"


class BatchRequest(BaseModel):
    name: str
    description: str = ""
    variant_type: str
    include_wildtype: bool = False
    records: list[BatchRecord]


class BatchResponse(BaseModel):
    batch_id: str
    created: int
    experiment_ids: list[int]
    skipped: int = 0
    skipped_genes: list[str] = []


def _parse_sim_params(raw: str) -> dict[str, Any]:
    if not raw or raw == "{}":
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid sim_params JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(400, "sim_params must be a JSON object")
    return parsed


def _canonical_sim_params(record: BatchRecord) -> str:
    params = _parse_sim_params(record.sim_params)
    length_sec = params.get("length_sec", DEFAULT_LENGTH_SEC)
    params.update({
        "seed": record.seed,
        "seeds": [record.seed],
        "generations": record.generations,
        "length_sec": length_sec,
    })
    return json.dumps(params, sort_keys=True)


def _record_base(
    session: Session,
    record: BatchRecord,
) -> tuple[str, str, str]:
    timeline = resolve_timeline_definition(session, record.timeline) if record.timeline else ""
    condition = infer_condition_from_timeline(session, timeline, "basal") if timeline else "basal"
    sim_params = _canonical_sim_params(record)
    return condition, timeline, sim_params


def _validate_batch_request(body: BatchRequest, session: Session) -> Variant:
    if not body.name.strip():
        raise HTTPException(400, "Batch name is required")
    if not body.variant_type.strip():
        raise HTTPException(400, "variant_type is required")
    if not body.records:
        raise HTTPException(400, "records must contain at least one item")
    if len(body.records) > MAX_BATCH_RECORDS:
        raise HTTPException(400, f"Batch too large: {len(body.records)} records (max {MAX_BATCH_RECORDS})")
    if body.include_wildtype and body.variant_type not in {"gene_knockout", MULTI_GENE_KNOCKOUT_TYPE}:
        raise HTTPException(400, "include_wildtype is only supported for gene knockout batches")

    variant = session.exec(select(Variant).where(Variant.name == body.variant_type)).first()
    if not variant:
        raise HTTPException(400, f"Unknown variant type: {body.variant_type}")

    for i, record in enumerate(body.records, start=1):
        if record.seed < 0:
            raise HTTPException(400, f"Record {i}: seed must be zero or greater")
        if record.generations < 1:
            raise HTTPException(400, f"Record {i}: generations must be at least 1")
        _parse_sim_params(record.sim_params)

    return variant


def _resolve_gene(session: Session, symbol: str) -> Gene:
    gene = session.exec(select(Gene).where(col(Gene.symbol).ilike(symbol))).first()
    if not gene:
        raise HTTPException(400, f"Unknown gene: {symbol}")
    if gene.ko_index < 1:
        raise HTTPException(400, f"Gene {gene.symbol} does not have a valid knockout index")
    return gene


def _find_or_create_batch_wildtype(
    session: Session,
    *,
    batch_id: str,
    batch_name: str,
    condition: str,
    timeline: str,
    sim_params: str,
    seed: int,
    now: str,
) -> int:
    existing = session.exec(
        select(Experiment).where(
            Experiment.batch_id == batch_id,
            Experiment.variant_type == "wildtype",
            Experiment.condition == condition,
            Experiment.timeline == timeline,
            Experiment.sim_params == sim_params,
        )
    ).first()
    if existing and existing.id is not None:
        return existing.id

    experiment = Experiment(
        name=f"Wildtype control seed {seed}",
        description=batch_name,
        variant_type="wildtype",
        variant_index=0,
        condition=condition,
        timeline=timeline,
        sim_params=sim_params,
        status="draft",
        created_at=now,
        updated_at=now,
        gene_symbol="",
        batch_id=batch_id,
    )
    session.add(experiment)
    session.flush()
    if experiment.id is None:
        raise HTTPException(500, "Failed to create wildtype experiment")
    return experiment.id


def create_typed_batch(body: BatchRequest, session: Session) -> BatchResponse:
    """Create a homogeneous typed batch as draft experiments."""
    _validate_batch_request(body, session)

    batch_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    batch_name = body.name.strip()
    created_ids: list[int] = []
    wildtype_keys: set[tuple[str, str, str, int]] = set()

    for record in body.records:
        condition, timeline, sim_params = _record_base(session, record)
        variant_index = record.variant_index
        gene_symbol = record.gene_symbol.strip()

        if body.variant_type == "gene_knockout" and gene_symbol:
            gene = _resolve_gene(session, gene_symbol)
            variant_index = gene.ko_index
            gene_symbol = gene.symbol
        elif body.variant_type == MULTI_GENE_KNOCKOUT_TYPE:
            sim_params, canonical_symbols, ko_indices = with_multi_gene_targets(
                sim_params,
                record.gene_symbols,
                session,
            )
            variant_index = 0
            gene_symbol = ",".join(canonical_symbols)

        if body.variant_type == MULTI_GENE_KNOCKOUT_TYPE:
            name = f"Multi-KO [{','.join(str(index) for index in ko_indices)}] seed {record.seed}"
        elif gene_symbol:
            name = f"KO {gene_symbol} seed {record.seed}"
        else:
            name = f"{body.variant_type}[{variant_index}] seed {record.seed}"

        experiment = Experiment(
            name=name,
            description=batch_name,
            variant_type=body.variant_type,
            variant_index=variant_index,
            condition=condition,
            timeline=timeline,
            sim_params=sim_params,
            status="draft",
            created_at=now,
            updated_at=now,
            gene_symbol=gene_symbol,
            batch_id=batch_id,
        )
        session.add(experiment)
        session.flush()
        if experiment.id is None:
            raise HTTPException(500, "Failed to create batch experiment")
        created_ids.append(experiment.id)

        if body.include_wildtype:
            wildtype_sim_params = (
                strip_multi_gene_targets(sim_params)
                if body.variant_type == MULTI_GENE_KNOCKOUT_TYPE
                else sim_params
            )
            wildtype_keys.add((condition, timeline, wildtype_sim_params, record.seed))

    for condition, timeline, sim_params, seed in sorted(wildtype_keys):
        wt_id = _find_or_create_batch_wildtype(
            session,
            batch_id=batch_id,
            batch_name=batch_name,
            condition=condition,
            timeline=timeline,
            sim_params=sim_params,
            seed=seed,
            now=now,
        )
        if wt_id not in created_ids:
            created_ids.append(wt_id)

    session.commit()

    return BatchResponse(
        batch_id=batch_id,
        created=len(created_ids),
        experiment_ids=created_ids,
        skipped=0,
        skipped_genes=[],
    )


def delete_batch(batch_id: str, session: Session) -> int:
    """Hard-delete a batch group after blocking active jobs/experiments."""
    experiments = session.exec(select(Experiment).where(Experiment.batch_id == batch_id)).all()
    if not experiments:
        raise HTTPException(404, f"Batch not found: {batch_id}")

    active_experiments = [exp for exp in experiments if exp.status in ACTIVE_EXPERIMENT_STATUSES]
    if active_experiments:
        raise HTTPException(409, "Cannot delete a batch with queued or running experiments")

    experiment_ids = [exp.id for exp in experiments if exp.id is not None]
    jobs = session.exec(
        select(SimulationJob).where(col(SimulationJob.experiment_id).in_(experiment_ids))
    ).all() if experiment_ids else []

    active_jobs = [job for job in jobs if job.status in ACTIVE_JOB_STATUSES]
    if active_jobs:
        raise HTTPException(409, "Cannot delete a batch with queued or running jobs")

    for job in jobs:
        results = session.exec(select(SimulationResult).where(SimulationResult.job_id == job.id)).all()
        for result in results:
            session.delete(result)
        session.delete(job)

    for experiment in experiments:
        session.delete(experiment)

    session.commit()
    return len(experiments)
