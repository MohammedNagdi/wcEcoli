"""Stage 4b: the ``summary`` config, one row per trajectory, computed from core (ADR 0010).

``summarize`` reads every core part ``data/core/<family>/part-NNNNN.parquet`` and writes
``data/summary/<family>/part-00000.parquet``: per trajectory ``sample_id``, ``n_steps`` and,
for each of the 18 scalars in ``SCALAR_CHANNELS`` order, ``<channel>_mean``, ``_min``,
``_max``, ``_first``, ``_last`` over its 1 s rows. Float channels give float32 statistics;
the int channels (``mrna_counts``, ``n_oric``) give int32 min/max/first/last and a float32
mean. Null values are skipped: ``growth_rate`` is null at row 0, so its ``_first`` is the
value at t = 1 and its mean is over rows 1..n-1 (a statistic with no non-null value is null).
Fields carry the core field's ``unit``; the file carries ``well4cell_version``, ``config`` =
``summary``, ``family`` and ``stride`` = 1, like every product.

The core files are streamed in record batches (a trajectory's rows are contiguous within one
file and may span batches) and opened with ``pre_buffer=False``, so pyarrow reads a row group
at a time rather than buffering the whole part. Memory stays at a batch plus one trajectory
plus the family's summary rows, whatever the size of the family or the part.

Verification (refuses on failure, before anything is written): per family, the summary has
exactly one row per index row with a non-null ``core_file``, in the same set, each with
``n_steps == core_n_rows`` and starting at ``core_row_offset`` of ``core_file``. The rows are
written in index order (family tier order, cell_id, seed, generation). So run it after
``finalize`` has filled the core locators, then run ``finalize`` again to put the summary in
the card and manifest.

Pathways (``--pathways``, pathways.py). Appends 13 float32 columns ``pathway_<name>`` (unit
``fraction``) after the scalar statistics: the proteome fraction of each pathway of the
Cellarium panel (``data/pathways.json``), from the ``expression`` config's
``protein_counts_matrix`` at 10 s, averaged over the trajectory. They are written only for a
family whose expression parts exist: with ``--pathways`` the stage refuses (before writing
anything) if any family it summarizes has no expression part, so run it once the expression
export is complete, or narrow ``--families``. Every pathway symbol that does not resolve and
every pruned monomer is logged; a pathway with no column is fatal. Without ``--pathways`` the
summary has no pathway columns.

Paths default to the build tree (``repo/data/core``, ``repo/data/expression``,
``repo/provenance/reference``, ``repo/index.parquet``, ``repo/data/summary``); ``--core-dir``,
``--expression-dir``, ``--reference-dir``, ``--index`` and ``--out-dir`` override them, so the
stage also runs on a machine holding only downloaded parts and the published index::

    PYTHONPATH=cluster WCECOLI_CAMPAIGN_ROOT=/unused python -m well4cell_build summarize \\
        --core-dir hub/data/core --index hub/index.parquet --out-dir hub/data/summary \\
        --pathways --expression-dir hub/data/expression --reference-dir hub/provenance/reference
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import pathways as pathway_fractions
from .finalize import UNITS
from .ledger import append_jsonl, now, rename_into_place, temp_path_for
from .settings import FAMILIES, INT_SCALARS, SCALAR_CHANNELS, SUMMARY_CONFIG, SUMMARY_STATS, Settings

BATCH_ROWS = 1 << 18


def column_names(panel: dict[str, list[str]] | None = None) -> list[str]:
    """Summary columns; with ``panel`` (``--pathways``) the pathway columns follow the statistics."""
    return (["sample_id", "n_steps"] + ["{}_{}".format(c, s) for c in SCALAR_CHANNELS for s in SUMMARY_STATS]
            + (pathway_fractions.column_names(panel) if panel else []))


def schema(settings: Settings, family: str, units: dict[str, str] | None = None) -> pa.Schema:
    units = {**UNITS, **(units or {})}
    fields = [pa.field("sample_id", pa.string(), nullable=False),
              pa.field("n_steps", pa.int32(), nullable=False)]
    for channel in SCALAR_CHANNELS:
        meta = {b"unit": units[channel].encode()} if units.get(channel) else None
        for stat in SUMMARY_STATS:
            kind = pa.int32() if channel in INT_SCALARS and stat != "mean" else pa.float32()
            fields.append(pa.field("{}_{}".format(channel, stat), kind, nullable=channel == "growth_rate",
                                   metadata=meta))
    return pa.schema(fields, metadata={b"well4cell_version": settings.version.encode(),
                                       b"config": SUMMARY_CONFIG.encode(), b"family": family.encode(),
                                       b"stride": b"1"})


def core_units(path: Path) -> dict[str, str]:
    return {f.name: f.metadata[b"unit"].decode() for f in pq.read_schema(path)
            if f.metadata and b"unit" in f.metadata}


# -- aggregation (pure; unit-tested in test_summarize.py) --------------------------------------
def _segment_stats(values: np.ndarray, starts: np.ndarray) -> dict[str, np.ndarray]:
    """mean/min/max/first/last of each segment [starts[i], starts[i+1]) of float64 ``values``,
    skipping NaN (= null); NaN where a segment has no finite value."""
    n = values.shape[0]
    finite = ~np.isnan(values)
    if finite.all():
        ends = np.append(starts[1:], n)
        sums = np.add.reduceat(values, starts)
        return {"mean": sums / (ends - starts), "min": np.minimum.reduceat(values, starts),
                "max": np.maximum.reduceat(values, starts), "first": values[starts], "last": values[ends - 1]}
    k = starts.shape[0]
    count = np.add.reduceat(finite.astype(np.int64), starts)
    sums = np.add.reduceat(np.where(finite, values, 0.0), starts)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(count > 0, sums / np.maximum(count, 1), np.nan)
    rows = np.flatnonzero(finite)
    segment = np.searchsorted(starts, rows, side="right") - 1
    first = np.full(k, np.nan)
    last = np.full(k, np.nan)
    first[segment[::-1]] = values[rows[::-1]]  # the earliest finite row of a segment is written last
    last[segment] = values[rows]
    return {"mean": mean, "min": np.fmin.reduceat(values, starts), "max": np.fmax.reduceat(values, starts),
            "first": first, "last": last}


def aggregate(block: pa.Table, starts: np.ndarray) -> dict[str, np.ndarray]:
    """Statistics of the trajectories of ``block``, which start at rows ``starts`` (complete
    trajectories only). Returns the columns of the summary as numpy arrays, NaN = null."""
    n = block.num_rows
    out: dict[str, np.ndarray] = {"n_steps": np.diff(np.append(starts, n)).astype(np.int64)}
    for channel in SCALAR_CHANNELS:
        column = block.column(channel).combine_chunks()
        values = pc.fill_null(column.cast(pa.float64()), np.nan).to_numpy(zero_copy_only=False)
        for stat, array in _segment_stats(values, starts).items():
            out["{}_{}".format(channel, stat)] = array
    return out


def _to_arrow(columns: dict[str, np.ndarray], sample_ids: list[str], target: pa.Schema) -> pa.Table:
    arrays = [pa.array(sample_ids, pa.string()), pa.array(columns["n_steps"], pa.int32())]
    for field in list(target)[2:]:
        values = columns[field.name]
        missing = np.isnan(values)
        if missing.any() and not field.nullable:
            raise SystemExit("summary column {} has a null where core has none".format(field.name))
        if pa.types.is_integer(field.type):
            arrays.append(pa.array(np.where(missing, 0, values).astype(np.int32), field.type,
                                   mask=missing if missing.any() else None))
        else:
            arrays.append(pa.array(values.astype(np.float32), field.type, mask=missing if missing.any() else None))
    return pa.Table.from_arrays(arrays, schema=target)


def summarize_core_file(path: Path, target: pa.Schema, batch_rows: int = BATCH_ROWS
                        ) -> tuple[pa.Table, list[int]]:
    """One core part -> (summary rows in file order, each trajectory's first row in the file).

    Refuses a trajectory whose rows are not contiguous (the same sample_id twice in the file)."""
    # pre_buffer=False (as pathways.py): with pyarrow's default read-ahead the resident set grows
    # toward the part size (~2 GB); without it a row group (2,048 rows) is buffered at a time.
    handle = pq.ParquetFile(str(path), pre_buffer=False)
    wanted = ["sample_id"] + list(SCALAR_CHANNELS)
    pieces: list[pa.Table] = []
    offsets: list[int] = []
    seen: set[str] = set()
    carry: pa.Table | None = None
    base = 0  # file row of the first row of `carry` (or of the next batch when carry is None)

    def flush(block: pa.Table, starts: np.ndarray, first_row: int) -> None:
        ids = block.column("sample_id").take(pa.array(starts)).to_pylist()
        repeated = [s for s in ids if s in seen]
        if repeated or len(set(ids)) != len(ids):
            raise SystemExit("{}: trajectory rows are not contiguous (e.g. {})".format(
                path, (repeated or ids)[:3]))
        seen.update(ids)
        offsets.extend(int(first_row + s) for s in starts)
        pieces.append(_to_arrow(aggregate(block, starts), ids, target))

    for batch in handle.iter_batches(batch_size=batch_rows, columns=wanted):
        table = pa.Table.from_batches([batch])
        table = table.set_column(0, "sample_id", table.column("sample_id").cast(pa.string()))
        if carry is not None:
            table = pa.concat_tables([carry, table]).combine_chunks()
        ids = table.column("sample_id")
        n = table.num_rows
        changed = pc.not_equal(ids.slice(1), ids.slice(0, n - 1)).to_numpy(zero_copy_only=False) if n > 1 else []
        starts = np.concatenate([[0], np.flatnonzero(changed) + 1]).astype(np.int64)
        last = int(starts[-1])
        if last > 0:
            flush(table.slice(0, last), starts[:-1], base)
        carry = table.slice(last)
        base += last
    if carry is not None and carry.num_rows:
        flush(carry, np.array([0], np.int64), base)
    if not pieces:
        return target.empty_table(), []
    return pa.concat_tables(pieces).combine_chunks(), offsets


def located_core(index: pa.Table, family: str) -> pa.Table:
    """Index rows of ``family`` with a core locator, in index order."""
    columns = ["sample_id", "family", "core_file", "core_row_offset", "core_n_rows"]
    missing = [c for c in columns if c not in index.column_names]
    if missing:
        raise SystemExit("index lacks {}; run `w4c finalize` first".format(missing))
    table = index.select(columns)
    mask = pc.and_(pc.equal(table.column("family"), family), pc.is_valid(table.column("core_file")))
    return table.filter(mask)


def assemble(family: str, pieces: list[tuple[str, pa.Table, list[int]]], index: pa.Table) -> pa.Table:
    """Concatenate the per-file summaries of ``family``, verify them against the index's core
    locators and return them in index order. ``pieces``: (core_file as the index names it,
    summary rows, first row of each trajectory in that file)."""
    expected = located_core(index, family)
    tables = [t for _, t, _ in pieces if t.num_rows]
    summary = pa.concat_tables(tables).combine_chunks() if tables else None
    rows = summary.num_rows if summary is not None else 0
    where = {}
    for name, table, offsets in pieces:
        for sample_id, offset in zip(table.column("sample_id").to_pylist(), offsets):
            where[sample_id] = (name, offset)
    if rows != expected.num_rows or len(where) != rows:
        raise SystemExit("{}: {} summary rows ({} distinct) but {} index rows with a core_file; the index "
                         "locators are stale or core is incomplete (run `w4c finalize`, then summarize)".format(
                             family, rows, len(where), expected.num_rows))
    wanted = expected.column("sample_id").to_pylist()
    absent = [s for s in wanted if s not in where]
    if absent:
        raise SystemExit("{}: {} located trajectories have no summary row, e.g. {}".format(family, len(absent), absent[:5]))
    position = {s: i for i, s in enumerate(summary.column("sample_id").to_pylist())}
    ordered = summary.take(pa.array([position[s] for s in wanted], pa.int64()))
    n_steps = ordered.column("n_steps").to_numpy()
    n_rows = expected.column("core_n_rows").to_numpy(zero_copy_only=False)
    bad = np.flatnonzero(n_steps != n_rows)
    if bad.size:
        raise SystemExit("{}: n_steps != core_n_rows for {} trajectories, e.g. {}".format(
            family, bad.size, [(wanted[i], int(n_steps[i]), int(n_rows[i])) for i in bad[:5]]))
    files = expected.column("core_file").to_pylist()
    starts = expected.column("core_row_offset").to_pylist()
    moved = [s for s, f, o in zip(wanted, files, starts) if where[s] != (f, o)]
    if moved:
        raise SystemExit("{}: {} trajectories are not where the index locates them, e.g. {}".format(
            family, len(moved), [(s, where[s], (f, o)) for s, f, o in zip(wanted, files, starts) if s in moved[:3]]))
    return ordered


def write_summary(settings: Settings, table: pa.Table, path: Path) -> int:
    """Atomic write: zstd (W4C_COMPRESSION), row groups of W4C_ROW_GROUP_ROWS."""
    temporary = temp_path_for(path)
    pq.write_table(table, temporary, compression=settings.compression, row_group_size=settings.row_group_rows)
    rename_into_place(temporary, path)
    return path.stat().st_size


def summarize_family(settings: Settings, family: str, files: list[Path], index: pa.Table,
                     out_path: Path, pathways: tuple[dict, dict, list[Path]] | None = None) -> dict:
    """``pathways``: (panel, resolved product columns, expression parts of this family), or None."""
    started = time.time()
    target = schema(settings, family, core_units(files[0]))
    pieces = []
    for path in files:
        table, offsets = summarize_core_file(path, target)
        pieces.append(("data/core/{}/{}".format(family, path.name), table, offsets))
        print("  {} {}: {:,} trajectories".format(family, path.name, table.num_rows), flush=True)
    ordered = assemble(family, pieces, index)
    report = {"family": family, "files": len(files)}
    if pathways is not None:
        panel, columns, expression = pathways
        ids, mean, n_rows = pathway_fractions.expression_fractions(expression, columns)
        print("  {} expression: {:,} trajectories from {} part(s)".format(family, len(ids), len(expression)), flush=True)
        ordered = pathway_fractions.append_columns(ordered, family, panel, ids, mean, n_rows, index)
        report["pathways"] = len(panel)
    size = write_summary(settings, ordered, out_path)
    return {**report, "rows": ordered.num_rows, "bytes": size, "seconds": round(time.time() - started, 1)}


def cmd_summarize(settings: Settings, args: argparse.Namespace) -> list[dict]:
    core_dir = Path(args.core_dir) if args.core_dir else settings.repo_dir / "data" / "core"
    index_path = Path(args.index) if args.index else settings.index_path
    out_dir = Path(args.out_dir) if args.out_dir else settings.repo_dir / "data" / SUMMARY_CONFIG
    families = [f.strip() for f in args.families.split(",") if f.strip()] if args.families else list(FAMILIES)
    unknown = [f for f in families if f not in FAMILIES]
    if unknown:
        raise SystemExit("unknown families {}; choose from {}".format(unknown, ", ".join(FAMILIES)))
    if not index_path.exists():
        raise SystemExit("no {}; run `w4c index build` and `w4c finalize` first".format(index_path))
    index = pq.read_table(index_path)
    core = {f: sorted((core_dir / f).glob("part-*.parquet")) for f in families}
    for family in [f for f in families if not core[f]]:
        print("{}: no core parts under {}; skipped".format(family, core_dir / family), file=sys.stderr)
    panel = columns = resolution = None
    expression: dict[str, list[Path]] = {}
    if getattr(args, "pathways", False):
        expression_dir = Path(args.expression_dir) if args.expression_dir else settings.repo_dir / "data" / "expression"
        expression = {f: sorted((expression_dir / f).glob("part-*.parquet")) for f in families if core[f]}
        lacking = [f for f, paths in expression.items() if not paths]
        if lacking:
            raise SystemExit("--pathways: no expression parts under {} for {}; pathway columns are computed from "
                             "the expression config, so export it first (or narrow --families)".format(
                                 expression_dir, ", ".join(lacking)))
        reference_dir = Path(args.reference_dir) if args.reference_dir else settings.reference_dir
        panel = pathway_fractions.load_panel()
        columns, resolution = pathway_fractions.resolve(
            panel, pq.read_table(reference_dir / "genes.parquet", columns=["symbol", "monomer_id"]),
            pq.read_table(reference_dir / "protein_counts.parquet"))
        print("pathways: {}".format(", ".join("{} {}".format(p, n) for p, n in resolution["columns"].items())))
    reports = []
    for family in families:
        if not core[family]:
            continue
        report = summarize_family(settings, family, core[family], index, out_dir / family / "part-00000.parquet",
                                  (panel, columns, expression[family]) if panel else None)
        print("{family}: {rows:,} trajectories from {files} core file(s), {bytes:,} bytes, {seconds} s".format(**report))
        reports.append(report)
    if settings.build_dir.is_dir() and not args.out_dir:
        record = {"at": now(), "stage": "summarize", "families": reports}
        if resolution:
            record["pathways"] = resolution
        append_jsonl(settings.ledger, record)
    return reports


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("summarize", help="the summary config: one row per trajectory, from core (after finalize)")
    parser.add_argument("--families", help="comma-separated families (default: every family with core parts)")
    parser.add_argument("--core-dir", help="directory holding <family>/part-*.parquet core parts (default: repo/data/core)")
    parser.add_argument("--index", help="index.parquet with the core locators (default: repo/index.parquet)")
    parser.add_argument("--out-dir", help="where <family>/part-00000.parquet is written (default: repo/data/summary)")
    parser.add_argument("--pathways", action="store_true",
                        help="append the 13 pathway_<name> proteome fractions from the expression config; refuses "
                             "if a family has no expression parts (run after the expression export)")
    parser.add_argument("--expression-dir", help="directory holding <family>/part-*.parquet expression parts "
                                                 "(default: repo/data/expression)")
    parser.add_argument("--reference-dir", help="directory holding genes.parquet and protein_counts.parquet "
                                                "(default: repo/provenance/reference)")
    parser.set_defaults(func=cmd_summarize)
