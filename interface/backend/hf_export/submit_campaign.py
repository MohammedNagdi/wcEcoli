"""Submit the locked v0 matrix as experiments + queued jobs (the generation side).

This only *enqueues* — the platform's worker runs the sims (per your plan: "running happens from the
Platform"). Use `--dry-run` to validate the whole campaign (gene/condition resolution, counts) WITHOUT
creating anything. Drop `--dry-run` to actually create experiments and queue jobs; then run the
exporter on the completed jobs.

    docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --limit 8
    docker exec interface-api-1 python -m hf_export.submit_campaign --limit 8      # real submit

v0 submittable via the existing create-experiment path: `wildtype`, `gene_knockout`, and
timeline-based dynamic media (the shift runs). Exotic variants (`sinusoidal_media`, ppGpp, aa_*) need
additional variant-param plumbing and are skipped with a reason (a documented follow-up).
"""

from __future__ import annotations

import argparse
import json
import logging
from typing import Any

from sqlmodel import Session, select

from app.config import settings
from app.db.engine import make_sqlite_engine
from app.db.models import Condition, Gene, Timeline
from app.services.experiment_creation import ExperimentCreateData, create_experiment_record
from app.services.job_queue import RunJobRequest, create_simulation_jobs_for_experiment

from .matrix import GENERATIONS, KO_TARGET, SEEDS, CampaignCell, v0_campaign

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("submit_campaign")

_SUBMITTABLE_DYNAMIC = {"timelines"}  # via the platform timeline mechanism


def resolve_ko_genes(session: Session, explicit: list[str] | None) -> list[str]:
    """Curated knockout list. Explicit wins; else first KO_TARGET knockout-ready genes.

    NOTE: essentiality-first selection is a follow-up — for now this is a stable alphabetical
    knockout-ready sample, which is enough to validate submission + export.
    """
    if explicit:
        return explicit
    genes = session.exec(select(Gene).where(Gene.ko_index > 0).order_by(Gene.symbol)).all()
    return [g.symbol for g in genes[:KO_TARGET] if g.symbol]


def plan_cell(session: Session, cell: CampaignCell) -> dict[str, Any]:
    """Resolve one campaign cell into a submittable plan item (no side effects)."""
    base = {"label": cell.label, "variant_type": cell.variant_type, "condition": cell.condition,
            "gene": cell.params.get("gene", ""), "variant_index": 0, "timeline": "",
            "submittable": True, "reason": ""}

    if cell.variant_type == "wildtype":
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
        return {**base, "timeline": cell.label.replace("/", "_"), "condition": None}

    return {**base, "submittable": False,
            "reason": f"variant_type '{cell.variant_type}' not yet submittable via create_experiment"}


def submit_cell(session: Session, cell: CampaignCell, plan: dict[str, Any], seeds: int, generations: int) -> dict[str, Any]:
    """Create the experiment + queue jobs for one (submittable) cell. Returns ids."""
    timeline_name = ""
    if cell.variant_type in _SUBMITTABLE_DYNAMIC:
        # Register the timeline (events string) so the experiment can reference it.
        timeline_name = plan["timeline"]
        if not session.exec(select(Timeline).where(Timeline.name == timeline_name)).first():
            session.add(Timeline(name=timeline_name, definition=cell.params.get("events", "")))
            session.commit()
        variant_type, gene_symbol, variant_index, condition = "wildtype", "", 0, "minimal"
    else:
        variant_type = cell.variant_type
        gene_symbol = plan["gene"]
        variant_index = plan["variant_index"]
        condition = cell.condition or "basal"

    result = create_experiment_record(session, ExperimentCreateData(
        name=f"[v0] {cell.label}", description="wcEcoli HF dataset v0 campaign.",
        variant_type=variant_type, variant_index=variant_index, condition=condition,
        timeline=timeline_name, gene_symbol=gene_symbol,
    ))
    jobs = create_simulation_jobs_for_experiment(
        result.experiment, RunJobRequest(condition=condition, seeds=list(range(seeds)), generations=generations),
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
        genes: list[str] | None, sample: int | None = None) -> dict[str, Any]:
    engine = make_sqlite_engine(settings.database_path)
    with Session(engine) as session:
        ko_genes = resolve_ko_genes(session, genes)
        cells = v0_campaign(ko_genes)
        if sample:
            cells = stratified_sample(cells, sample)  # diverse mini-pilot; takes precedence over --limit
        elif limit:
            cells = cells[:limit]
        plans = [(cell, plan_cell(session, cell)) for cell in cells]
        submittable = [(c, p) for c, p in plans if p["submittable"]]
        skipped = [(c, p) for c, p in plans if not p["submittable"]]

        summary: dict[str, Any] = {
            "dry_run": dry_run, "seeds": seeds, "generations": generations,
            "ko_genes_resolved": len(ko_genes),
            "cells_total": len(cells), "submittable": len(submittable), "skipped": len(skipped),
            "skipped_reasons": [{"label": p["label"], "reason": p["reason"]} for _, p in skipped][:20],
            "estimated_jobs": len(submittable) * seeds,
            "estimated_trajectories": len(submittable) * seeds * generations,
        }
        if dry_run:
            summary["plan_sample"] = [
                {"label": p["label"], "variant_type": p["variant_type"], "condition": p["condition"],
                 "gene": p["gene"], "variant_index": p["variant_index"]}
                for _, p in submittable[:12]
            ]
            return summary

        created = []
        for cell, plan in submittable:
            try:
                created.append({"label": cell.label, **submit_cell(session, cell, plan, seeds, generations)})
            except Exception as exc:  # noqa: BLE001
                logger.warning("submit failed for %s: %s", cell.label, exc)
                summary.setdefault("submit_errors", []).append({"label": cell.label, "error": str(exc)})
        summary["created"] = created
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
    args = ap.parse_args()
    genes = [g.strip() for g in args.genes.split(",") if g.strip()] or None
    print(json.dumps(run(limit=args.limit, dry_run=args.dry_run, seeds=args.seeds,
                         generations=args.generations, genes=genes, sample=args.sample),
                     indent=2, default=str))


if __name__ == "__main__":
    main()
