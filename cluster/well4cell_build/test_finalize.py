"""finalize: stats reduction and index locator fill, on a fabricated build tree.

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_finalize.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute  # noqa: F401  (pa.compute)
import pyarrow.parquet as pq
import pytest

from well4cell_build import finalize
from well4cell_build.settings import CONFIGS, MATRIX_CHANNELS, SCALAR_CHANNELS, Settings

REFERENCE_COLUMNS = 6
ACTIVE = {m: np.array([True, False, True, True, False, True]) for m in MATRIX_CHANNELS}
PARCA_CACHE = "5558948af4ad806f21d7c80c"
KB_SHA256 = "8ff93a58" * 8
CELLS = {"wildtype_media": ["T1/wildtype/basal", "T1/wildtype/acetate"],
         "single_knockout": ["T2/argG_KO/basal"]}


def make_settings(tmp: Path, monkeypatch) -> Settings:
    monkeypatch.setenv("WCECOLI_CAMPAIGN_ROOT", str(tmp / "campaign"))
    monkeypatch.setenv("W4C_ROOT", str(tmp / "w4c"))
    monkeypatch.setenv("DATABASE_PATH", str(tmp / "campaign" / "state" / "wcecoli.db"))
    settings = Settings.from_env()
    settings.ensure_layout()
    return settings


def write_reference(settings: Settings) -> None:
    for matrix in MATRIX_CHANNELS:
        active = ACTIVE[matrix]
        product = np.full(REFERENCE_COLUMNS, -1)
        product[active] = np.arange(active.sum())
        pq.write_table(pa.table({
            "column": pa.array(np.arange(REFERENCE_COLUMNS, dtype=np.int32)),
            "id": pa.array(["{}_{}".format(matrix.split("_")[0], i) for i in range(REFERENCE_COLUMNS)]),
            "active": pa.array(active),
            "product_column": pa.array([int(p) if a else None for p, a in zip(product, active)], pa.int32()),
        }), settings.reference_dir / (finalize.reference_name(matrix) + ".parquet"))


def samples(n_generations: int = 2) -> list[dict]:
    out = []
    for family, cells in CELLS.items():
        for cell in cells:
            for generation in range(n_generations):
                lineage = cell + "/s0"
                out.append({"sample_id": "{}/g{}".format(lineage, generation), "lineage_id": lineage, "cell_id": cell,
                            "parent_id": "{}/g{}".format(lineage, generation - 1) if generation else None,
                            "family": family, "generation": generation, "seed": 0,
                            "termination_class": "none" if generation == 0 else "time_limit",
                            "split_by_lineage": "train", "split_by_gene": "train",
                            "git_hash": "abc123", "sim_options_hash": "opt1",
                            "parca_cache": PARCA_CACHE, "kb_sha256": KB_SHA256})
    return out


def write_index(settings: Settings, rows: list[dict]) -> None:
    columns = {key: [r[key] for r in rows] for key in rows[0]}
    table = pa.table(columns)
    for config in CONFIGS:
        table = table.append_column(config + "_file", pa.nulls(len(rows), pa.string()))
        table = table.append_column(config + "_row_offset", pa.nulls(len(rows), pa.int64()))
        table = table.append_column(config + "_n_rows", pa.nulls(len(rows), pa.int32()))
    pq.write_table(table, settings.index_path)


def trajectory(rng: np.random.Generator, config: str, n_steps: int) -> dict[str, np.ndarray]:
    stride = CONFIGS[config].stride
    t = np.arange(n_steps)
    keep = (t % stride == 0) | (t == n_steps - 1)
    data = {"t": t[keep].astype(np.int32)}
    for channel in SCALAR_CHANNELS:
        data[channel] = rng.normal(100.0, 10.0, keep.sum()).astype(np.float32)
    data["growth_rate"][0] = np.nan
    for matrix in CONFIGS[config].matrices:
        data[matrix] = rng.poisson(5.0, (keep.sum(), int(ACTIVE[matrix].sum()))).astype(np.float32)
    return data


def partial_stats(arrays: list[dict[str, np.ndarray]], config: str) -> dict[str, np.ndarray]:
    out = {}
    for channel in SCALAR_CHANNELS + CONFIGS[config].matrices:
        values = np.concatenate([a[channel] for a in arrays]).astype(np.float64)
        values = values.reshape(len(values), -1)
        finite = ~np.isnan(values)
        out[channel + ".n"] = finite.sum(axis=0).astype(np.float64)
        out[channel + ".sum"] = np.nansum(values, axis=0)
        out[channel + ".sumsq"] = np.nansum(values * values, axis=0)
        out[channel + ".min"] = np.nanmin(values, axis=0)
        out[channel + ".max"] = np.nanmax(values, axis=0)
    return out


def write_part(settings: Settings, plan: str, part: int, config: str, family: str,
               trajectories: list[tuple[str, dict]], failed_qc: tuple[str, ...] = ()) -> dict:
    """One data file + stats npz + ok sentinel; trajectories in failed_qc are reported, not written."""
    path = "data/{}/{}/part-{:05d}.parquet".format(config, family, part)
    written = [(sid, arrays) for sid, arrays in trajectories if sid not in failed_qc]
    columns: dict[str, list] = {"sample_id": [], "t": []}
    for sid, arrays in written:
        columns["sample_id"] += [sid] * len(arrays["t"])
        columns["t"] += arrays["t"].tolist()
    table = pa.table({"sample_id": pa.array(columns["sample_id"]).dictionary_encode(),
                      "t": pa.array(columns["t"], pa.int32())})
    for channel in SCALAR_CHANNELS:
        values = np.concatenate([a[channel] for _, a in written])
        table = table.append_column(pa.field(channel, pa.float32(), metadata={b"unit": finalize.UNITS[channel].encode()}),
                                    pa.array(values, pa.float32(), from_pandas=True))
    for matrix in CONFIGS[config].matrices:
        values = np.concatenate([a[matrix] for _, a in written])
        flat = pa.array(values.ravel(), pa.float32())
        table = table.append_column(matrix, pa.FixedSizeListArray.from_arrays(flat, values.shape[1]))
    target = settings.repo_dir / path
    target.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, target)
    sdir = settings.manifest_dir / (plan + ".sentinels")
    sdir.mkdir(parents=True, exist_ok=True)
    npz = sdir / "{:05d}.stats.npz".format(part)
    np.savez(npz, **partial_stats([a for _, a in written], config))
    offset, records = 0, []
    for sid, arrays in trajectories:
        if sid in failed_qc:
            records.append({"sample_id": sid, "row_offset": None, "n_rows": 0,
                            "qc": {"ok": False, "reasons": ["t not strictly increasing"]}})
            continue
        records.append({"sample_id": sid, "row_offset": offset, "n_rows": len(arrays["t"]), "qc": {"ok": True, "reasons": []}})
        offset += len(arrays["t"])
    sentinel = {"status": "ok", "config": config, "family": family, "path": path, "bytes": target.stat().st_size,
                "seconds": 0.1, "rows": table.num_rows, "samples": records, "stats_npz": str(npz), "error": None,
                "plan": plan, "part": part}
    (sdir / "{:05d}.json".format(part)).write_text(json.dumps(sentinel))
    return sentinel


def build_tree(settings: Settings, seed: int = 0) -> dict:
    """Index, reference, and two configs (core, expression) of parts; returns the raw arrays."""
    rng = np.random.default_rng(seed)
    rows = samples()
    write_reference(settings)
    write_index(settings, rows)
    raw: dict[tuple[str, str], list[dict]] = {}
    part = 0
    for config in ("core", "expression"):
        plan = "export_20261008_000000_{}".format(config)
        for family in CELLS:
            ids = [r["sample_id"] for r in rows if r["family"] == family]
            arrays = [(sid, trajectory(rng, config, int(rng.integers(30, 60)))) for sid in ids]
            # Two parts per family so the reduction has partial sums to combine.
            half = max(1, len(arrays) // 2)
            failed = (ids[-1],) if (config, family) == ("core", "wildtype_media") else ()
            for chunk in (arrays[:half], arrays[half:]):
                if not chunk:
                    continue
                write_part(settings, plan, part, config, family, chunk, failed_qc=failed)
                raw.setdefault((config, family), []).extend(a for sid, a in chunk if sid not in failed)
                part += 1
    return raw


def test_stats_reduction_matches_numpy(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    raw = build_tree(settings)
    parts = finalize.current_parts(finalize.export_sentinels(settings))
    finalize.write_stats(settings, parts, {})
    for family in CELLS:
        stats = pq.read_table(settings.repo_dir / "stats" / (family + ".parquet")).to_pylist()
        for config in ("core", "expression"):
            for channel in SCALAR_CHANNELS + CONFIGS[config].matrices:
                values = np.concatenate([a[channel] for a in raw[(config, family)]]).astype(np.float64)
                values = values.reshape(len(values), -1)
                got = [s for s in stats if s["product"] == config and s["channel"] == channel]
                assert len(got) == values.shape[1]
                for column, row in enumerate(got):
                    expected = values[:, column][~np.isnan(values[:, column])]
                    assert row["n_rows"] == len(expected)
                    assert row["mean"] == pytest.approx(expected.mean(), rel=1e-9)
                    assert row["std"] == pytest.approx(expected.std(ddof=0), rel=1e-6)
                    assert row["min"] == expected.min() and row["max"] == expected.max()
                    if channel in MATRIX_CHANNELS:
                        reference_column = int(np.flatnonzero(ACTIVE[channel])[column])
                        assert row["column"] == column
                        assert row["column_id"] == "{}_{}".format(channel.split("_")[0], reference_column)
                    else:
                        assert row["column"] is None and row["column_id"] is None
    growth = [s for s in pq.read_table(settings.repo_dir / "stats" / "single_knockout.parquet").to_pylist()
              if s["channel"] == "growth_rate" and s["product"] == "core"][0]
    assert not np.isnan(growth["mean"])  # row-0 NaNs excluded, not propagated


def test_combine_is_order_free():
    rng = np.random.default_rng(1)
    chunks = [rng.normal(size=(n, 3)) for n in (5, 1, 17)]
    partials = [{"n": np.full(3, len(c), float), "sum": c.sum(0), "sumsq": (c * c).sum(0), "min": c.min(0), "max": c.max(0)}
                for c in chunks]
    mean, std = finalize.moments(finalize.combine(partials))
    every = np.concatenate(chunks)
    np.testing.assert_allclose(mean, every.mean(0))
    np.testing.assert_allclose(std, every.std(0))
    mean_r, _ = finalize.moments(finalize.combine(partials[::-1]))
    np.testing.assert_allclose(mean, mean_r)


def test_locator_fill_reads_back_each_trajectory(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    parts = finalize.current_parts(finalize.export_sentinels(settings))
    finalize.check_data_tree(settings, parts)
    report = finalize.fill_index(settings, finalize.locators(parts), list(CONFIGS))
    index = pq.read_table(settings.index_path).to_pylist()
    assert report["core"]["located"] == len(index) - 1  # one trajectory failed core QC
    for row in index:
        for config in ("core", "expression"):
            if row[config + "_file"] is None:
                assert config == "core" and row["sample_id"] == "T1/wildtype/acetate/s0/g1"
                continue
            table = pq.read_table(settings.repo_dir / row[config + "_file"])
            window = table.slice(row[config + "_row_offset"], row[config + "_n_rows"])
            assert set(window.column("sample_id").to_pylist()) == {row["sample_id"]}
            assert window.num_rows == table.filter(pa.compute.equal(
                table.column("sample_id").cast(pa.string()), row["sample_id"])).num_rows
        assert row["metabolism_file"] is None and row["metabolism_n_rows"] is None
    schema = pq.read_schema(settings.index_path)
    assert schema.field("core_row_offset").type == pa.int64()
    assert schema.field("core_n_rows").type == pa.int32()


def test_two_files_for_one_trajectory_is_refused(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    rng = np.random.default_rng(2)
    sid = "T2/argG_KO/basal/s0/g0"
    write_part(settings, "export_20261009_000000_again", 99, "core", "single_knockout",
               [(sid, trajectory(rng, "core", 20))])
    with pytest.raises(SystemExit, match="two files"):
        finalize.locators(finalize.current_parts(finalize.export_sentinels(settings)))


def test_orphan_data_file_is_refused(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    orphan = settings.repo_dir / "data" / "core" / "wildtype_media" / "part-00777.parquet"
    pq.write_table(pa.table({"sample_id": ["x"]}), orphan)
    with pytest.raises(SystemExit, match="without an ok sentinel"):
        finalize.check_data_tree(settings, finalize.current_parts(finalize.export_sentinels(settings)))


def test_export_qc_lists_every_attempt(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    failed = settings.manifest_dir / "export_20261008_000000_core.sentinels" / "00050.json"
    failed.write_text(json.dumps({"status": "failed", "config": "core", "family": "single_knockout",
                                  "path": "data/core/single_knockout/part-00050.parquet", "error": "Traceback\nOSError: disk",
                                  "samples": [{"sample_id": "T2/argG_KO/basal/s0/g1"}]}))
    sentinels = finalize.export_sentinels(settings)
    report = finalize.write_export_qc(settings, sentinels)
    qc = pq.read_table(settings.repo_dir / "provenance" / "export_qc.parquet").to_pylist()
    assert report["attempts"] == len(qc)
    bad = [r for r in qc if not r["ok"]]
    assert {r["sample_id"] for r in bad} == {"T1/wildtype/acetate/s0/g1", "T2/argG_KO/basal/s0/g1"}
    assert any(r["reasons"] == ["part failed: OSError: disk"] for r in bad)


def test_reads_the_npz_that_stats_py_writes(tmp_path):
    stats = pytest.importorskip("well4cell_build.stats")
    rng = np.random.default_rng(3)
    block = rng.normal(size=(40, 4))
    block[0, 1] = np.nan
    moments = stats.Moments()
    moments.add("reaction_flux_matrix", block[:25])
    moments.add("reaction_flux_matrix", block[25:])
    moments.add("cell_mass", block[:, 0])
    moments.add("growth_rate", np.full(5, np.nan))
    path = tmp_path / "part.stats.npz"
    moments.save(path)
    loaded = finalize.read_stats_npz(path)
    assert set(loaded) == {"reaction_flux_matrix", "cell_mass", "growth_rate"}
    mean, std = finalize.moments(finalize.combine([loaded["reaction_flux_matrix"]]))
    np.testing.assert_allclose(mean, np.nanmean(block, axis=0))
    np.testing.assert_allclose(std, np.nanstd(block, axis=0))
    assert loaded["growth_rate"]["n"][0] == 0


def test_part_with_every_trajectory_failing_qc_has_no_file(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    sdir = settings.manifest_dir / "export_20261008_000000_core.sentinels"
    (sdir / "00060.json").write_text(json.dumps({
        "status": "ok", "config": "core", "family": "single_knockout", "path": None,
        "planned_path": "data/core/single_knockout/part-00060.parquet", "bytes": 0, "rows": 0, "stats_npz": None,
        "samples": [{"sample_id": "T2/argG_KO/basal/s0/g0", "row_offset": None, "n_rows": None,
                     "qc": {"ok": False, "reasons": ["negative counts"]}}]}))
    sentinels = finalize.export_sentinels(settings)
    parts = finalize.current_parts(sentinels)
    assert None not in parts
    finalize.check_data_tree(settings, parts)
    finalize.write_export_qc(settings, sentinels)
    qc = pq.read_table(settings.repo_dir / "provenance" / "export_qc.parquet").to_pylist()
    assert {"sample_id": "T2/argG_KO/basal/s0/g0", "config": "core", "family": "single_knockout", "ok": False,
            "reasons": ["negative counts"], "part": "data/core/single_knockout/part-00060.parquet"} in qc


def test_completeness_refuses_only_for_the_configs_being_finalized(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    plan = "export_20261008_000000_000000_abcdef"
    manifest = settings.manifest_dir / (plan + ".jsonl")
    lines = [{"plan": plan, "part": 0, "config": "core", "family": "wildtype_media",
              "path": "data/core/wildtype_media/part-00000.parquet", "samples": []},
             {"plan": plan, "part": 1, "config": "expression", "family": "wildtype_media",
              "path": "data/expression/wildtype_media/part-00000.parquet", "samples": []}]
    manifest.write_text("".join(json.dumps(line) + "\n" for line in lines))
    sdir = settings.manifest_dir / (plan + ".sentinels")
    sdir.mkdir()
    (sdir / "00000.json").write_text(json.dumps({"status": "ok"}))
    assert finalize.check_complete(settings, ["core"], allow_incomplete=False) == []
    assert "not being finalized" in capsys.readouterr().err
    with pytest.raises(SystemExit, match="lack an ok sentinel"):
        finalize.check_complete(settings, ["core", "expression"], allow_incomplete=False)
    (sdir / "00001.json").write_text(json.dumps({"status": "failed"}))
    with pytest.raises(SystemExit, match="failed"):
        finalize.check_complete(settings, ["expression"], allow_incomplete=False)
    assert len(finalize.check_complete(settings, ["expression"], allow_incomplete=True)) == 1


def write_campaign_db(settings: Settings) -> None:
    """The two campaign tables write_failed_jobs reads, with one failed job."""
    import sqlite3
    settings.database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.database)
    connection.executescript(
        "create table experiments (id integer primary key, name text);"
        "create table simulation_jobs (id integer primary key, experiment_id integer, variant_type text, "
        "variant_index integer, condition text, seed integer, attempt integer, error_message text, sim_dir text, "
        "status text);"
        "insert into experiments values (1, '[T1] wildtype/basal');"
        "insert into simulation_jobs values (7, 1, 'wildtype', 0, 'basal', 3, 1, 'boom', '/out/run_7', 'failed');")
    connection.commit()
    connection.close()
    (settings.scan_dir / "runs.jsonl").write_text(json.dumps(
        {"run_dir": "run_7", "job_id": 7, "job_status": "failed", "status": "missing", "seed": 3}) + "\n")


def finalize_args(**overrides):
    import argparse
    return argparse.Namespace(**{"configs": None, "hold_back": None, "allow_incomplete": False, **overrides})


def test_parca_caches_are_identified_by_hash_never_copied(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    write_campaign_db(settings)
    cache = settings.out_dir / ("parca_cache_" + PARCA_CACHE) / "kb"
    cache.mkdir(parents=True)
    (cache / "simData.cPickle").write_bytes(b"x" * 1000)
    finalize.cmd_finalize(settings, finalize_args())
    assert not any(settings.repo_dir.rglob("*.cPickle"))
    assert not list((settings.repo_dir / "provenance").glob("parca_cache_*"))
    assert not hasattr(finalize, "copy_parca_caches")
    manifest = json.loads((settings.repo_dir / "manifest.json").read_text())
    assert manifest["kb_sha256"] == {PARCA_CACHE: KB_SHA256} and "parca_caches" not in manifest
    index = pq.read_table(settings.index_path)
    assert index.column("kb_sha256").to_pylist() == [KB_SHA256] * index.num_rows
    card_text = (settings.repo_dir / "README.md").read_text()
    provenance = card_text[card_text.index("## Provenance"):card_text.index("## Licence")]
    assert "`{}` (sha256 `{}`)".format(PARCA_CACHE, KB_SHA256) in provenance
    assert "The Parca caches themselves are not included in this repo" in provenance
    assert "cPickle`:" not in provenance and "MB)" not in provenance
    assert "| `kb_sha256` | string | sha256 of the fitted parameter set (simData.cPickle) used;" in card_text


def test_finalize_refuses_an_index_without_kb_sha256(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    index = pq.read_table(settings.index_path)
    pq.write_table(index.drop_columns(["kb_sha256"]), settings.index_path)
    with pytest.raises(SystemExit, match="no kb_sha256 column"):
        finalize.cmd_finalize(settings, finalize_args())
    column = index.schema.get_field_index("kb_sha256")
    nulled = index.set_column(column, "kb_sha256", pa.array([None] + [KB_SHA256] * (index.num_rows - 1), pa.string()))
    pq.write_table(nulled, settings.index_path)
    with pytest.raises(SystemExit, match="without exactly one kb_sha256"):
        finalize.cmd_finalize(settings, finalize_args())


def test_stale_parca_copy_warns_and_is_never_uploaded(tmp_path, monkeypatch, capsys):
    from well4cell_build import hub
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    stale = settings.repo_dir / "provenance" / ("parca_cache_" + PARCA_CACHE) / "kb"
    stale.mkdir(parents=True)
    finalize.check_kb_sha256(settings, pq.read_table(settings.index_path))
    assert "must not be published" in capsys.readouterr().err
    argv = hub.upload_argv(settings, hub.include_globs(settings, ["provenance"]), "m")
    excludes = [argv[i + 1] for i, a in enumerate(argv) if a == "--exclude"]
    assert "provenance/parca_cache_*/**" in excludes and "**/*.cPickle" in excludes


def test_hold_back_leaves_a_family_out_of_locators_and_card(tmp_path, monkeypatch):
    import yaml
    from well4cell_build import card
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    parts = finalize.current_parts(finalize.export_sentinels(settings))
    finalize.check_data_tree(settings, parts)
    held = finalize.parse_hold_back("core/single_knockout")
    assert held == {("core", "single_knockout")}
    kept = finalize.withhold(parts, held)
    assert not any(r["config"] == "core" and r["family"] == "single_knockout" for r in kept.values())
    located = finalize.locators(kept)
    assert not any(s.startswith("T2/") for s in located["core"])
    assert any(s.startswith("T2/") for s in located["expression"])
    index = pq.read_table(settings.index_path)
    summary = finalize.summarize(settings, index, kept, {}, held)
    assert set(summary["configs"]["core"]["families"]) == {"wildtype_media"}
    assert set(summary["configs"]["expression"]["families"]) == {"wildtype_media", "single_knockout"}
    assert summary["held_back"] == ["core/single_knockout"]
    text = card.render(settings, summary)
    front = yaml.safe_load(text.split("---")[1])
    paths = {f["path"] for c in front["configs"] if c["config_name"] != "index" for f in c["data_files"]}
    assert "data/core/single_knockout/*.parquet" not in paths
    assert "data/expression/single_knockout/*.parquet" in paths
    assert "Not yet in this repo" in text and "data/core/single_knockout/" in text
    with pytest.raises(SystemExit, match="config>/<family"):
        finalize.parse_hold_back("core")


def test_hub_include_globs_narrow_configs_to_families(tmp_path, monkeypatch):
    from well4cell_build import hub
    settings = make_settings(tmp_path, monkeypatch)
    assert hub.include_globs(settings, ["core"]) == ["data/core/**"]
    assert hub.include_globs(settings, ["index", "core"], ["wildtype_media", "regulation"]) == [
        "index.parquet", "data/core/wildtype_media/**", "data/core/regulation/**"]
    with pytest.raises(SystemExit, match="unknown families"):
        hub.include_globs(settings, ["core"], ["nope"])


def test_finalize_summarize_finalize_puts_the_summary_in_card_and_manifest(tmp_path, monkeypatch):
    import argparse
    import yaml
    from well4cell_build import summarize
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    write_campaign_db(settings)
    finalize.cmd_finalize(settings, finalize_args())
    assert "summary" not in json.loads((settings.repo_dir / "manifest.json").read_text())["configs"]
    assert json.loads((settings.repo_dir / "manifest.json").read_text())["translation_collapse"] == {}
    assert "It flags {{TODO}} trajectories" in (settings.repo_dir / "README.md").read_text()
    summarize.cmd_summarize(settings, argparse.Namespace(families=None, core_dir=None, index=None, out_dir=None))
    finalize.cmd_finalize(settings, finalize_args())
    index = pq.read_table(settings.index_path)
    assert "summary_file" not in index.column_names
    manifest = json.loads((settings.repo_dir / "manifest.json").read_text())
    located = sum(1 for f in index.column("core_file").to_pylist() if f)
    assert manifest["configs"]["summary"]["trajectories"] == manifest["configs"]["summary"]["rows"] == located
    assert set(manifest["configs"]["summary"]["families"]) == set(CELLS)
    text = (settings.repo_dir / "README.md").read_text()
    front = yaml.safe_load(text.split("---")[1])
    assert [c["config_name"] for c in front["configs"]][:3] == ["index", "summary", "core"]
    assert "| `summary` | trajectory |" in text
    collapse = manifest["translation_collapse"]
    assert collapse["threshold_aa_per_s"] == 1.0 and set(collapse["families"]) == set(CELLS)
    assert "It flags {:,} trajectories in this release, {:,} of them".format(
        collapse["trajectories"], collapse["divided"]) in text


def test_deg_rates_files_are_summarised_but_never_copied(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    write_campaign_db(settings)
    finalize.cmd_finalize(settings, finalize_args())
    assert json.loads((settings.repo_dir / "manifest.json").read_text())["deg_rates"] == {}
    assert "Degradation rates." not in (settings.repo_dir / "README.md").read_text()
    figures = {"n_units": 854, "pct_units": 27.26, "pct_expression": 12.087}
    document = {"parca_cache": PARCA_CACHE, "kb_sha256": KB_SHA256, "n_mrna_units": 3133,
                "rate_floor_as_half_life_min": 91.2, "rate_ceiling_as_half_life_min": 0.4,
                "imputation_constant_min": 5.190693, "on_floor": {**figures, "n_units": 245},
                "on_ceiling": {**figures, "n_units": 7}, "imputed_average": {**figures, "n_units": 602},
                "not_a_fit": figures, "determined": {**figures, "n_units": 2279},
                "most_expressed_not_a_fit": [{"id": "TU0-1[c]", "class": "floor", "pct_of_mrna_expression": 0.1}],
                "units_not_a_fit": {"floor": {"TU0-1[c]": 0.1}}}
    source = settings.build_dir / "provenance" / "deg_rates_{}.json".format(PARCA_CACHE)
    source.parent.mkdir(parents=True)
    source.write_text(json.dumps(document))
    (settings.build_dir / "provenance" / "deg_rates_other.json").write_text(
        json.dumps({**document, "parca_cache": "other"}))
    finalize.cmd_finalize(settings, finalize_args())
    assert list((settings.repo_dir / "provenance").glob("deg_rates_*")) == []
    assert "the index does not name" in capsys.readouterr().err
    manifest = json.loads((settings.repo_dir / "manifest.json").read_text())
    assert manifest["deg_rates"] == {PARCA_CACHE: {
        "kb_sha256": KB_SHA256,
        "mrna_units": {"floor": 245, "ceiling": 7, "imputed": 602, "determined": 2279, "total": 3133},
        "not_a_fit_pct_basal_mrna_expression": 12.087}}
    card_text = (settings.repo_dir / "README.md").read_text()
    provenance = card_text[card_text.index("## Provenance"):card_text.index("## Licence")]
    assert ("- `{}`: of 3,133 mRNA transcription units, 2,279 have a fitted rate and 854, carrying 12.1% of basal "
            "mRNA expression, do not: 245 on the floor, 7 on the ceiling and 602 imputed.".format(PARCA_CACHE)
            ) in provenance
    for withheld in ("TU0-1", "91.2", "5.19", "0.4 min", "deg_rates_"):
        assert withheld not in card_text and withheld not in json.dumps(manifest)
    source.write_text(json.dumps({**document, "kb_sha256": "0" * 64}))
    with pytest.raises(SystemExit, match="re-run `w4c deg-rates`"):
        finalize.cmd_finalize(settings, finalize_args())


def test_finalize_refuses_a_deg_rates_copy_left_in_repo(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    copy = settings.repo_dir / "provenance" / "deg_rates_{}.json".format(PARCA_CACHE)
    copy.parent.mkdir(parents=True, exist_ok=True)
    copy.write_text("{}")
    with pytest.raises(SystemExit, match="copied by an older finalize.*Delete them"):
        finalize.cmd_finalize(settings, finalize_args())
    assert copy.exists()


def test_hub_upload_excludes_deg_rates_files(tmp_path, monkeypatch):
    from fnmatch import fnmatch

    from well4cell_build import hub
    settings = make_settings(tmp_path, monkeypatch)
    argv = hub.upload_argv(settings, hub.include_globs(settings, ["provenance"]), "m")
    excludes = [argv[i + 1] for i, a in enumerate(argv) if a == "--exclude"]
    assert "**/deg_rates_*.json" in excludes
    name = "provenance/deg_rates_{}.json".format(PARCA_CACHE)
    assert any(fnmatch(name, g) for g in hub.include_globs(settings, ["provenance"]))
    assert any(fnmatch(name, e) for e in excludes)
    assert not any(fnmatch("provenance/export_qc.parquet", e) for e in excludes)
