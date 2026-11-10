"""All fixtures are temporary; the real app and job queue are never started."""

import copy
from contextlib import closing
import hashlib
import json
import os
import sqlite3
import subprocess
import sys

import pytest
from pydantic import ValidationError

from hf_export.demo_campaign import DEFAULT_MANIFEST, CampaignSpec, fingerprint, open_reference, plan


def reference_catalog(path):
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE variants (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE conditions (id INTEGER PRIMARY KEY, name TEXT, nutrients TEXT);
            CREATE TABLE media_recipes (id INTEGER PRIMARY KEY, media_id TEXT);
            CREATE TABLE timelines (id INTEGER PRIMARY KEY, name TEXT, definition TEXT);
            CREATE TABLE genes (id INTEGER PRIMARY KEY, symbol TEXT, ko_index INTEGER,
                                is_mechanistic INTEGER);
        """)
        db.executemany("INSERT INTO variants(name) VALUES (?)", [("wildtype",), ("gene_knockout",)])
        pairs = [("basal", "minimal"), ("with_aa", "minimal_plus_amino_acids"),
                 ("acetate", "minimal_acetate"), ("no_oxygen", "minimal_minus_oxygen")]
        db.executemany("INSERT INTO conditions(name,nutrients) VALUES (?,?)", pairs)
        db.executemany("INSERT INTO media_recipes(media_id) VALUES (?)", [(p[1],) for p in pairs])
        db.executemany("INSERT INTO genes(symbol,ko_index,is_mechanistic) VALUES (?,?,1)",
                       [("hisG", 10), ("trpA", 20), ("pgi", 30)])
        db.executemany("INSERT INTO timelines(name,definition) VALUES (?,?)", [
            ("000002_add_aa", "0 minimal, 1200 minimal_plus_amino_acids"),
            ("000025_cut_aa", "0 minimal_plus_amino_acids, 1200 minimal"),
        ])


@pytest.fixture
def campaign():
    return CampaignSpec.model_validate_json(DEFAULT_MANIFEST.read_text())


@pytest.fixture
def catalog(tmp_path):
    path = tmp_path / "reference.sqlite"
    reference_catalog(path)
    return path


def tree_hashes(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


def test_all_twelve_resolve_without_writes(campaign, catalog, tmp_path):
    before = tree_hashes(tmp_path)
    first = plan(campaign, catalog)
    assert first["catalog_valid"] and not first["runtime_ready"]
    assert first["planned_jobs"] == 12 and first["max_generation_trajectories"] == 48
    assert next(row for row in first["experiments"] if row["key"] == "hisG-basal")["variant_index"] == 10
    assert first == plan(campaign, catalog)
    assert tree_hashes(tmp_path) == before


def test_cli_is_read_only_and_output_is_opt_in(catalog, tmp_path):
    before = tree_hashes(tmp_path)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run([sys.executable, "-m", "hf_export.demo_campaign", "--database", str(catalog)],
                            env=env, text=True, capture_output=True, check=True)
    assert json.loads(result.stdout)["catalog_valid"]
    assert tree_hashes(tmp_path) == before
    output = tmp_path / "report.json"
    command = [sys.executable, "-m", "hf_export.demo_campaign", "--database", str(catalog),
               "--out", str(output)]
    assert subprocess.run(command, env=env, capture_output=True).returncode == 0
    original = output.read_bytes()
    assert subprocess.run(command, env=env, capture_output=True).returncode == 2
    assert output.read_bytes() == original


def test_missing_database_does_not_create_one(campaign, tmp_path):
    path = tmp_path / "absent.sqlite"
    with pytest.raises(FileNotFoundError):
        plan(campaign, path)
    assert not path.exists()


def test_cli_validation_errors_do_not_echo_rejected_credentials(campaign, catalog, tmp_path):
    raw = campaign.model_dump()
    raw["api_key"] = "dummy-credential-must-not-be-echoed"
    manifest = tmp_path / "invalid.json"
    manifest.write_text(json.dumps(raw))
    result = subprocess.run([
        sys.executable, "-m", "hf_export.demo_campaign", "--database", str(catalog),
        "--manifest", str(manifest),
    ], text=True, capture_output=True)
    assert result.returncode == 2
    assert raw["api_key"] not in result.stdout + result.stderr


def test_active_wal_is_rejected(campaign, catalog):
    catalog.with_name(catalog.name + "-wal").write_bytes(b"uncheckpointed")
    with pytest.raises(ValueError, match="WAL"):
        plan(campaign, catalog)


def test_reference_connection_rejects_writes(catalog):
    with closing(open_reference(catalog)) as db:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            db.execute("DELETE FROM genes")


def test_cli_output_cannot_overwrite_database(catalog):
    before = catalog.read_bytes()
    result = subprocess.run([
        sys.executable, "-m", "hf_export.demo_campaign", "--database", str(catalog),
        "--out", str(catalog),
    ], text=True, capture_output=True)
    assert result.returncode == 2
    assert catalog.read_bytes() == before


def test_old_catalog_is_rejected_without_migration(campaign, catalog, tmp_path):
    with sqlite3.connect(catalog) as db:
        db.execute("DROP TABLE media_recipes")
    before = tree_hashes(tmp_path)
    report = plan(campaign, catalog)
    assert not report["catalog_valid"]
    assert "media_recipes" in report["errors"][0]["message"]
    assert tree_hashes(tmp_path) == before


def test_fingerprint_ignores_presentation_order(campaign):
    raw = campaign.model_dump()
    raw["experiments"].reverse()
    raw["pilot_keys"].reverse()
    for exp in raw["experiments"]:
        exp["controls"].reverse()
        exp["measurements"].reverse()
    reordered = CampaignSpec.model_validate(raw)
    assert fingerprint(campaign.canonical()) == fingerprint(reordered.canonical())


def test_quoted_seed_catalog_timelines(campaign, catalog):
    with sqlite3.connect(catalog) as db:
        for name, definition in db.execute("SELECT name,definition FROM timelines").fetchall():
            db.execute("UPDATE timelines SET definition=? WHERE name=?", (json.dumps(definition), name))
    assert plan(campaign, catalog)["catalog_valid"]


@pytest.mark.parametrize("change", ["key", "execution", "control", "media-control", "time", "gene", "seed"])
def test_invalid_manifest_rejected(campaign, change):
    raw = copy.deepcopy(campaign.model_dump())
    if change == "key":
        raw["experiments"][1]["key"] = raw["experiments"][0]["key"]
    elif change == "execution":
        raw["experiments"][1] = {**raw["experiments"][0], "key": "different-label"}
    elif change == "control":
        raw["experiments"][4]["controls"][0]["key"] = "missing-control"
    elif change == "media-control":
        raw["experiments"][4]["controls"][0]["key"] = "wt-with-aa"
    elif change == "time":
        raw["experiments"][-1]["events"][1]["time_sec"] = 0
    elif change == "gene":
        raw["experiments"][0]["gene"] = "hisG"
    else:
        raw["experiments"][0]["seed"] = 3
    with pytest.raises(ValidationError):
        CampaignSpec.model_validate(raw)


@pytest.mark.parametrize("sql,part", [
    ("DELETE FROM genes WHERE symbol='hisG'", "gene"),
    ("UPDATE genes SET is_mechanistic=0 WHERE symbol='hisG'", "gene"),
    ("DELETE FROM conditions WHERE name='basal'", "condition"),
    ("DELETE FROM media_recipes WHERE media_id='minimal'", "media"),
    ("DELETE FROM variants WHERE name='wildtype'", "variant"),
    ("UPDATE timelines SET definition='0 minimal, nonsense'", "unpack"),
    ("UPDATE timelines SET definition='0 minimal'", "timeline"),
    ("UPDATE genes SET ko_index=10 WHERE symbol='trpA'", "duplicates"),
])
def test_invalid_catalog_reports_errors(campaign, catalog, sql, part):
    with sqlite3.connect(catalog) as db:
        db.execute(sql)
    report = plan(campaign, catalog)
    assert not report["catalog_valid"] and not report["runtime_ready"]
    assert any(part in error["message"] for error in report["errors"])


def test_planner_does_not_import_runtime(campaign, catalog):
    import builtins
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert not name.startswith(("app.", "wholecell", "models.", "hf_export.submit"))
        return original(name, *args, **kwargs)
    from unittest.mock import patch
    with patch("builtins.__import__", guarded):
        assert plan(campaign, catalog)["catalog_valid"]
