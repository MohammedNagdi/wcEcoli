"""Package an exported shard into an upload-ready Hugging Face dataset (M2).

Given a shard dir (trajectories.h5 + metadata.jsonl + manifest.json), writes:
    splits/{train,val,test}.jsonl   baselines.md   README.md (dataset card)   croissant.json

    docker exec interface-api-1 python -m hf_export.package_release /app/eval/hf_v0 --test-condition acetate
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .baselines import run_baselines
from .card import build_croissant, build_dataset_card
from .splits import write_splits


def package(shard_dir: Path, *, test_conditions: set[str], test_gene_frac: float) -> dict:
    manifest = json.loads((shard_dir / "manifest.json").read_text())
    split_counts = write_splits(shard_dir, test_conditions=test_conditions, test_gene_frac=test_gene_frac)
    try:
        baselines = run_baselines(shard_dir)
        baselines_md = baselines["table_md"]
    except Exception as exc:  # noqa: BLE001 — baselines are best-effort
        baselines_md = f"_baselines failed: {exc}_"

    (shard_dir / "README.md").write_text(
        build_dataset_card(manifest, split_counts, baselines_md), encoding="utf-8")
    (shard_dir / "croissant.json").write_text(
        json.dumps(build_croissant(manifest), indent=2), encoding="utf-8")

    return {"split_counts": split_counts, "wrote": ["splits/", "baselines.md", "README.md", "croissant.json"]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("shard_dir", type=Path)
    ap.add_argument("--test-condition", action="append", default=[],
                    help="condition(s) held out entirely for the test split (repeatable)")
    ap.add_argument("--test-gene-frac", type=float, default=0.1)
    args = ap.parse_args()
    print(json.dumps(package(args.shard_dir, test_conditions=set(args.test_condition),
                             test_gene_frac=args.test_gene_frac), indent=2))


if __name__ == "__main__":
    main()
