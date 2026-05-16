"""Genome Design API — in-silico genome engineering workflow.

Combines gene knockout simulation results with ML surrogate predictions
to help users explore and design optimal gene modification strategies.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.db.models import Experiment, Gene, SimulationJob, SimulationResult
from app.main import get_session

router = APIRouter(prefix="/api/design", tags=["design"])
logger = logging.getLogger(__name__)


# ── Response models ──────────────────────────────────────────────────────

class GeneKOSummary(BaseModel):
    """Summary of a gene knockout's simulation results."""
    gene_symbol: str
    ko_index: int
    category: str
    is_mechanistic: bool
    experiment_id: Optional[int]
    n_seeds: int
    n_completed: int
    divided: Optional[bool]  # None if no completed seeds
    division_rate: Optional[str]  # e.g., "3/4 divided"
    mean_division_time_min: Optional[float]
    mean_growth_rate: Optional[float]
    mean_doubling_time_min: Optional[float]
    mean_final_mass_fg: Optional[float]
    phenotype: str  # "essential", "growth_defect", "neutral", "unknown"


class DesignOverview(BaseModel):
    """Overview of all gene knockouts with phenotype classification."""
    total_genes: int
    mechanistic_genes: int
    simulated_genes: int
    essential_genes: int
    growth_defect_genes: int
    neutral_genes: int
    unknown_genes: int
    genes: list[GeneKOSummary]


class EssentialityStats(BaseModel):
    """Essentiality statistics by functional category."""
    category: str
    total: int
    essential: int
    growth_defect: int
    neutral: int
    unknown: int
    essential_pct: float


# ── GET /api/design/overview ─────────────────────────────────────────────

@router.get("/overview", response_model=DesignOverview)
def get_design_overview(
    category: Optional[str] = Query(None, description="Filter by gene category"),
    phenotype: Optional[str] = Query(None, description="Filter by phenotype"),
    condition: str = Query("basal", description="Condition to analyze"),
    session: Session = Depends(get_session),
):
    """Get an overview of all gene knockouts with phenotype classification.

    Phenotype classification:
    - essential: cell did not divide in any seed
    - growth_defect: cell divided but growth metrics are >20% below wildtype
    - neutral: cell divided with near-normal growth
    - unknown: no simulation data available
    """
    # Load all mechanistic genes
    gene_stmt = select(Gene).where(Gene.is_mechanistic == True).order_by(Gene.symbol)
    if category:
        gene_stmt = gene_stmt.where(col(Gene.category).ilike(f"%{category}%"))
    all_genes = session.exec(gene_stmt).all()

    # Get wildtype reference metrics (from wildtype experiment or defaults)
    wt_growth_rate = _get_wildtype_growth_rate(session, condition)

    # For each gene, find its KO experiment results
    summaries: list[GeneKOSummary] = []
    counts = {"essential": 0, "growth_defect": 0, "neutral": 0, "unknown": 0}

    for gene in all_genes:
        summary = _get_gene_ko_summary(session, gene, condition, wt_growth_rate)
        if phenotype and summary.phenotype != phenotype:
            continue
        summaries.append(summary)
        counts[summary.phenotype] += 1

    return DesignOverview(
        total_genes=len(all_genes),
        mechanistic_genes=len(all_genes),
        simulated_genes=sum(1 for s in summaries if s.experiment_id is not None),
        essential_genes=counts["essential"],
        growth_defect_genes=counts["growth_defect"],
        neutral_genes=counts["neutral"],
        unknown_genes=counts["unknown"],
        genes=summaries,
    )


# ── GET /api/design/essentiality ─────────────────────────────────────────

@router.get("/essentiality", response_model=list[EssentialityStats])
def get_essentiality_by_category(
    condition: str = Query("basal"),
    session: Session = Depends(get_session),
):
    """Get gene essentiality breakdown by functional category."""
    all_genes = session.exec(
        select(Gene).where(Gene.is_mechanistic == True)
    ).all()

    wt_growth_rate = _get_wildtype_growth_rate(session, condition)

    # Group by category
    cat_stats: dict[str, dict] = {}
    for gene in all_genes:
        cat = gene.category or "Uncategorized"
        if cat not in cat_stats:
            cat_stats[cat] = {"total": 0, "essential": 0, "growth_defect": 0, "neutral": 0, "unknown": 0}
        cat_stats[cat]["total"] += 1

        summary = _get_gene_ko_summary(session, gene, condition, wt_growth_rate)
        cat_stats[cat][summary.phenotype] += 1

    result = []
    for cat, stats in sorted(cat_stats.items()):
        total = stats["total"]
        result.append(EssentialityStats(
            category=cat,
            total=total,
            essential=stats["essential"],
            growth_defect=stats["growth_defect"],
            neutral=stats["neutral"],
            unknown=stats["unknown"],
            essential_pct=round(stats["essential"] / total * 100, 1) if total > 0 else 0,
        ))

    return result


# ── Helpers ──────────────────────────────────────────────────────────────

def _get_wildtype_growth_rate(session: Session, condition: str) -> Optional[float]:
    """Get wildtype growth rate for phenotype comparison."""
    wt_exp = session.exec(
        select(Experiment).where(
            Experiment.variant_type == "wildtype",
            Experiment.condition == condition,
        )
    ).first()
    if not wt_exp:
        return None

    jobs = session.exec(
        select(SimulationJob).where(
            SimulationJob.experiment_id == wt_exp.id,
            SimulationJob.status == "done",
        )
    ).all()

    growth_rates = []
    for job in jobs:
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .limit(1)
        ).first()
        if result and result.growth_rate is not None:
            growth_rates.append(result.growth_rate)

    if growth_rates:
        return sum(growth_rates) / len(growth_rates)
    return None


def _get_gene_ko_summary(
    session: Session,
    gene: Gene,
    condition: str,
    wt_growth_rate: Optional[float],
) -> GeneKOSummary:
    """Build a KO summary for a single gene."""
    # Find the experiment for this gene
    exp = session.exec(
        select(Experiment).where(
            Experiment.variant_type == "gene_knockout",
            col(Experiment.gene_symbol).ilike(gene.symbol),
            Experiment.condition == condition,
        )
    ).first()

    if not exp:
        return GeneKOSummary(
            gene_symbol=gene.symbol,
            ko_index=gene.ko_index,
            category=gene.category,
            is_mechanistic=gene.is_mechanistic,
            experiment_id=None,
            n_seeds=0,
            n_completed=0,
            divided=None,
            division_rate=None,
            mean_division_time_min=None,
            mean_growth_rate=None,
            mean_doubling_time_min=None,
            mean_final_mass_fg=None,
            phenotype="unknown",
        )

    # Get completed jobs
    jobs = session.exec(
        select(SimulationJob).where(
            SimulationJob.experiment_id == exp.id,
        )
    ).all()

    completed = [j for j in jobs if j.status == "done"]

    div_times = []
    growth_rates = []
    doubling_times = []
    masses = []
    divided_count = 0

    for job in completed:
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .order_by(SimulationResult.generation)
            .limit(1)
        ).first()
        if not result:
            continue

        if result.division_time_sec is not None:
            divided_count += 1
            div_times.append(result.division_time_sec / 60.0)
        if result.growth_rate is not None:
            growth_rates.append(result.growth_rate)
        if result.doubling_time_min is not None:
            doubling_times.append(result.doubling_time_min)
        if result.final_mass_fg is not None:
            masses.append(result.final_mass_fg)

    n_completed = len(completed)
    all_divided = divided_count == n_completed and n_completed > 0
    none_divided = divided_count == 0 and n_completed > 0

    # Classify phenotype
    if n_completed == 0:
        phenotype = "unknown"
    elif none_divided:
        phenotype = "essential"
    elif growth_rates and wt_growth_rate and wt_growth_rate > 0:
        mean_gr = sum(growth_rates) / len(growth_rates)
        ratio = mean_gr / wt_growth_rate
        if ratio < 0.8:
            phenotype = "growth_defect"
        else:
            phenotype = "neutral"
    elif all_divided:
        phenotype = "neutral"
    else:
        phenotype = "growth_defect"

    mean_div = round(sum(div_times) / len(div_times), 1) if div_times else None
    mean_gr = round(sum(growth_rates) / len(growth_rates), 6) if growth_rates else None
    mean_dt = round(sum(doubling_times) / len(doubling_times), 1) if doubling_times else None
    mean_mass = round(sum(masses) / len(masses), 1) if masses else None

    division_rate = f"{divided_count}/{n_completed} divided" if n_completed > 0 else None

    return GeneKOSummary(
        gene_symbol=gene.symbol,
        ko_index=gene.ko_index,
        category=gene.category,
        is_mechanistic=gene.is_mechanistic,
        experiment_id=exp.id,
        n_seeds=len(jobs),
        n_completed=n_completed,
        divided=all_divided if n_completed > 0 else None,
        division_rate=division_rate,
        mean_division_time_min=mean_div,
        mean_growth_rate=mean_gr,
        mean_doubling_time_min=mean_dt,
        mean_final_mass_fg=mean_mass,
        phenotype=phenotype,
    )
