"""hub verify / hub prune and finalize with published-only parts (ADR 0011), Hub mocked.

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_published.py
"""

from __future__ import annotations

import argparse
import json

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from well4cell_build import finalize, hub, published
from well4cell_build.test_finalize import CELLS, build_tree, finalize_args, make_settings, write_campaign_db

REVISION = "0123abcd" * 5


def ok_parts(settings) -> dict[str, dict]:
    return finalize.current_parts(finalize.export_sentinels(settings))


def fake_hub(monkeypatch, settings, sizes: dict[str, int] | None = None, missing=(), stale=()) -> list:
    """Mock hub.api_call: the Hub holds every current ok part (at its sentinel size, or ``sizes``),
    except ``missing``, plus the ``stale`` paths. Returns the list of calls made."""
    calls = []

    def api_call(settings_, op, allow_create=False, extra=()):
        prefixes = json.loads(extra[0])
        calls.append((op, prefixes))
        files = [{"path": p, "size": (sizes or {}).get(p, int(r["bytes"])), "sha256": "f" * 64}
                 for p, r in ok_parts(settings).items() if p not in missing]
        files += [{"path": p, "size": 1, "sha256": None} for p in stale]
        files = [f for f in files if any(f["path"].startswith(prefix + "/") for prefix in prefixes)]
        return {"private": True, "id": settings.repo_id, "sha": REVISION, "files": files}

    monkeypatch.setattr(hub, "api_call", api_call)
    return calls


def hub_args(configs: str, families: str | None = None, **overrides) -> argparse.Namespace:
    return argparse.Namespace(**{"configs": configs, "families": families, "yes": False, "parts": None,
                                 "manifest": None, **overrides})


def paths_of(settings, config: str, family: str | None = None) -> list[str]:
    return sorted(p for p, r in ok_parts(settings).items()
                  if r["config"] == config and (family is None or r["family"] == family))


def test_verify_records_only_the_parts_that_match_the_hub(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    expression = paths_of(settings, "expression")
    assert len(expression) == 4
    wrong, gone = expression[0], expression[1]
    stale = "data/expression/wildtype_media/part-00099.parquet"
    calls = fake_hub(monkeypatch, settings, sizes={wrong: 7}, missing={gone}, stale=[stale])
    with pytest.raises(SystemExit, match="3 problem"):
        hub.cmd_verify(settings, hub_args("expression"))
    assert calls == [("files", ["data/expression/single_knockout", "data/expression/wildtype_media"])]
    err = capsys.readouterr().err
    assert "size on the Hub 7" in err and "not on the Hub: " + gone in err and stale in err
    records = [json.loads(line) for line in published.records_path(settings).read_text().splitlines()]
    assert sorted(r["path"] for r in records) == expression[2:]
    parts = ok_parts(settings)
    for record in records:
        assert record["bytes"] == parts[record["path"]]["bytes"] and record["revision"] == REVISION
        assert record["repo_id"] == settings.repo_id and record["sha256"] == "f" * 64
    assert published.stored_schema(settings, "expression") is not None
    assert published.stored_schema(settings, "core") is None
    # all on the Hub now: the rest are recorded, nothing twice
    fake_hub(monkeypatch, settings)
    assert hub.cmd_verify(settings, hub_args("expression")) == {"matched": 4, "recorded": 2}
    assert hub.cmd_verify(settings, hub_args("expression", "wildtype_media")) == {"matched": 2, "recorded": 0}
    assert len(published.records_path(settings).read_text().splitlines()) == 4
    assert set(published.published_parts(settings, ok_parts(settings))) == set(expression)
    ledger = [json.loads(line) for line in settings.ledger.read_text().splitlines()]
    assert [r["stage"] for r in ledger] == ["hub.verify"] * 3


def test_a_record_stops_counting_once_the_part_is_exported_again(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    fake_hub(monkeypatch, settings)
    hub.cmd_verify(settings, hub_args("core"))
    parts = ok_parts(settings)
    assert len(published.published_parts(settings, parts)) == 4
    path = paths_of(settings, "core")[0]
    assert not published.matches(published.published_parts(settings, parts)[path],
                                 {**parts[path], "finished_at": "2026-10-21T00:00:00+00:00"})
    assert published.published_parts(settings, {path: {**parts[path], "bytes": parts[path]["bytes"] + 1}}) == {}
    monkeypatch.setenv("W4C_REPO_ID", "someone/else")
    from well4cell_build.settings import Settings
    assert published.published_parts(Settings.from_env(), parts) == {}


def test_prune_refuses_without_a_matching_record_and_deletes_only_with_yes(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    before = {p: (settings.repo_dir / p).stat().st_size for p in ok_parts(settings)}
    with pytest.raises(SystemExit, match="refusing to prune.*nothing deleted"):
        hub.cmd_prune(settings, hub_args("expression", "wildtype_media", yes=True))
    assert "no published record" in capsys.readouterr().err
    assert all((settings.repo_dir / p).exists() for p in before)
    fake_hub(monkeypatch, settings)
    hub.cmd_verify(settings, hub_args("expression", "wildtype_media"))
    doomed = paths_of(settings, "expression", "wildtype_media")
    # a local file that changed since it was verified is refused
    target = settings.repo_dir / doomed[0]
    original = target.read_bytes()
    target.write_bytes(original + b"x")
    with pytest.raises(SystemExit, match="refusing to prune"):
        hub.cmd_prune(settings, hub_args("expression", "wildtype_media", yes=True))
    assert "local size" in capsys.readouterr().err and target.exists()
    target.write_bytes(original)
    # a family without records is refused even when another one has them
    with pytest.raises(SystemExit, match="refusing to prune"):
        hub.cmd_prune(settings, hub_args("expression", yes=True))
    assert all((settings.repo_dir / p).exists() for p in before)
    # dry run by default
    assert hub.cmd_prune(settings, hub_args("expression", "wildtype_media"))["dry_run"]
    assert all((settings.repo_dir / p).exists() for p in before)
    report = hub.cmd_prune(settings, hub_args("expression", "wildtype_media", yes=True))
    assert report == {"deleted": 2, "bytes": sum(before[p] for p in doomed)}
    assert not any((settings.repo_dir / p).exists() for p in doomed)
    assert all((settings.repo_dir / p).exists() for p in before if p not in doomed)
    assert published.stored_schema(settings, "expression") is not None
    # re-running is a no-op
    assert hub.cmd_prune(settings, hub_args("expression", "wildtype_media", yes=True))["deleted"] == 0
    assert json.loads(settings.ledger.read_text().splitlines()[-1])["stage"] == "hub.prune"


def test_prune_keeps_the_schema_of_a_config_before_its_last_part_goes(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    fake_hub(monkeypatch, settings)
    hub.cmd_verify(settings, hub_args("expression"))
    published.schema_path(settings, "expression").unlink()  # as if verify had run on published-only parts
    first = settings.repo_dir / paths_of(settings, "expression")[0]
    expected = pq.read_schema(first)
    hub.cmd_prune(settings, hub_args("expression", yes=True))
    assert not list((settings.repo_dir / "data" / "expression").rglob("*.parquet"))
    assert published.stored_schema(settings, "expression").equals(expected, check_metadata=True)


def _snapshot(settings) -> tuple[dict, str, pa.Table, dict]:
    manifest = json.loads((settings.repo_dir / "manifest.json").read_text())
    readme = (settings.repo_dir / "README.md").read_text().replace(manifest.pop("built_at"), "BUILT_AT")
    stats = {f.name: pq.read_table(f) for f in sorted((settings.repo_dir / "stats").glob("*.parquet"))}
    return manifest, readme, pq.read_table(settings.index_path), stats


def test_finalize_with_published_only_parts_writes_what_it_writes_with_every_part_local(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    write_campaign_db(settings)
    report = finalize.cmd_finalize(settings, finalize_args())
    assert report["parts"] == {"local": 8, "published_only": 0}
    local_manifest, local_readme, local_index, local_stats = _snapshot(settings)
    fake_hub(monkeypatch, settings)
    hub.cmd_verify(settings, hub_args("expression"))
    hub.cmd_verify(settings, hub_args("core", "single_knockout"))
    hub.cmd_prune(settings, hub_args("expression", yes=True))  # no expression part left on disk
    hub.cmd_prune(settings, hub_args("core", "single_knockout", yes=True))
    assert not list((settings.repo_dir / "data" / "expression").rglob("*.parquet"))
    capsys.readouterr()
    report = finalize.cmd_finalize(settings, finalize_args())
    assert report["parts"] == {"local": 2, "published_only": 6}
    assert "2 part(s) on disk, 6 published-only" in capsys.readouterr().out
    manifest, readme, index, stats = _snapshot(settings)
    assert manifest == local_manifest
    assert readme == local_readme
    assert index.equals(local_index, check_metadata=True)
    assert stats.keys() == local_stats.keys() and all(stats[k].equals(local_stats[k]) for k in stats)
    assert set(manifest["configs"]["expression"]["families"]) == set(CELLS)
    assert manifest["configs"]["expression"]["bytes"] > 0
    ledger = json.loads(settings.ledger.read_text().splitlines()[-1])
    assert ledger["stage"] == "finalize" and ledger["parts"] == {"local": 2, "published_only": 6}


def test_sentinel_bytes_are_the_file_sizes(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    for path, record in ok_parts(settings).items():
        assert finalize.part_bytes(settings, path, record) == (settings.repo_dir / path).stat().st_size
        assert finalize.part_bytes(settings, path, {**record, "bytes": None}) == record["bytes"]


def test_finalize_refuses_a_missing_part_without_a_matching_record(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    write_campaign_db(settings)
    path = paths_of(settings, "core", "wildtype_media")[0]
    part = ok_parts(settings)[path]
    (settings.repo_dir / path).unlink()
    with pytest.raises(SystemExit, match="1 ok sentinels whose file is missing"):
        finalize.cmd_finalize(settings, finalize_args())
    # a record for another export attempt, or another size, does not count
    published.append(settings, [published.record(settings, {**part, "finished_at": "earlier"}, {"size": part["bytes"]}, "r"),
                                published.record(settings, part, {"size": part["bytes"] + 1}, "r")])
    with pytest.raises(SystemExit, match="1 ok sentinels whose file is missing"):
        finalize.cmd_finalize(settings, finalize_args())
    published.append(settings, [published.record(settings, part, {"size": part["bytes"]}, "r")])
    assert finalize.cmd_finalize(settings, finalize_args())["parts"] == {"local": 7, "published_only": 1}


def test_product_schema_falls_back_to_build_with_zero_local_parts(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    files = finalize.exported_files(ok_parts(settings))
    assert files == {c: {f: [str(p.relative_to(settings.repo_dir)) for p in ps] for f, ps in fams.items()}
                     for c, fams in finalize.data_files(settings).items()}
    expected = finalize.product_fields(settings, files)
    for path in files["expression"]["wildtype_media"] + files["expression"]["single_knockout"]:
        moved = settings.root / "aside" / path
        moved.parent.mkdir(parents=True, exist_ok=True)
        (settings.repo_dir / path).rename(moved)
    with pytest.raises(SystemExit, match="no part of expression is on disk"):
        finalize.product_fields(settings, files)
    published.keep_schema(settings, "expression", settings.root / "aside" / files["expression"]["wildtype_media"][0])
    assert finalize.product_fields(settings, files) == expected
    # a local part that disagrees with the stored schema is refused
    core = settings.repo_dir / next(iter(files["core"].values()))[0]  # the part config_schema reads
    published.keep_schema(settings, "core", core)
    table = pq.read_table(core)
    pq.write_table(table.set_column(1, pa.field("t", pa.int64()), table.column("t").cast(pa.int64())), core)
    with pytest.raises(SystemExit, match="differs from"):
        finalize.product_fields(settings, files)


def test_the_hub_listing_script_compiles_and_never_deletes():
    compile(hub._API_SCRIPT, "api", "exec")
    assert "delete" not in hub._API_SCRIPT


def test_hub_upload_takes_one_config_and_family_and_skips_pruned_configs(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    result = hub.cmd_upload(settings, argparse.Namespace(include="expression", families="wildtype_media",
                                                         dry_run=True, allow_public=False))
    argv = result["argv"]
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--include"] == ["data/expression/wildtype_media/**"]
    assert not any(a.startswith("--delete") for a in argv)
    result = hub.cmd_upload(settings, argparse.Namespace(include="index,provenance", families=None, dry_run=True,
                                                         allow_public=False))
    assert [result["argv"][i + 1] for i, a in enumerate(result["argv"]) if a == "--include"] == [
        "index.parquet", "provenance/**"]
    assert "expression" in hub.default_parts(settings)
    for path in (settings.repo_dir / "data" / "expression").rglob("*.parquet"):
        path.unlink()  # pruned: the directories stay
    assert "expression" not in hub.default_parts(settings) and "core" in hub.default_parts(settings)
    with pytest.raises(SystemExit, match="nothing local matches"):
        hub.cmd_upload(settings, argparse.Namespace(include="expression", families="wildtype_media", dry_run=True,
                                                    allow_public=False))


# -- a family dispatched in slices: hub verify / prune --parts -----------------------------------
def write_manifests(settings) -> dict[str, list[int]]:
    """The export manifests build_tree's sentinels belong to; plan -> its part indices."""
    out: dict[str, list[dict]] = {}
    for _, record in finalize.export_sentinels(settings):
        out.setdefault(record["plan"], []).append({k: record[k] for k in ("plan", "part", "config", "family", "path")})
    for plan, lines in out.items():
        lines.sort(key=lambda line: line["part"])
        (settings.manifest_dir / (plan + ".jsonl")).write_text("".join(json.dumps(l) + "\n" for l in lines))
    return {plan: [line["part"] for line in lines] for plan, lines in out.items()}


def slices(settings) -> tuple[str, list[str], list[str]]:
    """The expression manifest (the latest) cut in two slices: (its path, paths of parts 4-5, of 6-7)."""
    plans = write_manifests(settings)
    assert plans["export_20261008_000000_expression"] == [4, 5, 6, 7]
    manifest = str(settings.manifest_dir / "export_20261008_000000_expression.jsonl")
    by_part = {r["part"]: p for p, r in ok_parts(settings).items() if r["config"] == "expression"}
    return manifest, [by_part[4], by_part[5]], [by_part[6], by_part[7]]


def test_verify_parts_passes_for_an_uploaded_slice_while_a_later_one_is_not_uploaded(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    _, first, second = slices(settings)
    fake_hub(monkeypatch, settings, missing=set(second))
    # without --parts the whole selection is checked, strictly
    with pytest.raises(SystemExit, match="2 problem"):
        hub.cmd_verify(settings, hub_args("expression"))
    err = capsys.readouterr().err
    assert all("not on the Hub: " + p in err for p in second)
    # the default manifest is the latest one (expression); the first verify recorded slice 4-5 already
    assert hub.cmd_verify(settings, hub_args("expression", parts="4-5")) == {"matched": 2, "recorded": 0}
    assert hub.cmd_verify(settings, hub_args("expression", parts="5,4")) == {"matched": 2, "recorded": 0}
    assert set(published.published_parts(settings, ok_parts(settings))) == set(first)
    ledger = json.loads(settings.ledger.read_text().splitlines()[-1])
    assert ledger["stage"] == "hub.verify" and ledger["parts"] == "5,4" and ledger["problems"] == 0
    # a remote file of an ok part outside the range is not stale; one of no ok part is
    fake_hub(monkeypatch, settings, stale=["data/expression/wildtype_media/part-00099.parquet"])
    with pytest.raises(SystemExit, match="1 problem"):
        hub.cmd_verify(settings, hub_args("expression", parts="4-5"))
    assert "part-00099" in capsys.readouterr().err


def test_verify_parts_still_fails_for_a_missing_or_mismatched_part_inside_the_range(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    manifest, first, second = slices(settings)
    fake_hub(monkeypatch, settings, sizes={first[0]: 7}, missing={first[1]} | set(second))
    with pytest.raises(SystemExit, match="2 problem"):
        hub.cmd_verify(settings, hub_args("expression", parts="4-5", manifest=manifest))
    err = capsys.readouterr().err
    assert "size on the Hub 7" in err and "not on the Hub: " + first[1] in err and second[0] not in err
    assert not published.records_path(settings).exists()
    # an index of the selection that was not exported ok is a problem too
    (settings.manifest_dir / "export_20261008_000000_expression.sentinels" / "00005.json").unlink()
    fake_hub(monkeypatch, settings)
    with pytest.raises(SystemExit, match="1 problem"):
        hub.cmd_verify(settings, hub_args("expression", parts="4-5"))
    assert "part 5 of export_20261008_000000_expression.jsonl has no ok sentinel (not exported)" in capsys.readouterr().err
    # an index the manifest does not have, or bad syntax, is refused outright
    with pytest.raises(SystemExit, match="has no part"):
        hub.cmd_verify(settings, hub_args("expression", parts="4-9"))
    with pytest.raises(SystemExit, match="bad --parts"):
        hub.cmd_verify(settings, hub_args("expression", parts="4..5"))
    with pytest.raises(SystemExit, match="only applies with --parts"):
        hub.cmd_prune(settings, hub_args("expression", manifest=manifest, yes=True))
    # indices of another config are outside the selection
    with pytest.raises(SystemExit, match="no part of .* is of core"):
        hub.cmd_verify(settings, hub_args("core", parts="4-5"))


def test_prune_parts_deletes_only_the_slice_and_refuses_problems_inside_it(tmp_path, monkeypatch, capsys):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    _, first, second = slices(settings)
    fake_hub(monkeypatch, settings, missing=set(second))
    with pytest.raises(SystemExit):
        hub.cmd_verify(settings, hub_args("expression", parts="4-6"))  # 6 is not on the Hub; 4-5 are recorded
    capsys.readouterr()
    # without --parts prune still refuses: the second slice has no published record
    with pytest.raises(SystemExit, match="refusing to prune"):
        hub.cmd_prune(settings, hub_args("expression", yes=True))
    assert "no published record" in capsys.readouterr().err
    # a problem inside the range refuses the whole slice
    target = settings.repo_dir / first[0]
    original = target.read_bytes()
    target.write_bytes(original + b"x")
    with pytest.raises(SystemExit, match="refusing to prune"):
        hub.cmd_prune(settings, hub_args("expression", parts="4-5", yes=True))
    assert "local size" in capsys.readouterr().err
    target.write_bytes(original)
    with pytest.raises(SystemExit, match="refusing to prune"):
        hub.cmd_prune(settings, hub_args("expression", parts="4-6", yes=True))
    assert "no published record" in capsys.readouterr().err
    assert all((settings.repo_dir / p).exists() for p in first + second)
    assert hub.cmd_prune(settings, hub_args("expression", parts="4-5"))["dry_run"]  # dry run by default
    assert all((settings.repo_dir / p).exists() for p in first + second)
    assert hub.cmd_prune(settings, hub_args("expression", parts="4-5", yes=True))["deleted"] == 2
    assert not any((settings.repo_dir / p).exists() for p in first)
    assert all((settings.repo_dir / p).exists() for p in second)
    assert json.loads(settings.ledger.read_text().splitlines()[-1])["parts"] == "4-5"


def test_prune_parts_of_the_last_slice_keeps_the_schema(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    build_tree(settings)
    _, first, second = slices(settings)
    fake_hub(monkeypatch, settings, missing=set(second))
    hub.cmd_verify(settings, hub_args("expression", parts="4-5"))
    hub.cmd_prune(settings, hub_args("expression", parts="4-5", yes=True))
    expected = pq.read_schema(settings.repo_dir / second[0])
    fake_hub(monkeypatch, settings)
    assert hub.cmd_verify(settings, hub_args("expression", parts="6-7")) == {"matched": 2, "recorded": 2}
    published.schema_path(settings, "expression").unlink()  # as if no schema had been stored yet
    assert hub.cmd_prune(settings, hub_args("expression", parts="6-7", yes=True))["deleted"] == 2
    assert not list((settings.repo_dir / "data" / "expression").rglob("*.parquet"))
    assert published.stored_schema(settings, "expression").equals(expected, check_metadata=True)
    # every part is published-only now: the whole selection verifies, and prunes as a no-op
    assert hub.cmd_verify(settings, hub_args("expression")) == {"matched": 4, "recorded": 0}
    assert hub.cmd_prune(settings, hub_args("expression", yes=True))["deleted"] == 0
