"""Read-only, bounded-query mechanistic knockout evidence aggregation.

One experiment is the unit of evidence. Results cover only the earliest recorded
generation of each completed job; missing records never count as non-division.
"""

from collections import defaultdict
import math
import json
from html import unescape
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db.models import (
    Experiment,
    Gene,
    MediaRecipe,
    SimulationJob,
    SimulationResult,
    Timeline,
    UserTimeline,
)
from app.services.experiment_identity import run_param_key
from app.services.timelines import normalize_timeline_definition

SCOPE = "Earliest recorded generation per completed job; experiments are never merged."


class SourceMetadata(BaseModel):
    experiment_id: int
    name: str
    status: str
    created_at: str
    condition: str
    timeline: str
    resolved_protocol: Optional[str] = None
    duration_sec: Optional[float] = None
    generations: Optional[int] = None
    configured_seed_count: Optional[int] = None
    total_jobs: int
    completed_jobs: int
    usable_results: int
    experiment_url: str


class BaselineMetadata(BaseModel):
    status: str = "unavailable"
    reason: str = "No compatible wildtype with usable completed results."
    source: Optional[SourceMetadata] = None
    mean_growth_rate: Optional[float] = None
    growth_rate_samples: int = 0


class GeneKOSummary(BaseModel):
    gene_symbol: str
    ko_index: int
    category: str
    is_mechanistic: bool
    experiment_id: Optional[int] = None
    n_seeds: int = 0  # Legacy field: total jobs, not division count.
    n_completed: int = 0
    divided: Optional[bool] = None
    division_rate: Optional[str] = None
    mean_division_time_min: Optional[float] = None
    mean_growth_rate: Optional[float] = None
    mean_doubling_time_min: Optional[float] = None
    mean_final_mass_fg: Optional[float] = None
    phenotype: str = "unknown"
    evidence_status: str = "no_experiment"
    evidence_reason: str = "No knockout experiment for this condition."
    evidence_gaps: list[str] = Field(default_factory=list)
    usable_result_count: int = 0
    recorded_result_count: int = 0
    divided_count: int = 0
    division_sample_count: int = 0
    metric_sample_counts: dict[str, int] = Field(default_factory=dict)
    source: Optional[SourceMetadata] = None
    baseline: BaselineMetadata = Field(default_factory=BaselineMetadata)
    aggregation_scope: str = SCOPE


class DesignOverview(BaseModel):
    total_genes: int
    mechanistic_genes: int
    simulated_genes: int
    essential_genes: int
    growth_defect_genes: int
    neutral_genes: int
    unknown_genes: int
    genes: list[GeneKOSummary]
    condition: str
    genes_with_experiments: int
    genes_with_usable_results: int
    unclassified_genes: int
    result_coverage_fraction: float
    aggregation_scope: str = SCOPE


class EssentialityStats(BaseModel):
    category: str
    total: int
    essential: int
    growth_defect: int
    neutral: int
    unknown: int
    essential_pct: float


class JobEvidence(BaseModel):
    job_id: int
    seed: int
    status: str
    termination_reason: str
    lineage_terminated: bool
    result_url: str
    earliest_result_id: Optional[int] = None
    results: list[dict]


class GeneEvidence(BaseModel):
    gene: dict
    condition: str
    summary: GeneKOSummary
    experiments: list[SourceMetadata]
    jobs: list[JobEvidence]
    baseline_jobs: list[JobEvidence]


def finite(value, *, positive=False):
    if value is None or not math.isfinite(value) or (positive and value <= 0):
        return None
    return value


def division_observed(result: SimulationResult) -> Optional[bool]:
    time = finite(result.division_time_sec, positive=True)
    if result.divided and time is not None:
        return True
    if not result.divided and result.division_time_sec is None:
        return False
    # Contradictory or legacy incomplete flags cannot establish division.
    return None


def usable(result: SimulationResult) -> bool:
    return (
        division_observed(result) is not None
        or finite(result.growth_rate) is not None
        or finite(result.final_mass_fg, positive=True) is not None
        or finite(result.doubling_time_min, positive=True) is not None
    )


def result_record(result: SimulationResult) -> dict:
    record = result.model_dump(exclude={"terminated"})
    record["terminated"] = bool(result.terminated)
    invalid = {}
    for name in ("division_time_sec", "growth_rate", "doubling_time_min", "final_mass_fg"):
        value = record[name]
        if value is not None and not math.isfinite(value):
            invalid[name] = str(value)
            record[name] = None
    if invalid:
        record["invalid_metric_values"] = invalid
    return record


class DesignEvidenceCatalog:
    def __init__(self, session: Session, condition: str):
        self.condition = condition
        self.genes = session.exec(select(Gene).order_by(Gene.symbol)).all()
        self.experiments = session.exec(
            select(Experiment)
            .where(
                Experiment.condition == condition,
                Experiment.variant_type.in_(["gene_knockout", "wildtype"]),
            )
            .order_by(Experiment.created_at.desc(), Experiment.id.desc())
        ).all()
        # Joins avoid huge IN parameter lists and include only this evidence scope.
        self.jobs = session.exec(
            select(SimulationJob)
            .join(Experiment, SimulationJob.experiment_id == Experiment.id)
            .where(
                Experiment.condition == condition,
                Experiment.variant_type.in_(["gene_knockout", "wildtype"]),
            )
            .order_by(SimulationJob.id)
        ).all()
        self.results = session.exec(
            select(SimulationResult)
            .join(SimulationJob, SimulationResult.job_id == SimulationJob.id)
            .join(Experiment, SimulationJob.experiment_id == Experiment.id)
            .where(
                Experiment.condition == condition,
                Experiment.variant_type.in_(["gene_knockout", "wildtype"]),
            )
            .order_by(SimulationResult.generation, SimulationResult.id)
        ).all()
        timelines = session.exec(select(Timeline)).all()
        user_timelines = session.exec(select(UserTimeline)).all()
        media = {r.media_id for r in session.exec(select(MediaRecipe)).all()}
        definitions = {t.name: t.definition for t in user_timelines}
        definitions.update({t.name: t.definition for t in timelines if t.definition})
        self.protocols: dict[str, Optional[str]] = {"": ""}
        for exp in self.experiments:
            value = exp.timeline.strip()
            if value not in self.protocols:
                try:
                    raw = value if " " in value else definitions.get(value, value)
                    self.protocols[value] = normalize_timeline_definition(raw, media)
                except (HTTPException, ValueError, OverflowError):
                    self.protocols[value] = None
        self.jobs_by_exp = defaultdict(list)
        self.results_by_job = defaultdict(list)
        self.exps_by_gene = defaultdict(list)
        for job in self.jobs:
            self.jobs_by_exp[job.experiment_id].append(job)
        job_experiments = {j.id: j.experiment_id for j in self.jobs}
        for result in self.results:
            if result.experiment_id == job_experiments.get(result.job_id):
                self.results_by_job[result.job_id].append(result)
        for exp in self.experiments:
            if exp.variant_type == "gene_knockout":
                self.exps_by_gene[exp.gene_symbol.casefold()].append(exp)
        self.earliest = {
            job_id: records[0] for job_id, records in self.results_by_job.items() if records
        }
        self.usable_by_exp = {
            exp.id: [
                self.earliest[j.id]
                for j in self.jobs_by_exp[exp.id]
                if j.status == "done" and j.id in self.earliest and usable(self.earliest[j.id])
            ]
            for exp in self.experiments
        }
        self.keys = {exp.id: self.comparison_key(exp) for exp in self.experiments}
        self.wildtypes = [e for e in self.experiments if e.variant_type == "wildtype"]

    def comparison_key(self, exp):
        protocol = self.protocols.get(exp.timeline.strip())
        try:
            if not isinstance(json.loads(exp.sim_params or "{}"), dict):
                return None
            _, generations, duration = run_param_key(exp.sim_params)
            if protocol is None or generations < 1 or finite(duration, positive=True) is None:
                return None
            return exp.condition, protocol, generations, duration
        except (ValueError, TypeError, OverflowError):
            return None

    def source(self, exp: Experiment) -> SourceMetadata:
        key = self.keys[exp.id]
        try:
            seed_count = len(run_param_key(exp.sim_params)[0])
        except (ValueError, TypeError, OverflowError):
            seed_count = None
        jobs = self.jobs_by_exp[exp.id]
        return SourceMetadata(
            experiment_id=exp.id,
            name=exp.name,
            status=exp.status,
            created_at=exp.created_at,
            condition=exp.condition,
            timeline=exp.timeline,
            resolved_protocol=key[1] if key else None,
            duration_sec=key[3] if key else None,
            generations=key[2] if key else None,
            configured_seed_count=seed_count,
            total_jobs=len(jobs),
            completed_jobs=sum(j.status == "done" for j in jobs),
            usable_results=len(self.usable_by_exp[exp.id]),
            experiment_url=f"/experiments?experiment={exp.id}",
        )

    def select_experiment(self, gene, experiment_id=None):
        exps = self.exps_by_gene[gene.symbol.casefold()]
        if experiment_id is not None:
            chosen = next((e for e in exps if e.id == experiment_id), None)
            if chosen is None:
                raise HTTPException(404, "Experiment does not belong to this gene and condition.")
            return chosen
        return next((e for e in exps if self.usable_by_exp[e.id]), exps[0] if exps else None)

    def baseline_for(self, exp):
        key = self.keys[exp.id]
        if key is None:
            return BaselineMetadata(
                reason="Experiment protocol or run parameters cannot be resolved."
            ), None
        reference = next(
            (e for e in self.wildtypes if self.keys[e.id] == key and self.usable_by_exp[e.id]), None
        )
        if reference is None:
            return BaselineMetadata(), None
        completed = [j for j in self.jobs_by_exp[reference.id] if j.status == "done"]
        results = self.usable_by_exp[reference.id]
        growth = [v for r in results if (v := finite(r.growth_rate, positive=True)) is not None]
        reliable = (
            len(results) == len(completed)
            and len(growth) == len(completed)
            and not any(r.terminated for r in results)
            and not any(j.lineage_terminated for j in completed)
        )
        return BaselineMetadata(
            status="available" if reliable else "unusable_comparison",
            reason="Matched condition, resolved protocol, duration and generations; seed sets may differ."
            if reliable
            else "Compatible wildtype has missing, invalid or terminated growth evidence.",
            source=self.source(reference),
            mean_growth_rate=sum(growth) / len(growth) if growth else None,
            growth_rate_samples=len(growth),
        ), reference

    def summary(self, gene, experiment_id=None):
        summary = GeneKOSummary(
            gene_symbol=gene.symbol,
            ko_index=gene.ko_index,
            category=gene.category or "Uncategorized",
            is_mechanistic=gene.is_mechanistic,
        )
        exp = self.select_experiment(gene, experiment_id)
        if exp is None:
            summary.evidence_gaps = [summary.evidence_reason]
            return summary
        summary.experiment_id = exp.id
        summary.source = self.source(exp)
        summary.n_seeds = summary.source.total_jobs
        summary.n_completed = summary.source.completed_jobs
        completed = [j for j in self.jobs_by_exp[exp.id] if j.status == "done"]
        recorded = [self.earliest[j.id] for j in completed if j.id in self.earliest]
        results = self.usable_by_exp[exp.id]
        summary.recorded_result_count = len(recorded)
        summary.usable_result_count = len(results)
        observations = [v for r in results if (v := division_observed(r)) is not None]
        summary.divided_count = sum(observations)
        summary.division_sample_count = len(observations)
        summary.division_rate = (
            f"{summary.divided_count}/{len(observations)} divided" if observations else None
        )
        summary.divided = all(observations) if observations else None
        metrics = {
            "division_time_min": [
                r.division_time_sec / 60 for r in results if division_observed(r) is True
            ],
            "growth_rate": [v for r in results if (v := finite(r.growth_rate)) is not None],
            "doubling_time_min": [
                v for r in results if (v := finite(r.doubling_time_min, positive=True)) is not None
            ],
            "final_mass_fg": [
                v for r in results if (v := finite(r.final_mass_fg, positive=True)) is not None
            ],
        }
        summary.metric_sample_counts = {name: len(values) for name, values in metrics.items()}
        for name, values in metrics.items():
            setattr(summary, f"mean_{name}", sum(values) / len(values) if values else None)
        summary.baseline, _ = self.baseline_for(exp)
        gaps = []
        if not completed:
            summary.evidence_status = "no_completed_jobs"
            gaps.append("No completed jobs in the selected experiment.")
        elif not recorded:
            summary.evidence_status = "missing_results"
            gaps.append("Completed jobs have no stored result records.")
        elif not results:
            summary.evidence_status = "unavailable_metrics"
            gaps.append(
                "Result records do not contain usable measurements or division observations."
            )
        else:
            summary.evidence_status = "usable" if len(results) == len(completed) else "partial"
        if completed and len(results) < len(completed):
            gaps.append(
                f"{len(completed) - len(results)} completed job(s) lack usable result records."
            )
        terminated = any(r.terminated for r in recorded) or any(
            j.lineage_terminated for j in completed
        )
        if terminated:
            gaps.append(
                "Lineage terminated; recorded measurements remain inspectable but are not a complete growth comparison."
            )
        if results and len(observations) != len(results):
            gaps.append("Division observations are missing or inconsistent.")
        complete = bool(completed) and len(observations) == len(completed) and not terminated
        if complete and not any(observations):
            summary.phenotype = "essential"
        elif complete:
            growth = metrics["growth_rate"]
            if len(growth) == len(completed) and summary.baseline.status == "available":
                summary.phenotype = (
                    "growth_defect"
                    if sum(growth) / len(growth) < 0.8 * summary.baseline.mean_growth_rate
                    else "neutral"
                )
            else:
                gaps.append(
                    "A growth comparison requires recorded growth rates for every completed job and a usable compatible wildtype."
                )
        for name, values in metrics.items():
            if results and not values:
                gaps.append(f"Unavailable metric: {name.replace('_', ' ')}.")
        if summary.phenotype == "unknown" and summary.baseline.status != "available" and results:
            gaps.append(summary.baseline.reason)
        summary.evidence_gaps = list(dict.fromkeys(gaps))
        summary.evidence_reason = (
            summary.evidence_gaps[0]
            if gaps
            else "Usable completed results; measurements use the disclosed generation scope."
        )
        return summary

    def overview(self, category=None, phenotype=None):
        genes = [
            self.summary(g)
            for g in self.genes
            if g.is_mechanistic and (not category or category.casefold() in g.category.casefold())
        ]
        if phenotype:
            genes = [g for g in genes if g.phenotype == phenotype]
        counts = {
            p: sum(g.phenotype == p for g in genes)
            for p in ("essential", "growth_defect", "neutral", "unknown")
        }
        usable_count = sum(g.usable_result_count > 0 for g in genes)
        return DesignOverview(
            total_genes=len(genes),
            mechanistic_genes=len(genes),
            simulated_genes=usable_count,
            essential_genes=counts["essential"],
            growth_defect_genes=counts["growth_defect"],
            neutral_genes=counts["neutral"],
            unknown_genes=counts["unknown"],
            genes=genes,
            condition=self.condition,
            genes_with_experiments=sum(g.experiment_id is not None for g in genes),
            genes_with_usable_results=usable_count,
            unclassified_genes=counts["unknown"],
            result_coverage_fraction=usable_count / len(genes) if genes else 0,
        )

    def category_stats(self):
        groups = defaultdict(list)
        for gene in self.overview().genes:
            groups[gene.category].append(gene)
        return [
            EssentialityStats(
                category=category,
                total=len(genes),
                **{
                    p: sum(g.phenotype == p for g in genes)
                    for p in ("essential", "growth_defect", "neutral", "unknown")
                },
                essential_pct=round(
                    100 * sum(g.phenotype == "essential" for g in genes) / len(genes), 1
                ),
            )
            for category, genes in sorted(groups.items())
        ]

    def job_evidence(self, exp):
        if exp is None:
            return []
        return [
            JobEvidence(
                job_id=j.id,
                seed=j.seed,
                status=j.status,
                lineage_terminated=j.lineage_terminated,
                termination_reason=j.termination_reason,
                result_url=f"/results/{j.id}",
                earliest_result_id=self.earliest[j.id].id if j.id in self.earliest else None,
                results=[result_record(r) for r in self.results_by_job[j.id]],
            )
            for j in self.jobs_by_exp[exp.id]
        ]

    def detail(self, symbol, experiment_id=None):
        gene = next((g for g in self.genes if g.symbol.casefold() == symbol.casefold()), None)
        if gene is None:
            raise HTTPException(404, "Gene not found.")
        if not gene.is_mechanistic:
            raise HTTPException(
                422,
                "This gene is outside the mechanistic knockout scope. Inspect it in the gene workspace; expression-only genes are excluded here.",
            )
        exp = self.select_experiment(gene, experiment_id)
        summary = self.summary(gene, experiment_id)
        _, baseline = self.baseline_for(exp) if exp else (None, None)
        return GeneEvidence(
            gene={**gene.model_dump(), "description": unescape(gene.monomer_name or "")},
            condition=self.condition,
            summary=summary,
            experiments=[self.source(e) for e in self.exps_by_gene[gene.symbol.casefold()]],
            jobs=self.job_evidence(exp),
            baseline_jobs=self.job_evidence(baseline),
        )
