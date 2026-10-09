"""Reading a run's export/channels.h5.

Layout on disk (written by interface/backend/hf_export/converter.py)::

    /reference/<matrix>                 column ids, variable-length strings
    /seed<S>/gen<G>/<channel>/{time,value}
    /seed<S>/gen<G>/matrices/<matrix>/{time,value}

One seed per run. Generation groups carry summary attrs; runs before 2026-09-22 lack the
``terminated`` attrs, so outcomes are taken from the campaign database, never from here.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import h5py
import numpy as np

from .settings import MATRIX_CHANNELS, SCALAR_CHANNELS

_GEN = re.compile(r"^gen(\d+)$")
_SEED = re.compile(r"^seed(\d+)$")


@dataclass
class GenerationShape:
    seed: int
    generation: int
    n_steps: int
    t0: float
    t_end: float
    uniform_1s: bool
    channels_present: tuple[str, ...]
    matrices_present: tuple[str, ...]
    attrs: dict


def open_run(run_dir: Path) -> h5py.File:
    # Read-only and unlocked: HDF5 file locks on GPFS can fail or linger, and nothing writes these.
    return h5py.File(run_dir / "export" / "channels.h5", "r", locking=False)


def reference_ids(handle: h5py.File) -> dict[str, list[str]]:
    out = {}
    for matrix in MATRIX_CHANNELS:
        raw = handle["reference"][matrix][:]
        out[matrix] = [value.decode() if isinstance(value, bytes) else str(value) for value in raw]
    return out


def reference_hash(ids: dict[str, list[str]]) -> str:
    digest = hashlib.sha256()
    for matrix in MATRIX_CHANNELS:
        digest.update(matrix.encode())
        digest.update(("\n".join(ids[matrix]) + "\n\n").encode())
    return digest.hexdigest()


def seed_group(handle: h5py.File) -> tuple[int | None, h5py.Group | None]:
    """The run's one seed group; (None, None) when a partial file has none."""
    seeds = [(int(_SEED.match(k).group(1)), k) for k in handle.keys() if _SEED.match(k)]
    if not seeds:
        return None, None
    if len(seeds) != 1:
        raise ValueError("expected exactly one seed group, found {}".format([k for _, k in seeds]))
    return seeds[0][0], handle[seeds[0][1]]


def generations(handle: h5py.File) -> list[tuple[int, h5py.Group]]:
    _, group = seed_group(handle)
    if group is None:
        return []
    gens = sorted((int(_GEN.match(k).group(1)), k) for k in group.keys() if _GEN.match(k))
    return [(g, group[k]) for g, k in gens]


def generation_shape(seed: int, generation: int, group: h5py.Group) -> GenerationShape:
    # cell_mass carries the time axis; a partial generation may lack it, so fall back to
    # any channel that has one, and to an empty axis when none does.
    time = np.zeros(0)
    for channel in ("cell_mass",) + SCALAR_CHANNELS:
        if channel in group and isinstance(group[channel], h5py.Group) and "time" in group[channel]:
            time = group[channel]["time"][:]
            break
    diffs = np.diff(time) if len(time) > 1 else np.array([1.0])
    uniform = bool(len(time) > 0 and np.all(np.abs(diffs - 1.0) < 1e-6))
    channels = tuple(c for c in SCALAR_CHANNELS if c in group)
    matrices = tuple(m for m in MATRIX_CHANNELS
                     if "matrices" in group and m in group["matrices"] and "value" in group["matrices"][m])
    attrs = {}
    for key, value in group.attrs.items():
        if isinstance(value, (bytes, np.bytes_)):
            value = value.decode()
        elif isinstance(value, np.generic):
            value = value.item()
        attrs[key] = value
    return GenerationShape(seed, generation, int(len(time)), float(time[0]) if len(time) else float("nan"),
                           float(time[-1]) if len(time) else float("nan"), uniform, channels, matrices, attrs)


def read_scalars(group: h5py.Group) -> dict[str, np.ndarray]:
    return {channel: group[channel]["value"][:].astype(np.float32) for channel in SCALAR_CHANNELS}


def read_matrix(group: h5py.Group, matrix: str, rows: np.ndarray | None = None,
                columns: np.ndarray | None = None) -> np.ndarray:
    """Read one [T, N] matrix, optionally subset to ``rows`` (sorted) and ``columns`` (sorted)."""
    dataset = group["matrices"][matrix]["value"]
    if rows is None:
        value = dataset[:]
    else:
        # h5py fancy indexing on a chunked dataset is slow; read the span and subset.
        lo, hi = int(rows[0]), int(rows[-1]) + 1
        value = dataset[lo:hi]
        value = value[rows - lo]
    if columns is not None:
        value = value[:, columns]
    return value


def active_columns(group: h5py.Group, matrix: str) -> np.ndarray:
    """Boolean [N]: column ever non-zero in this generation."""
    dataset = group["matrices"][matrix]["value"]
    mask = np.zeros(dataset.shape[1], dtype=bool)
    step = max(1, 65536 // max(1, dataset.shape[1]) * 8)
    for start in range(0, dataset.shape[0], step):
        block = dataset[start:start + step]
        mask |= (block != 0).any(axis=0)
    return mask
