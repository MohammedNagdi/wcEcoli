"""Experiment configuration API endpoints."""

import csv
import json
import logging
import math
import statistics
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.config import settings
from app.db.models import Condition, Experiment, Gene, SimulationJob, SimulationResult, TFEdge, Variant
from app.main import get_session
from app.routers.jobs import (
    RunJobRequest,
    RunResponse,
    create_simulation_jobs_for_experiment,
)
from app.services.timelines import infer_condition_from_timeline, resolve_timeline_definition
from app.services.multi_gene_knockout import (
    MULTI_GENE_KNOCKOUT_TYPE,
    strip_multi_gene_targets,
    with_multi_gene_targets,
)
from app.services.batches import (
    BatchRequest,
    BatchResponse,
    create_typed_batch,
    delete_batch,
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
    gene_symbols: list[str] = []
    include_wildtype: bool = False  # Auto-create a matching WT control


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
    batch_id: str = ""
    wildtype_experiment_id: int | None = None  # Set when WT was auto-created


class VariantDetailOut(BaseModel):
    name: str
    docstring: str
    filename: str
    parameter_count: Optional[int]
    parameter_hints: dict  # UI hints for the variant's parameters


# --- Variant detail with parameter hints ---

PPGPP_FACTORS = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]
PPGPP_CONDITION_NAMES = ["basal", "with_aa"]
NEW_GENE_CONDITION_STRIDE = 1000
NEW_GENE_VALID_REMAINDER_RANGE = [0, 20]
NEW_GENE_EXPRESSION_FACTORS = [0, 7, 8, 9, 10]
NEW_GENE_TRANSLATION_EFFICIENCY_VALUES = [10, 5, 1, 0.1, 0]


def _list_conditions_in_variant_order(session: Session) -> list[Condition]:
    """Return conditions in the same order used by the runtime variant indices."""
    return session.exec(select(Condition).order_by(Condition.id)).all()


def _build_condition_index_options(session: Session) -> list[str]:
    options: list[str] = []
    for index, condition in enumerate(_list_conditions_in_variant_order(session)):
        if condition.nutrients:
            options.append(f"{index}: {condition.name} ({condition.nutrients})")
        else:
            options.append(f"{index}: {condition.name}")
    return options


def _load_tf_activity_names(session: Session) -> list[str]:
    """Load TF names in the same order filtered by the runtime reconstruction inputs."""
    known_tfs = {tf_symbol for tf_symbol in session.exec(select(TFEdge.tf_symbol)).all()}
    if not known_tfs:
        return []

    if not settings.tf_condition_tsv.exists():
        return sorted(known_tfs)

    tf_names: set[str] = set()
    with open(settings.tf_condition_tsv, encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        for row in reader:
            if not row:
                continue
            first_cell = row[0].strip()
            if not first_cell or first_cell.startswith("#"):
                continue
            tf_name = first_cell.strip('"')
            if tf_name == "TF":
                continue
            if tf_name in known_tfs:
                tf_names.add(tf_name)

    return sorted(tf_names)


def _load_tf_activity_specs(session: Session) -> dict[str, dict]:
    """Load user-readable TF active/inactive definitions from tf_condition.tsv."""
    known_tfs = {tf_symbol for tf_symbol in session.exec(select(TFEdge.tf_symbol)).all()}
    if not known_tfs or not settings.tf_condition_tsv.exists():
        return {}

    specs: dict[str, dict] = {}
    with open(settings.tf_condition_tsv, encoding="utf-8") as handle:
        rows = [
            row for row in csv.reader(handle, delimiter="\t")
            if row and not row[0].strip().startswith("#")
        ]

    if not rows:
        return specs

    header = [cell.strip().strip('"') for cell in rows[0]]
    for row_values in rows[1:]:
        row = {
            header[index]: row_values[index]
            for index in range(min(len(header), len(row_values)))
        }
        tf_name = (row.get("TF") or "").strip().strip('"')
        if not tf_name or tf_name not in known_tfs:
            continue
        specs[tf_name] = {
            "active_molecule": (row.get("active TF") or "").strip().strip('"'),
            "active_nutrients": (row.get("active nutrients") or "").strip().strip('"'),
            "active_perturbations": (row.get("active genotype perturbations") or "").strip(),
            "inactive_nutrients": (row.get("inactive nutrients") or "").strip().strip('"'),
            "inactive_perturbations": (row.get("inactive genotype perturbations") or "").strip(),
            "tf_type": (row.get("TF type") or "").strip().strip('"'),
        }

    return specs


def _build_tf_activity_index_options(session: Session) -> tuple[list[str], list[str]]:
    tf_names = _load_tf_activity_names(session)
    options = ["0: control"]
    for offset, tf_name in enumerate(tf_names):
        options.append(f"{2 * offset + 1}: {tf_name} active")
        options.append(f"{2 * offset + 2}: {tf_name} inactive")
    return tf_names, options


def _decode_new_gene_remainder(remainder: int) -> tuple[str, str]:
    translation_index = remainder % len(NEW_GENE_TRANSLATION_EFFICIENCY_VALUES)
    if translation_index == 0:
        expression_index = remainder // len(NEW_GENE_TRANSLATION_EFFICIENCY_VALUES)
    else:
        expression_index = remainder // len(NEW_GENE_TRANSLATION_EFFICIENCY_VALUES) + 1

    expression_factor = 10 ** (NEW_GENE_EXPRESSION_FACTORS[expression_index] - 1)
    translation_efficiency = NEW_GENE_TRANSLATION_EFFICIENCY_VALUES[translation_index]
    return f"expression {expression_factor:g}x", f"translation efficiency {translation_efficiency:g}"


def _build_new_gene_index_options(session: Session) -> tuple[list[str], list[str]]:
    conditions = _list_conditions_in_variant_order(session)
    condition_names = [condition.name for condition in conditions]
    options = ["0: control (new gene expression knocked out)"]

    for condition_index, condition_name in enumerate(condition_names):
        base_index = condition_index * NEW_GENE_CONDITION_STRIDE
        if base_index > 0:
            options.append(
                f"{base_index}: {condition_name}, control remainder (no induced new-gene expression)"
            )

        for remainder in range(1, NEW_GENE_VALID_REMAINDER_RANGE[1] + 1):
            expression_label, translation_label = _decode_new_gene_remainder(remainder)
            options.append(
                f"{base_index + remainder}: {condition_name}, {expression_label}, {translation_label}"
            )

    return condition_names, options

def _extract_index_options_from_docstring(docstring: str) -> list[str]:
    """Extract documented expected variant index lines from a variant docstring."""
    lines = docstring.splitlines()
    start = None

    for index, line in enumerate(lines):
        if line.strip().startswith("Expected variant indices"):
            start = index + 1
            break

    if start is None:
        return []

    options: list[str] = []
    for line in lines[start:]:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("TODO:"):
            break
        options.append(stripped)

    return options

VARIANT_PARAM_HINTS: dict[str, dict] = {
    "gene_knockout": {
        "index_meaning": "Gene index (0 = control, 1-4749 = individual gene KO)",
        "index_range": [0, 4749],
        "supports_gene_lookup": True,
        "timeline_behavior": "composer",
        "index_options": [
            "0: control",
            "1-4749: individual gene knockout index; use gene search to map symbols to indices",
        ],
    },
    "multi_gene_knockout": {
        "index_meaning": "Always 0; selected genes are stored as validated KO indexes in sim_params",
        "index_range": [0, 0],
        "hide_index": True,
        "timeline_behavior": "composer",
        "index_options": [
            "0: multi-gene knockout target set supplied by experiment metadata",
        ],
    },
    "condition": {
        "index_meaning": "Condition index (maps to condition_defs.tsv row)",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "timeline_notice": "This variant presets its timeline internally from the selected condition. Media selection is locked because the selected condition controls the model environment.",
    },
    "timelines": {
        "index_meaning": "Ignored for this experiment type. Use the Timeline Composer to define the effective timeline.",
        "index_range": [0, 0],
        "supports_gene_lookup": False,
        "hide_index": True,
        "timeline_behavior": "composer",
        "timeline_notice": "This experiment type uses the composed timeline directly. Preset timeline selection by parameter index is disabled.",
        "index_options": [
            "This experiment type no longer uses parameter index selection in the UI.",
            "Use the Timeline Composer to define the effective timeline.",
        ],
    },
    "wildtype": {
        "index_meaning": "Always 0 (no modifications)",
        "index_range": [0, 0],
        "supports_gene_lookup": False,
        "timeline_behavior": "composer",
        "index_options": [
            "0: control run with no variant changes",
        ],
    },
    "ppgpp_conc": {
        "index_meaning": "ppGpp concentration index",
        "index_range": [0, 19],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "timeline_notice": "This variant selects its runtime condition block internally, then clamps ppGpp concentration. Media selection is locked; choose the condition block above instead.",
    },
    "add_one_aa": {
        "index_meaning": "Amino acid index (0-20, maps to standard AAs)",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "basal",
        "fixed_timeline": "0 minimal",
        "timeline_notice": "This variant adds the selected amino acid to the model's minimal medium definition. Media selection is locked so the amino-acid addition is not accidentally bypassed by another medium.",
    },
    "remove_one_aa": {
        "index_meaning": "Amino acid index to remove",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "with_aa",
        "fixed_timeline": "0 minimal_plus_amino_acids",
        "timeline_notice": "This variant always runs in minimal_plus_amino_acids and removes the selected amino acid from that internally managed environment.",
    },
    "add_one_aa_shift": {
        "index_meaning": "Amino acid index to add after the internal shift",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "basal",
        "fixed_timeline": "0 minimal, 600 minimal_plus_SELECTED_AA",
        "timeline_notice": "This variant defines its own 10-minute shift internally. Media selection is locked so the run uses the variant-managed shift timeline.",
    },
    "remove_one_aa_shift": {
        "index_meaning": "Amino acid index to remove after the internal shift",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "with_aa",
        "fixed_timeline": "0 minimal_plus_amino_acids, 600 minimal_plus_amino_acids_without_SELECTED_AA",
        "timeline_notice": "This variant defines its own 10-minute shift internally. Media selection is locked so the run uses the variant-managed shift timeline.",
    },
    "remove_aas_shift": {
        "index_meaning": "Index selects the amino-acid removal branch",
        "index_range": [0, 23],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "with_aa",
        "fixed_timeline": "0 minimal_plus_amino_acids, 600 selected_amino_acid_media",
        "timeline_notice": "This variant selects a predefined amino-acid media branch. Media selection is locked; choose the branch above instead.",
    },
    "tf_activity": {
        "index_meaning": "Index selects the TF activity state",
        "min_valid_index": 0,
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "tf_state",
        "timeline_notice": "Non-control TF activity runs set their own nutrient timeline internally. The composer may still matter for the control branch.",
    },
    "sinusoidal_media": {
        "index_meaning": "Period in minutes for the sinusoidal media oscillation",
        "min_valid_index": 1,
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "glc_2mM",
        "fixed_timeline": "sinusoidal minimal <-> minimal_GLC_2mM",
        "timeline_notice": "This variant initializes and updates its environment internally using sinusoidal mixing. Media selection is locked because the runtime uses the variant-managed sinusoidal media definition.",
        "index_options": [
            "1+: oscillation period in minutes",
            "0: invalid because a zero-period sinusoid is not supported",
        ],
    },
    "new_gene_internal_shift": {
        "index_meaning": "Combined condition/expression index",
        "min_valid_index": 0,
        "condition_stride": NEW_GENE_CONDITION_STRIDE,
        "valid_remainder_range": NEW_GENE_VALID_REMAINDER_RANGE,
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "timeline_notice": "This variant derives its starting timeline from the selected condition index and then applies internal gene-expression shifts by generation.",
    },
    "rrna_operon_knockout": {
        "index_meaning": "Paper-specific rRNA operon knockout branch",
        "index_range": [0, 18],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "conditional",
        "timeline_notice": "Non-control branches encode their own minimal, rich, or minimal-to-rich environment. Media selection is locked for those branches.",
        "index_options": [
            "0: control",
            "1-6: knock out one to six rRNA operons in minimal media",
            "7-12: knock out one to six rRNA operons in rich amino-acid media",
            "13-18: knock out one to six rRNA operons in a minimal-to-rich shift",
        ],
    },
    "rrna_location": {
        "index_meaning": "Paper-specific rRNA location branch",
        "index_range": [0, 3],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "conditional",
        "timeline_notice": "Non-control branches encode their own minimal, rich, or minimal-to-rich environment. Media selection is locked for those branches.",
        "index_options": [
            "0: control",
            "1: relocate rRNA genes in minimal media",
            "2: relocate rRNA genes in rich amino-acid media",
            "3: relocate rRNA genes in a minimal-to-rich shift",
        ],
    },
    "rrna_orientation": {
        "index_meaning": "Paper-specific rRNA orientation branch",
        "index_range": [0, 3],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "conditional",
        "timeline_notice": "Non-control branches encode their own minimal, rich, or minimal-to-rich environment. Media selection is locked for those branches.",
        "index_options": [
            "0: control",
            "1: reverse rRNA orientation in minimal media",
            "2: reverse rRNA orientation in rich amino-acid media",
            "3: reverse rRNA orientation in a minimal-to-rich shift",
        ],
    },
}


def _build_variant_hints(variant: Variant, session: Session) -> dict:
    hints = dict(VARIANT_PARAM_HINTS.get(variant.name, {
        "index_meaning": "Variant-specific parameter index",
        "supports_gene_lookup": False,
        "timeline_behavior": "composer",
    }))

    if variant.name == "condition":
        condition_options = _build_condition_index_options(session)
        if condition_options:
            hints["index_range"] = [0, len(condition_options) - 1]
            hints["index_options"] = condition_options

    elif variant.name == "ppgpp_conc":
        conditions = {condition.name: condition for condition in _list_conditions_in_variant_order(session)}
        index_options: list[str] = []
        for block_index, condition_name in enumerate(PPGPP_CONDITION_NAMES):
            condition = conditions.get(condition_name)
            condition_label = (
                f"{condition.name} ({condition.nutrients})"
                if condition and condition.nutrients
                else condition_name
            )
            for factor_index, factor in enumerate(PPGPP_FACTORS):
                index = block_index * len(PPGPP_FACTORS) + factor_index
                index_options.append(f"{index}: {condition_label}, {factor}x baseline ppGpp")
        hints["index_range"] = [0, len(index_options) - 1]
        hints["index_options"] = index_options
        hints["condition_names"] = PPGPP_CONDITION_NAMES

    elif variant.name == "tf_activity":
        tf_names, index_options = _build_tf_activity_index_options(session)
        exact_max_index = len(tf_names) * 2
        hints["tf_names"] = tf_names
        hints["tf_state_details"] = _load_tf_activity_specs(session)
        hints["max_exact_index"] = exact_max_index
        hints["control_period"] = exact_max_index + 1
        hints["index_options"] = index_options

    elif variant.name == "new_gene_internal_shift":
        condition_names, index_options = _build_new_gene_index_options(session)
        if condition_names:
            hints["condition_names"] = condition_names
            hints["condition_count"] = len(condition_names)
            hints["max_valid_index"] = (
                (len(condition_names) - 1) * NEW_GENE_CONDITION_STRIDE
                + NEW_GENE_VALID_REMAINDER_RANGE[1]
            )
        hints["index_options"] = index_options

    if "index_options" not in hints:
        index_options = _extract_index_options_from_docstring(variant.docstring)
        if index_options:
            hints["index_options"] = index_options

    return hints


def _condition_for_nutrients(session: Session, nutrients: str, default: str = "basal") -> str:
    condition = session.exec(
        select(Condition).where(Condition.nutrients == nutrients)
    ).first()
    return condition.name if condition else default


def _condition_name_for_index(session: Session, index: int, default: str = "basal") -> str:
    conditions = _list_conditions_in_variant_order(session)
    if 0 <= index < len(conditions):
        return conditions[index].name
    return default


def _tf_activity_environment(
    session: Session,
    variant_index: int,
    default_condition: str,
) -> tuple[str, str]:
    if variant_index <= 0:
        return default_condition or "basal", ""

    tf_names = _load_tf_activity_names(session)
    max_index = len(tf_names) * 2
    if variant_index > max_index:
        return default_condition or "basal", ""

    tf_name = tf_names[(variant_index - 1) // 2]
    status = "active" if variant_index % 2 == 1 else "inactive"
    spec = _load_tf_activity_specs(session).get(tf_name, {})
    nutrients = spec.get(f"{status}_nutrients") or "minimal"
    return _condition_for_nutrients(session, nutrients, default_condition or "basal"), ""


def _normalized_experiment_environment(
    session: Session,
    variant_type: str,
    variant_index: int,
    condition: str,
    timeline: str,
) -> tuple[str, str]:
    """Return the condition/timeline that should be recorded for an experiment.

    Variants that set sim_data.external_state.current_timeline_id internally
    should not persist a user-composed timeline, because the worker passes
    explicit timelines to runSim and stale timeline metadata also breaks WT
    matching. For these variants, record the comparison condition and leave the
    timeline empty so the variant owns the model environment.
    """
    base_condition = condition or "basal"

    if variant_type == "condition":
        return _condition_name_for_index(session, variant_index, base_condition), ""

    if variant_type in {"add_one_aa", "add_one_aa_shift"}:
        return "basal", ""

    if variant_type in {"remove_one_aa", "remove_one_aa_shift"}:
        return "with_aa", ""

    if variant_type == "remove_aas_shift":
        return ("basal" if variant_index == 3 else "with_aa"), ""

    if variant_type == "ppgpp_conc":
        block_index = variant_index // len(PPGPP_FACTORS)
        condition_name = (
            PPGPP_CONDITION_NAMES[block_index]
            if 0 <= block_index < len(PPGPP_CONDITION_NAMES)
            else base_condition
        )
        return condition_name, ""

    if variant_type == "tf_activity":
        if variant_index == 0:
            resolved_timeline = resolve_timeline_definition(session, timeline) if timeline else ""
            resolved_condition = (
                infer_condition_from_timeline(session, resolved_timeline, base_condition)
                if resolved_timeline
                else base_condition
            )
            return resolved_condition, resolved_timeline
        return _tf_activity_environment(session, variant_index, base_condition)

    if variant_type == "sinusoidal_media":
        return "glc_2mM", ""

    if variant_type == "new_gene_internal_shift":
        condition_index = variant_index // NEW_GENE_CONDITION_STRIDE
        return _condition_name_for_index(session, condition_index, base_condition), ""

    if variant_type in {"rrna_location", "rrna_orientation"} and variant_index > 0:
        if variant_index == 2:
            return "with_aa", ""
        return "basal", ""

    if variant_type == "rrna_operon_knockout" and variant_index > 0:
        if 7 <= variant_index <= 12:
            return "with_aa", ""
        return "basal", ""

    resolved_timeline = resolve_timeline_definition(session, timeline) if timeline else ""
    resolved_condition = (
        infer_condition_from_timeline(session, resolved_timeline, base_condition)
        if resolved_timeline
        else base_condition
    )
    return resolved_condition, resolved_timeline


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

    hints = _build_variant_hints(variant, session)

    return VariantDetailOut(
        name=variant.name,
        docstring=variant.docstring,
        filename=variant.filename,
        parameter_count=variant.parameter_count,
        parameter_hints=hints,
    )


# --- Wildtype helper ---

def _find_or_create_wildtype(
    session: Session,
    condition: str,
    timeline: str,
    sim_params: str,
    now: str,
    batch_id: str = "",
) -> int:
    """Find an existing wildtype experiment for this condition, or create one.

    Returns the experiment ID. Deduplicates across all statuses — a WT that's
    queued, running, or done is reused rather than creating a duplicate.
    """
    existing_wt = session.exec(
        select(Experiment).where(
            Experiment.variant_type == "wildtype",
            Experiment.condition == condition,
        ).order_by(
            # Prefer done > running > queued > draft
            Experiment.status.desc(),
            Experiment.created_at.desc(),
        )
    ).first()

    if existing_wt:
        logger.info("Reusing existing WT experiment #%d (%s) for condition '%s'",
                     existing_wt.id, existing_wt.status, condition)
        return existing_wt.id

    wt = Experiment(
        name=f"Wildtype control ({condition})",
        description=f"Auto-created wildtype baseline for condition '{condition}'",
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
    session.add(wt)
    session.flush()
    logger.info("Created WT experiment #%d for condition '%s'", wt.id, condition)
    return wt.id


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

    sim_params = body.sim_params
    gene_symbol = body.gene_symbol
    if body.variant_type == MULTI_GENE_KNOCKOUT_TYPE:
        if body.gene_symbol:
            raise HTTPException(400, "Use gene_symbols for multi_gene_knockout")
        sim_params, canonical_symbols, _ = with_multi_gene_targets(
            body.sim_params,
            body.gene_symbols,
            session,
        )
        body.variant_index = 0
        gene_symbol = ",".join(canonical_symbols)

    condition, timeline = _normalized_experiment_environment(
        session,
        body.variant_type,
        body.variant_index,
        body.condition or "basal",
        body.timeline or "",
    )

    experiment = Experiment(
        name=body.name,
        description=body.description,
        variant_type=body.variant_type,
        variant_index=body.variant_index,
        condition=condition,
        timeline=timeline,
        sim_params=sim_params,
        status="draft",
        created_at=now,
        updated_at=now,
        gene_symbol=gene_symbol,
    )
    session.add(experiment)
    session.flush()  # get the ID before potential WT creation

    # Auto-create wildtype control if requested
    wt_id: int | None = None
    if body.include_wildtype:
        wildtype_sim_params = (
            strip_multi_gene_targets(sim_params)
            if body.variant_type == MULTI_GENE_KNOCKOUT_TYPE
            else sim_params
        )
        wt_id = _find_or_create_wildtype(
            session, condition, timeline, wildtype_sim_params, now,
        )

    session.commit()
    session.refresh(experiment)

    out = ExperimentOut.model_validate(experiment, from_attributes=True)
    # Attach WT experiment ID in the response for the frontend
    if wt_id is not None:
        out.wildtype_experiment_id = wt_id
    return out


# ── Batch list, detail, and run ────────────────────────────────────────
# These MUST be defined before /{experiment_id} to avoid route conflicts.

class BatchSummary(BaseModel):
    batch_id: str
    name: str
    created_at: str
    total: int
    draft: int = 0
    queued: int = 0
    running: int = 0
    done: int = 0
    failed: int = 0
    cancelled: int = 0


class BatchDetail(BaseModel):
    batch_id: str
    name: str
    created_at: str
    total: int
    draft: int = 0
    queued: int = 0
    running: int = 0
    done: int = 0
    failed: int = 0
    cancelled: int = 0
    experiments: list[ExperimentOut]


class BatchRunResponse(BaseModel):
    batch_id: str
    queued: int
    skipped: int
    total_jobs: int
    message: str


class BatchControlResponse(BaseModel):
    batch_id: str
    cancelled: int = 0
    resumed: int = 0
    queued: int = 0
    skipped: int = 0
    total_jobs: int = 0
    message: str


def _batch_status_counts(experiments: list[Experiment]) -> dict[str, int]:
    status_counts = {
        "draft": 0,
        "queued": 0,
        "running": 0,
        "done": 0,
        "failed": 0,
        "cancelled": 0,
    }
    for exp in experiments:
        bucket = exp.status
        if bucket in ("running_parca", "running_sim", "ingesting"):
            bucket = "running"
        if bucket in status_counts:
            status_counts[bucket] += 1
    return status_counts


def _get_batch_experiments(batch_id: str, session: Session) -> list[Experiment]:
    experiments = session.exec(
        select(Experiment).where(Experiment.batch_id == batch_id)
    ).all()
    if not experiments:
        raise HTTPException(404, f"Batch not found: {batch_id}")
    return experiments


def _queue_draft_batch_experiments(
    batch_id: str,
    experiments: list[Experiment],
    session: Session,
) -> tuple[int, int, int]:
    queued_count = 0
    skipped_count = 0
    total_jobs = 0

    for exp in experiments:
        if exp.status != "draft":
            skipped_count += 1
            continue

        try:
            params = json.loads(exp.sim_params) if exp.sim_params else {}
        except Exception:
            params = {}

        body = RunJobRequest(
            seeds=params.get("seeds", params.get("seed", 1)),
            generations=params.get("generations", 1),
            condition=exp.condition,
        )

        try:
            resp = create_simulation_jobs_for_experiment(exp, body, session)
            total_jobs += len(resp.job_ids)
            queued_count += 1
        except HTTPException:
            skipped_count += 1

    return queued_count, skipped_count, total_jobs


@router.get("/batches", response_model=list[BatchSummary])
def list_batches(session: Session = Depends(get_session)):
    """List all batch groups with summary stats."""
    experiments = session.exec(
        select(Experiment).where(Experiment.batch_id != "")
    ).all()

    batches: dict[str, list[Experiment]] = {}
    for exp in experiments:
        batches.setdefault(exp.batch_id, []).append(exp)

    result: list[BatchSummary] = []
    for bid, exps in batches.items():
        status_counts = _batch_status_counts(exps)

        # Derive batch name from first experiment's description or common prefix
        first = min(exps, key=lambda e: e.created_at or "")
        name = first.description or f"Batch ({len(exps)} experiments)"

        result.append(BatchSummary(
            batch_id=bid,
            name=name,
            created_at=first.created_at,
            total=len(exps),
            **status_counts,
        ))

    result.sort(key=lambda b: b.created_at, reverse=True)
    return result


@router.get("/batches/{batch_id}", response_model=BatchDetail)
def get_batch_detail(batch_id: str, session: Session = Depends(get_session)):
    """Get full detail for a single batch including all experiments."""
    experiments = _get_batch_experiments(batch_id, session)
    status_counts = _batch_status_counts(experiments)

    first = min(experiments, key=lambda e: e.created_at or "")
    name = first.description or f"Batch ({len(experiments)} experiments)"

    exp_out = [
        ExperimentOut(
            id=e.id, name=e.name, description=e.description,
            variant_type=e.variant_type, variant_index=e.variant_index,
            condition=e.condition, timeline=e.timeline,
            sim_params=e.sim_params, status=e.status,
            created_at=e.created_at, updated_at=e.updated_at,
            gene_symbol=e.gene_symbol, batch_id=e.batch_id,
        )
        for e in sorted(experiments, key=lambda e: e.name)
    ]

    return BatchDetail(
        batch_id=batch_id,
        name=name,
        created_at=first.created_at,
        total=len(experiments),
        experiments=exp_out,
        **status_counts,
    )


@router.post("/batches/{batch_id}/run", response_model=BatchRunResponse)
def run_batch(batch_id: str, session: Session = Depends(get_session)):
    """Submit all draft experiments in a batch for simulation.

    Creates simulation jobs for each draft experiment using its sim_params.
    Experiments already queued/running/done are skipped.
    """
    experiments = _get_batch_experiments(batch_id, session)
    queued_count, skipped_count, total_jobs = _queue_draft_batch_experiments(batch_id, experiments, session)

    return BatchRunResponse(
        batch_id=batch_id,
        queued=queued_count,
        skipped=skipped_count,
        total_jobs=total_jobs,
        message=f"Queued {queued_count} experiments ({total_jobs} jobs), skipped {skipped_count}",
    )


@router.post("/batches/{batch_id}/cancel", response_model=BatchControlResponse)
def cancel_batch_run(batch_id: str, session: Session = Depends(get_session)):
    """Stop queued batch work while allowing the currently running job to finish."""
    experiments = _get_batch_experiments(batch_id, session)
    experiment_ids = [exp.id for exp in experiments if exp.id is not None]
    if not experiment_ids:
        raise HTTPException(404, f"Batch not found: {batch_id}")

    now = datetime.now(timezone.utc).isoformat()
    pending_jobs = session.exec(
        select(SimulationJob)
        .where(col(SimulationJob.experiment_id).in_(experiment_ids))
        .where(SimulationJob.status == "pending")
        .order_by(col(SimulationJob.id).asc())
    ).all()

    for job in pending_jobs:
        job.status = "cancelled"
        job.phase = "Cancelled"
        job.error_message = "Batch cancelled by user"
        job.finished_at = now
        session.add(job)

    cancelled_by_experiment: dict[int, list[SimulationJob]] = {}
    for job in pending_jobs:
        cancelled_by_experiment.setdefault(job.experiment_id, []).append(job)

    for exp in experiments:
        if exp.id not in cancelled_by_experiment:
            continue
        jobs = session.exec(select(SimulationJob).where(SimulationJob.experiment_id == exp.id)).all()
        if not any(job.status in ("pending", "running_parca", "running_sim", "ingesting") for job in jobs):
            exp.status = "cancelled"
            exp.updated_at = now
            session.add(exp)

    session.commit()
    return BatchControlResponse(
        batch_id=batch_id,
        cancelled=len(pending_jobs),
        message=(
            f"Stopped {len(pending_jobs)} queued job{'' if len(pending_jobs) == 1 else 's'}. "
            "The current running job will finish."
        ),
    )


@router.post("/batches/{batch_id}/resume", response_model=BatchControlResponse)
def resume_batch_run(batch_id: str, session: Session = Depends(get_session)):
    """Resume jobs stopped by batch cancellation, then queue remaining drafts."""
    experiments = _get_batch_experiments(batch_id, session)
    experiment_ids = [exp.id for exp in experiments if exp.id is not None]
    if not experiment_ids:
        raise HTTPException(404, f"Batch not found: {batch_id}")

    now = datetime.now(timezone.utc).isoformat()
    cancelled_jobs = session.exec(
        select(SimulationJob)
        .where(col(SimulationJob.experiment_id).in_(experiment_ids))
        .where(SimulationJob.status == "cancelled")
        .order_by(col(SimulationJob.id).asc())
    ).all()

    resumed_experiment_ids = {job.experiment_id for job in cancelled_jobs}
    for job in cancelled_jobs:
        job.status = "pending"
        job.phase = "Queued (resumed)"
        job.error_message = ""
        job.log_tail = ""
        job.started_at = ""
        job.finished_at = ""
        job.sim_dir = ""
        session.add(job)

    for exp in experiments:
        if exp.id in resumed_experiment_ids and exp.status in ("cancelled", "failed"):
            exp.status = "queued"
            exp.updated_at = now
            session.add(exp)

    session.commit()

    refreshed = _get_batch_experiments(batch_id, session)
    queued_count, skipped_count, total_jobs = _queue_draft_batch_experiments(batch_id, refreshed, session)
    return BatchControlResponse(
        batch_id=batch_id,
        resumed=len(cancelled_jobs),
        queued=queued_count,
        skipped=skipped_count,
        total_jobs=total_jobs,
        message=(
            f"Resumed {len(cancelled_jobs)} stopped job{'' if len(cancelled_jobs) == 1 else 's'} "
            f"and queued {queued_count} draft experiment{'' if queued_count == 1 else 's'}."
        ),
    )


@router.delete("/batches/{batch_id}", status_code=204)
def delete_batch_group(batch_id: str, session: Session = Depends(get_session)):
    """Delete a batch group and all non-active experiments/jobs/results in it."""
    delete_batch(batch_id, session)


# ── Multi-experiment comparison ────────────────────────────────────────
# Must be defined before /{experiment_id} to avoid route conflicts.

class ComparisonMetric(BaseModel):
    """Aggregated metric for one experiment in a comparison."""
    mean: Optional[float] = None
    std: Optional[float] = None
    n: int = 0

class ComparisonExperiment(BaseModel):
    """One experiment row in a comparison table."""
    experiment_id: int
    experiment_name: str
    gene_symbol: str
    variant_type: str
    variant_index: int
    condition: str
    is_wildtype: bool = False
    total_seeds: int = 0
    completed_seeds: int = 0
    divided_seeds: int = 0
    division_time_min: ComparisonMetric
    final_mass_fg: ComparisonMetric
    growth_rate: ComparisonMetric
    doubling_time_min: ComparisonMetric

class ComparisonDelta(BaseModel):
    """Delta between a knockout and the wildtype baseline."""
    experiment_id: int
    gene_symbol: str
    division_time_pct: Optional[float] = None
    final_mass_pct: Optional[float] = None
    growth_rate_pct: Optional[float] = None
    doubling_time_pct: Optional[float] = None

class WildtypeSuggestion(BaseModel):
    """Suggested wildtype experiment when none exists for the comparison condition."""
    condition: str
    variant_type: str = "wildtype"
    variant_index: int = 0
    message: str
    recommended_seeds: int = 4


class ComparisonResponse(BaseModel):
    """Multi-experiment comparison with optional wildtype baseline."""
    experiments: list[ComparisonExperiment]
    wildtype: Optional[ComparisonExperiment] = None
    wildtype_suggestion: Optional[WildtypeSuggestion] = None
    deltas: list[ComparisonDelta] = []


def _comparison_metric(values: list[Optional[float]]) -> ComparisonMetric:
    clean = [v for v in values if v is not None]
    n = len(clean)
    if n == 0:
        return ComparisonMetric(mean=None, std=None, n=0)
    mean = statistics.mean(clean)
    std = statistics.stdev(clean) if n > 1 else None
    return ComparisonMetric(
        mean=round(mean, 4),
        std=round(std, 4) if std is not None else None,
        n=n,
    )


def _build_comparison_experiment(
    experiment: Experiment,
    session: Session,
    is_wildtype: bool = False,
) -> ComparisonExperiment:
    """Build a ComparisonExperiment from an Experiment + its jobs/results."""
    jobs = session.exec(
        select(SimulationJob)
        .where(SimulationJob.experiment_id == experiment.id)
    ).all()

    completed = [j for j in jobs if j.status == "done"]

    div_times: list[Optional[float]] = []
    masses: list[Optional[float]] = []
    growth_rates: list[Optional[float]] = []
    doubling_times: list[Optional[float]] = []

    for job in completed:
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .order_by(SimulationResult.generation)
            .limit(1)
        ).first()
        if result:
            div_t = result.division_time_sec
            div_times.append(div_t / 60.0 if div_t is not None else None)
            masses.append(result.final_mass_fg)
            growth_rates.append(result.growth_rate)
            doubling_times.append(result.doubling_time_min)

    divided = sum(1 for d in div_times if d is not None)

    return ComparisonExperiment(
        experiment_id=experiment.id,
        experiment_name=experiment.name,
        gene_symbol=experiment.gene_symbol or ("wildtype" if is_wildtype else ""),
        variant_type=experiment.variant_type,
        variant_index=experiment.variant_index,
        condition=experiment.condition,
        is_wildtype=is_wildtype,
        total_seeds=len(jobs),
        completed_seeds=len(completed),
        divided_seeds=divided,
        division_time_min=_comparison_metric(div_times),
        final_mass_fg=_comparison_metric(masses),
        growth_rate=_comparison_metric(growth_rates),
        doubling_time_min=_comparison_metric(doubling_times),
    )


def _pct_change(ko_val: Optional[float], wt_val: Optional[float]) -> Optional[float]:
    """Percentage change from wildtype to knockout."""
    if ko_val is None or wt_val is None or wt_val == 0:
        return None
    return round(((ko_val - wt_val) / abs(wt_val)) * 100, 2)


@router.get("/compare", response_model=ComparisonResponse)
def compare_experiments(
    ids: str = Query(..., description="Comma-separated experiment IDs"),
    include_wildtype: bool = Query(True, description="Include wildtype baseline"),
    session: Session = Depends(get_session),
):
    """Compare multiple experiments side-by-side with optional wildtype baseline.

    Returns aggregated metrics for each experiment plus percentage deltas
    relative to a wildtype baseline (auto-detected or from the same condition).
    """
    exp_ids = [int(x.strip()) for x in ids.split(",") if x.strip()]
    if not exp_ids:
        raise HTTPException(400, "No experiment IDs provided")

    experiments_out: list[ComparisonExperiment] = []
    condition = None

    for eid in exp_ids:
        experiment = session.get(Experiment, eid)
        if not experiment:
            continue
        comp = _build_comparison_experiment(experiment, session, is_wildtype=False)
        experiments_out.append(comp)
        if condition is None:
            condition = experiment.condition

    if not experiments_out:
        raise HTTPException(404, "No valid experiments found")

    # Find wildtype baseline for the same condition
    wildtype_comp: Optional[ComparisonExperiment] = None
    wildtype_suggestion: Optional[WildtypeSuggestion] = None
    deltas: list[ComparisonDelta] = []

    if include_wildtype and condition:
        wt_experiment = session.exec(
            select(Experiment).where(
                Experiment.variant_type == "wildtype",
                Experiment.condition == condition,
                Experiment.status == "done",
            ).order_by(Experiment.created_at.desc())
        ).first()

        if wt_experiment:
            wildtype_comp = _build_comparison_experiment(
                wt_experiment, session, is_wildtype=True
            )

            # Compute deltas
            for comp in experiments_out:
                deltas.append(ComparisonDelta(
                    experiment_id=comp.experiment_id,
                    gene_symbol=comp.gene_symbol,
                    division_time_pct=_pct_change(
                        comp.division_time_min.mean,
                        wildtype_comp.division_time_min.mean
                    ),
                    final_mass_pct=_pct_change(
                        comp.final_mass_fg.mean,
                        wildtype_comp.final_mass_fg.mean
                    ),
                    growth_rate_pct=_pct_change(
                        comp.growth_rate.mean,
                        wildtype_comp.growth_rate.mean
                    ),
                    doubling_time_pct=_pct_change(
                        comp.doubling_time_min.mean,
                        wildtype_comp.doubling_time_min.mean
                    ),
                ))
        else:
            # No completed wildtype for this condition — check if one is in progress
            wt_pending = session.exec(
                select(Experiment).where(
                    Experiment.variant_type == "wildtype",
                    Experiment.condition == condition,
                    Experiment.status.in_(["draft", "queued", "running"]),
                )
            ).first()

            if wt_pending:
                wildtype_suggestion = WildtypeSuggestion(
                    condition=condition,
                    message=f"A wildtype simulation for '{condition}' is {wt_pending.status} (experiment #{wt_pending.id}). Deltas will appear once it completes.",
                    recommended_seeds=4,
                )
            else:
                wildtype_suggestion = WildtypeSuggestion(
                    condition=condition,
                    message=f"No wildtype baseline exists for condition '{condition}'. Create one to see relative fitness deltas.",
                    recommended_seeds=4,
                )

    return ComparisonResponse(
        experiments=experiments_out,
        wildtype=wildtype_comp,
        wildtype_suggestion=wildtype_suggestion,
        deltas=deltas,
    )


@router.get("/compare/batch/{batch_id}", response_model=ComparisonResponse)
def compare_batch(
    batch_id: str,
    include_wildtype: bool = Query(True),
    session: Session = Depends(get_session),
):
    """Compare all completed experiments in a batch."""
    experiments = session.exec(
        select(Experiment).where(Experiment.batch_id == batch_id)
    ).all()

    if not experiments:
        raise HTTPException(404, f"Batch not found: {batch_id}")

    completed = [e for e in experiments if e.status == "done"]
    if not completed:
        raise HTTPException(404, "No completed experiments in this batch")

    ids_str = ",".join(str(e.id) for e in completed)
    return compare_experiments(ids=ids_str, include_wildtype=include_wildtype, session=session)


# ── Wildtype delta for a single experiment ─────────────────────────────

class WildtypeDelta(BaseModel):
    """WT comparison metrics for a single experiment's results page."""
    has_wildtype: bool = False
    wt_experiment_id: int | None = None
    wt_status: str | None = None  # status of WT experiment
    division_time_pct: float | None = None
    final_mass_pct: float | None = None
    growth_rate_pct: float | None = None
    doubling_time_pct: float | None = None
    wt_division_time_min: float | None = None
    wt_final_mass_fg: float | None = None
    wt_growth_rate: float | None = None
    wt_doubling_time_min: float | None = None


@router.get("/wt-delta/{experiment_id}", response_model=WildtypeDelta)
def get_wt_delta(experiment_id: int, session: Session = Depends(get_session)):
    """Get wildtype comparison delta for a single experiment.

    Used by the results page to show % change vs WT on summary cards.
    """
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, f"Experiment {experiment_id} not found")

    condition = experiment.condition or "basal"

    # Find a completed wildtype for this condition
    wt_exp = session.exec(
        select(Experiment).where(
            Experiment.variant_type == "wildtype",
            Experiment.condition == condition,
            Experiment.status == "done",
        ).order_by(Experiment.created_at.desc())
    ).first()

    if not wt_exp:
        # Check for in-progress WT
        wt_pending = session.exec(
            select(Experiment).where(
                Experiment.variant_type == "wildtype",
                Experiment.condition == condition,
                Experiment.status.in_(["draft", "queued", "running",
                                       "running_parca", "running_sim", "ingesting"]),
            )
        ).first()
        return WildtypeDelta(
            has_wildtype=False,
            wt_experiment_id=wt_pending.id if wt_pending else None,
            wt_status=wt_pending.status if wt_pending else None,
        )

    # Build WT metrics
    wt_comp = _build_comparison_experiment(wt_exp, session, is_wildtype=True)

    # Build KO metrics
    ko_comp = _build_comparison_experiment(experiment, session, is_wildtype=False)

    return WildtypeDelta(
        has_wildtype=True,
        wt_experiment_id=wt_exp.id,
        wt_status="done",
        division_time_pct=_pct_change(
            ko_comp.division_time_min.mean, wt_comp.division_time_min.mean
        ),
        final_mass_pct=_pct_change(
            ko_comp.final_mass_fg.mean, wt_comp.final_mass_fg.mean
        ),
        growth_rate_pct=_pct_change(
            ko_comp.growth_rate.mean, wt_comp.growth_rate.mean
        ),
        doubling_time_pct=_pct_change(
            ko_comp.doubling_time_min.mean, wt_comp.doubling_time_min.mean
        ),
        wt_division_time_min=wt_comp.division_time_min.mean,
        wt_final_mass_fg=wt_comp.final_mass_fg.mean,
        wt_growth_rate=wt_comp.growth_rate.mean,
        wt_doubling_time_min=wt_comp.doubling_time_min.mean,
    )


# ── Single experiment CRUD (parameterized — must come after static paths) ──

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

    jobs = session.exec(
        select(SimulationJob).where(SimulationJob.experiment_id == experiment_id)
    ).all()
    for job in jobs:
        results = session.exec(
            select(SimulationResult).where(SimulationResult.job_id == job.id)
        ).all()
        for result in results:
            session.delete(result)
        session.delete(job)

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

@router.post("/batch", response_model=BatchResponse, status_code=201)
def create_batch_experiments(
    body: BatchRequest,
    session: Session = Depends(get_session),
):
    """Create a homogeneous typed batch."""
    return create_typed_batch(body, session)
