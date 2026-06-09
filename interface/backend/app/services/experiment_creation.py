"""Shared experiment creation helpers."""

from __future__ import annotations

import csv
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict
from sqlmodel import Session, col, select

from app.config import settings
from app.db.models import Condition, Experiment, Gene, TFEdge, Variant
from app.services.experiment_identity import experiment_environment_key
from app.services.multi_gene_knockout import (
    MULTI_GENE_KNOCKOUT_TYPE,
    strip_multi_gene_targets,
    with_multi_gene_targets,
)
from app.services.timelines import infer_condition_from_timeline, resolve_timeline_definition


logger = logging.getLogger(__name__)

PPGPP_FACTORS = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]
PPGPP_CONDITION_NAMES = ["basal", "with_aa"]
NEW_GENE_CONDITION_STRIDE = 1000


class ExperimentCreateData(BaseModel):
    name: str
    description: str = ""
    variant_type: str
    variant_index: int = 0
    condition: str = "basal"
    timeline: str = ""
    sim_params: str = "{}"
    gene_symbol: str = ""
    gene_symbols: list[str] = []
    include_wildtype: bool = False


class ExperimentCreateResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    experiment: Experiment
    wildtype_experiment_id: int | None = None


def _condition_name_for_index(session: Session, variant_index: int, fallback: str) -> str:
    condition = session.exec(select(Condition).order_by(Condition.id).offset(variant_index).limit(1)).first()
    return condition.name if condition else fallback


def _condition_for_nutrients(session: Session, nutrients: str, fallback: str) -> str:
    normalized = (nutrients or "").strip()
    if not normalized:
        return fallback
    condition = session.exec(select(Condition).where(Condition.nutrients == normalized)).first()
    return condition.name if condition else fallback


def _load_tf_activity_names(session: Session) -> list[str]:
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


def _load_tf_activity_specs(session: Session) -> dict[str, dict[str, str]]:
    known_tfs = {tf_symbol for tf_symbol in session.exec(select(TFEdge.tf_symbol)).all()}
    if not known_tfs or not settings.tf_condition_tsv.exists():
        return {}

    specs: dict[str, dict[str, str]] = {}
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
            "active_nutrients": (row.get("active nutrients") or "").strip().strip('"'),
            "inactive_nutrients": (row.get("inactive nutrients") or "").strip().strip('"'),
        }

    return specs


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


def normalized_experiment_environment(
    session: Session,
    variant_type: str,
    variant_index: int,
    condition: str,
    timeline: str,
) -> tuple[str, str]:
    """Return the persisted condition/timeline for a variant run."""
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


def _find_or_create_wildtype(
    session: Session,
    condition: str,
    timeline: str,
    sim_params: str,
    now: str,
    batch_id: str = "",
) -> int:
    target_key = experiment_environment_key(
        session,
        condition=condition,
        timeline=timeline,
        sim_params=sim_params,
    )
    existing_wts = session.exec(
        select(Experiment).where(
            Experiment.variant_type == "wildtype",
            Experiment.condition == condition,
        ).order_by(
            Experiment.status.desc(),
            Experiment.created_at.desc(),
        )
    ).all()

    for existing_wt in existing_wts:
        if existing_wt.id is None:
            continue
        existing_key = experiment_environment_key(
            session,
            condition=existing_wt.condition,
            timeline=existing_wt.timeline,
            sim_params=existing_wt.sim_params,
        )
        if existing_key == target_key:
            logger.info(
                "Reusing existing WT experiment #%d (%s) for condition '%s'",
                existing_wt.id,
                existing_wt.status,
                condition,
            )
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
    return wt.id or 0


def create_experiment_record(session: Session, data: ExperimentCreateData) -> ExperimentCreateResult:
    """Create an experiment using the same persisted semantics as the public API."""
    now = datetime.now(timezone.utc).isoformat()

    variant = session.exec(select(Variant).where(Variant.name == data.variant_type)).first()
    if not variant:
        raise HTTPException(400, f"Unknown variant type: {data.variant_type}")

    variant_index = data.variant_index
    gene_symbol = data.gene_symbol
    if data.variant_type == "gene_knockout" and data.gene_symbol:
        gene = session.exec(select(Gene).where(col(Gene.symbol).ilike(data.gene_symbol))).first()
        if not gene:
            raise HTTPException(400, f"Unknown gene: {data.gene_symbol}")
        variant_index = gene.ko_index

    sim_params = data.sim_params
    if data.variant_type == MULTI_GENE_KNOCKOUT_TYPE:
        if data.gene_symbol:
            raise HTTPException(400, "Use gene_symbols for multi_gene_knockout")
        sim_params, canonical_symbols, _ = with_multi_gene_targets(
            data.sim_params,
            data.gene_symbols,
            session,
        )
        variant_index = 0
        gene_symbol = ",".join(canonical_symbols)

    condition, timeline = normalized_experiment_environment(
        session,
        data.variant_type,
        variant_index,
        data.condition or "basal",
        data.timeline or "",
    )

    # Validate sim_params early so assistant-created records are not opaque bad JSON.
    try:
        decoded_params: Any = json.loads(sim_params or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid sim_params JSON: {exc.msg}") from exc
    if not isinstance(decoded_params, dict):
        raise HTTPException(400, "sim_params must be a JSON object")

    experiment = Experiment(
        name=data.name,
        description=data.description,
        variant_type=data.variant_type,
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

    wt_id: int | None = None
    if data.include_wildtype:
        wildtype_sim_params = (
            strip_multi_gene_targets(sim_params)
            if data.variant_type == MULTI_GENE_KNOCKOUT_TYPE
            else sim_params
        )
        wt_id = _find_or_create_wildtype(session, condition, timeline, wildtype_sim_params, now)

    session.commit()
    session.refresh(experiment)

    return ExperimentCreateResult(experiment=experiment, wildtype_experiment_id=wt_id)
