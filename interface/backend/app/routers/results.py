"""Results visualization API â€” time-series data for completed simulations.

Serves mock data when simulation outputs don't exist (development mode),
or real TableReader-extracted data when simOut directories are present.
"""

import logging
import math
import random
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from app.config import settings
from app.db.models import Experiment, SimulationJob, SimulationResult
from app.main import get_session

router = APIRouter(prefix="/api", tags=["results"])
logger = logging.getLogger(__name__)


# â”€â”€ Response models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class TimeseriesPoint(BaseModel):
    time: float  # seconds
    value: float


class TimeseriesData(BaseModel):
    label: str
    unit: str
    points: list[TimeseriesPoint]


class ResultsSummary(BaseModel):
    job_id: int
    seed: int
    generation: int
    division_time_sec: Optional[float]
    final_mass_fg: Optional[float]
    growth_rate: Optional[float]
    doubling_time_min: Optional[float]


class ResultsResponse(BaseModel):
    summary: list[ResultsSummary]
    timeseries: dict[str, list[TimeseriesData]]  # channel â†’ [per-seed series]


# â”€â”€ Channel display metadata (label overrides for frontend) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

CHANNEL_LABELS: dict[str, str] = {
    "cell_mass": "Cell mass",
    "dry_mass": "Dry mass",
    "protein_mass": "Protein mass",
    "rna_mass": "RNA mass",
    "dna_mass": "DNA mass",
    "small_molecule_mass": "Small-molecule mass",
    "growth_rate": "Growth rate",
    "cell_volume": "Cell volume",
    "ppgpp_conc": "ppGpp concentration",
    "aa_pool_size": "Amino-acid pool",
    "ntp_pool_size": "NTP pool",
    "trna_charged_fraction": "tRNA charged fraction",
    "aa_supply_total": "AA supply rate",
    "aa_synthesis_total": "AA synthesis rate",
    "mrna_counts": "mRNA count",
    "fba_objective": "FBA objective",
    "exchange_flux_total": "Exchange flux (total)",
    "reaction_flux_total": "Reaction flux (total)",
    "ribosome_elongation_rate": "Ribosome elongation rate",
    "ribosome_actual_elongations": "Ribosome elongations",
    "n_oric": "Origins of replication",
}


# â”€â”€ Real data extraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_real_timeseries(
    job: SimulationJob,
) -> dict[str, list[TimeseriesData]] | None:
    """Try to load timeseries from simOut via the bridge.

    Returns None if data is unavailable or extraction fails entirely.
    """
    if not job.sim_dir:
        return None

    sim_out_base = settings.sim_output_dir / job.sim_dir
    try:
        from app.services.table_reader_bridge import SimOutReader, find_sim_outs
        sim_outs = find_sim_outs(sim_out_base)
        if not sim_outs:
            return None
    except Exception as exc:
        logger.warning("Failed to locate simOut dirs for job %d: %s", job.id, exc)
        return None

    timeseries: dict[str, list[TimeseriesData]] = {}

    for sim_out_path in sim_outs:
        try:
            reader = SimOutReader(sim_out_path)
            channels = reader.extract_all_channels()
        except Exception as exc:
            logger.warning("extract_all_channels failed for %s: %s", sim_out_path, exc)
            continue

        seed_label = f"seed {job.seed}"

        for ch_name, ch_data in channels.items():
            time_arr = ch_data["time"]
            val_arr = ch_data["values"]
            unit = ch_data["unit"]
            label = CHANNEL_LABELS.get(ch_name, ch_name)

            points = [
                TimeseriesPoint(time=float(t), value=float(v))
                for t, v in zip(time_arr, val_arr)
                if math.isfinite(float(v))
            ]
            if not points:
                continue

            if ch_name not in timeseries:
                timeseries[ch_name] = []

            timeseries[ch_name].append(TimeseriesData(
                label=f"{label} ({seed_label})" if len(sim_outs) > 1 else label,
                unit=unit,
                points=points,
            ))

    return timeseries if timeseries else None


# â”€â”€ Mock data generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _generate_mock_timeseries(
    seed: int,
    duration_sec: float = 7200.0,
    dt: float = 2.0,
) -> dict[str, TimeseriesData]:
    """Generate biologically plausible mock time-series for one cell.

    Models exponential mass growth with realistic E. coli parameters:
    - Initial dry mass ~300 fg, doubles to ~600 fg
    - Growth rate ~0.0003 1/s (~40 min doubling time)
    - RNA/protein fractions follow mass allocation
    """
    rng = random.Random(seed + 42)
    n_points = int(duration_sec / dt)
    times = [i * dt for i in range(n_points)]

    # Growth rate with slight noise
    mu = 0.00028 + rng.gauss(0, 0.00002)  # ~40 min doubling

    # Cell mass (exponential growth with noise)
    m0 = 300.0 + rng.gauss(0, 10)  # initial dry mass in fg
    masses = []
    for t in times:
        noise = rng.gauss(0, 2)
        masses.append(m0 * math.exp(mu * t) + noise)

    # Growth rate (instantaneous, noisy around mu)
    growth_rates = []
    for i, t in enumerate(times):
        gr = mu + rng.gauss(0, 0.00003)
        # Dip slightly at start (lag phase effect)
        if t < 300:
            gr *= (0.5 + 0.5 * t / 300)
        growth_rates.append(gr)

    # Protein mass (~55% of dry mass)
    protein = [m * (0.55 + rng.gauss(0, 0.01)) for m in masses]

    # RNA mass (~20% of dry mass)
    rna = [m * (0.20 + rng.gauss(0, 0.005)) for m in masses]

    # DNA mass (step function â€” replicates partway through)
    dna_base = 4.6  # fg, one genome equivalent
    dna = []
    replication_start = duration_sec * (0.3 + rng.uniform(-0.05, 0.05))
    replication_end = duration_sec * (0.7 + rng.uniform(-0.05, 0.05))
    for t in times:
        if t < replication_start:
            dna.append(dna_base + rng.gauss(0, 0.1))
        elif t < replication_end:
            frac = (t - replication_start) / (replication_end - replication_start)
            dna.append(dna_base * (1 + frac) + rng.gauss(0, 0.1))
        else:
            dna.append(dna_base * 2 + rng.gauss(0, 0.1))

    # mRNA counts (noisy, ~2000-4000 total)
    mrna = [int(2000 + 1000 * m / m0 + rng.gauss(0, 100)) for m in masses]

    # tRNA charged fraction (~0.7-0.9)
    trna_charged = [0.80 + 0.05 * math.sin(2 * math.pi * t / 3600) + rng.gauss(0, 0.02) for t in times]

    def to_series(label, unit, values):
        return TimeseriesData(
            label=label,
            unit=unit,
            points=[TimeseriesPoint(time=t, value=v) for t, v in zip(times, values)],
        )

    return {
        "cell_mass": to_series("Cell mass", "fg", masses),
        "growth_rate": to_series("Growth rate", "1/s", growth_rates),
        "protein_mass": to_series("Protein mass", "fg", protein),
        "rna_mass": to_series("RNA mass", "fg", rna),
        "dna_mass": to_series("DNA mass", "fg", dna),
        "mrna_counts": to_series("mRNA count", "molecules", mrna),
        "trna_charged": to_series("tRNA charged fraction", "fraction", trna_charged),
    }


# â”€â”€ GET /api/jobs/{id}/timeseries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@router.get("/jobs/{job_id}/timeseries", response_model=ResultsResponse)
def get_job_timeseries(job_id: int, session: Session = Depends(get_session)):
    """Get time-series and summary data for a completed job.

    Returns real data from simOut if available, otherwise generates
    biologically plausible mock data for development/demo purposes.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    # Get summary results from DB
    db_results = session.exec(
        select(SimulationResult)
        .where(SimulationResult.job_id == job_id)
        .order_by(SimulationResult.seed, SimulationResult.generation)
    ).all()

    summary = [
        ResultsSummary(
            job_id=r.job_id,
            seed=r.seed,
            generation=r.generation,
            division_time_sec=r.division_time_sec,
            final_mass_fg=r.final_mass_fg,
            growth_rate=r.growth_rate,
            doubling_time_min=r.doubling_time_min,
        )
        for r in db_results
    ]

    # â”€â”€ Try real data first â”€â”€
    timeseries = _load_real_timeseries(job)

    # â”€â”€ Fall back to mock â”€â”€
    if timeseries is None:
        timeseries = {}
        num_seeds = max(1, job.seed + 1) if not db_results else max(r.seed for r in db_results) + 1
        if num_seeds == 0:
            num_seeds = 1

        for seed in range(num_seeds):
            mock = _generate_mock_timeseries(seed)
            for channel, series in mock.items():
                if channel not in timeseries:
                    timeseries[channel] = []
                series.label = f"{series.label} (seed {seed})"
                timeseries[channel].append(series)

        # Also generate mock summary if none exists
        if not summary:
            rng = random.Random(42)
            for seed in range(num_seeds):
                summary.append(ResultsSummary(
                    job_id=job_id,
                    seed=seed,
                    generation=0,
                    division_time_sec=2400 + rng.gauss(0, 200),
                    final_mass_fg=600 + rng.gauss(0, 30),
                    growth_rate=0.00028 + rng.gauss(0, 0.00002),
                    doubling_time_min=40 + rng.gauss(0, 3),
                ))

    return ResultsResponse(summary=summary, timeseries=timeseries)


# â”€â”€ Feature extraction for ML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class FeatureRow(BaseModel):
    """One row in the ML feature matrix â€” one seed of one experiment."""
    experiment_id: int
    experiment_name: str
    job_id: int
    gene_symbol: str
    ko_index: int
    category: str
    is_mechanistic: bool
    variant_type: str
    variant_index: int
    condition: str
    seed: int
    # Target variables (simulation outputs)
    divided: bool
    division_time_sec: Optional[float]
    final_mass_fg: Optional[float]
    growth_rate: Optional[float]
    doubling_time_min: Optional[float]


class FeatureExtractionResponse(BaseModel):
    """ML-ready feature matrix extracted from all completed experiments."""
    total_rows: int
    total_experiments: int
    total_genes: int
    columns: list[str]
    rows: list[FeatureRow]


@router.get("/features", response_model=FeatureExtractionResponse)
def extract_features(
    condition: Optional[str] = Query(None, description="Filter by condition"),
    variant_type: Optional[str] = Query(None, description="Filter by variant type"),
    mechanistic_only: bool = Query(False, description="Only mechanistically-modeled genes"),
    session: Session = Depends(get_session),
):
    """Extract ML-ready feature matrix from all completed simulation results.

    Returns one row per seed per experiment, with gene metadata and
    simulation summary statistics. Use this to train surrogate models
    that predict simulation outcomes from gene/condition features.

    Typical usage:
    - GET /api/features?variant_type=gene_knockout â†’ all KO results
    - GET /api/features?mechanistic_only=true â†’ only mechanistic genes
    - GET /api/features?condition=with_aa â†’ only amino-acid-supplemented
    """
    from app.db.models import Gene

    # Build query for completed jobs
    stmt = (
        select(SimulationJob, Experiment)
        .join(Experiment, SimulationJob.experiment_id == Experiment.id)
        .where(SimulationJob.status == "done")
    )
    if condition:
        stmt = stmt.where(Experiment.condition == condition)
    if variant_type:
        stmt = stmt.where(Experiment.variant_type == variant_type)

    job_exp_pairs = session.exec(stmt).all()

    # Pre-load gene metadata
    gene_cache: dict[str, Gene] = {}
    all_genes = session.exec(select(Gene)).all()
    for g in all_genes:
        gene_cache[g.symbol.lower()] = g

    rows: list[FeatureRow] = []
    seen_genes = set()
    seen_experiments = set()

    for job, experiment in job_exp_pairs:
        # Get result for this job
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .order_by(SimulationResult.generation)
            .limit(1)
        ).first()

        if not result:
            continue

        gene = gene_cache.get(experiment.gene_symbol.lower()) if experiment.gene_symbol else None

        if mechanistic_only and gene and not gene.is_mechanistic:
            continue

        ko_index = gene.ko_index if gene else experiment.variant_index
        category = gene.category if gene else ""
        is_mech = gene.is_mechanistic if gene else False

        if gene:
            seen_genes.add(gene.symbol)
        seen_experiments.add(experiment.id)

        divided = result.division_time_sec is not None

        rows.append(FeatureRow(
            experiment_id=experiment.id,
            experiment_name=experiment.name,
            job_id=job.id,
            gene_symbol=experiment.gene_symbol or "",
            ko_index=ko_index,
            category=category,
            is_mechanistic=is_mech,
            variant_type=experiment.variant_type,
            variant_index=experiment.variant_index,
            condition=experiment.condition,
            seed=job.seed,
            divided=divided,
            division_time_sec=result.division_time_sec,
            final_mass_fg=result.final_mass_fg,
            growth_rate=result.growth_rate,
            doubling_time_min=result.doubling_time_min,
        ))

    columns = list(FeatureRow.model_fields.keys())

    return FeatureExtractionResponse(
        total_rows=len(rows),
        total_experiments=len(seen_experiments),
        total_genes=len(seen_genes),
        columns=columns,
        rows=rows,
    )


@router.get("/features/csv")
def extract_features_csv(
    condition: Optional[str] = Query(None),
    variant_type: Optional[str] = Query(None),
    mechanistic_only: bool = Query(False),
    session: Session = Depends(get_session),
):
    """Download the feature matrix as CSV for use in notebooks/sklearn/etc."""
    from fastapi.responses import StreamingResponse
    import csv
    import io

    result = extract_features(
        condition=condition,
        variant_type=variant_type,
        mechanistic_only=mechanistic_only,
        session=session,
    )

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=result.columns)
    writer.writeheader()
    for row in result.rows:
        writer.writerow(row.model_dump())

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=wcecoli_features.csv"},
    )


# â”€â”€ GET /api/jobs/{id}/debug â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@router.get("/jobs/{job_id}/debug")
def debug_job_data(job_id: int, session: Session = Depends(get_session)):
    """Diagnostic endpoint: shows what the API can see for a job's sim data."""
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    result = {
        "job_id": job.id,
        "sim_dir": job.sim_dir,
        "status": job.status,
        "sim_output_dir": str(settings.sim_output_dir),
    }

    if not job.sim_dir:
        result["error"] = "No sim_dir set on job"
        return result

    sim_out_base = settings.sim_output_dir / job.sim_dir
    result["sim_out_base"] = str(sim_out_base)
    result["sim_out_base_exists"] = sim_out_base.exists()

    if sim_out_base.exists():
        result["top_level_contents"] = sorted(str(p.name) for p in sim_out_base.iterdir())

    try:
        from app.services.table_reader_bridge import SimOutReader, find_sim_outs
        sim_outs = find_sim_outs(sim_out_base)
        result["sim_outs_found"] = [str(p) for p in sim_outs]

        if sim_outs:
            reader = SimOutReader(sim_outs[0])
            result["tables"] = reader.list_tables()

            # Try reading one column to verify binary reader works
            try:
                time_arr = reader._read_column("Mass", "time")
                result["mass_time_length"] = len(time_arr) if time_arr is not None else None
                result["mass_time_sample"] = time_arr[:3].tolist() if time_arr is not None and len(time_arr) > 0 else None
            except Exception as e:
                result["mass_read_error"] = str(e)

            # Try extract_all_channels
            try:
                channels = reader.extract_all_channels()
                result["channels_found"] = list(channels.keys())
                result["channel_lengths"] = {k: len(v["values"]) for k, v in channels.items()}
            except Exception as e:
                result["extract_error"] = str(e)
                import traceback
                result["extract_traceback"] = traceback.format_exc()
    except Exception as e:
        result["bridge_error"] = str(e)
        import traceback
        result["bridge_traceback"] = traceback.format_exc()

    return result
