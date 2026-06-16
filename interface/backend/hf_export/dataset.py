"""Reference dataloader for the wcEcoli HF dataset.

Framework-agnostic core (numpy + h5py) so it loads without torch; an optional `torch_dataset()`
wrapper is provided for training (lazy torch import). Reads the HDF5 trajectories, the `/reference`
column-id maps, and `metadata.jsonl`, and exposes the benchmark tasks:

- **T1 tabular** — (genotype, condition) features -> a scalar phenotype (e.g. growth_rate).
- **T3 forecast** — a channel's trajectory prefix -> its suffix.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np


class WcEcoliShard:
    """One exported shard: metadata index + lazy HDF5 access + reference id maps."""

    def __init__(self, shard_dir: str | Path):
        self.dir = Path(shard_dir)
        self.metadata = [json.loads(l) for l in (self.dir / "metadata.jsonl").read_text().splitlines() if l.strip()]
        self.manifest = json.loads((self.dir / "manifest.json").read_text())
        self._h5 = None

    @property
    def h5(self):
        import h5py
        if self._h5 is None:
            self._h5 = h5py.File(self.dir / "trajectories.h5", "r")
        return self._h5

    def reference_ids(self, matrix_channel: str) -> list[str]:
        ref = self.h5.get("reference")
        if ref is None or f"{matrix_channel}_ids" not in ref:
            return []
        return [x.decode() if isinstance(x, bytes) else str(x) for x in ref[f"{matrix_channel}_ids"][()]]

    def read_channel(self, h5_path: str, channel: str) -> tuple[np.ndarray, np.ndarray]:
        """(time, value) for a scalar channel; value is [T] or [T, N] for matrix channels."""
        grp = self.h5[h5_path][channel]
        return grp["time"][()], grp["value"][()]

    def rows(self, split_paths: list[str] | None = None) -> list[dict[str, Any]]:
        if split_paths is None:
            return self.metadata
        keep = set(split_paths)
        return [r for r in self.metadata if r["h5_path"] in keep]

    # ---- task adapters ----------------------------------------------------
    def tabular_features(self, rows: list[dict[str, Any]]) -> tuple[np.ndarray, list[str]]:
        """One-hot (genotype, condition) design matrix + column names. Pure metadata (no HDF5)."""
        genos = sorted({r["genotype"] for r in rows})
        conds = sorted({r["condition"] for r in rows})
        cols = [f"geno={g}" for g in genos] + [f"cond={c}" for c in conds]
        idx = {c: i for i, c in enumerate(cols)}
        X = np.zeros((len(rows), len(cols)), dtype=np.float32)
        for i, r in enumerate(rows):
            X[i, idx[f"geno={r['genotype']}"]] = 1.0
            X[i, idx[f"cond={r['condition']}"]] = 1.0
        return X, cols

    def tabular_target(self, rows: list[dict[str, Any]], field: str = "growth_rate") -> np.ndarray:
        return np.array([float(r.get(field) or "nan") for r in rows], dtype=np.float32)

    def forecast_pairs(self, rows: list[dict[str, Any]], channel: str = "cell_mass", prefix_frac: float = 0.5):
        """Yield (prefix, suffix) 1-D arrays for a scalar channel (task T3)."""
        for r in rows:
            try:
                _, value = self.read_channel(r["h5_path"], channel)
            except (KeyError, OSError):
                continue
            value = np.asarray(value, dtype=np.float32).ravel()
            if value.size < 4:
                continue
            cut = max(1, int(value.size * prefix_frac))
            yield value[:cut], value[cut:]


def torch_dataset(shard: WcEcoliShard, rows: list[dict[str, Any]], *, task: str = "growth", **kwargs):
    """Optional torch wrapper (lazy import). task in {'growth', 'forecast'}."""
    import torch
    from torch.utils.data import Dataset

    class _DS(Dataset):
        def __init__(self):
            if task == "growth":
                self.X, _ = shard.tabular_features(rows)
                self.y = shard.tabular_target(rows, kwargs.get("field", "growth_rate"))
            else:
                self.pairs = list(shard.forecast_pairs(rows, kwargs.get("channel", "cell_mass"),
                                                       kwargs.get("prefix_frac", 0.5)))

        def __len__(self):
            return len(self.y) if task == "growth" else len(self.pairs)

        def __getitem__(self, i):
            if task == "growth":
                return torch.tensor(self.X[i]), torch.tensor(self.y[i])
            pre, suf = self.pairs[i]
            return torch.tensor(pre), torch.tensor(suf)

    return _DS()
