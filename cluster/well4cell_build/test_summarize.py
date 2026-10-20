"""summarize: per-trajectory statistics of fabricated core parts, checked against numpy.

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_summarize.py
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from well4cell_build import finalize, hub, summarize
from well4cell_build.settings import CONFIGS, INT_SCALARS, SCALAR_CHANNELS, SUMMARY_STATS, Settings

FAMILY = "wildtype_media"
# (sample_id, n_steps) in index order, split over two core files.
FILES = {"part-00000.parquet": [("T1/WT/basal/s0/g0", 7), ("T1/WT/basal/s0/g1", 5), ("T1/WT/basal/s1/g0", 1)],
         "part-00001.parquet": [("T1/WT/rich/s0/g0", 9), ("T1/WT/rich/s0/g1", 4)]}


def make_settings(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("WCECOLI_CAMPAIGN_ROOT", str(tmp_path / "campaign"))
    monkeypatch.setenv("W4C_ROOT", str(tmp_path / "w4c"))
    monkeypatch.setenv("W4C_ROW_GROUP_ROWS", "2")
    return Settings.from_env()


def fake_trajectory(rng: np.random.Generator, n_steps: int) -> dict[str, np.ndarray]:
    data = {"t": np.arange(n_steps, dtype=np.int32)}
    for channel in SCALAR_CHANNELS:
        if channel in INT_SCALARS:
            data[channel] = rng.integers(0, 3000, n_steps).astype(np.int32)
        else:
            data[channel] = rng.normal(100.0, 10.0, n_steps).astype(np.float32)
    data["growth_rate"][0] = np.nan  # written as null, as export does
    return data


def write_core(path, trajectories: list[tuple[str, dict]]) -> None:
    sample_ids = [sid for sid, a in trajectories for _ in range(len(a["t"]))]
    columns = {"sample_id": pa.array(sample_ids).dictionary_encode(),
               "t": pa.array(np.concatenate([a["t"] for _, a in trajectories]), pa.int32()),
               "t_abs": pa.array(np.concatenate([a["t"] for _, a in trajectories]), pa.int32())}
    fields = [pa.field("sample_id", columns["sample_id"].type), pa.field("t", pa.int32()), pa.field("t_abs", pa.int32())]
    arrays = list(columns.values())
    for channel in SCALAR_CHANNELS:
        values = np.concatenate([a[channel] for _, a in trajectories])
        kind = pa.int32() if channel in INT_SCALARS else pa.float32()
        fields.append(pa.field(channel, kind, nullable=channel == "growth_rate",
                               metadata={b"unit": finalize.UNITS[channel].encode()}))
        arrays.append(pa.array(values, kind, from_pandas=True))
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_arrays(arrays, schema=pa.schema(fields)), path, row_group_size=4)


def build(tmp_path, seed: int = 0) -> tuple[dict, pa.Table]:
    """Core parts under tmp/core/<family>/ and an index with the core locators."""
    rng = np.random.default_rng(seed)
    raw, rows = {}, {"sample_id": [], "family": [], "core_file": [], "core_row_offset": [], "core_n_rows": []}
    for name, spec in FILES.items():
        trajectories, offset = [], 0
        for sid, n in spec:
            raw[sid] = fake_trajectory(rng, n)
            trajectories.append((sid, raw[sid]))
            for key, value in (("sample_id", sid), ("family", FAMILY), ("core_file", "data/core/{}/{}".format(FAMILY, name)),
                               ("core_row_offset", offset), ("core_n_rows", n)):
                rows[key].append(value)
            offset += n
        write_core(tmp_path / "core" / FAMILY / name, trajectories)
    # A trajectory of another family, and one without core data: neither is summarized here.
    for sid, family, core_file, n in (("T2/argG_KO/basal/s0/g0", "single_knockout",
                                       "data/core/single_knockout/part-00000.parquet", 3),
                                      ("T1/WT/acetate/s0/g0", FAMILY, None, None)):
        rows["sample_id"].append(sid)
        rows["family"].append(family)
        rows["core_file"].append(core_file)
        rows["core_row_offset"].append(0 if core_file else None)
        rows["core_n_rows"].append(n)
    index = pa.table({"sample_id": pa.array(rows["sample_id"]), "family": pa.array(rows["family"]),
                      "core_file": pa.array(rows["core_file"], pa.string()),
                      "core_row_offset": pa.array(rows["core_row_offset"], pa.int64()),
                      "core_n_rows": pa.array(rows["core_n_rows"], pa.int32())})
    pq.write_table(index, tmp_path / "index.parquet")
    return raw, index


def args(tmp_path, **overrides) -> argparse.Namespace:
    return argparse.Namespace(**{"families": FAMILY, "core_dir": str(tmp_path / "core"),
                                 "index": str(tmp_path / "index.parquet"), "out_dir": str(tmp_path / "summary"),
                                 **overrides})


def test_statistics_match_numpy_and_skip_the_growth_rate_null(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    raw, _ = build(tmp_path)
    summarize.cmd_summarize(settings, args(tmp_path))
    table = pq.read_table(tmp_path / "summary" / FAMILY / "part-00000.parquet")
    assert table.column_names == summarize.column_names()
    assert table.column("sample_id").to_pylist() == [sid for spec in FILES.values() for sid, _ in spec]
    for i, sid in enumerate(table.column("sample_id").to_pylist()):
        row = {name: table.column(name)[i].as_py() for name in table.column_names}
        assert row["n_steps"] == len(raw[sid]["t"])
        for channel in SCALAR_CHANNELS:
            values = raw[sid][channel].astype(np.float64)
            values = values[~np.isnan(values)]
            if values.size == 0:  # growth_rate of a one-row trajectory: every statistic is null
                assert all(row["{}_{}".format(channel, s)] is None for s in SUMMARY_STATS)
                continue
            expected = {"mean": values.mean(), "min": values.min(), "max": values.max(),
                        "first": values[0], "last": values[-1]}
            for stat in SUMMARY_STATS:
                assert row["{}_{}".format(channel, stat)] == pytest.approx(expected[stat], rel=1e-6), (sid, channel, stat)
        # growth_rate ignores the null at row 0: _first is the value at t = 1
        if len(raw[sid]["t"]) > 1:
            assert row["growth_rate_first"] == pytest.approx(float(raw[sid]["growth_rate"][1]))


def test_types_units_and_file_metadata(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build(tmp_path)
    summarize.cmd_summarize(settings, args(tmp_path))
    path = tmp_path / "summary" / FAMILY / "part-00000.parquet"
    schema = pq.read_schema(path)
    assert schema.field("sample_id").type == pa.string() and schema.field("n_steps").type == pa.int32()
    for channel in SCALAR_CHANNELS:
        for stat in SUMMARY_STATS:
            field = schema.field("{}_{}".format(channel, stat))
            integral = channel in INT_SCALARS and stat != "mean"
            assert field.type == (pa.int32() if integral else pa.float32()), field
            assert field.metadata[b"unit"] == finalize.UNITS[channel].encode()
    assert schema.field("mrna_counts_mean").type == pa.float32()
    assert {k: schema.metadata[k] for k in (b"well4cell_version", b"config", b"family", b"stride")} == {
        b"well4cell_version": settings.version.encode(), b"config": b"summary", b"family": FAMILY.encode(),
        b"stride": b"1"}
    metadata = pq.read_metadata(path)
    assert metadata.num_row_groups == 3 and max(metadata.row_group(i).num_rows for i in range(3)) <= 2
    assert metadata.row_group(0).column(0).compression == "ZSTD"


def test_trajectories_spanning_record_batches(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    raw, _ = build(tmp_path)
    path = tmp_path / "core" / FAMILY / "part-00000.parquet"
    target = summarize.schema(settings, FAMILY)
    whole, offsets = summarize.summarize_core_file(path, target)
    for batch_rows in (1, 2, 3, 6):
        table, small = summarize.summarize_core_file(path, target, batch_rows=batch_rows)
        assert table.equals(whole) and small == offsets
    assert offsets == [0, 7, 12]


def test_core_parts_are_read_without_pre_buffering(tmp_path, monkeypatch):
    """pyarrow's default read-ahead buffers a whole ~2 GB part; the reader must opt out (as pathways does)."""
    settings = make_settings(tmp_path, monkeypatch)
    build(tmp_path)
    opened = []
    real = pq.ParquetFile

    def recording(*args, **kwargs):
        opened.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(pq, "ParquetFile", recording)
    summarize.summarize_core_file(tmp_path / "core" / FAMILY / "part-00000.parquet", summarize.schema(settings, FAMILY))
    assert opened and all(kwargs.get("pre_buffer") is False for kwargs in opened)


def test_summary_rows_must_match_the_index_locators(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    _, index = build(tmp_path)
    # a trajectory the index locates but core lacks: stale locators
    extra = pa.table({"sample_id": ["T1/WT/rich/s1/g0"], "family": [FAMILY],
                      "core_file": ["data/core/{}/part-00002.parquet".format(FAMILY)],
                      "core_row_offset": pa.array([0], pa.int64()), "core_n_rows": pa.array([3], pa.int32())})
    pq.write_table(pa.concat_tables([index, extra]), tmp_path / "index.parquet")
    with pytest.raises(SystemExit, match="5 summary rows .* but 6 index rows with a core_file"):
        summarize.cmd_summarize(settings, args(tmp_path))
    # n_steps disagreeing with core_n_rows
    n_rows = index.column("core_n_rows").to_pylist()
    n_rows[1] += 1
    pq.write_table(index.set_column(4, "core_n_rows", pa.array(n_rows, pa.int32())), tmp_path / "index.parquet")
    with pytest.raises(SystemExit, match="n_steps != core_n_rows"):
        summarize.cmd_summarize(settings, args(tmp_path))
    # an index without locators (finalize never ran)
    pq.write_table(index.drop_columns(["core_file"]), tmp_path / "index.parquet")
    with pytest.raises(SystemExit, match="run `w4c finalize` first"):
        summarize.cmd_summarize(settings, args(tmp_path))
    assert not (tmp_path / "summary" / FAMILY / "part-00000.parquet").exists()


def test_rows_follow_index_order(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    _, index = build(tmp_path)
    flipped = pa.concat_tables([index.slice(3, 2), index.slice(0, 3), index.slice(5)])
    pq.write_table(flipped, tmp_path / "index.parquet")
    summarize.cmd_summarize(settings, args(tmp_path))
    table = pq.read_table(tmp_path / "summary" / FAMILY / "part-00000.parquet")
    assert table.column("sample_id").to_pylist() == flipped.column("sample_id").to_pylist()[:5]


def test_finalize_counts_the_summary_and_hub_uploads_it(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    _, index = build(tmp_path)
    out = settings.repo_dir / "data" / "summary"
    summarize.cmd_summarize(settings, args(tmp_path, out_dir=str(out)))
    # summary parts have no export sentinel and must not be taken for orphans
    finalize.check_data_tree(settings, {})
    entry = finalize.summary_config(index, finalize.data_files(settings)["summary"])
    assert entry["rows"] == entry["trajectories"] == 5 and entry["stride"] == 1 and entry["files"] == 1
    assert entry["families"][FAMILY]["bytes"] == (out / FAMILY / "part-00000.parquet").stat().st_size
    assert "WARNING" not in capsys.readouterr().err
    finalize.summary_config(index.slice(1), finalize.data_files(settings)["summary"])
    assert "re-run `w4c summarize`" in capsys.readouterr().err
    assert "summary" not in CONFIGS
    assert hub.include_globs(settings, ["summary"]) == ["data/summary/**"]
    assert hub.include_globs(settings, ["summary"], [FAMILY]) == ["data/summary/{}/**".format(FAMILY)]
    assert "summary" in hub.default_parts(settings)
    json.dumps(entry)


def test_translation_collapse_counts_low_elongation_and_the_divided_subset(tmp_path):
    rates = {"a": 0.2, "b": 0.99, "c": 1.0, "d": None, "e": 16.0, "f": 0.0}
    terminations = {"a": "none", "b": "time_limit", "c": "none", "d": "none", "e": "none", "f": "none", "g": "none"}
    families = {}
    for family, ids in (("single_knockout", "abcd"), ("wildtype_media", "ef")):
        path = tmp_path / family / "part-00000.parquet"
        path.parent.mkdir()
        pq.write_table(pa.table({"sample_id": list(ids),
                                 "ribosome_elongation_rate_mean": pa.array([rates[i] for i in ids], pa.float32())}), path)
        families[family] = [path]
    index = pa.table({"sample_id": list(terminations), "termination_class": list(terminations.values())})
    collapse = finalize.translation_collapse(index, families)
    assert collapse == {"threshold_aa_per_s": 1.0, "trajectories": 3, "divided": 2,
                        "families": {"wildtype_media": {"trajectories": 1, "divided": 1},
                                     "single_knockout": {"trajectories": 2, "divided": 1}}}
    assert list(collapse["families"]) == ["wildtype_media", "single_knockout"]  # tier order
    # one evaluation of the predicate feeds the counts and the index column; a null mean is false
    flags = finalize.collapse_flags(families)
    assert flags == {"wildtype_media": {"e": False, "f": True},
                     "single_knockout": {"a": True, "b": True, "c": False, "d": False}}
    assert finalize.translation_collapse(index, {}) == {}
