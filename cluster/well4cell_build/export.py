"""Stage 3: one parquet file per array task, for one config and one family.

``plan``       packs the trajectories of index.parquet (in stored order) into parts of
               about W4C_FILE_TARGET_BYTES, never crossing a config or family, and writes
               the manifest (one line per part).
``dispatch``   submits the parts that have no ok sentinel (or ``--parts``) as one SLURM array.
``run``        (array task) builds ONE part: per trajectory read the generation group,
               apply the stride rule and the QC gates, append the rows; write the file to a
               temporary name and rename it into place; save the part's stats npz; write
               the sentinel. Skips when an ok sentinel already exists; always exits 0.
``status``     what the manifests, sentinels and queue say.
``reconcile``  folds sentinels into ledger.jsonl and reports failed, lost (dispatched, gone from
               SLURM, no sentinel), running/pending and not-yet-dispatched parts.

Contract: cluster/well4cell_build/SPEC.md.
"""

from __future__ import annotations

import argparse
import math
import re
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path

import h5py
import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import h5io
from .ledger import (append_jsonl, format_array, manifest_id, now, read_json, read_jsonl, rename_into_place, sbatch,
                     sentinel_dir, squeue_names, temp_path_for, write_atomic_json, write_jsonl)
from .settings import (CONFIGS, FAMILIES, FLUX_NOISE, INT_MATRICES, INT_SCALARS, MATRIX_CHANNELS, SCALAR_CHANNELS,
                       Config, Settings)
from .stats import Moments

_PART = re.compile(r"part-(\d+)\.parquet$")
_INT32_MAX = np.iinfo(np.int32).max
# SLURM states in which an array task may still write its sentinel.
_LIVE_STATES = {"PENDING", "RUNNING", "REQUEUED", "CONFIGURING", "COMPLETING", "RESIZING", "SUSPENDED",
                "REQUEUE_HOLD", "REQUEUE_FED", "STAGE_OUT", "SIGNALING"}


# -- pure pieces (unit-tested in test_export.py) --------------------------------

def stride_rows(n_steps: int, stride: int) -> np.ndarray:
    """Row indices kept: t % stride == 0, plus the last row."""
    if n_steps <= 0:
        return np.zeros(0, dtype=np.int64)
    rows = np.arange(0, n_steps, stride, dtype=np.int64)
    if rows[-1] != n_steps - 1:
        rows = np.append(rows, n_steps - 1)
    return rows


def n_rows_after_stride(n_steps: int, stride: int) -> int:
    if n_steps <= 0:
        return 0
    return int(math.ceil(n_steps / stride) + (1 if (n_steps - 1) % stride else 0))


def _integral_nonnegative(values: np.ndarray) -> tuple[bool, bool]:
    """(all >= 0, all integral and within int32). NaN fails both."""
    with np.errstate(invalid="ignore"):
        nonneg = bool(np.all(values >= 0))
        integral = bool(np.all(values == np.round(values)) and np.all(np.abs(values) <= _INT32_MAX))
    return nonneg, integral


def qc_trajectory(time_axis: np.ndarray, n_steps_expected: int, scalars: dict[str, np.ndarray],
                  matrices: dict[str, np.ndarray], matrix_times: dict[str, np.ndarray] | None = None,
                  reference_hash: str | None = None, expected_hash: str | None = None,
                  reference_sizes: dict[str, int] | None = None) -> list[str]:
    """Every QC gate of SPEC.md; returns the failure reasons (empty means pass).

    Gates are applied to every row of what this config contains, before the stride."""
    reasons: list[str] = []
    n = int(len(time_axis))
    if n != n_steps_expected:
        reasons.append("n_steps {} != scan n_steps {}".format(n, n_steps_expected))
    if n == 0:
        reasons.append("no rows")
        return reasons
    if n > 1 and not np.all(np.diff(time_axis.astype(np.float64)) == 1.0):
        reasons.append("time not strictly increasing by 1")
    if expected_hash is not None and reference_hash != expected_hash:
        reasons.append("reference hash {} != campaign {}".format(str(reference_hash)[:12], expected_hash[:12]))
    for channel in SCALAR_CHANNELS:
        if channel not in scalars:
            reasons.append("{} missing".format(channel))
            continue
        values = scalars[channel]
        if len(values) != n:
            reasons.append("{} has {} rows, time has {}".format(channel, len(values), n))
            continue
        if channel == "growth_rate":
            if np.isnan(values[1:]).any():
                reasons.append("growth_rate NaN after row 0 ({} rows)".format(int(np.isnan(values[1:]).sum())))
        elif channel in INT_SCALARS:
            nonneg, integral = _integral_nonnegative(values)
            if not nonneg:
                reasons.append("{} negative or NaN".format(channel))
            if not integral:
                reasons.append("{} not integral".format(channel))
    for matrix, values in matrices.items():
        if values.ndim != 2 or values.shape[0] != n:
            reasons.append("{} shape {} does not match {} rows".format(matrix, values.shape, n))
            continue
        if reference_sizes is not None and values.shape[1] != reference_sizes[matrix]:
            reasons.append("{} has {} columns, reference has {}".format(matrix, values.shape[1], reference_sizes[matrix]))
            continue
        if matrix_times is not None and matrix in matrix_times and not np.array_equal(matrix_times[matrix], time_axis):
            reasons.append("{} time axis differs from the scalars'".format(matrix))
        if matrix in INT_MATRICES:
            nonneg, integral = _integral_nonnegative(values)
            if not nonneg:
                reasons.append("{} negative or NaN".format(matrix))
            if not integral:
                reasons.append("{} not integral".format(matrix))
        elif matrix == "reaction_flux_matrix":
            with np.errstate(invalid="ignore"):
                if not np.all(values >= -FLUX_NOISE):
                    reasons.append("reaction_flux_matrix below -{:g} or NaN".format(FLUX_NOISE))
    return reasons


# -- reference ------------------------------------------------------------------

@dataclass
class Reference:
    """Campaign reference ids and the active columns of each matrix (product_column order)."""

    ids: dict[str, list[str]]
    columns: dict[str, np.ndarray]
    hash: str

    @classmethod
    def load(cls, settings: Settings) -> "Reference":
        ids, columns = {}, {}
        for matrix in MATRIX_CHANNELS:
            table = pq.read_table(settings.reference_dir / (matrix.replace("_matrix", "") + ".parquet")).to_pydict()
            ids[matrix] = [str(v) for v in table["id"]]
            active = [(pcol, col) for col, act, pcol in zip(table["column"], table["active"], table["product_column"]) if act]
            active.sort()
            if [p for p, _ in active] != list(range(len(active))):
                raise ValueError("{}: product_column is not 0..{} over the active columns".format(matrix, len(active) - 1))
            columns[matrix] = np.asarray([c for _, c in active], dtype=np.int64)
        return cls(ids, columns, h5io.reference_hash(ids))

    @property
    def sizes(self) -> dict[str, int]:
        return {m: len(self.ids[m]) for m in MATRIX_CHANNELS}


# -- plan -----------------------------------------------------------------------

def _part_number(path: str) -> int:
    match = _PART.search(path)
    return int(match.group(1)) if match else -1


def _export_manifests(settings: Settings) -> list[Path]:
    return sorted(settings.manifest_dir.glob("export_*.jsonl"))


def _sentinel_path(settings: Settings, manifest: Path, index: int) -> Path:
    return sentinel_dir(settings, manifest) / "{:05d}.json".format(index)


def _read_sentinel(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return read_json(path)
    except (OSError, ValueError):
        return None


def _written_elsewhere(settings: Settings) -> tuple[dict[tuple[str, str], int], dict[str, set[str]], list[str]]:
    """Highest part number taken per (config, family), and sample ids written by ok sentinels
    (not yet folded into the index by finalize), and parts still pending in older manifests."""
    highest: dict[tuple[str, str], int] = {}
    written: dict[str, set[str]] = {}
    pending: list[str] = []
    for record in read_jsonl(settings.ledger):
        if record.get("stage") == "export" and record.get("status") == "ok":
            key = (record["config"], record["family"])
            highest[key] = max(highest.get(key, -1), _part_number(record["path"]))
    for manifest in _export_manifests(settings):
        for line in read_jsonl(manifest):
            key = (line["config"], line["family"])
            # Any planned path is taken: a later plan must never overwrite it.
            highest[key] = max(highest.get(key, -1), _part_number(line["path"]))
            sentinel = _read_sentinel(_sentinel_path(settings, manifest, line["part"]))
            if sentinel is None:
                pending.append("{}#{} {}".format(manifest.name, line["part"], line["path"]))
            elif sentinel.get("status") == "ok":
                written.setdefault(line["config"], set()).update(
                    s["sample_id"] for s in sentinel.get("samples", []) if s.get("qc", {}).get("ok"))
    return highest, written, pending


def pack(samples: list[dict], bytes_per_row: int, stride: int, target_bytes: int) -> list[list[dict]]:
    """Consecutive runs of samples whose estimated size stays under target (at least one each)."""
    parts: list[list[dict]] = []
    current: list[dict] = []
    size = 0
    for sample in samples:
        estimate = bytes_per_row * n_rows_after_stride(int(sample["n_steps"]), stride)
        if current and size + estimate > target_bytes:
            parts.append(current)
            current, size = [], 0
        current.append(sample)
        size += estimate
    if current:
        parts.append(current)
    return parts


def cmd_plan(settings: Settings, args: argparse.Namespace) -> dict:
    settings.ensure_layout()
    configs = [settings.config(c) for c in (args.configs.split(",") if args.configs else CONFIGS)]
    families = None
    if args.families and args.families.strip() != "all":
        families = [f.strip() for f in args.families.split(",") if f.strip()]
        unknown = sorted(set(families) - set(FAMILIES))
        if unknown:
            raise SystemExit("unknown families {}; choose from {} or all".format(unknown, ", ".join(FAMILIES)))
    if not settings.index_path.exists():
        raise SystemExit("no {}; run `index` first".format(settings.index_path))
    wanted = ["sample_id", "family", "run_dir", "h5_group", "n_steps"] + [c.name + "_file" for c in configs]
    index = pq.read_table(settings.index_path, columns=wanted).to_pylist()
    highest, written, pending = ({}, {}, []) if args.force else _written_elsewhere(settings)
    planned_configs = {c.name for c in configs}
    pending = [p for p in pending if p.split(" ", 1)[1].split("/")[1] in planned_configs]
    if pending:
        print("WARNING: {} part(s) of earlier manifests have no sentinel yet (e.g. {}); their samples will "
              "be planned again unless those arrays finish first".format(len(pending), pending[0]), file=sys.stderr)
    plan = manifest_id("export")
    lines = []
    skipped = {}
    for config in configs:
        done = written.get(config.name, set())
        by_family: dict[str, list[dict]] = {}
        order: list[str] = []
        for row in index:
            if families and row["family"] not in families:
                continue
            if not args.force and (row[config.name + "_file"] or row["sample_id"] in done):
                skipped[config.name] = skipped.get(config.name, 0) + 1
                continue
            if row["family"] not in by_family:
                by_family[row["family"]] = []
                order.append(row["family"])
            by_family[row["family"]].append({"sample_id": row["sample_id"], "run_dir": row["run_dir"],
                                             "h5_group": row["h5_group"], "n_steps": int(row["n_steps"])})
        # Tier order (settings.FAMILIES), whatever order the index is stored in.
        order.sort(key=lambda f: FAMILIES.index(f) if f in FAMILIES else len(FAMILIES))
        for family in order:
            number = highest.get((config.name, family), -1) + 1
            for samples in pack(by_family[family], config.bytes_per_row, config.stride, settings.file_target_bytes):
                lines.append({"plan": plan, "part": len(lines), "config": config.name, "family": family,
                              "path": "data/{}/{}/part-{:05d}.parquet".format(config.name, family, number),
                              "samples": samples})
                number += 1
    if not lines:
        print("nothing to export (already exported: {})".format(skipped))
        return {"parts": 0}
    manifest = settings.manifest_dir / (plan + ".jsonl")
    write_jsonl(manifest, lines)
    counts: dict[str, int] = {}
    for line in lines:
        counts[line["config"]] = counts.get(line["config"], 0) + 1
    print("manifest {}: {} parts {} ({} samples); already exported, skipped: {}".format(
        manifest, len(lines), counts, sum(len(l["samples"]) for l in lines), skipped))
    return {"manifest": str(manifest), "parts": len(lines)}


# -- dispatch -------------------------------------------------------------------

def _latest_manifest(settings: Settings) -> Path:
    candidates = _export_manifests(settings)
    if not candidates:
        raise SystemExit("no export manifest; run `export plan` first")
    return candidates[-1]


def parse_parts(text: str) -> list[int]:
    """'0-161,170,175-180' -> sorted distinct part indices of a manifest (the syntax of
    ``export dispatch --parts``, ``hub verify --parts``, ``hub prune --parts`` and of the
    dispatch log's array specs)."""
    indices: set[int] = set()
    for item in text.split(","):
        item = item.strip()
        match = re.fullmatch(r"(\d+)(?:-(\d+))?", item)
        if not match:
            raise SystemExit("bad --parts item {!r}: expected N or N-M, comma-separated (e.g. 0-161,170)".format(item))
        start, stop = int(match.group(1)), int(match.group(2) or match.group(1))
        if stop < start:
            raise SystemExit("bad --parts range {!r}: the end is below the start".format(item))
        indices.update(range(start, stop + 1))
    return sorted(indices)


def manifest_parts(manifest: Path, text: str) -> tuple[list[dict], list[int]]:
    """(the manifest's lines, the --parts indices); refuses an index the manifest does not have."""
    lines = read_jsonl(manifest)
    indices = parse_parts(text)
    unknown = sorted(set(indices) - {line["part"] for line in lines})
    if unknown:
        raise SystemExit("{} has no part(s) {} (its parts: {})".format(
            manifest.name, format_array(unknown), format_array([line["part"] for line in lines]) if lines else "none"))
    return lines, indices


def dispatched_parts(settings: Settings) -> dict[str, tuple[list[str], set[int] | None]]:
    """manifest name -> (export array job ids, the part indices they were submitted for; None
    when a dispatch record does not say, which counts as the whole manifest)."""
    out: dict[str, tuple[list[str], set[int] | None]] = {}
    for record in read_jsonl(settings.dispatch_log):
        if record.get("stage") != "export":
            continue
        jobs, indices = out.setdefault(Path(record["manifest"]).name, ([], set()))
        jobs.append(str(record["array_job_id"]))
        spec = str(record.get("indices") or "").split("%", 1)[0]
        if indices is not None and spec:
            indices.update(parse_parts(spec))
        else:
            out[Path(record["manifest"]).name] = (jobs, None)
    return out


def cmd_dispatch(settings: Settings, args: argparse.Namespace) -> dict:
    manifest = Path(args.manifest) if args.manifest else _latest_manifest(settings)
    lines = read_jsonl(manifest)
    if args.parts:
        indices = manifest_parts(manifest, args.parts)[1]
    else:
        indices = [line["part"] for line in lines
                   if (_read_sentinel(_sentinel_path(settings, manifest, line["part"])) or {}).get("status") != "ok"]
    if not indices:
        print("every part of {} has an ok sentinel".format(manifest.name))
        return {"array_job_id": None}
    busy = squeue_names(settings.job_prefix + "-export")
    if busy and not args.force:
        raise SystemExit("an export array is already queued ({}); --force to submit anyway".format(len(busy)))
    array_job_id, account = sbatch(settings, "export", manifest, indices, args.concurrency or settings.concurrency,
                                   time_limit=args.time, mem=args.mem, dry_run=args.dry_run)
    print("submitted {} under {} ({} parts)".format(array_job_id, account, len(indices)))
    return {"array_job_id": array_job_id}


# -- run ------------------------------------------------------------------------

@dataclass
class _Run:
    """The open channels.h5 of the run being read (samples of one run are adjacent)."""

    run_dir: str | None = None
    handle: h5py.File | None = None
    reference_hash: str | None = None

    def open(self, settings: Settings, run_dir: str) -> h5py.File:
        if run_dir != self.run_dir:
            self.close()
            self.handle = h5io.open_run(settings.out_dir / run_dir)
            self.run_dir = run_dir
            self.reference_hash = h5io.reference_hash(h5io.reference_ids(self.handle))
        return self.handle

    def close(self) -> None:
        if self.handle is not None:
            self.handle.close()
        self.run_dir, self.handle, self.reference_hash = None, None, None


def _unit(dataset: h5py.Dataset | h5py.Group) -> str | None:
    unit = dataset.attrs.get("unit")
    if unit is None:
        return None
    return unit.decode() if isinstance(unit, (bytes, np.bytes_)) else str(unit)


def build_schema(settings: Settings, config: Config, family: str, reference: Reference,
                 units: dict[str, str | None]) -> pa.Schema:
    def meta(name: str) -> dict | None:
        return {b"unit": units[name].encode()} if units.get(name) else None

    fields = [pa.field("sample_id", pa.dictionary(pa.int32(), pa.string()), nullable=False),
              pa.field("t", pa.int32(), nullable=False, metadata={b"unit": b"s"}),
              pa.field("t_abs", pa.int32(), nullable=False, metadata={b"unit": b"s"})]
    for channel in SCALAR_CHANNELS:
        kind = pa.int32() if channel in INT_SCALARS else pa.float32()
        fields.append(pa.field(channel, kind, nullable=channel == "growth_rate", metadata=meta(channel)))
    for matrix in config.matrices:
        kind = pa.int32() if matrix in INT_MATRICES else pa.float32()
        fields.append(pa.field(matrix, pa.list_(pa.field("item", kind, nullable=False), len(reference.columns[matrix])),
                               nullable=False, metadata=meta(matrix)))
    return pa.schema(fields, metadata={b"well4cell_version": settings.version.encode(), b"config": config.name.encode(),
                                       b"family": family.encode(), b"stride": str(config.stride).encode()})


@dataclass
class _Trajectory:
    rows: np.ndarray
    t0: int
    scalars: dict[str, np.ndarray]
    matrices: dict[str, np.ndarray]       # already strided and column-pruned
    units: dict[str, str | None]
    reasons: list[str] = field(default_factory=list)


def read_trajectory(handle: h5py.File, h5_group: str, n_steps: int, config: Config, reference: Reference,
                    run_hash: str | None) -> _Trajectory:
    group = handle[h5_group]
    time_axis = group["cell_mass"]["time"][:] if "cell_mass" in group else np.zeros(0, dtype=np.float32)
    scalars, units = {}, {}
    for channel in SCALAR_CHANNELS:
        if channel in group:
            scalars[channel] = group[channel]["value"][:]
            units[channel] = _unit(group[channel]["value"])
    full, times = {}, {}
    for matrix in config.matrices:
        if "matrices" in group and matrix in group["matrices"]:
            node = group["matrices"][matrix]
            full[matrix] = node["value"][:]
            times[matrix] = node["time"][:] if "time" in node else time_axis
            units[matrix] = _unit(node["value"]) or _unit(node)
        else:
            full[matrix] = np.zeros((0, 0), dtype=np.float32)
    reasons = qc_trajectory(time_axis, n_steps, scalars, full, times, run_hash, reference.hash, reference.sizes)
    rows = stride_rows(len(time_axis), config.stride)
    if reasons:
        return _Trajectory(rows, 0, {}, {}, units, reasons)
    matrices = {}
    for matrix in config.matrices:
        value = full.pop(matrix)
        if config.stride != 1:
            value = value[rows]
        value = value[:, reference.columns[matrix]]
        matrices[matrix] = np.ascontiguousarray(value, dtype=np.int32 if matrix in INT_MATRICES else np.float32)
        del value
    picked = {c: scalars[c][rows] for c in SCALAR_CHANNELS}
    return _Trajectory(rows, int(time_axis[0]), picked, matrices, units)


def trajectory_table(sample_id: str, trajectory: _Trajectory, schema: pa.Schema) -> pa.Table:
    """Rows of one trajectory (sample_id as plain strings; dictionary-encoded at flush)."""
    k = len(trajectory.rows)
    t = trajectory.rows.astype(np.int32)
    columns = [pa.array([sample_id] * k, pa.string()), pa.array(t), pa.array(t + np.int32(trajectory.t0))]
    for channel in SCALAR_CHANNELS:
        values = trajectory.scalars[channel]
        if channel in INT_SCALARS:
            columns.append(pa.array(values.astype(np.int32)))
        elif channel == "growth_rate":
            mask = np.zeros(k, dtype=bool)
            mask[trajectory.rows == 0] = True
            columns.append(pa.array(values.astype(np.float32), mask=mask))
        else:
            columns.append(pa.array(values.astype(np.float32)))
    for name in schema.names[3 + len(SCALAR_CHANNELS):]:
        value = trajectory.matrices[name]
        columns.append(pa.FixedSizeListArray.from_arrays(pa.array(value.reshape(-1)), value.shape[1]))
    names = schema.names
    plain = pa.schema([pa.field("sample_id", pa.string(), nullable=False)] + [schema.field(n) for n in names[1:]])
    return pa.Table.from_arrays(columns, schema=plain)


class _PartWriter:
    """Buffers trajectory tables and writes full row groups of exactly ``row_group_rows``."""

    def __init__(self, path: Path, schema: pa.Schema, settings: Settings) -> None:
        self.schema = schema
        self.row_group_rows = settings.row_group_rows
        self.writer = pq.ParquetWriter(str(path), schema, compression=settings.compression,
                                       use_dictionary=["sample_id"], write_statistics=["sample_id", "t", "t_abs"])
        self.buffer: list[pa.Table] = []
        self.buffered = 0

    def append(self, table: pa.Table) -> None:
        self.buffer.append(table)
        self.buffered += table.num_rows
        if self.buffered >= self.row_group_rows:
            self._flush(final=False)

    def _flush(self, final: bool) -> None:
        if not self.buffered:
            return
        table = pa.concat_tables(self.buffer)
        take = self.buffered if final else (self.buffered // self.row_group_rows) * self.row_group_rows
        slab = table.slice(0, take)
        sample_ids = pc.dictionary_encode(slab.column("sample_id").combine_chunks()).cast(self.schema.field("sample_id").type)
        slab = slab.set_column(0, self.schema.field("sample_id"), sample_ids).cast(self.schema)
        self.writer.write_table(slab, row_group_size=self.row_group_rows)
        rest = table.slice(take)
        self.buffer = [rest] if rest.num_rows else []
        self.buffered = rest.num_rows

    def close(self) -> None:
        self._flush(final=True)
        self.writer.close()


def export_part(settings: Settings, line: dict, stats_path: Path) -> dict:
    """Build one part. Returns the sentinel body (status set by the caller)."""
    config = settings.config(line["config"])
    reference = Reference.load(settings)
    target = settings.repo_dir / line["path"]
    temporary = temp_path_for(target)
    moments = Moments()
    samples, rows_total = [], 0
    writer: _PartWriter | None = None
    run = _Run()
    try:
        for sample in line["samples"]:
            entry = {"sample_id": sample["sample_id"], "row_offset": None, "n_rows": None}
            started = time.time()
            try:
                handle = run.open(settings, sample["run_dir"])
                trajectory = read_trajectory(handle, sample["h5_group"], int(sample["n_steps"]), config, reference,
                                             run.reference_hash)
            except Exception as error:  # noqa: BLE001 - an unreadable trajectory is a QC failure
                run.close()
                entry["qc"] = {"ok": False, "reasons": ["unreadable: {}: {}".format(type(error).__name__, error)]}
                samples.append(entry)
                print("QC FAIL {}: {}".format(sample["sample_id"], entry["qc"]["reasons"][0]), flush=True)
                continue
            if trajectory.reasons:
                entry["qc"] = {"ok": False, "reasons": trajectory.reasons}
                samples.append(entry)
                print("QC FAIL {}: {}".format(sample["sample_id"], "; ".join(trajectory.reasons)), flush=True)
                continue
            if writer is None:
                writer = _PartWriter(temporary, build_schema(settings, config, line["family"], reference,
                                                             trajectory.units), settings)
            writer.append(trajectory_table(sample["sample_id"], trajectory, writer.schema))
            for channel in SCALAR_CHANNELS:
                values = trajectory.scalars[channel]
                if channel == "growth_rate":
                    values = np.where(trajectory.rows == 0, np.nan, values)
                moments.add(channel, values)
            for matrix, value in trajectory.matrices.items():
                moments.add(matrix, value)
            n = len(trajectory.rows)
            entry.update(row_offset=rows_total, n_rows=n, qc={"ok": True, "reasons": []},
                         seconds=round(time.time() - started, 3))
            rows_total += n
            samples.append(entry)
            del trajectory
        run.close()
        if writer is not None:
            writer.close()
            writer = None
            rename_into_place(temporary, target)
            size = target.stat().st_size
        else:
            size = 0  # every trajectory failed QC: no file is written
        moments.save(stats_path)
    except BaseException:
        run.close()
        if writer is not None:
            try:
                writer.writer.close()
            except Exception:  # noqa: BLE001
                pass
        temporary.unlink(missing_ok=True)
        raise
    return {"config": config.name, "family": line["family"], "path": line["path"] if size else None,
            "planned_path": line["path"], "bytes": size, "rows": rows_total, "samples": samples,
            "stats_npz": str(stats_path), "qc_failed": sum(1 for s in samples if not s["qc"]["ok"])}


def cmd_run(settings: Settings, args: argparse.Namespace) -> dict:
    manifest = Path(args.manifest)
    line = next(l for l in read_jsonl(manifest) if l["part"] == args.index)
    sentinel = _sentinel_path(settings, manifest, args.index)
    previous = _read_sentinel(sentinel)
    if previous and previous.get("status") == "ok" and not getattr(args, "force", False):
        print("part {} already ok ({})".format(args.index, line["path"]))
        return previous
    started = time.time()
    record = {"plan": line["plan"], "part": args.index, "config": line["config"], "family": line["family"],
              "path": line["path"], "started_at": now(), "error": None}
    try:
        record.update(export_part(settings, line, sentinel.with_suffix(".stats.npz")))
        record["status"] = "ok"
    except Exception:  # noqa: BLE001 - the sentinel carries the outcome
        record.update(status="failed", error=traceback.format_exc()[-4000:], bytes=0, rows=0, samples=[], stats_npz=None)
    record["seconds"] = round(time.time() - started, 3)
    record["finished_at"] = now()
    write_atomic_json(sentinel, record)
    print("{} part {} {}: {} rows, {} bytes, {} QC failures, {:.1f} s".format(
        record["status"], args.index, line["path"], record.get("rows"), record.get("bytes"),
        record.get("qc_failed", "-"), record["seconds"]), flush=True)
    if record["error"]:
        print(record["error"], file=sys.stderr)
    return record


# -- status / reconcile ---------------------------------------------------------

def _array_states(array_job_id: str) -> dict[int, str]:
    """index -> SLURM state for one array: squeue (live) first, then sacct (finished)."""
    states: dict[int, str] = {}
    live = subprocess.run(["squeue", "-r", "-h", "-j", array_job_id, "-o", "%i|%T"], capture_output=True, text=True)
    if live.returncode == 0:
        for row in live.stdout.splitlines():
            job, _, state = row.partition("|")
            if "_" in job:
                try:
                    states[int(job.split("_", 1)[1])] = state.strip()
                except ValueError:
                    pass
    done = subprocess.run(["sacct", "-X", "-n", "-P", "-j", array_job_id, "--format=JobID,State"],
                          capture_output=True, text=True)
    if done.returncode == 0:
        for row in done.stdout.splitlines():
            job, _, state = row.partition("|")
            if "_" in job and "[" not in job:
                try:
                    states.setdefault(int(job.split("_", 1)[1]), state.strip().split()[0])
                except ValueError:
                    pass
    return states


def _manifest_summary(settings: Settings, manifest: Path, dispatched: set[int] | None) -> dict:
    """Counts of one manifest; ``dispatched`` holds the part indices some array was submitted
    for (None: all of them). A part without a sentinel is pending if dispatched, else not
    dispatched yet."""
    lines = read_jsonl(manifest)
    summary = {"parts": len(lines), "ok": 0, "failed": 0, "pending": [], "not_dispatched": [], "rows": 0, "bytes": 0,
               "qc_failed": 0}
    for line in lines:
        sentinel = _read_sentinel(_sentinel_path(settings, manifest, line["part"]))
        if sentinel is None:
            undispatched = dispatched is not None and line["part"] not in dispatched
            summary["not_dispatched" if undispatched else "pending"].append(line["part"])
        elif sentinel.get("status") == "ok":
            summary["ok"] += 1
            summary["rows"] += sentinel.get("rows", 0)
            summary["bytes"] += sentinel.get("bytes", 0)
            summary["qc_failed"] += sentinel.get("qc_failed", 0)
        else:
            summary["failed"] += 1
    return summary


def cmd_status(settings: Settings, args: argparse.Namespace) -> dict:
    out = {}
    dispatched = dispatched_parts(settings)
    for manifest in _export_manifests(settings):
        summary = _manifest_summary(settings, manifest, dispatched.get(manifest.name, ([], set()))[1])
        out[manifest.name] = summary
        print("{}: {} parts  ok {}  failed {}  pending {}  not dispatched {}  rows {}  {:.2f} GB  "
              "QC-failed trajectories {}".format(
                  manifest.name, summary["parts"], summary["ok"], summary["failed"], len(summary["pending"]),
                  len(summary["not_dispatched"]), summary["rows"], summary["bytes"] / 1e9, summary["qc_failed"]))
    print("queued export tasks: {}".format(len(squeue_names(settings.job_prefix + "-export"))))
    return out


def cmd_reconcile(settings: Settings, args: argparse.Namespace) -> dict:
    """Fold every export sentinel into ledger.jsonl once; report failed, lost, running/pending
    and not-yet-dispatched parts.

    A part without a sentinel is running/pending while SLURM shows a live state for its task;
    lost when an array was submitted for it (dispatch log) and SLURM no longer has it live;
    not dispatched yet when no array was ever submitted for it (a sliced dispatch). Only lost
    parts are offered for re-dispatch."""
    seen = {(r.get("plan"), r.get("part"), r.get("status"), r.get("finished_at"))
            for r in read_jsonl(settings.ledger) if r.get("stage") == "export"}
    dispatched = dispatched_parts(settings)
    added, failed, lost, running, undispatched = 0, [], [], [], []
    for manifest in _export_manifests(settings):
        lines = read_jsonl(manifest)
        jobs, submitted = dispatched.get(manifest.name, ([], set()))
        states: dict[int, str] = {}
        for array_job_id in jobs:
            for index, state in _array_states(array_job_id).items():
                if state in _LIVE_STATES or index not in states:
                    states[index] = state
        for line in lines:
            sentinel = _read_sentinel(_sentinel_path(settings, manifest, line["part"]))
            if sentinel is None:
                state = states.get(line["part"])
                item = {"manifest": manifest.name, "part": line["part"], "path": line["path"], "slurm": state}
                if state in _LIVE_STATES:
                    running.append(item)
                elif submitted is not None and line["part"] not in submitted:
                    undispatched.append(item)
                else:
                    lost.append(item)
                continue
            key = (line["plan"], line["part"], sentinel.get("status"), sentinel.get("finished_at"))
            if sentinel.get("status") != "ok":
                failed.append({"manifest": manifest.name, "part": line["part"], "path": line["path"],
                               "error": (sentinel.get("error") or "").strip().splitlines()[-1:] or [""]})
            if key in seen:
                continue
            append_jsonl(settings.ledger, {
                "at": now(), "stage": "export", "plan": line["plan"], "part": line["part"],
                "config": line["config"], "family": line["family"], "path": line["path"],
                "status": sentinel.get("status"), "rows": sentinel.get("rows", 0), "bytes": sentinel.get("bytes", 0),
                "qc_failed": sentinel.get("qc_failed", 0), "finished_at": sentinel.get("finished_at"),
            })
            seen.add(key)
            added += 1
    print("ledger lines added: {}  failed parts: {}  lost parts: {}  running/pending: {}  not dispatched yet: {}".format(
        added, len(failed), len(lost), len(running), len(undispatched)))
    for item in failed[:20]:
        print("  failed {}#{} {}: {}".format(item["manifest"], item["part"], item["path"], item["error"][0]))
    for item in lost[:20]:
        print("  lost   {}#{} {} (slurm: {})".format(item["manifest"], item["part"], item["path"], item["slurm"]))
    for name, parts in _by_manifest(undispatched).items():
        print("  not dispatched yet  {}: parts {}".format(name, format_array(parts)))
    for name, parts in _by_manifest(lost).items():
        print("  re-dispatch: w4c export dispatch --manifest {} --parts {}".format(
            settings.manifest_dir / name, format_array(parts)))
    return {"added": added, "failed": failed, "lost": lost, "running": running, "undispatched": undispatched}


def _by_manifest(items: list[dict]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for item in items:
        out.setdefault(item["manifest"], []).append(item["part"])
    return out


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("export", help="one parquet file per array task, per config and family")
    stage = parser.add_subparsers(dest="action", required=True)
    plan = stage.add_parser("plan")
    plan.add_argument("--configs", help="comma-separated; default all of " + ",".join(CONFIGS))
    plan.add_argument("--families", help="comma-separated family names, or all (the default)")
    plan.add_argument("--force", action="store_true",
                      help="re-export trajectories already located, numbering parts from 00000 (overwrites)")
    plan.set_defaults(func=cmd_plan)
    dispatch = stage.add_parser("dispatch")
    dispatch.add_argument("--manifest", help="default: the latest export manifest")
    dispatch.add_argument("--parts", help="part indices of the manifest, comma-separated, ranges allowed (0-161,170)")
    dispatch.add_argument("--concurrency", type=int); dispatch.add_argument("--time"); dispatch.add_argument("--mem")
    dispatch.add_argument("--force", action="store_true"); dispatch.add_argument("--dry-run", action="store_true")
    dispatch.set_defaults(func=cmd_dispatch)
    run = stage.add_parser("run")
    run.add_argument("--manifest", required=True); run.add_argument("--index", type=int, required=True)
    run.add_argument("--force", action="store_true", help="rebuild even when an ok sentinel exists")
    run.set_defaults(func=cmd_run)
    stage.add_parser("status").set_defaults(func=cmd_status)
    stage.add_parser("reconcile").set_defaults(func=cmd_reconcile)
