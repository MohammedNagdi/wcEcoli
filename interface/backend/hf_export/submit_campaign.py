"""Submit the campaign matrix as experiments + queued jobs (the generation side).

This only *enqueues* — the platform's worker runs the sims (per your plan: "running happens from the
Platform"). Use `--dry-run` to validate the whole campaign (gene/condition resolution, counts) WITHOUT
creating anything. Drop `--dry-run` to actually create experiments and queue jobs; then run the
exporter on the completed jobs.

    docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --limit 8
    docker exec interface-api-1 python -m hf_export.submit_campaign --limit 8      # real submit

Implemented campaign tiers cover the legacy `v0` pilot plus T2-T5. T3 direct dynamics, T4
regulatory variants, and T5 multi-gene knockouts are submitted through the same experiment-creation
contract used by the app. T6 genome-design variants remain a documented follow-up.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import settings
from app.db.engine import make_sqlite_engine
from app.db.models import Condition, Gene, TFEdge, Timeline, Variant
from app.services.experiment_creation import (
    PPGPP_CONDITION_NAMES,
    PPGPP_FACTORS,
    ExperimentCreateData,
    _load_tf_activity_names,
    create_experiment_record,
)
from app.services.job_queue import RunJobRequest, create_simulation_jobs_for_experiment
from app.services.multi_gene_knockout import MULTI_GENE_KNOCKOUT_TYPE, resolve_multi_gene_targets

from .matrix import (
    GENERATIONS,
    KO_TARGET,
    SEEDS,
    SUPPORTED_TIERS,
    T2_CORE_CONDITIONS,
    T2_CORE_NONESSENTIAL_PER_CATEGORY,
    T2_EXTENDED_ESSENTIAL_TARGET,
    T2_EXTENDED_NONESSENTIAL_PER_CATEGORY,
    T5_PAIR_DEFINITIONS,
    TIER_T2_CORE,
    TIER_T2_EXTENDED,
    T3_ESSENTIAL_TARGET,
    T3_NONESSENTIAL_TARGET,
    TIER_T3,
    TIER_T4,
    TIER_T5,
    TIER_V0,
    CampaignCell,
    t3_campaign,
    t4_campaign,
    t5_campaign,
    t2_core_campaign,
    t2_extended_campaign,
    v0_campaign,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("submit_campaign")

_SUBMITTABLE_DYNAMIC = {"timelines"}  # via the platform timeline mechanism
_T3_DIRECT_SUBMITTABLE_VARIANTS = {
    "sinusoidal_media",
    "add_one_aa_shift",
    "remove_one_aa_shift",
    "remove_aas_shift",
}
_T4_DIRECT_SUBMITTABLE_VARIANTS = {
    "tf_activity",
    "ppgpp_conc",
}


def _strip_quotes(value: str) -> str:
    return value.strip().strip('"')


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _campaign_ledger_path() -> Path:
    return settings.database_path.parent / "campaign_ledger.jsonl"


def default_campaign_id(tiers: list[str], seeds: int, generations: int) -> str:
    payload = {"tiers": tiers, "seeds": seeds, "generations": generations, "matrix_version": "t1-t5"}
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:16]


def campaign_cell_key(cell: CampaignCell, plan: dict[str, Any], *, campaign_id: str, seeds: int, generations: int) -> str:
    payload = {
        "campaign_id": campaign_id,
        "tier": cell.tier,
        "label": cell.label,
        "variant_type": plan.get("variant_type", cell.variant_type),
        "condition": plan.get("condition", cell.condition),
        "variant_index": plan.get("variant_index", 0),
        "gene": plan.get("gene", ""),
        "genes": plan.get("genes", []),
        "events": cell.params.get("events", ""),
        "protocol": cell.params.get("protocol", ""),
        "sim_params": cell.params.get("sim_params", {}),
        "seeds": list(range(seeds)),
        "generations": generations,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _read_campaign_ledger(path: Path | None = None) -> dict[str, dict[str, Any]]:
    path = path or _campaign_ledger_path()
    if not path.exists():
        return {}
    entries: dict[str, dict[str, Any]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            cell_key = row.get("cell_key")
            if cell_key:
                entries[cell_key] = row
    return entries


def _append_campaign_ledger(row: dict[str, Any], path: Path | None = None) -> None:
    path = path or _campaign_ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True, default=str) + "\n")


def _essential_genes_path() -> Path:
    module_path = Path(__file__).resolve()
    candidates = [
        settings.wcecoli_root / "validation" / "ecoli" / "flat" / "essential_genes.tsv",
        module_path.parent / "essential_genes.tsv",
        Path.cwd() / "validation" / "ecoli" / "flat" / "essential_genes.tsv",
    ]
    candidates.extend(
        parent / "validation" / "ecoli" / "flat" / "essential_genes.tsv"
        for parent in module_path.parents
    )
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


def load_essential_gene_symbols(path: Path | None = None) -> list[str]:
    """Load the essential-gene order used for fixed T2 selection."""
    path = path or _essential_genes_path()
    if not path.exists():
        logger.warning("essential genes file not found: %s", path)
        return []

    with path.open(encoding="utf-8") as handle:
        reader = csv.DictReader((line for line in handle if not line.startswith("#")), delimiter="\t")
        return [_strip_quotes(row["gene"]) for row in reader if row.get("gene")]


def resolve_ko_genes(session: Session, explicit: list[str] | None) -> list[str]:
    """Curated knockout list. Explicit wins; else first KO_TARGET knockout-ready genes.

    NOTE: essentiality-first selection is a follow-up — for now this is a stable alphabetical
    knockout-ready sample, which is enough to validate submission + export.
    """
    if explicit:
        return explicit
    genes = session.exec(select(Gene).where(Gene.ko_index > 0).order_by(Gene.symbol)).all()
    return [g.symbol for g in genes[:KO_TARGET] if g.symbol]


def _sample_nonessential_by_category(
    genes: list[Gene],
    essential_symbols: set[str],
    per_category: int,
) -> list[Gene]:
    grouped: dict[str, list[Gene]] = defaultdict(list)
    for gene in genes:
        if gene.symbol in essential_symbols:
            continue
        grouped[gene.category or "other"].append(gene)

    sampled: list[Gene] = []
    for category in sorted(grouped):
        sampled.extend(sorted(grouped[category], key=lambda gene: gene.symbol)[:per_category])
    return sampled


def _sample_nonessential_round_robin(
    genes: list[Gene],
    essential_symbols: set[str],
    target: int,
) -> list[Gene]:
    grouped: dict[str, list[Gene]] = defaultdict(list)
    for gene in genes:
        if gene.symbol in essential_symbols:
            continue
        grouped[gene.category or "other"].append(gene)

    for category in grouped:
        grouped[category] = sorted(grouped[category], key=lambda gene: gene.symbol)

    sampled: list[Gene] = []
    categories = sorted(grouped)
    index = 0
    while len(sampled) < target and any(grouped[category] for category in categories):
        category = categories[index % len(categories)]
        if grouped[category]:
            sampled.append(grouped[category].pop(0))
        index += 1
    return sampled


def resolve_t2_gene_sets(
    session: Session,
    essential_symbols: list[str] | None = None,
) -> dict[str, Any]:
    """Resolve deterministic T2 Core and Extended gene sets from DB + essential list."""
    ko_ready = session.exec(select(Gene).where(Gene.ko_index > 0).order_by(Gene.symbol)).all()
    by_symbol = {gene.symbol: gene for gene in ko_ready if gene.symbol}
    essential_order = essential_symbols if essential_symbols is not None else load_essential_gene_symbols()

    essential_genes: list[Gene] = []
    seen: set[str] = set()
    for symbol in essential_order:
        gene = by_symbol.get(symbol)
        if gene and symbol not in seen:
            essential_genes.append(gene)
            seen.add(symbol)

    essential_set = {gene.symbol for gene in essential_genes}
    core_nonessential = _sample_nonessential_by_category(
        ko_ready,
        essential_set,
        T2_CORE_NONESSENTIAL_PER_CATEGORY,
    )
    extended_nonessential = _sample_nonessential_by_category(
        ko_ready,
        essential_set,
        T2_EXTENDED_NONESSENTIAL_PER_CATEGORY,
    )

    core_genes = essential_genes + core_nonessential
    extended_genes = essential_genes[:T2_EXTENDED_ESSENTIAL_TARGET] + extended_nonessential

    return {
        "core": [gene.symbol for gene in core_genes],
        "extended": [gene.symbol for gene in extended_genes],
        "essential_ko_ready": [gene.symbol for gene in essential_genes],
        "core_category_counts": dict(Counter(gene.category or "other" for gene in core_genes)),
        "extended_category_counts": dict(Counter(gene.category or "other" for gene in extended_genes)),
        "nonessential_ko_ready_categories": sorted({
            gene.category or "other" for gene in ko_ready if gene.symbol not in essential_set
        }),
    }


def resolve_t3_gene_set(
    session: Session,
    essential_symbols: list[str] | None = None,
) -> dict[str, Any]:
    """Resolve the deterministic KO subset used by T3 timeline protocols."""
    ko_ready = session.exec(select(Gene).where(Gene.ko_index > 0).order_by(Gene.symbol)).all()
    by_symbol = {gene.symbol: gene for gene in ko_ready if gene.symbol}
    essential_order = essential_symbols if essential_symbols is not None else load_essential_gene_symbols()

    essential_genes: list[Gene] = []
    seen: set[str] = set()
    for symbol in essential_order:
        gene = by_symbol.get(symbol)
        if gene and symbol not in seen:
            essential_genes.append(gene)
            seen.add(symbol)
        if len(essential_genes) >= T3_ESSENTIAL_TARGET:
            break

    essential_set = {gene.symbol for gene in essential_genes}
    nonessential_genes = _sample_nonessential_round_robin(
        ko_ready,
        essential_set,
        T3_NONESSENTIAL_TARGET,
    )
    genes = essential_genes + nonessential_genes

    return {
        "genes": [gene.symbol for gene in genes],
        "essential_genes": [gene.symbol for gene in essential_genes],
        "nonessential_genes": [gene.symbol for gene in nonessential_genes],
        "category_counts": dict(Counter(gene.category or "other" for gene in genes)),
    }


def resolve_t4_regulatory_set(session: Session) -> dict[str, Any]:
    """Resolve the deterministic regulatory set used by T4."""
    tf_names = _load_tf_activity_names(session)
    tf_network_symbols = {
        symbol for symbol in session.exec(select(TFEdge.tf_symbol)).all() if symbol
    }
    ppgpp_indices = list(range(len(PPGPP_FACTORS) * len(PPGPP_CONDITION_NAMES)))

    return {
        "tf_names": tf_names,
        "tf_activity_cells": len(tf_names) * 2,
        "tf_network_tfs": len(tf_network_symbols),
        "tf_uncovered_count": len(tf_network_symbols - set(tf_names)),
        "ppgpp_indices": ppgpp_indices,
        "ppgpp_cells": len(ppgpp_indices),
    }


def resolve_t5_pair_set(session: Session) -> dict[str, Any]:
    """Resolve and validate the deterministic curated pair set used by T5."""
    valid_pairs: list[dict[str, Any]] = []
    invalid_pairs: list[dict[str, Any]] = []

    for pair in T5_PAIR_DEFINITIONS:
        genes = list(pair["genes"])
        pair_class = pair.get("pair_class", "curated_pair")
        pair_label = pair.get("pair_label") or "+".join(genes)
        try:
            canonical_genes, ko_indices = resolve_multi_gene_targets(session, genes)
        except HTTPException as exc:
            invalid_pairs.append({
                "genes": genes,
                "pair_class": pair_class,
                "pair_label": pair_label,
                "reason": str(exc.detail),
            })
            continue
        valid_pairs.append({
            "genes": canonical_genes,
            "ko_indices": ko_indices,
            "pair_class": pair_class,
            "pair_label": "+".join(canonical_genes),
        })

    return {
        "pair_definitions": len(T5_PAIR_DEFINITIONS),
        "valid_pairs": valid_pairs,
        "invalid_pairs": invalid_pairs,
        "pair_class_counts": dict(Counter(pair["pair_class"] for pair in valid_pairs)),
    }


def parse_tiers(raw: str) -> list[str]:
    tiers = [_strip_quotes(tier).upper() for tier in raw.split(",") if tier.strip()]
    tiers = [TIER_V0 if tier == TIER_V0.upper() else tier for tier in tiers]
    if not tiers:
        return [TIER_V0]

    unsupported = [tier for tier in tiers if tier not in SUPPORTED_TIERS]
    if unsupported:
        raise ValueError(f"Unsupported tier(s): {', '.join(unsupported)}")

    deduped: list[str] = []
    for tier in tiers:
        if tier not in deduped:
            deduped.append(tier)
    return deduped


def _deduplicate_cells(cells: list[CampaignCell]) -> list[CampaignCell]:
    seen: set[tuple[str, str | None, str, str, str, str, str, str]] = set()
    deduped: list[CampaignCell] = []
    for cell in cells:
        key = (
            cell.variant_type,
            cell.condition,
            str(cell.params.get("gene", "")),
            json.dumps(sorted(cell.params.get("genes", []))),
            str(cell.params.get("events", "")),
            str(cell.params.get("variant_index", "")),
            str(cell.params.get("protocol", "")),
            json.dumps(cell.params.get("sim_params", {}), sort_keys=True),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(cell)
    return deduped


def build_campaign_cells(
    session: Session,
    tiers: list[str],
    genes: list[str] | None,
) -> tuple[list[CampaignCell], dict[str, Any]]:
    cells: list[CampaignCell] = []
    metadata: dict[str, Any] = {}

    if TIER_V0 in tiers:
        ko_genes = resolve_ko_genes(session, genes)
        cells.extend(v0_campaign(ko_genes))
        metadata["v0_ko_genes_resolved"] = len(ko_genes)

    t2_gene_sets: dict[str, Any] | None = None
    if TIER_T2_CORE in tiers or TIER_T2_EXTENDED in tiers:
        t2_gene_sets = resolve_t2_gene_sets(session)
        metadata["t2"] = {
            "essential_ko_ready": len(t2_gene_sets["essential_ko_ready"]),
            "core_genes": len(t2_gene_sets["core"]),
            "extended_genes": len(t2_gene_sets["extended"]),
            "nonessential_ko_ready_categories": len(t2_gene_sets["nonessential_ko_ready_categories"]),
            "core_category_counts": t2_gene_sets["core_category_counts"],
            "extended_category_counts": t2_gene_sets["extended_category_counts"],
        }

    if TIER_T2_CORE in tiers and t2_gene_sets:
        cells.extend(t2_core_campaign(t2_gene_sets["core"]))
    if TIER_T2_EXTENDED in tiers and t2_gene_sets:
        cells.extend(t2_extended_campaign(t2_gene_sets["extended"]))

    if TIER_T3 in tiers:
        t3_gene_set = resolve_t3_gene_set(session)
        t3_cells = t3_campaign(t3_gene_set["genes"])
        cells.extend(t3_cells)
        metadata["t3"] = {
            "ko_genes": len(t3_gene_set["genes"]),
            "essential_genes": len(t3_gene_set["essential_genes"]),
            "nonessential_genes": len(t3_gene_set["nonessential_genes"]),
            "category_counts": t3_gene_set["category_counts"],
            "timeline_cells": sum(1 for cell in t3_cells if cell.variant_type == "timelines"),
            "sinusoidal_cells": sum(1 for cell in t3_cells if cell.variant_type == "sinusoidal_media"),
            "aa_shift_cells": sum(1 for cell in t3_cells if cell.variant_type in {
                "add_one_aa_shift",
                "remove_one_aa_shift",
                "remove_aas_shift",
            }),
        }

    if TIER_T4 in tiers:
        t4_regulatory_set = resolve_t4_regulatory_set(session)
        t4_cells = t4_campaign(t4_regulatory_set["tf_names"], t4_regulatory_set["ppgpp_indices"])
        cells.extend(t4_cells)
        metadata["t4"] = {
            "tf_activity_tfs": len(t4_regulatory_set["tf_names"]),
            "tf_activity_cells": t4_regulatory_set["tf_activity_cells"],
            "tf_network_tfs": t4_regulatory_set["tf_network_tfs"],
            "tf_uncovered_count": t4_regulatory_set["tf_uncovered_count"],
            "ppgpp_cells": t4_regulatory_set["ppgpp_cells"],
            "total_cells": len(t4_cells),
        }

    if TIER_T5 in tiers:
        t5_pair_set = resolve_t5_pair_set(session)
        t5_cells = t5_campaign(t5_pair_set["valid_pairs"])
        cells.extend(t5_cells)
        metadata["t5"] = {
            "pair_definitions": t5_pair_set["pair_definitions"],
            "valid_pairs": len(t5_pair_set["valid_pairs"]),
            "invalid_pairs": t5_pair_set["invalid_pairs"],
            "conditions": T2_CORE_CONDITIONS,
            "cells": len(t5_cells),
            "pair_class_counts": t5_pair_set["pair_class_counts"],
        }

    return _deduplicate_cells(cells), metadata


def _required_condition_missing(session: Session, condition_names: list[str]) -> str:
    for condition_name in condition_names:
        condition = session.exec(select(Condition).where(Condition.name == condition_name)).first()
        if not condition:
            return condition_name
    return ""


def plan_cell(session: Session, cell: CampaignCell) -> dict[str, Any]:
    """Resolve one campaign cell into a submittable plan item (no side effects)."""
    base = {"label": cell.label, "variant_type": cell.variant_type, "condition": cell.condition,
            "gene": cell.params.get("gene", ""), "variant_index": 0, "timeline": "",
            "submittable": True, "reason": "", "tier": cell.tier}

    if not session.exec(select(Variant).where(Variant.name == cell.variant_type)).first():
        return {**base, "submittable": False, "reason": f"variant '{cell.variant_type}' not found"}
    try:
        json.dumps(cell.params.get("sim_params", {}), sort_keys=True)
    except (TypeError, ValueError) as exc:
        return {**base, "submittable": False, "reason": f"invalid sim_params: {exc}"}

    if cell.variant_type == "wildtype":
        if cell.condition and not session.exec(select(Condition).where(Condition.name == cell.condition)).first():
            return {**base, "submittable": False, "reason": f"condition '{cell.condition}' not found"}
        return base

    if cell.variant_type == "gene_knockout":
        gene = session.exec(select(Gene).where(Gene.symbol == cell.params.get("gene"))).first()
        if not gene or not gene.ko_index or gene.ko_index <= 0:
            return {**base, "submittable": False, "reason": f"gene '{cell.params.get('gene')}' not knockout-ready"}
        if cell.condition and not session.exec(select(Condition).where(Condition.name == cell.condition)).first():
            return {**base, "submittable": False, "reason": f"condition '{cell.condition}' not found"}
        return {**base, "variant_index": gene.ko_index}

    if cell.variant_type in _SUBMITTABLE_DYNAMIC:
        # Dynamic media via a timeline reference; the timeline row is created at submit time.
        if not cell.params.get("events"):
            return {**base, "submittable": False, "reason": "timeline events are required"}
        gene_symbol = cell.params.get("gene", "")
        if gene_symbol:
            gene = session.exec(select(Gene).where(Gene.symbol == gene_symbol)).first()
            if not gene or not gene.ko_index or gene.ko_index <= 0:
                return {**base, "submittable": False, "reason": f"gene '{gene_symbol}' not knockout-ready"}
            return {
                **base,
                "timeline": cell.label.replace("/", "_"),
                "condition": None,
                "variant_index": gene.ko_index,
            }
        return {**base, "timeline": cell.label.replace("/", "_"), "condition": None}

    if cell.variant_type in _T3_DIRECT_SUBMITTABLE_VARIANTS and cell.tier == TIER_T3:
        return {**base, "variant_index": int(cell.params.get("variant_index", 0))}

    if cell.variant_type == "tf_activity" and cell.tier == TIER_T4:
        variant_index = int(cell.params.get("variant_index", 0))
        tf_names = _load_tf_activity_names(session)
        max_index = len(tf_names) * 2
        if variant_index <= 0:
            return {**base, "submittable": False, "reason": "tf_activity index 0 is not emitted by T4"}
        if variant_index > max_index:
            return {**base, "submittable": False,
                    "reason": f"tf_activity index {variant_index} exceeds max {max_index}"}
        mapped_tf = tf_names[(variant_index - 1) // 2]
        mapped_state = "active" if variant_index % 2 == 1 else "inactive"
        return {
            **base,
            "variant_index": variant_index,
            "tf": mapped_tf,
            "tf_state": mapped_state,
        }

    if cell.variant_type == "ppgpp_conc" and cell.tier == TIER_T4:
        variant_index = int(cell.params.get("variant_index", 0))
        max_index = len(PPGPP_FACTORS) * len(PPGPP_CONDITION_NAMES) - 1
        if variant_index < 0 or variant_index > max_index:
            return {**base, "submittable": False,
                    "reason": f"ppgpp_conc index {variant_index} outside 0..{max_index}"}
        missing_condition = _required_condition_missing(session, PPGPP_CONDITION_NAMES)
        if missing_condition:
            return {**base, "submittable": False, "reason": f"condition '{missing_condition}' not found"}
        block_index = variant_index // len(PPGPP_FACTORS)
        factor_index = variant_index % len(PPGPP_FACTORS)
        return {
            **base,
            "variant_index": variant_index,
            "ppgpp_condition": PPGPP_CONDITION_NAMES[block_index],
            "ppgpp_factor": PPGPP_FACTORS[factor_index],
        }

    if cell.variant_type == MULTI_GENE_KNOCKOUT_TYPE and cell.tier == TIER_T5:
        if cell.condition and not session.exec(select(Condition).where(Condition.name == cell.condition)).first():
            return {**base, "submittable": False, "reason": f"condition '{cell.condition}' not found"}
        try:
            canonical_genes, ko_indices = resolve_multi_gene_targets(session, cell.params.get("genes", []))
        except HTTPException as exc:
            return {**base, "submittable": False, "reason": str(exc.detail)}
        return {
            **base,
            "variant_index": 0,
            "genes": canonical_genes,
            "ko_indices": ko_indices,
            "pair_class": cell.params.get("pair_class", ""),
        }

    return {**base, "submittable": False,
            "reason": f"variant_type '{cell.variant_type}' not yet submittable via create_experiment"}


def submit_cell(session: Session, cell: CampaignCell, plan: dict[str, Any], seeds: int, generations: int) -> dict[str, Any]:
    """Create the experiment + queue jobs for one (submittable) cell. Returns ids."""
    timeline_name = ""
    sim_params = json.dumps(cell.params.get("sim_params", {}), sort_keys=True)
    if cell.variant_type in _SUBMITTABLE_DYNAMIC:
        # Register the timeline (events string) so the experiment can reference it.
        timeline_name = plan["timeline"]
        if not session.exec(select(Timeline).where(Timeline.name == timeline_name)).first():
            session.add(Timeline(name=timeline_name, definition=cell.params.get("events", "")))
            session.commit()
        if plan["gene"]:
            variant_type, gene_symbol, variant_index = "gene_knockout", plan["gene"], plan["variant_index"]
        else:
            variant_type, gene_symbol, variant_index = "wildtype", "", 0
        condition = "basal"
    else:
        variant_type = cell.variant_type
        gene_symbol = plan["gene"]
        variant_index = plan["variant_index"]
        condition = cell.condition or "basal"
    gene_symbols = plan.get("genes", []) if variant_type == MULTI_GENE_KNOCKOUT_TYPE else []

    result = create_experiment_record(session, ExperimentCreateData(
        name=f"[{cell.tier}] {cell.label}", description=f"wcEcoli HF dataset {cell.tier} campaign.",
        variant_type=variant_type, variant_index=variant_index, condition=condition,
        timeline=timeline_name, gene_symbol=gene_symbol, gene_symbols=gene_symbols, sim_params=sim_params,
    ))
    jobs = create_simulation_jobs_for_experiment(
        result.experiment,
        RunJobRequest(condition=result.experiment.condition, seed_values=list(range(seeds)), generations=generations),
        session,
    )
    return {"experiment_id": result.experiment.id, "job_ids": jobs.job_ids}


def stratified_sample(cells: list[CampaignCell], n: int) -> list[CampaignCell]:
    """Round-robin across variant families so a small pilot spans WT + KO + dynamics, not just the
    alphabetical head (which is all WT)."""
    from collections import defaultdict

    groups: dict[str, list[CampaignCell]] = defaultdict(list)
    for cell in cells:
        groups[cell.variant_type].append(cell)
    families = list(groups)
    picked: list[CampaignCell] = []
    i = 0
    while len(picked) < n and any(groups[f] for f in families):
        family = families[i % len(families)]
        if groups[family]:
            picked.append(groups[family].pop(0))
        i += 1
    return picked


def run(*, limit: int | None, dry_run: bool, seeds: int, generations: int,
        genes: list[str] | None, sample: int | None = None, tiers: list[str] | None = None,
        campaign_id: str | None = None) -> dict[str, Any]:
    tiers = tiers or [TIER_V0]
    campaign_id = campaign_id or default_campaign_id(tiers, seeds, generations)
    engine = make_sqlite_engine(settings.database_path)
    with Session(engine) as session:
        cells, campaign_metadata = build_campaign_cells(session, tiers, genes)
        ko_gene_symbols: set[str] = set()
        for cell in cells:
            if cell.params.get("gene"):
                ko_gene_symbols.add(cell.params["gene"])
            ko_gene_symbols.update(cell.params.get("genes", []))
        ko_genes_resolved = len(ko_gene_symbols)
        if sample:
            cells = stratified_sample(cells, sample)  # diverse mini-pilot; takes precedence over --limit
        elif limit:
            cells = cells[:limit]
        plans = [(cell, plan_cell(session, cell)) for cell in cells]
        submittable = [(c, p) for c, p in plans if p["submittable"]]
        skipped = [(c, p) for c, p in plans if not p["submittable"]]
        ledger = _read_campaign_ledger()
        ledger_existing = 0
        for cell, plan in submittable:
            cell_key = campaign_cell_key(cell, plan, campaign_id=campaign_id, seeds=seeds, generations=generations)
            existing = ledger.get(cell_key)
            if existing and existing.get("experiment_id") and existing.get("job_ids"):
                ledger_existing += 1

        skipped_reasons = [{"label": p["label"], "reason": p["reason"]} for _, p in skipped][:20]
        reason_counts = Counter(p["reason"] for _, p in skipped)

        summary: dict[str, Any] = {
            "dry_run": dry_run, "campaign_id": campaign_id, "tiers": tiers, "seeds": seeds,
            "seed_values": list(range(seeds)), "generations": generations,
            "ko_genes_resolved": ko_genes_resolved,
            "cells_total": len(cells), "submittable": len(submittable), "skipped": len(skipped),
            "skipped_reasons": skipped_reasons,
            "missing_variants": sum(count for reason, count in reason_counts.items() if reason.startswith("variant '")),
            "missing_conditions": sum(count for reason, count in reason_counts.items() if reason.startswith("condition '")),
            "invalid_indices": sum(count for reason, count in reason_counts.items() if "index" in reason),
            "invalid_sim_params": sum(count for reason, count in reason_counts.items() if reason.startswith("invalid sim_params")),
            "ledger_existing": ledger_existing,
            "estimated_jobs": len(submittable) * seeds,
            "estimated_trajectories": len(submittable) * seeds * generations,
            "tier_counts": dict(Counter(cell.tier for cell in cells)),
            "campaign_metadata": campaign_metadata,
        }
        if dry_run:
            summary["plan_sample"] = [
                {"tier": p["tier"], "label": p["label"], "variant_type": p["variant_type"], "condition": p["condition"],
                 "gene": p["gene"], "variant_index": p["variant_index"],
                 "genes": p.get("genes", []), "ko_indices": p.get("ko_indices", []),
                 "pair_class": p.get("pair_class", ""),
                 "tf": p.get("tf", ""), "tf_state": p.get("tf_state", ""),
                 "ppgpp_condition": p.get("ppgpp_condition", ""), "ppgpp_factor": p.get("ppgpp_factor", ""),
                 "protocol": c.params.get("protocol", ""), "events": c.params.get("events", ""),
                 "sim_params": c.params.get("sim_params", {})}
                for c, p in submittable[:12]
            ]
            return summary

        created = []
        reused = []
        for cell, plan in submittable:
            cell_key = campaign_cell_key(cell, plan, campaign_id=campaign_id, seeds=seeds, generations=generations)
            existing = ledger.get(cell_key)
            if existing and existing.get("experiment_id") and existing.get("job_ids"):
                reused.append({"label": cell.label, "experiment_id": existing["experiment_id"], "job_ids": existing["job_ids"]})
                continue
            try:
                result = {"label": cell.label, **submit_cell(session, cell, plan, seeds, generations)}
                created.append(result)
                row = {
                    "campaign_id": campaign_id,
                    "cell_key": cell_key,
                    "tier": cell.tier,
                    "label": cell.label,
                    "variant_type": plan["variant_type"],
                    "condition": plan["condition"],
                    "variant_index": plan["variant_index"],
                    "payload_json": _canonical_json({"cell": cell.__dict__, "plan": plan, "seeds": list(range(seeds)), "generations": generations}),
                    "experiment_id": result["experiment_id"],
                    "job_ids": result["job_ids"],
                    "status": "submitted",
                    "error": "",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                _append_campaign_ledger(row)
                ledger[cell_key] = row
            except Exception as exc:  # noqa: BLE001
                logger.warning("submit failed for %s: %s", cell.label, exc)
                summary.setdefault("submit_errors", []).append({"label": cell.label, "error": str(exc)})
                _append_campaign_ledger({
                    "campaign_id": campaign_id,
                    "cell_key": cell_key,
                    "tier": cell.tier,
                    "label": cell.label,
                    "variant_type": plan["variant_type"],
                    "condition": plan["condition"],
                    "variant_index": plan["variant_index"],
                    "payload_json": _canonical_json({"cell": cell.__dict__, "plan": plan}),
                    "experiment_id": None,
                    "job_ids": [],
                    "status": "failed",
                    "error": str(exc),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
        summary["created"] = created
        summary["reused"] = reused
        summary["queued_jobs"] = sum(len(c["job_ids"]) for c in created)
        return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="cap campaign cells, first-N (mini-pilot)")
    ap.add_argument("--sample", type=int, default=None,
                    help="pick N cells stratified across families (WT+KO+dynamics); overrides --limit")
    ap.add_argument("--dry-run", action="store_true", help="validate + count only; create nothing")
    ap.add_argument("--seeds", type=int, default=SEEDS)
    ap.add_argument("--generations", type=int, default=GENERATIONS)
    ap.add_argument("--genes", type=str, default="", help="comma-separated KO gene list (else auto)")
    ap.add_argument("--campaign-id", type=str, default="", help="stable id for idempotent campaign submission")
    ap.add_argument("--tiers", type=str, default=TIER_V0,
                    help="comma-separated campaign tiers: v0, T2_CORE, T2_EXTENDED, T3, T4, T5")
    args = ap.parse_args()
    genes = [g.strip() for g in args.genes.split(",") if g.strip()] or None
    tiers = parse_tiers(args.tiers)
    print(json.dumps(run(limit=args.limit, dry_run=args.dry_run, seeds=args.seeds,
                         generations=args.generations, genes=genes, sample=args.sample, tiers=tiers,
                         campaign_id=args.campaign_id or None),
                     indent=2, default=str))


if __name__ == "__main__":
    main()
