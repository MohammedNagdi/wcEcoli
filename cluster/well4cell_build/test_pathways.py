"""pathways: proteome fractions of fabricated expression parts and reference tables (summarize --pathways).

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_pathways.py
"""

from __future__ import annotations

import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from well4cell_build import finalize, pathways, summarize
from well4cell_build.test_summarize import FAMILY, FILES, args, build, make_settings

# protein_counts reference: ids carry a compartment suffix; M4 is pruned (never non-zero).
REFERENCE = [("M0[c]", True, 0), ("M1[i]", True, 1), ("M2[c]", True, 2), ("M3[p]", True, 3), ("M4[c]", False, None),
             ("M5[c]", True, 4)]
WIDTH = 5
# genes.parquet: symbol -> monomer_id without the suffix; x has no monomer, M9 is not in the reference.
GENES = [("a", "M0"), ("b", "M1"), ("c", "M2"), ("d", "M3"), ("p", "M4"), ("x", None), ("y", "M9"), ("e", "M5")]
PANEL = {"alpha": ["a", "b", "x", "zz"], "beta": ["c", "p"], "gamma": ["d", "e", "y"]}
EXPECTED_COLUMNS = {"alpha": [0, 1], "beta": [2], "gamma": [3, 4]}


def write_reference(directory) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"column": pa.array(range(len(REFERENCE)), pa.int32()),
                             "id": [r[0] for r in REFERENCE], "active": [r[1] for r in REFERENCE],
                             "product_column": pa.array([r[2] for r in REFERENCE], pa.float64())}),
                   directory / "protein_counts.parquet")
    pq.write_table(pa.table({"symbol": [g[0] for g in GENES], "monomer_id": pa.array([g[1] for g in GENES], pa.string())}),
                   directory / "genes.parquet")


def write_panel(path, panel=PANEL) -> None:
    path.write_text(json.dumps({"_source": "test", "pathways": panel}))


def write_expression(path, rng, trajectories: list[tuple[str, int]]) -> dict[str, np.ndarray]:
    """One expression part, ``n`` rows per trajectory; the second row of each is all zero (no
    protein yet), a row Cellarium's definition skips."""
    raw = {sid: rng.integers(0, 50, (n, WIDTH)).astype(np.int32) for sid, n in trajectories}
    for counts in raw.values():
        if counts.shape[0] > 1:
            counts[1] = 0
    ids = [sid for sid, n in trajectories for _ in range(n)]
    matrix = np.concatenate([raw[sid] for sid, _ in trajectories])
    values = pa.FixedSizeListArray.from_arrays(pa.array(matrix.ravel(), pa.int32()), WIDTH)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"sample_id": pa.array(ids).dictionary_encode(), "protein_counts_matrix": values}), path,
                   row_group_size=3)
    return raw


def expected(counts: np.ndarray) -> dict[str, float]:
    total = counts.sum(axis=1).astype(float)
    keep = total > 0
    return {p: float(np.mean(counts[keep][:, c].sum(axis=1) / total[keep])) for p, c in EXPECTED_COLUMNS.items()}


def setup(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build(tmp_path)
    write_reference(tmp_path / "reference")
    write_panel(tmp_path / "pathways.json")
    monkeypatch.setattr(pathways, "PANEL_PATH", tmp_path / "pathways.json")
    rng = np.random.default_rng(3)
    trajectories = [(sid, 1 + n // 3) for spec in FILES.values() for sid, n in spec]
    raw = write_expression(tmp_path / "expression" / FAMILY / "part-00000.parquet", rng, trajectories[:3])
    raw |= write_expression(tmp_path / "expression" / FAMILY / "part-00001.parquet", rng, trajectories[3:])
    return settings, raw


def pathway_args(tmp_path, **overrides):
    return args(tmp_path, pathways=True, expression_dir=str(tmp_path / "expression"),
                reference_dir=str(tmp_path / "reference"), **overrides)


def test_panel_file_is_cellarium_s_thirteen_pathways_with_its_licence():
    document = json.loads(pathways.PANEL_PATH.read_text())
    assert "cellarium" in document["_source"] and document["_license"].startswith("MIT License. Copyright (c) 2026")
    panel = pathways.load_panel()
    assert len(panel) == 13 and list(panel)[0] == "translation_ribosome" and "rpsA" in panel["translation_ribosome"]
    assert pathways.column_names(panel)[0] == "pathway_translation_ribosome"


def test_symbols_resolve_through_genes_and_unresolved_or_pruned_are_logged(tmp_path):
    write_reference(tmp_path)
    lines = []
    columns, report = pathways.resolve(PANEL, pq.read_table(tmp_path / "genes.parquet"),
                                       pq.read_table(tmp_path / "protein_counts.parquet"), log=lines.append)
    assert {p: c.tolist() for p, c in columns.items()} == EXPECTED_COLUMNS
    assert report["unresolved"] == {"alpha": ["x", "zz"], "gamma": ["y"]}
    assert report["pruned"] == {"beta": ["M4"]}
    assert report["columns"] == {"alpha": 2, "beta": 1, "gamma": 2}
    assert any("symbol zz does not resolve (not a gene symbol" in line for line in lines)
    assert any("symbol x does not resolve (no monomer_id" in line for line in lines)
    assert any("M4 (p) is pruned" in line for line in lines)
    with pytest.raises(SystemExit, match="pathway empty resolves to no protein_counts_matrix column"):
        pathways.resolve({"empty": ["p", "x"]}, pq.read_table(tmp_path / "genes.parquet"),
                         pq.read_table(tmp_path / "protein_counts.parquet"), log=lines.append)


def test_summarize_appends_the_fractions_cellarium_computes(tmp_path, monkeypatch):
    settings, raw = setup(tmp_path, monkeypatch)
    summarize.cmd_summarize(settings, pathway_args(tmp_path))
    path = tmp_path / "summary" / FAMILY / "part-00000.parquet"
    table = pq.read_table(path)
    assert table.column_names == summarize.column_names(PANEL)
    schema = pq.read_schema(path)
    for name in pathways.column_names(PANEL):
        assert schema.field(name).type == pa.float32() and schema.field(name).metadata == {b"unit": b"fraction"}
    assert schema.metadata[b"config"] == b"summary"
    for i, sid in enumerate(table.column("sample_id").to_pylist()):
        for pathway, value in expected(raw[sid]).items():
            got = table.column("pathway_" + pathway)[i].as_py()
            assert got == pytest.approx(value, rel=1e-6) and 0.0 <= got <= 1.0, (sid, pathway)
    # the scalar statistics are unchanged by --pathways
    plain = tmp_path / "plain"
    summarize.cmd_summarize(settings, args(tmp_path, out_dir=str(plain)))
    assert table.select(summarize.column_names()).equals(pq.read_table(plain / FAMILY / "part-00000.parquet"))


def test_trajectories_spanning_batches(tmp_path, monkeypatch):
    _, raw = setup(tmp_path, monkeypatch)
    files = sorted((tmp_path / "expression" / FAMILY).glob("part-*.parquet"))
    columns = {p: np.array(c) for p, c in EXPECTED_COLUMNS.items()}
    whole = pathways.expression_fractions(files, columns)
    for batch_rows in (1, 2, 5):
        ids, mean, rows = pathways.expression_fractions(files, columns, batch_rows=batch_rows)
        assert ids == whole[0] and np.allclose(mean, whole[1]) and rows.tolist() == whole[2].tolist()
    assert whole[2].tolist() == [raw[s].shape[0] for s in whole[0]]


def test_pathways_refuse_a_family_without_expression_and_write_nothing(tmp_path, monkeypatch):
    settings, _ = setup(tmp_path, monkeypatch)
    for part in (tmp_path / "expression" / FAMILY).glob("*.parquet"):
        part.unlink()
    with pytest.raises(SystemExit, match="--pathways: no expression parts .* for wildtype_media"):
        summarize.cmd_summarize(settings, pathway_args(tmp_path))
    assert not (tmp_path / "summary" / FAMILY / "part-00000.parquet").exists()


def test_pathways_check_the_index_expression_locators(tmp_path, monkeypatch):
    settings, raw = setup(tmp_path, monkeypatch)
    index = pq.read_table(tmp_path / "index.parquet")
    ids = index.column("sample_id").to_pylist()
    files = ["data/expression/x.parquet" if s in raw else None for s in ids]
    n_rows = [raw[s].shape[0] if s in raw else None for s in ids]
    located = index.append_column("expression_file", pa.array(files, pa.string())) \
                   .append_column("expression_n_rows", pa.array(n_rows, pa.int32()))
    pq.write_table(located, tmp_path / "index.parquet")
    summarize.cmd_summarize(settings, pathway_args(tmp_path))  # agrees
    n_rows[0] += 1
    pq.write_table(located.set_column(located.num_columns - 1, "expression_n_rows", pa.array(n_rows, pa.int32())),
                   tmp_path / "index.parquet")
    with pytest.raises(SystemExit, match="expression rows != expression_n_rows"):
        summarize.cmd_summarize(settings, pathway_args(tmp_path))
    files[1] = None
    pq.write_table(located.set_column(located.num_columns - 2, "expression_file", pa.array(files, pa.string())),
                   tmp_path / "index.parquet")
    with pytest.raises(SystemExit, match="the index locates 4; the index locators are stale"):
        summarize.cmd_summarize(settings, pathway_args(tmp_path))


def test_a_trajectory_missing_from_expression_gets_nulls(tmp_path, monkeypatch, capsys):
    settings, _ = setup(tmp_path, monkeypatch)
    (tmp_path / "expression" / FAMILY / "part-00001.parquet").unlink()
    summarize.cmd_summarize(settings, pathway_args(tmp_path))
    table = pq.read_table(tmp_path / "summary" / FAMILY / "part-00000.parquet")
    assert table.column("pathway_alpha").null_count == 2 and table.column("pathway_alpha").to_pylist()[:3] != [None] * 3
    assert "2 of 5 trajectories have no expression rows" in capsys.readouterr().err


def test_finalize_lists_the_pathway_columns_of_the_summary(tmp_path, monkeypatch):
    settings, _ = setup(tmp_path, monkeypatch)
    summarize.cmd_summarize(settings, pathway_args(tmp_path))
    index = pq.read_table(tmp_path / "index.parquet")
    parts = {FAMILY: [tmp_path / "summary" / FAMILY / "part-00000.parquet"]}
    entry = finalize.summary_config(index, parts)
    assert entry["pathways"] == ["pathway_alpha", "pathway_beta", "pathway_gamma"]
    assert entry["families"][FAMILY]["pathway_columns"] == 3
    summarize.cmd_summarize(settings, args(tmp_path))  # without --pathways: no pathway columns
    entry = finalize.summary_config(index, parts)
    assert "pathways" not in entry and "pathway_columns" not in entry["families"][FAMILY]
