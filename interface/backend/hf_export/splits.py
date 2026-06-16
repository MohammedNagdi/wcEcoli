"""Canonical train/val/test splits for the wcEcoli HF dataset.

Generalization is the point, so splits are **held-out genotype + held-out condition**, not random
rows: a model must extrapolate to unseen knockouts and unseen media, not memorize. Deterministic
(seeded) so the benchmark is reproducible.

Policy:
- test  = any trajectory whose **condition ∈ test_conditions** OR whose **ko_gene ∈ held-out genes**
          (a seeded random fraction of the KO genes present).
- val   = trajectories in the remaining pool whose **seed == val_seed**.
- train = everything else.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any


def build_splits(
    metadata: list[dict[str, Any]],
    *,
    test_conditions: set[str] | None = None,
    test_gene_frac: float = 0.1,
    val_seed: int = 0,
    rng_seed: int = 0,
) -> dict[str, list[str]]:
    """Assign each metadata row (by h5_path) to train/val/test. Returns {split: [h5_path]}."""
    test_conditions = test_conditions or set()
    ko_genes = sorted({r.get("ko_gene") for r in metadata if r.get("ko_gene")})
    rng = random.Random(rng_seed)
    n_hold = int(round(len(ko_genes) * test_gene_frac))
    held_out_genes = set(rng.sample(ko_genes, n_hold)) if n_hold and ko_genes else set()

    splits: dict[str, list[str]] = {"train": [], "val": [], "test": []}
    for row in metadata:
        path = row["h5_path"]
        if row.get("condition") in test_conditions or (row.get("ko_gene") in held_out_genes and row.get("ko_gene")):
            splits["test"].append(path)
        elif int(row.get("seed", 0)) == val_seed:
            splits["val"].append(path)
        else:
            splits["train"].append(path)
    return splits


def write_splits(shard_dir: Path, **kwargs: Any) -> dict[str, int]:
    """Read <shard_dir>/metadata.jsonl, compute splits, write splits/{train,val,test}.jsonl."""
    metadata = [json.loads(line) for line in (shard_dir / "metadata.jsonl").read_text().splitlines() if line.strip()]
    splits = build_splits(metadata, **kwargs)
    out = shard_dir / "splits"
    out.mkdir(parents=True, exist_ok=True)
    for name, paths in splits.items():
        (out / f"{name}.jsonl").write_text("".join(json.dumps({"h5_path": p}) + "\n" for p in paths), encoding="utf-8")
    return {name: len(paths) for name, paths in splits.items()}
