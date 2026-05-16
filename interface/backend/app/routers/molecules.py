"""Per-molecule timeseries API — query individual gene/protein/mRNA trajectories.

Exposes the per-molecule data from MonomerCounts and RNACounts listeners
for downstream use in model training, exports, and single-gene views.

Molecule types:
    protein       — 4,435 protein monomers (total counts incl. in-complex)
    protein_free  — same proteins, free/unbound only
    mRNA          — 4,349 mRNA transcription units (total counts)
    mRNA_full     — same mRNAs, fully transcribed only
    rRNA          — 22 rRNA transcription units (partial transcripts)
    mRNA_cistron  — per-cistron mRNA counts
"""

import logging
import math
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from app.config import settings
from app.db.models import SimulationJob
from app.main import get_session

router = APIRouter(prefix="/api", tags=["molecules"])
logger = logging.getLogger(__name__)

VALID_MOLECULE_TYPES = [
    "protein", "protein_free", "mRNA", "mRNA_full",
    "rRNA", "mRNA_cistron",
]


# ── Response models ──────────────────────────────────────────────────────

class MoleculeTypeInfo(BaseModel):
    molecule_type: str
    count: int
    total_ids: int
    ids: list[str]  # preview (first 50)
    columns: list[str]


class MoleculeListResponse(BaseModel):
    job_id: int
    available_types: list[MoleculeTypeInfo]


class MoleculeIdsResponse(BaseModel):
    molecule_type: str
    count: int
    ids: list[str]


class TimeseriesPoint(BaseModel):
    time: float
    value: float


class MoleculeTimeseries(BaseModel):
    molecule_id: str
    molecule_type: str
    unit: str
    generation: int
    seed: int
    points: list[TimeseriesPoint]


class MoleculeTimeseriesResponse(BaseModel):
    job_id: int
    molecule_type: str
    molecules: list[MoleculeTimeseries]


# ── Helper ─────────────────────────────────────────────────────────────

def _get_reader_for_job(job: SimulationJob):
    """Get SimOutReader instances for a job's sim outputs."""
    from app.services.table_reader_bridge import SimOutReader, find_sim_outs, parse_sim_out_path

    if not job.sim_dir:
        raise HTTPException(400, "Job has no simulation directory")

    sim_out_base = settings.sim_output_dir / job.sim_dir
    sim_outs = find_sim_outs(sim_out_base)
    if not sim_outs:
        raise HTTPException(404, f"No simOut directories found for job {job.id}")

    readers = []
    for p in sim_outs:
        try:
            info = parse_sim_out_path(p)
            readers.append((SimOutReader(p), info))
        except Exception as e:
            logger.warning("Failed to create reader for %s: %s", p, e)

    if not readers:
        raise HTTPException(500, "Could not read any simulation outputs")

    return readers


# ── GET /api/jobs/{id}/molecules ──────────────────────────────────────

@router.get("/jobs/{job_id}/molecules", response_model=MoleculeListResponse)
def list_molecule_types(job_id: int, session: Session = Depends(get_session)):
    """List available molecule types and counts for a completed job.

    Shows how many proteins, mRNAs, etc. have per-molecule timeseries data.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    readers = _get_reader_for_job(job)
    reader, _ = readers[0]  # use first simOut for metadata

    type_infos = []
    for mtype in ["protein", "mRNA", "rRNA", "mRNA_cistron"]:
        try:
            summary = reader.get_molecule_summary(mtype)
            type_infos.append(MoleculeTypeInfo(
                molecule_type=mtype,
                count=summary.get("count", 0),
                total_ids=summary.get("total_ids", 0),
                ids=summary.get("ids", []),
                columns=summary.get("columns", []),
            ))
        except Exception as e:
            logger.debug("Skipping molecule type %s: %s", mtype, e)

    return MoleculeListResponse(job_id=job_id, available_types=type_infos)


# ── GET /api/jobs/{id}/molecules/{type}/ids ───────────────────────────

@router.get("/jobs/{job_id}/molecules/{molecule_type}/ids",
            response_model=MoleculeIdsResponse)
def list_molecule_ids(
    job_id: int,
    molecule_type: str,
    search: Optional[str] = Query(None, description="Filter IDs containing this string"),
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    """List molecule IDs for a specific type, with optional search filter.

    Use this to find specific proteins or mRNAs by ID before querying
    their timeseries.
    """
    if molecule_type not in VALID_MOLECULE_TYPES:
        raise HTTPException(400, f"Invalid molecule_type. Use one of: {VALID_MOLECULE_TYPES}")

    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    readers = _get_reader_for_job(job)
    reader, _ = readers[0]

    # Map compound types to base type for ID listing
    base_type = molecule_type.replace("_free", "").replace("_full", "")
    all_ids = reader.list_molecule_ids(base_type)

    if search:
        search_lower = search.lower()
        all_ids = [mid for mid in all_ids if search_lower in mid.lower()]

    total = len(all_ids)
    page = all_ids[offset:offset + limit]

    return MoleculeIdsResponse(
        molecule_type=molecule_type,
        count=total,
        ids=page,
    )


# ── GET /api/jobs/{id}/molecules/{type}/timeseries ────────────────────

@router.get("/jobs/{job_id}/molecules/{molecule_type}/timeseries",
            response_model=MoleculeTimeseriesResponse)
def get_molecule_timeseries(
    job_id: int,
    molecule_type: str,
    ids: str = Query(..., description="Comma-separated molecule IDs (max 20)"),
    session: Session = Depends(get_session),
):
    """Get time-series data for specific molecules.

    Returns count trajectories across all generations for the requested
    molecule IDs. Used for per-gene views, model training data, and exports.

    Example:
        GET /api/jobs/6/molecules/protein/timeseries?ids=ADHE-MONOMER,PFKA-MONOMER
    """
    if molecule_type not in VALID_MOLECULE_TYPES:
        raise HTTPException(400, f"Invalid molecule_type. Use one of: {VALID_MOLECULE_TYPES}")

    mol_ids = [mid.strip() for mid in ids.split(",") if mid.strip()]
    if len(mol_ids) > 20:
        raise HTTPException(400, "Maximum 20 molecule IDs per request")
    if not mol_ids:
        raise HTTPException(400, "No molecule IDs provided")

    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    readers = _get_reader_for_job(job)

    all_series = []
    for reader, path_info in readers:
        seed = path_info.get("seed", job.seed)
        gen = path_info.get("generation", 0)

        try:
            ts_data = reader.get_molecule_timeseries(molecule_type, mol_ids)
        except Exception as e:
            logger.warning("get_molecule_timeseries failed for gen %d: %s", gen, e)
            continue

        for mid, mdata in ts_data.items():
            points = []
            time_arr = mdata["time"]
            val_arr = mdata["values"]
            for t, v in zip(time_arr, val_arr):
                fv = float(v)
                if math.isfinite(fv):
                    points.append(TimeseriesPoint(time=float(t), value=fv))

            if points:
                all_series.append(MoleculeTimeseries(
                    molecule_id=mid,
                    molecule_type=molecule_type,
                    unit=mdata["unit"],
                    generation=gen,
                    seed=seed,
                    points=points,
                ))

    return MoleculeTimeseriesResponse(
        job_id=job_id,
        molecule_type=molecule_type,
        molecules=all_series,
    )


# ── GET /api/jobs/{id}/molecules/search ───────────────────────────────

@router.get("/jobs/{job_id}/molecules/search")
def search_molecules(
    job_id: int,
    q: str = Query(..., min_length=2, description="Search query (min 2 chars)"),
    limit: int = Query(50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    """Search across all molecule types for IDs matching a query string.

    Useful when you know a gene name but not the exact molecule ID format.
    Returns matches grouped by molecule type.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    readers = _get_reader_for_job(job)
    reader, _ = readers[0]

    q_lower = q.lower()
    results = {}

    for mtype in ["protein", "mRNA", "rRNA", "mRNA_cistron"]:
        try:
            all_ids = reader.list_molecule_ids(mtype)
            matches = [mid for mid in all_ids if q_lower in mid.lower()]
            if matches:
                results[mtype] = matches[:limit]
        except Exception:
            pass

    return {
        "query": q,
        "results": results,
        "total_matches": sum(len(v) for v in results.values()),
    }
