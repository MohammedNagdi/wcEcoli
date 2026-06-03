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

import json
import logging
import math
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.config import settings
from app.db.models import Experiment, Gene, SimulationJob, TFEdge
from app.main import get_session

router = APIRouter(prefix="/api", tags=["molecules"])
logger = logging.getLogger(__name__)

VALID_MOLECULE_TYPES = [
    "protein", "protein_free", "mRNA", "mRNA_full",
    "rRNA", "mRNA_cistron",
    "reaction_flux", "exchange_flux", "metabolite_delta",
    "metabolite_count", "aa_pool",
]

PLOTTABLE_TYPES = [
    "protein", "mRNA", "rRNA", "mRNA_cistron",
    "reaction_flux", "exchange_flux", "metabolite_delta",
    "metabolite_count", "aa_pool",
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


class ResultStateVariable(BaseModel):
    id: str
    molecule_type: str
    display_type: str
    role: str
    gene_symbol: str
    gene_name: Optional[str] = None
    available: bool = False
    final_value: Optional[float] = None
    wt_final_value: Optional[float] = None
    delta: Optional[float] = None
    delta_pct: Optional[float] = None
    rank_score: Optional[float] = None


class ResultStateNode(BaseModel):
    id: str
    label: str
    node_type: str
    role: str
    available: bool = False


class ResultStateEdge(BaseModel):
    source: str
    target: str
    edge_type: str
    label: str = ""
    log2fc: Optional[float] = None
    regulation: str = ""


class ResultStateExplorerResponse(BaseModel):
    job_id: int
    wt_job_id: Optional[int] = None
    focus_gene: str
    variables: list[ResultStateVariable]
    nodes: list[ResultStateNode]
    edges: list[ResultStateEdge]
    unavailable_count: int = 0


class StoichiometryMolecule(BaseModel):
    id: str
    coefficient: float
    role: str
    available_types: list[str] = []


class StoichiometryReaction(BaseModel):
    id: str
    direction: str
    catalysts: list[str]
    reactants: list[StoichiometryMolecule]
    products: list[StoichiometryMolecule]
    reaction_flux_available: bool = False


class StoichiometryNeighborhoodResponse(BaseModel):
    job_id: int
    focus_gene: str
    enzyme_ids: list[str]
    reactions: list[StoichiometryReaction]
    note: str = "Stoichiometry shows biochemical adjacency only; it is not causal evidence by itself."


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


def _json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [item.strip() for item in parsed if isinstance(item, str) and item.strip()]


def _strip_compartment(molecule_id: str) -> str:
    if "[" in molecule_id:
        return molecule_id.rsplit("[", 1)[0]
    return molecule_id


def _protein_id(monomer_id: str) -> str:
    return monomer_id if "[" in monomer_id else f"{monomer_id}[c]"


def _find_gene(session: Session, query: str) -> Optional[Gene]:
    gene = session.exec(select(Gene).where(Gene.symbol == query)).first()
    if gene:
        return gene
    gene = session.exec(select(Gene).where(col(Gene.symbol).ilike(query))).first()
    if gene:
        return gene
    pattern = f"%{query}%"
    return session.exec(
        select(Gene).where(
            (col(Gene.ecoli_id).ilike(query))
            | (col(Gene.synonyms).ilike(pattern))
            | (col(Gene.monomer_id).ilike(query))
        )
    ).first()


def _available_id_sets(reader) -> dict[str, set[str]]:
    sets: dict[str, set[str]] = {}
    for molecule_type in PLOTTABLE_TYPES:
        try:
            sets[molecule_type] = set(reader.list_molecule_ids(molecule_type))
        except Exception:
            sets[molecule_type] = set()
    return sets


def _add_if_present(target: dict[str, list[str]], molecule_type: str, molecule_id: str, available: dict[str, set[str]]):
    ids = available.get(molecule_type, set())
    candidates = [molecule_id]
    if molecule_type == "protein":
        candidates.append(_protein_id(molecule_id))
        candidates.append(_strip_compartment(molecule_id))
    for candidate in candidates:
        if candidate in ids and candidate not in target.setdefault(molecule_type, []):
            target[molecule_type].append(candidate)
            return


def _gene_state_candidates(gene: Gene) -> list[dict]:
    candidates: list[dict] = []
    for rna_id in _json_list(gene.rna_ids):
        candidates.append({
            "id": rna_id,
            "molecule_type": "mRNA_cistron",
            "display_type": "mRNA",
        })
    if gene.monomer_id:
        candidates.append({
            "id": _protein_id(gene.monomer_id),
            "molecule_type": "protein",
            "display_type": "protein",
        })
    for complex_id in _json_list(gene.complex_ids):
        candidates.append({
            "id": _protein_id(complex_id),
            "molecule_type": "protein",
            "display_type": "complex",
        })
    return candidates


def _enzyme_ids_for_gene(gene: Gene) -> set[str]:
    enzyme_ids = set()
    if gene.monomer_id:
        enzyme_ids.add(gene.monomer_id)
    enzyme_ids.update(_json_list(gene.complex_ids))
    return enzyme_ids


def _metabolic_reaction_candidates(gene: Gene) -> list[dict]:
    """Find reconstruction metabolic reactions catalyzed by this gene's products."""
    enzyme_ids = _enzyme_ids_for_gene(gene)
    if not enzyme_ids:
        return []

    path = settings.reconstruction_path / "ecoli" / "flat" / "metabolic_reactions.tsv"
    if not path.exists():
        return []

    candidates: list[dict] = []
    try:
        import csv

        with path.open("r", encoding="utf-8") as handle:
            reader = csv.reader(handle, delimiter="\t")
            for row in reader:
                if len(row) < 4:
                    continue
                reaction_id = row[0].strip().strip('"')
                try:
                    catalysts = json.loads(row[3])
                except Exception:
                    catalysts = []
                if not isinstance(catalysts, list):
                    continue
                if any(isinstance(catalyst, str) and catalyst in enzyme_ids for catalyst in catalysts):
                    candidates.append({
                        "id": reaction_id,
                        "molecule_type": "reaction_flux",
                        "display_type": "reaction flux",
                    })
    except Exception:
        return []

    return candidates[:12]


def _available_metabolite_types(molecule_id: str, available: dict[str, set[str]]) -> list[str]:
    types: list[str] = []
    for molecule_type in ("metabolite_delta", "metabolite_count"):
        ids = available.get(molecule_type, set())
        if molecule_id in ids or _strip_compartment(molecule_id) in ids:
            types.append(molecule_type)
    return types


def _stoichiometry_neighborhood(
    gene: Gene,
    available: dict[str, set[str]],
    limit: int = 12,
) -> tuple[list[str], list[StoichiometryReaction]]:
    enzyme_ids = _enzyme_ids_for_gene(gene)
    if not enzyme_ids:
        return [], []

    path = settings.reconstruction_path / "ecoli" / "flat" / "metabolic_reactions.tsv"
    if not path.exists():
        return sorted(enzyme_ids), []

    reactions: list[StoichiometryReaction] = []
    try:
        import csv

        with path.open("r", encoding="utf-8") as handle:
            reader = csv.reader(handle, delimiter="\t")
            for row in reader:
                if len(row) < 4:
                    continue
                reaction_id = row[0].strip().strip('"')
                if not reaction_id or reaction_id == "id" or reaction_id.startswith("#"):
                    continue
                try:
                    stoich = json.loads(row[1])
                    catalysts = json.loads(row[3])
                except Exception:
                    continue
                if not isinstance(stoich, dict) or not isinstance(catalysts, list):
                    continue
                if not any(isinstance(catalyst, str) and catalyst in enzyme_ids for catalyst in catalysts):
                    continue

                reactants: list[StoichiometryMolecule] = []
                products: list[StoichiometryMolecule] = []
                for molecule_id, coefficient in stoich.items():
                    if not isinstance(molecule_id, str) or not isinstance(coefficient, (int, float)) or coefficient == 0:
                        continue
                    entry = StoichiometryMolecule(
                        id=molecule_id,
                        coefficient=float(coefficient),
                        role="reactant" if coefficient < 0 else "product",
                        available_types=_available_metabolite_types(molecule_id, available),
                    )
                    if coefficient < 0:
                        reactants.append(entry)
                    else:
                        products.append(entry)

                reactions.append(StoichiometryReaction(
                    id=reaction_id,
                    direction=row[2].strip().strip('"') if len(row) > 2 else "",
                    catalysts=[c for c in catalysts if isinstance(c, str)],
                    reactants=reactants,
                    products=products,
                    reaction_flux_available=reaction_id in available.get("reaction_flux", set()),
                ))
                if len(reactions) >= limit:
                    break
    except Exception as exc:
        logger.warning("Failed to parse metabolic stoichiometry for %s: %s", gene.symbol, exc)
        return sorted(enzyme_ids), []

    return sorted(enzyme_ids), reactions


def _find_wt_job(session: Session, job: SimulationJob) -> Optional[SimulationJob]:
    experiment = session.get(Experiment, job.experiment_id)
    condition = (experiment.condition if experiment else job.condition) or "basal"
    wt_experiments = session.exec(
        select(Experiment)
        .where(Experiment.variant_type == "wildtype")
        .where(Experiment.condition == condition)
        .where(Experiment.status == "done")
        .order_by(Experiment.created_at.desc())
    ).all()
    fallback: Optional[SimulationJob] = None
    for wt_experiment in wt_experiments:
        wt_jobs = session.exec(
            select(SimulationJob)
            .where(SimulationJob.experiment_id == wt_experiment.id)
            .where(SimulationJob.status == "done")
            .order_by(SimulationJob.created_at.desc())
        ).all()
        for wt_job in wt_jobs:
            if fallback is None:
                fallback = wt_job
            if wt_job.seed == job.seed and wt_job.generations == job.generations:
                return wt_job
    return fallback


def _final_values(job: Optional[SimulationJob], grouped_ids: dict[str, list[str]]) -> dict[tuple[str, str], float]:
    if not job:
        return {}
    try:
        readers = _get_reader_for_job(job)
    except HTTPException:
        return {}
    if not readers:
        return {}

    reader, _ = readers[-1]
    values: dict[tuple[str, str], float] = {}
    for molecule_type, molecule_ids in grouped_ids.items():
        if molecule_type not in VALID_MOLECULE_TYPES or not molecule_ids:
            continue
        try:
            data = reader.get_molecule_timeseries(molecule_type, molecule_ids)
        except Exception:
            continue
        for molecule_id, series in data.items():
            raw_values = series.get("values", [])
            if len(raw_values) == 0:
                continue
            final_value = float(raw_values[-1])
            if math.isfinite(final_value):
                values[(molecule_type, molecule_id)] = final_value
    return values


def _pct_change(value: Optional[float], baseline: Optional[float]) -> Optional[float]:
    if value is None or baseline is None or baseline == 0:
        return None
    return ((value - baseline) / baseline) * 100.0


def _regulation_label(regulation: str) -> str:
    value = str(regulation).strip().lower()
    if value in {"1", "+", "activation", "activator", "activate", "activates"}:
        return "activation"
    if value in {"-1", "2", "-", "repression", "repressor", "repress", "represses"}:
        return "repression"
    return value or "regulates"


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
    for mtype in PLOTTABLE_TYPES:
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

@router.get("/jobs/{job_id}/state-explorer", response_model=ResultStateExplorerResponse)
def get_result_state_explorer(
    job_id: int,
    gene: str = Query(..., min_length=1, description="Focus gene symbol"),
    session: Session = Depends(get_session),
):
    """Resolve a result's focus gene into plot-ready model state variables."""
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    focus_gene = _find_gene(session, gene)
    if not focus_gene:
        raise HTTPException(404, f"Gene '{gene}' not found")

    readers = _get_reader_for_job(job)
    reader, _ = readers[0]
    available = _available_id_sets(reader)

    downstream_edges = session.exec(
        select(TFEdge).where(TFEdge.tf_symbol == focus_gene.symbol)
    ).all()
    upstream_edges = session.exec(
        select(TFEdge).where(TFEdge.target_symbol == focus_gene.symbol)
    ).all()

    gene_roles: dict[str, str] = {focus_gene.symbol: "focus"}
    for edge in downstream_edges:
        gene_roles.setdefault(edge.target_symbol, "downstream_target")
    for edge in upstream_edges:
        gene_roles.setdefault(edge.tf_symbol, "upstream_regulator")

    gene_by_symbol: dict[str, Gene] = {}
    for symbol in gene_roles:
        resolved = _find_gene(session, symbol)
        if resolved:
            gene_by_symbol[resolved.symbol] = resolved

    nodes: list[ResultStateNode] = []
    edges: list[ResultStateEdge] = []
    variables: list[ResultStateVariable] = []
    grouped_ids: dict[str, list[str]] = {}
    seen_nodes: set[str] = set()

    def add_node(node: ResultStateNode):
        if node.id in seen_nodes:
            return
        seen_nodes.add(node.id)
        nodes.append(node)

    for symbol, role in gene_roles.items():
        current_gene = gene_by_symbol.get(symbol)
        if not current_gene:
            continue

        gene_node = f"gene:{current_gene.symbol}"
        add_node(ResultStateNode(
            id=gene_node,
            label=current_gene.symbol,
            node_type="gene",
            role=role,
            available=True,
        ))

        for candidate in [*_gene_state_candidates(current_gene), *_metabolic_reaction_candidates(current_gene)]:
            molecule_id = candidate["id"]
            molecule_type = candidate["molecule_type"]
            display_type = candidate["display_type"]
            is_available = molecule_id in available.get(molecule_type, set())
            if is_available and molecule_id not in grouped_ids.setdefault(molecule_type, []):
                grouped_ids[molecule_type].append(molecule_id)

            variables.append(ResultStateVariable(
                id=molecule_id,
                molecule_type=molecule_type,
                display_type=display_type,
                role=role,
                gene_symbol=current_gene.symbol,
                gene_name=current_gene.monomer_name,
                available=is_available,
            ))

            var_node = f"state:{molecule_type}:{molecule_id}"
            add_node(ResultStateNode(
                id=var_node,
                label=molecule_id,
                node_type=display_type,
                role=role,
                available=is_available,
            ))
            edges.append(ResultStateEdge(
                source=gene_node,
                target=var_node,
                edge_type="state_variable",
                label=display_type,
            ))

    for edge in downstream_edges:
        regulation = _regulation_label(edge.regulation_direct)
        edges.append(ResultStateEdge(
            source=f"gene:{edge.tf_symbol}",
            target=f"gene:{edge.target_symbol}",
            edge_type="regulates",
            label=regulation,
            log2fc=edge.log2fc_mean,
            regulation=regulation,
        ))
    for edge in upstream_edges:
        regulation = _regulation_label(edge.regulation_direct)
        edges.append(ResultStateEdge(
            source=f"gene:{edge.tf_symbol}",
            target=f"gene:{edge.target_symbol}",
            edge_type="regulates",
            label=regulation,
            log2fc=edge.log2fc_mean,
            regulation=regulation,
        ))

    seen_variables: set[tuple[str, str, str]] = set()
    deduped: list[ResultStateVariable] = []
    for variable in variables:
        key = (variable.role, variable.molecule_type, variable.id)
        if key in seen_variables:
            continue
        seen_variables.add(key)
        deduped.append(variable)

    current_values = _final_values(job, grouped_ids)
    wt_job = _find_wt_job(session, job)
    wt_values = _final_values(wt_job, grouped_ids)

    enriched: list[ResultStateVariable] = []
    for variable in deduped:
        final_value = current_values.get((variable.molecule_type, variable.id))
        wt_final_value = wt_values.get((variable.molecule_type, variable.id))
        delta = (
            final_value - wt_final_value
            if final_value is not None and wt_final_value is not None
            else None
        )
        delta_pct = _pct_change(final_value, wt_final_value)
        rank_score = abs(delta_pct) if delta_pct is not None else (abs(delta) if delta is not None else None)
        enriched.append(variable.model_copy(update={
            "final_value": final_value,
            "wt_final_value": wt_final_value,
            "delta": delta,
            "delta_pct": delta_pct,
            "rank_score": rank_score,
        }))

    role_rank = {"focus": 0, "downstream_target": 1, "upstream_regulator": 2}
    enriched.sort(
        key=lambda item: (
            not item.available,
            role_rank.get(item.role, 9),
            -(item.rank_score or -1),
            item.gene_symbol,
            item.display_type,
        )
    )

    return ResultStateExplorerResponse(
        job_id=job_id,
        wt_job_id=wt_job.id if wt_job else None,
        focus_gene=focus_gene.symbol,
        variables=enriched,
        nodes=nodes,
        edges=edges,
        unavailable_count=sum(1 for variable in enriched if not variable.available),
    )


@router.get("/jobs/{job_id}/stoichiometry-neighborhood", response_model=StoichiometryNeighborhoodResponse)
def get_stoichiometry_neighborhood(
    job_id: int,
    gene: str = Query(..., min_length=1, description="Focus gene symbol"),
    limit: int = Query(12, ge=1, le=50),
    session: Session = Depends(get_session),
):
    """Return metabolic reaction stoichiometry for reactions catalyzed by a gene's products.

    This is a reconstruction-derived adjacency layer. It does not infer causal
    metabolite effects; result availability flags only indicate whether linked
    reactions/metabolites are plottable in this job's simOut tables.
    """
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")

    focus_gene = _find_gene(session, gene)
    if not focus_gene:
        raise HTTPException(404, f"Gene '{gene}' not found")

    readers = _get_reader_for_job(job)
    reader, _ = readers[0]
    available = _available_id_sets(reader)
    enzyme_ids, reactions = _stoichiometry_neighborhood(focus_gene, available, limit=limit)

    return StoichiometryNeighborhoodResponse(
        job_id=job_id,
        focus_gene=focus_gene.symbol,
        enzyme_ids=enzyme_ids,
        reactions=reactions,
    )


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
    available = _available_id_sets(reader)

    gene = _find_gene(session, q)
    if gene:
        mapped: dict[str, list[str]] = {}
        for candidate in [*_gene_state_candidates(gene), *_metabolic_reaction_candidates(gene)]:
            _add_if_present(mapped, candidate["molecule_type"], candidate["id"], available)
        for molecule_type, ids in mapped.items():
            if ids:
                results[molecule_type] = ids[:limit]

    for mtype in PLOTTABLE_TYPES:
        try:
            all_ids = reader.list_molecule_ids(mtype)
            matches = [mid for mid in all_ids if q_lower in mid.lower()]
            if matches:
                existing = results.setdefault(mtype, [])
                for match in matches:
                    if match not in existing:
                        existing.append(match)
                    if len(existing) >= limit:
                        break
        except Exception:
            pass

    return {
        "query": q,
        "results": results,
        "total_matches": sum(len(v) for v in results.values()),
    }
