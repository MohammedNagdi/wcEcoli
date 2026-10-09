"""Running moments per channel column: n, sum, sumsq, min, max (float64).

One ``Moments`` per part, fed one trajectory at a time by export, saved as one npz.
finalize merges the npz files of a family into stats/<family>.parquet.

npz layout: for every name (a scalar channel, or a matrix restricted to its active
columns in product_column order) five float64 arrays ``<name>.n``, ``<name>.sum``,
``<name>.sumsq``, ``<name>.min``, ``<name>.max`` of shape [k] (k = 1 for a scalar), plus
``names`` (the names, in insertion order). NaN values are not counted; a column that never
saw a finite value keeps n = 0, min = +inf, max = -inf.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

FIELDS = ("n", "sum", "sumsq", "min", "max")


class Moments:
    def __init__(self) -> None:
        self.names: list[str] = []
        self.data: dict[str, dict[str, np.ndarray]] = {}

    def _slot(self, name: str, width: int) -> dict[str, np.ndarray]:
        slot = self.data.get(name)
        if slot is None:
            slot = {"n": np.zeros(width), "sum": np.zeros(width), "sumsq": np.zeros(width),
                    "min": np.full(width, np.inf), "max": np.full(width, -np.inf)}
            self.data[name] = slot
            self.names.append(name)
        elif slot["n"].shape[0] != width:
            raise ValueError("{}: width {} != {}".format(name, width, slot["n"].shape[0]))
        return slot

    def add(self, name: str, values: np.ndarray) -> None:
        """Fold ``values`` ([rows] for a scalar, [rows, k] for a matrix) into ``name``."""
        values = np.asarray(values)
        if values.ndim == 1:
            values = values[:, None]
        slot = self._slot(name, values.shape[1])
        if values.shape[0] == 0:
            return
        block = values.astype(np.float64, copy=False)
        finite = ~np.isnan(block)
        if finite.all():
            slot["n"] += block.shape[0]
            slot["sum"] += block.sum(axis=0)
            slot["sumsq"] += np.einsum("ij,ij->j", block, block)
            np.minimum(slot["min"], block.min(axis=0), out=slot["min"])
            np.maximum(slot["max"], block.max(axis=0), out=slot["max"])
            return
        zeroed = np.where(finite, block, 0.0)
        slot["n"] += finite.sum(axis=0)
        slot["sum"] += zeroed.sum(axis=0)
        slot["sumsq"] += np.einsum("ij,ij->j", zeroed, zeroed)
        np.minimum(slot["min"], np.where(finite, block, np.inf).min(axis=0), out=slot["min"])
        np.maximum(slot["max"], np.where(finite, block, -np.inf).max(axis=0), out=slot["max"])

    def merge(self, other: "Moments") -> None:
        for name in other.names:
            theirs = other.data[name]
            mine = self._slot(name, theirs["n"].shape[0])
            for field in ("n", "sum", "sumsq"):
                mine[field] += theirs[field]
            np.minimum(mine["min"], theirs["min"], out=mine["min"])
            np.maximum(mine["max"], theirs["max"], out=mine["max"])

    def to_arrays(self) -> dict[str, np.ndarray]:
        out = {"names": np.array(self.names, dtype=str)}
        for name in self.names:
            for field in FIELDS:
                out["{}.{}".format(name, field)] = self.data[name][field]
        return out

    def save(self, path: Path) -> None:
        """Atomic: write a sibling temporary then rename."""
        from .ledger import rename_into_place, temp_path_for
        temporary = temp_path_for(path)
        with temporary.open("wb") as stream:
            np.savez(stream, **self.to_arrays())
        rename_into_place(temporary, path)

    @classmethod
    def load(cls, path: Path) -> "Moments":
        moments = cls()
        with np.load(path) as loaded:
            for name in loaded["names"].tolist():
                moments.names.append(name)
                moments.data[name] = {field: loaded["{}.{}".format(name, field)].astype(np.float64)
                                      for field in FIELDS}
        return moments

    def summary(self, name: str) -> dict[str, np.ndarray]:
        """mean and population std alongside the raw moments."""
        slot = self.data[name]
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = slot["sum"] / slot["n"]
            var = np.maximum(slot["sumsq"] / slot["n"] - mean * mean, 0.0)
        return {**slot, "mean": mean, "std": np.sqrt(var)}
