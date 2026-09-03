"""Read a pruned run: the per-job HDF5 that replaced its raw simOut tree.

When ``WCECOLI_PRUNE_SIMOUT=1``, each SLURM array task converts its generations to
``<sim_dir>/export/channels.h5`` and deletes the raw ``simOut`` directories, taking a job
from ~1259 files to a handful. That is what makes a 56k-job campaign fit inside the
/gscratch inode allocation at all.

This module presents such a run through the same surface ``run_export`` already uses for
``SimOutReader``, so the exporter does not care which form a job is stored in:

    channels  {name: {"time", "values", "unit"}}
    summary   {division_time_sec, final_mass_fg, growth_rate, doubling_time_min, divided}
    matrices  {channel: {"time", "matrix", "ids", "unit"}}   (only if pruned with tensors)

A pruned run is authoritative: its simOut is gone, so anything not captured at prune time
is unrecoverable. ``summary`` and matrix column ids are therefore persisted into the file
by ``app.services.slurm_ingest.convert_and_prune``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

PRUNED_H5_NAME = "channels.h5"
PRUNED_MARKER = "pruned.json"

# Written by write_sim/convert_and_prune as bookkeeping, not as simulation output.
_STRUCTURAL_ATTRS = {
    "seed", "generation", "sim_dir", "variant_dir",
    "channels", "n_timesteps", "summary_keys",
}


def pruned_h5_path(base: Path) -> Path:
    return Path(base) / "export" / PRUNED_H5_NAME


def is_pruned(base: Path) -> bool:
    """True when this run's raw simOut has been replaced by a per-job HDF5."""
    return pruned_h5_path(base).is_file()


class PrunedRun:
    """Reader over one job's pruned HDF5. Use as a context manager."""

    def __init__(self, base: Path):
        self.path = pruned_h5_path(base)
        self._h5: Any = None

    def __enter__(self) -> "PrunedRun":
        import h5py

        self._h5 = h5py.File(self.path, "r")
        return self

    def __exit__(self, *exc_info) -> None:
        if self._h5 is not None:
            self._h5.close()
            self._h5 = None

    @property
    def keeps_tensors(self) -> bool:
        return bool(self._h5.attrs.get("keeps_tensors", False))

    def generations(self) -> list[tuple[int, int, str]]:
        """Return (seed, generation, group_path), ordered."""
        found: list[tuple[int, int, str]] = []
        for seed_key in self._h5:
            if not seed_key.startswith("seed"):
                continue
            for gen_key in self._h5[seed_key]:
                group = "{}/{}".format(seed_key, gen_key)
                attrs = self._h5[group].attrs
                # Prefer the stored values; fall back to parsing the group name.
                seed = int(attrs.get("seed", seed_key.removeprefix("seed") or 0))
                generation = int(attrs.get("generation", gen_key.removeprefix("gen") or 0))
                found.append((seed, generation, group))
        return sorted(found, key=lambda item: (item[0], item[1]))

    def channels(self, group: str) -> dict[str, dict[str, Any]]:
        node = self._h5[group]
        names = [n for n in str(node.attrs.get("channels", "")).split(",") if n]
        result: dict[str, dict[str, Any]] = {}
        for name in names:
            if name not in node:
                continue
            sub = node[name]
            result[name] = {
                "time": sub["time"][:],
                "values": sub["value"][:],
                "unit": _text(sub["value"].attrs.get("unit", "")),
            }
        return result

    def summary(self, group: str) -> dict[str, Any]:
        attrs = self._h5[group].attrs
        keys = [k for k in str(attrs.get("summary_keys", "")).split(",") if k]
        if not keys:
            # Older files predate summary_keys; fall back to "everything not structural".
            keys = [k for k in attrs.keys() if k not in _STRUCTURAL_ATTRS]
        summary: dict[str, Any] = {}
        for key in keys:
            if key in attrs:
                summary[key] = _scalar(attrs[key])
        return summary

    def matrices(self, group: str) -> dict[str, dict[str, Any]]:
        path = group + "/matrices"
        if path not in self._h5:
            return {}
        node = self._h5[path]
        result: dict[str, dict[str, Any]] = {}
        for name in node:
            sub = node[name]
            result[name] = {
                "time": sub["time"][:],
                "matrix": sub["value"][:],
                # Column ids live once per file under /reference: they are model-wide, and
                # too large to hold as HDF5 attributes.
                "ids": self.column_ids(name),
                "unit": _text(sub["value"].attrs.get("unit", "")),
            }
        return result

    def column_ids(self, channel: str) -> list[str]:
        path = "reference/" + channel
        if path not in self._h5:
            return []
        return [_text(value) for value in self._h5[path][:]]


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _scalar(value: Any):
    """Unwrap an HDF5 attribute into a plain Python scalar."""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if hasattr(value, "item") and getattr(value, "shape", None) == ():
        return value.item()
    return value
