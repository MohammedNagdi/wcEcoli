"""Experiment configuration API endpoints."""

import logging
import math
import statistics
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.db.models import Experiment, Gene, SimulationJob, SimulationResult, Variant
from app.main import get_session
from app.routers.jobs import (
    RunJobRequest,
    RunResponse,
    create_simulation_jobs_for_experiment,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/experiments", tags=["experiments"])


# --- Request / response models ---

class ExperimentCreate(BaseModel):
    name: str
    description: str = ""
    variant_type: str
    variant_index: int = 0
    condition: str = "basal"
    timeline: str = ""
    sim_params: str = "{}"
    gene_symbol: str = ""


class ExperimentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    variant_type: Optional[str] = None
    variant_index: Optional[int] = None
    condition: Optional[str] = None
    timeline: Optional[str] = None
    sim_params: Optional[str] = None
    status: Optional[str] = None
    gene_symbol: Optional[str] = None


class ExperimentOut(BaseModel):
    id: int
    name: str
    description: str
    variant_type: str
    variant_index: int
    condition: str
    timeline: str
    sim_params: str
    status: str
    created_at: str
    updated_at: str
    gene_symbol: str


class VariantDetailOut(BaseModel):
    name: str
    docstring: str
    filename: str
    parameter_count: Optional[int]
    parameter_hints: dict  # UI hints for the variant's parameters


# --- Variant detail with parameter hints ---

VARIANT_PARAM_HINTS: dict[str, dict] = {
    "gene_knockout": {
        "index_meaning": "Gene index (0 = control, 1-4749 = individual gene KO)",
        "index_range": [0, 4749],
        "supports_gene_lookup": True,
    },
    "condition": {
        "index_meaning": "Condition index (maps to condition_defs.tsv row)",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
    },
    "timelines": {
        "index_meaning": "Timeline index (maps to timelines_def.tsv row)",
        "index_range": [0, 30],
        "supports_gene_lookup": False,
    },
    "wildtype": {
        "index_meaning": "Always 0 (no modifications)",
        "index_range": [0, 0],
        "supports_gene_lookup": False,
    },
    "ppgpp_conc": {
        "index_meaning": "ppGpp concentration index",
        "index_range": [0, 50],
        "supports_gene_lookup": False,
    },
    "add_one_aa": {
        "index_meaning": "Amino acid index (0-20, maps to standard AAs)",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
    },
    "remove_one_aa": {
        "index_meaning": "Amino acid index to remove",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
    },
}


@router.get("/variants/{name}", response_model=VariantDetailOut)
def get_variant_detail(name: str, session: Session = Depends(get_session)):
    """Get variant detail with parameter hints for the experiment designer."""
    variant = session.exec(select(Variant).where(Variant.name == name)).first()
    if not variant:
        variant = session.exec(
            select(Variant).where(col(Variant.name).ilike(name))
        ).first()
    if not variant:
        raise HTTPException(404, f"Variant '{name}' not found")

    hints = VARIANT_PARAM_HINTS.get(variant.name, {
        "index_meaning": "Variant-specific parameter index",
        "supports_gene_lookup": False,
    })

    return VariantDetailOut(
        name=variant.name,
        docstring=variant.docstring,
        filename=variant.filename,
        parameter_count=variant.parameter_count,
        parameter_hints=hints,
    )


# --- Experiment CRUD ---

@router.get("", response_model=list[ExperimentOut])
def list_experiments(
    status: Optional[str] = Query(None),
    session: Session = Depends(get_session),
):
    """List all saved experiments, optionally filtered by status."""
    stmt = select(Experiment).order_by(col(Experiment.id).desc())
    if status:
        stmt = stmt.where(Experiment.status == status)
    experiments = session.exec(stmt).all()
    return [ExperimentOut.model_validate(e, from_attributes=True) for e in experiments]


@router.post("", response_model=ExperimentOut, status_code=201)
def create_experiment(
    body: ExperimentCreate,
    session: Session = Depends(get_session),
):
    """Create a new experiment configuration."""
    now = datetime.now(timezone.utc).isoformat()

    variant = session.exec(
        select(Variant).where(Variant.name == body.variant_type)
    ).first()
    if not variant:
        raise HTTPException(400, f"Unknown variant type: {body.variant_type}")

    if body.variant_type == "gene_knockout" and body.gene_symbol:
        gene = session.exec(
            select(Gene).where(col(Gene.symbol).ilike(body.gene_symbol))
        ).first()
        if not gene:
            raise HTTPException(400, f"Unknown gene: {body.gene_symbol}")
        body.variant_index = gene.ko_index

    experiment = Experiment(
        name=body.name,
        description=body.description,
        variant_type=body.variant_type,
        variant_index=body.variant_index,
        condition=body.condition,
        timeline=body.timeline,
        sim_params=body.sim_params,
        status="draft",
        created_at=now,
        updated_at=now,
        gene_symbol=body.gene_symbol,
    )
    session.add(experiment)
    session.commit()
    session.refresh(experiment)
    return ExperimentOut.model_validate(experiment, from_attributes=True)


@router.get("/{experiment_id}", response_model=ExperimentOut)
def get_experiment(experiment_id: int, session: Session = Depends(get_session)):
    """Get a single experiment by ID."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, f"Experiment {experiment_id} not found")
    return ExperimentOut.model_validate(experiment, from_attributes=True)


@router.patch("/{experiment_id}", response_model=ExperimentOut)
def update_experiment(
    experiment_id: int,
    body: ExperimentUpdate,
    session: Session = Depends(get_session),
):
    """Update an experiment configuration."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, f"Experiment {experiment_id} not found")

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(experiment, key, value)
    experiment.updated_at = datetime.now(timezone.utc).isoformat()

    session.add(experiment)
    session.commit()
    session.refresh(experiment)
    return ExperimentOut.model_validate(experiment, from_attributes=True)


@router.delete("/{experiment_id}", status_code=204)
def delete_experiment(experiment_id: int, session: Session = Depends(get_session)):
    """Delete an experiment configuration."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, f"Experiment {experiment_id} not found")
    session.delete(experiment)
    session.commit()


# --- Experiment run submission ---

@router.post("/{experiment_id}/run", response_model=RunResponse)
def run_experiment(
    experiment_id: int,
    body: RunJobRequest | None = None,
    session: Session = Depends(get_session),
):
    """Submit an experiment for simulation."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, f"Experiment {experiment_id} not found")

    request = body or RunJobRequest(condition=experiment.condition or "basal")
    if not request.condition:
        request.condition = experiment.condition or "basal"

    return create_simulation_jobs_for_experiment(experiment, request, session)


# --- Experiment-level aggregation ---

class AggregatedMetric(BaseModel):
    """A single metric aggregated across seeds."""
    mean: Optional[float]
    std: Optional[float]
    ci_lower: Optional[float]
    ci_upper: Optional[float]
    n: int
    values: list[Optional[float]]


class SeedJobSummary(BaseModel):
    """Summary for one seed/job within the experiment."""
    job_id: int
    seed: int
    status: str
    division_time_sec: Optional[float]
    final_mass_fg: Optional[float]
    growth_rate: Optional[float]
    doubling_time_min: Optional[float]


class ExperimentAggregation(BaseModel):
    """Experiment-level aggregated results across all seeds."""
    experiment_id: int
    experiment_name: str
    variant_type: str
    variant_index: int
    condition: str
    gene_symbol: str
    total_seeds: int
    completed_seeds: int
    failed_seeds: int
    division_rate: str
    division_time: AggregatedMetric
    final_mass: AggregatedMetric
    growth_rate: AggregatedMetric
    doubling_time: AggregatedMetric
    seeds: list[SeedJobSummary]


def _aggregate(values: list[Optional[float]]) -> AggregatedMetric:
    """Compute mean, std, and 95% CI from a list of possibly-null values."""
    clean = [v for v in values if v is not None]
    n = len(clean)
    if n == 0:
        return AggregatedMetric(
            mean=None,
            std=None,
            ci_lower=None,
            ci_upper=None,
            n=0,
            values=values,
        )
    mean = statistics.mean(clean)
    if n == 1:
        return AggregatedMetric(
            mean=mean,
            std=None,
            ci_lower=None,
            ci_upper=None,
            n=1,
            values=values,
        )
    std = statistics.stdev(clean)
    margin = 1.96 * std / math.sqrt(n)
    return AggregatedMetric(
        mean=round(mean, 4),
        std=round(std, 4),
        ci_lower=round(mean - margin, 4),
        ci_upper=round(mean + margin, 4),
        n=n,
        values=values,
    )


@router.get("/{experiment_id}/results", response_model=ExperimentAggregation)
def get_experiment_results(experiment_id: int, session: Session = Depends(get_session)):
    """Get aggregated results for an experiment across all seeds."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, f"Experiment {experiment_id} not found")

    jobs = session.exec(
        select(SimulationJob)
        .where(SimulationJob.experiment_id == experiment_id)
        .order_by(SimulationJob.seed)
    ).all()
    if not jobs:
        raise HTTPException(404, f"No jobs found for experiment {experiment_id}")

    completed = [j for j in jobs if j.status == "done"]
    failed = [j for j in jobs if j.status == "failed"]

    seed_summaries: list[SeedJobSummary] = []
    div_times: list[Optional[float]] = []
    masses: list[Optional[float]] = []
    growth_rates: list[Optional[float]] = []
    doubling_times: list[Optional[float]] = []

    for job in jobs:
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .order_by(SimulationResult.generation)
            .limit(1)
        ).first()

        div_t = result.division_time_sec if result else None
        mass = result.final_mass_fg if result else None
        gr = result.growth_rate if result else None
        dt = result.doubling_time_min if result else None

        seed_summaries.append(SeedJobSummary(
            job_id=job.id,
            seed=job.seed,
            status=job.status,
            division_time_sec=div_t,
            final_mass_fg=mass,
            growth_rate=gr,
            doubling_time_min=dt,
        ))

        if job.status == "done":
            div_times.append(div_t)
            masses.append(mass)
            growth_rates.append(gr)
            doubling_times.append(dt)

    divided = sum(1 for d in div_times if d is not None)
    division_rate = f"{divided}/{len(completed)} seeds divided"

    return ExperimentAggregation(
        experiment_id=experiment.id,
        experiment_name=experiment.name,
        variant_type=experiment.variant_type,
        variant_index=experiment.variant_index,
        condition=experiment.condition,
        gene_symbol=experiment.gene_symbol,
        total_seeds=len(jobs),
        completed_seeds=len(completed),
        failed_seeds=len(failed),
        division_rate=division_rate,
        division_time=_aggregate(div_times),
        final_mass=_aggregate(masses),
        growth_rate=_aggregate(growth_rates),
        doubling_time=_aggregate(doubling_times),
        seeds=seed_summaries,
    )


# --- Batch experiment creation ---

class BatchExperimentItem(BaseModel):
    """Single item in a batch creation request."""
    name: str = ""
    description: str = ""
    variant_type: str = "gene_knockout"
    variant_index: int = 0
    condition: str = "basal"
    timeline: str = ""
    sim_params: str = "{}"
    gene_symbol: str = ""


class BatchRequest(BaseModel):
    """Batch experiment creation request.

    Two modes:
    1. Explicit list: provide experiments with individual specs.
    2. Screen shorthand: set screen to a preset name.
       - all_mechanistic: one experiment per mechanistic gene.
       - gene_knockout_all: one experiment per mechanistic gene.
       - gene_knockout_category:<cat>: KO all genes in a category.
    """
    experiments: list[BatchExperimentItem] = []
    screen: str = ""
    condition: str = "basal"
    timeline: str = ""
    sim_params: str = "{}"
    description: str = ""


class BatchResponse(BaseModel):
    created: int
    experiment_ids: list[int]
    skipped: int = 0
    skipped_genes: list[str] = []


@router.post("/batch", response_model=BatchResponse, status_code=201)
def create_batch_experiments(
    body: BatchRequest,
    session: Session = Depends(get_session),
):
    """Create multiple experiments in one request."""
    items: list[BatchExperimentItem] = []

    if body.screen:
        items = _expand_screen(body, session)
    elif body.experiments:
        items = body.experiments
    else:
        raise HTTPException(400, "Provide either 'experiments' list or 'screen' name")

    if len(items) > 5000:
        raise HTTPException(400, f"Batch too large: {len(items)} items (max 5000)")

    variant_cache: dict[str, Variant] = {}
    for item in items:
        if item.variant_type not in variant_cache:
            v = session.exec(
                select(Variant).where(Variant.name == item.variant_type)
            ).first()
            if not v:
                raise HTTPException(400, f"Unknown variant type: {item.variant_type}")
            variant_cache[item.variant_type] = v

    existing = set()
    all_exps = session.exec(select(Experiment)).all()
    for e in all_exps:
        existing.add((e.variant_type, e.gene_symbol.lower(), e.condition))

    now = datetime.now(timezone.utc).isoformat()
    created_ids: list[int] = []
    skipped_genes: list[str] = []

    for item in items:
        condition = item.condition if item.condition != "basal" else body.condition
        timeline = item.timeline or body.timeline
        sim_params = item.sim_params if item.sim_params != "{}" else body.sim_params
        description = item.description or body.description

        variant_index = item.variant_index
        gene_symbol = item.gene_symbol
        if item.variant_type == "gene_knockout" and gene_symbol:
            gene = session.exec(
                select(Gene).where(col(Gene.symbol).ilike(gene_symbol))
            ).first()
            if not gene:
                skipped_genes.append(gene_symbol)
                continue
            variant_index = gene.ko_index
            gene_symbol = gene.symbol

        dup_key = (item.variant_type, gene_symbol.lower(), condition)
        if dup_key in existing:
            skipped_genes.append(gene_symbol + " (exists)")
            continue
        existing.add(dup_key)

        name = item.name
        if not name:
            if gene_symbol:
                name = f"KO {gene_symbol}"
                if condition != "basal":
                    name += f" ({condition})"
            else:
                name = f"{item.variant_type}[{variant_index}]"

        experiment = Experiment(
            name=name,
            description=description,
            variant_type=item.variant_type,
            variant_index=variant_index,
            condition=condition,
            timeline=timeline,
            sim_params=sim_params,
            status="draft",
            created_at=now,
            updated_at=now,
            gene_symbol=gene_symbol,
        )
        session.add(experiment)
        session.flush()
        created_ids.append(experiment.id)

    session.commit()
    logger.info("Batch created %d experiments (%d skipped)", len(created_ids), len(skipped_genes))

    return BatchResponse(
        created=len(created_ids),
        experiment_ids=created_ids,
        skipped=len(skipped_genes),
        skipped_genes=skipped_genes[:50],
    )


def _expand_screen(body: BatchRequest, session: Session) -> list[BatchExperimentItem]:
    """Expand a screen preset into a list of batch items."""
    screen = body.screen.lower().strip()

    if screen in {"all_mechanistic", "gene_knockout_all"}:
        genes = session.exec(
            select(Gene).where(Gene.is_mechanistic == True).order_by(Gene.symbol)
        ).all()
        if not genes:
            raise HTTPException(400, "No mechanistic genes found in database")
        return [
            BatchExperimentItem(
                variant_type="gene_knockout",
                gene_symbol=g.symbol,
            )
            for g in genes
        ]

    elif screen.startswith("gene_knockout_category:"):
        category = screen.split(":", 1)[1].strip()
        genes = session.exec(
            select(Gene).where(
                Gene.is_mechanistic == True,
                col(Gene.category).ilike(f"%{category}%"),
            ).order_by(Gene.symbol)
        ).all()
        if not genes:
            raise HTTPException(400, f"No mechanistic genes in category matching '{category}'")
        return [
            BatchExperimentItem(
                variant_type="gene_knockout",
                gene_symbol=g.symbol,
            )
            for g in genes
        ]

    else:
        raise HTTPException(400, f"Unknown screen preset: '{body.screen}'")
