"""Pathway proteome fractions for the summary config (``summarize --pathways``).

For each trajectory, one float32 column ``pathway_<name>`` (unit ``fraction``) per pathway of
the Cellarium pathway panel (``data/pathways.json``, copied from Cellarium's
``pathway_panel.py`` under its MIT licence, so the builder does not import Cellarium). The
definition is Cellarium's (``_reader_worker.py:_pathways``): at each row, the sum of the
pathway's monomer counts over the sum of all monomer counts, then the mean over the
trajectory's rows (a row with no protein at all is skipped). The rows are the ``expression``
config's 10 s rows and the counts its ``protein_counts_matrix``. That matrix is pruned to the
monomers that are non-zero somewhere in the campaign, so its row sum is the sum over all
monomers.

Symbols resolve through ``provenance/reference/genes.parquet`` (``symbol`` -> ``monomer_id``)
to ``provenance/reference/protein_counts.parquet``, whose ``id`` carries a compartment suffix
(``EG10003-MONOMER[c]``) that ``monomer_id`` lacks; the row's ``product_column`` is the matrix
column. Every symbol that does not resolve and every monomer that is pruned (``active`` false,
never non-zero) is logged; a pathway that resolves to no column is fatal.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Callable

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

PANEL_PATH = Path(__file__).resolve().parent / "data" / "pathways.json"
PREFIX = "pathway_"
UNIT = "fraction"
MATRIX = "protein_counts_matrix"
BATCH_ROWS = 2048
_COMPARTMENT = re.compile(r"\[[^\]]+\]$")


def _warn(line: str) -> None:
    print(line, file=sys.stderr)


def load_panel(path: Path | None = None) -> dict[str, list[str]]:
    """{pathway: [gene symbol]} in file order (default: data/pathways.json)."""
    path = Path(path or PANEL_PATH)
    panel = json.loads(path.read_text(encoding="utf-8"))["pathways"]
    if not panel or not all(isinstance(v, list) and v for v in panel.values()):
        raise SystemExit("{}: no pathways, or a pathway without genes".format(path))
    return panel


def column_names(panel: dict[str, list[str]]) -> list[str]:
    return [PREFIX + name for name in panel]


def resolve(panel: dict[str, list[str]], genes: pa.Table, reference: pa.Table,
            log: Callable[[str], None] = _warn) -> tuple[dict[str, np.ndarray], dict]:
    """{pathway: product columns of protein_counts_matrix} and a report
    ({"columns": {pathway: n}, "unresolved": {pathway: [symbol]}, "pruned": {pathway: [monomer]}}).

    A symbol is unresolved when genes.parquet has no row with that ``symbol``, the row has no
    ``monomer_id``, or the monomer is not in the reference; a resolved monomer is pruned when
    its reference row is not ``active``. Refuses a pathway with no column."""
    monomers: dict[str, list[str]] = {}
    for symbol, monomer in zip(genes.column("symbol").to_pylist(), genes.column("monomer_id").to_pylist()):
        if symbol:
            monomers.setdefault(symbol, [])
            if monomer:
                monomers[symbol].append(monomer)
    rows: dict[str, tuple[bool, int | None]] = {}
    for rid, active, product in zip(reference.column("id").to_pylist(), reference.column("active").to_pylist(),
                                    reference.column("product_column").to_pylist()):
        base = _COMPARTMENT.sub("", rid)
        if base in rows:
            raise SystemExit("protein_counts reference: monomer {} appears twice".format(base))
        rows[base] = (bool(active), None if product is None or product != product else int(product))
    columns, report = {}, {"columns": {}, "unresolved": {}, "pruned": {}}
    for pathway, symbols in panel.items():
        found: list[int] = []
        for symbol in symbols:
            ids = [m for m in monomers.get(symbol, []) if _COMPARTMENT.sub("", m) in rows]
            if not ids:
                why = ("not a gene symbol in genes.parquet" if symbol not in monomers else
                       "no monomer_id in genes.parquet" if not monomers[symbol] else
                       "monomer {} not in protein_counts.parquet".format(monomers[symbol]))
                log("pathway {}: symbol {} does not resolve ({})".format(pathway, symbol, why))
                report["unresolved"].setdefault(pathway, []).append(symbol)
                continue
            for monomer in ids:
                active, product = rows[_COMPARTMENT.sub("", monomer)]
                if not active or product is None:
                    log("pathway {}: {} ({}) is pruned (never non-zero in the campaign)".format(pathway, monomer, symbol))
                    report["pruned"].setdefault(pathway, []).append(monomer)
                    continue
                found.append(product)
        found = sorted(set(found))
        if not found:
            raise SystemExit("pathway {} resolves to no protein_counts_matrix column".format(pathway))
        columns[pathway] = np.array(found, np.int64)
        report["columns"][pathway] = len(found)
    return columns, report


def row_fractions(counts: np.ndarray, columns: dict[str, np.ndarray]) -> np.ndarray:
    """[rows, pathways] float64: each pathway's counts over the row total; NaN where the total is 0."""
    total = counts.sum(axis=1, dtype=np.int64).astype(np.float64)
    total[total == 0] = np.nan
    out = np.empty((counts.shape[0], len(columns)))
    for k, cols in enumerate(columns.values()):
        out[:, k] = counts[:, cols].sum(axis=1, dtype=np.int64) / total
    return out


def _matrix(column: pa.ChunkedArray | pa.Array) -> np.ndarray:
    array = column.combine_chunks() if isinstance(column, pa.ChunkedArray) else column
    if array.null_count:
        raise SystemExit("{} has a null row".format(MATRIX))
    width = array.type.list_size
    return array.flatten().to_numpy(zero_copy_only=False).reshape(len(array), width)


def expression_fractions(files: list[Path], columns: dict[str, np.ndarray], batch_rows: int = BATCH_ROWS
                         ) -> tuple[list[str], np.ndarray, np.ndarray]:
    """Stream the expression parts of one family: (sample_ids, [trajectories, pathways] mean
    fractions with NaN where no row had protein, rows per trajectory). Refuses a trajectory whose
    rows are not contiguous."""
    ids: list[str] = []
    sums: list[np.ndarray] = []
    counts: list[np.ndarray] = []
    rows: list[int] = []
    for path in files:
        previous = None  # trajectories do not span files
        # pre_buffer=False: with it, pyarrow buffers the whole file (RSS ~ file size); without, a row group.
        handle = pq.ParquetFile(str(path), pre_buffer=False)
        for batch in handle.iter_batches(batch_size=batch_rows, columns=["sample_id", MATRIX]):
            sample = batch.column(0).cast(pa.string())
            n = len(sample)
            changed = pc.not_equal(sample.slice(1), sample.slice(0, n - 1)).to_numpy(zero_copy_only=False) \
                if n > 1 else np.zeros(0, bool)
            starts = np.concatenate([[0], np.flatnonzero(changed) + 1]).astype(np.int64)
            fractions = row_fractions(_matrix(batch.column(1)), columns)
            finite = ~np.isnan(fractions)
            segment_sum = np.add.reduceat(np.where(finite, fractions, 0.0), starts, axis=0)
            segment_count = np.add.reduceat(finite.astype(np.int64), starts, axis=0)
            segment_rows = np.diff(np.append(starts, n))
            names = sample.take(pa.array(starts)).to_pylist()
            for i, name in enumerate(names):
                if i == 0 and previous == name:  # continues from the previous batch
                    sums[-1] += segment_sum[i]
                    counts[-1] += segment_count[i]
                    rows[-1] += int(segment_rows[i])
                    continue
                ids.append(name)
                sums.append(segment_sum[i].copy())
                counts.append(segment_count[i].copy())
                rows.append(int(segment_rows[i]))
            previous = names[-1]
    if len(set(ids)) != len(ids):
        repeated = [name for name, n in Counter(ids).items() if n > 1]
        raise SystemExit("expression: trajectory rows are not contiguous (e.g. {})".format(repeated[:3]))
    if not ids:
        return [], np.zeros((0, len(columns))), np.zeros(0, np.int64)
    total, count = np.vstack(sums), np.vstack(counts)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    return ids, mean, np.array(rows, np.int64)


def located_expression(index: pa.Table, family: str) -> dict[str, int] | None:
    """{sample_id: expression_n_rows} of the index rows of ``family`` with an expression locator;
    None when the index has no expression locator columns."""
    if "expression_file" not in index.column_names or "expression_n_rows" not in index.column_names:
        return None
    table = index.select(["sample_id", "family", "expression_file", "expression_n_rows"])
    table = table.filter(pc.and_(pc.equal(table.column("family"), family), pc.is_valid(table.column("expression_file"))))
    return dict(zip(table.column("sample_id").to_pylist(), table.column("expression_n_rows").to_pylist()))


def append_columns(summary: pa.Table, family: str, panel: dict[str, list[str]], ids: list[str],
                   mean: np.ndarray, n_rows: np.ndarray, index: pa.Table,
                   log: Callable[[str], None] = _warn) -> pa.Table:
    """``summary`` with the ``pathway_<name>`` columns appended (null for a trajectory that is
    not in the expression parts). Refuses an expression trajectory that is not in the summary,
    and, when the index has expression locators, any disagreement with them (set or row count)."""
    position = {s: i for i, s in enumerate(ids)}
    wanted = summary.column("sample_id").to_pylist()
    stray = sorted(set(ids) - set(wanted))
    if stray:
        raise SystemExit("{}: {} expression trajectories are not in the summary, e.g. {}".format(family, len(stray), stray[:3]))
    located = located_expression(index, family)
    if located is not None:
        if set(located) != set(ids):
            raise SystemExit("{}: the expression parts hold {} trajectories but the index locates {}; the index "
                             "locators are stale (run `w4c finalize`, then summarize --pathways)".format(
                                 family, len(ids), len(located)))
        bad = [(s, int(n_rows[position[s]]), n) for s, n in located.items() if int(n_rows[position[s]]) != n]
        if bad:
            raise SystemExit("{}: expression rows != expression_n_rows for {} trajectories, e.g. {}".format(
                family, len(bad), bad[:3]))
    missing = [s for s in wanted if s not in position]
    if missing:
        log("{}: {} of {} trajectories have no expression rows; their pathway columns are null".format(
            family, len(missing), len(wanted)))
    take = np.array([position.get(s, -1) for s in wanted], np.int64)
    for k, name in enumerate(column_names(panel)):
        values = np.where(take >= 0, mean[np.maximum(take, 0), k] if len(ids) else np.nan, np.nan)
        null = np.isnan(values)
        field = pa.field(name, pa.float32(), nullable=True, metadata={b"unit": UNIT.encode()})
        summary = summary.append_column(field, pa.array(values.astype(np.float32), pa.float32(),
                                                        mask=null if null.any() else None))
    return summary
