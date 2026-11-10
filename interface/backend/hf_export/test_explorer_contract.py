"""Tiny, explicitly synthetic fixtures; no production exporter or simulator runs."""

import json
import os
from pathlib import Path
import sqlite3

import h5py
import numpy as np
import pytest

from hf_export.demo_campaign import DEFAULT_MANIFEST, CampaignSpec, file_sha256, fingerprint, plan
from hf_export.explorer_contract import CHANNELS, MATRIX_CHANNELS, validate_release
from hf_export.test_demo_campaign import reference_catalog, tree_hashes


def write_manifest(root, manifest):
    for item in manifest["files"]:
        path = root / item["path"]
        item.update(bytes=path.stat().st_size, sha256=file_sha256(path))
    (root / "manifest.json").write_text(json.dumps(manifest))


@pytest.fixture
def bundle(tmp_path):
    root = tmp_path / "release"
    root.mkdir()
    (root / "trajectories").mkdir()
    catalog = root / "catalog.sqlite"
    reference_catalog(catalog)
    campaign = CampaignSpec.model_validate_json(DEFAULT_MANIFEST.read_text())
    resolved = {row["key"]: row for row in plan(campaign, catalog)["experiments"]}
    with sqlite3.connect(catalog) as db:
        db.executescript("""
            CREATE TABLE demo_experiments (key TEXT, experiment_id INTEGER, job_id INTEGER);
            CREATE TABLE demo_controls (experiment_key TEXT, control_key TEXT, role TEXT);
            CREATE TABLE experiments (id INTEGER PRIMARY KEY, name TEXT, variant_type TEXT,
                                      variant_index INTEGER, condition TEXT, gene_symbol TEXT);
            CREATE TABLE simulation_jobs (id INTEGER PRIMARY KEY, experiment_id INTEGER,
                                          seed INTEGER, generations INTEGER, status TEXT);
            CREATE TABLE simulation_results (id INTEGER PRIMARY KEY, job_id INTEGER,
                experiment_id INTEGER, seed INTEGER, generation INTEGER, divided INTEGER,
                terminated INTEGER, termination_reason TEXT);
        """)
        experiments, metadata, qc = [], [], []
        for index, spec in enumerate(campaign.experiments, 1):
            variant_index = resolved[spec.key]["variant_index"]
            exp = {
                "key": spec.key, "experiment_id": index, "job_id": index,
                "variant_index": variant_index, "initial_condition": spec.initial_condition,
                "events": [event.model_dump() for event in spec.events],
                "execution_sha256": fingerprint(spec.execution(variant_index)),
                "transcription_unit_id": f"synthetic-TU-{index}" if spec.gene else None,
                "co_targeted_genes": [] if spec.gene else None,
                "outcome": "terminated", "reason": "synthetic early-stop example",
                "shard": f"trajectories/{spec.key}.h5", "trajectories": [],
            }
            db.execute("INSERT INTO demo_experiments VALUES (?,?,?)", (spec.key, index, index))
            db.execute("INSERT INTO experiments VALUES (?,?,?,?,?,?)", (
                index, spec.key, spec.variant, variant_index, spec.initial_condition, spec.gene or ""))
            db.execute("INSERT INTO simulation_jobs VALUES (?,?,0,4,'done')", (index, index))
            for control in spec.controls:
                db.execute("INSERT INTO demo_controls VALUES (?,?,?)", (spec.key, control.key, control.role))
            with h5py.File(root / exp["shard"], "w") as h5:
                for name in MATRIX_CHANNELS:
                    h5.create_dataset(f"reference/{name}_ids", data=["synthetic-A", "synthetic-B"],
                                      dtype=h5py.string_dtype())
                for generation in (0, 1):
                    start = float(generation * 3)
                    outcome = "completed" if generation == 0 else "terminated"
                    reason = "synthetic early-stop example" if generation else ""
                    trajectory = {
                        "seed": 0, "generation": generation,
                        "h5_group": f"seed=0/gen={generation}",
                        "lineage_start_sec": start, "lineage_end_sec": start + 2,
                        "outcome": outcome, "termination_reason": reason, "channels": {},
                    }
                    group = h5.create_group(trajectory["h5_group"])
                    for key in ("seed", "generation", "lineage_start_sec", "lineage_end_sec",
                                "outcome", "termination_reason"):
                        group.attrs[key] = trajectory[key]
                    for name in CHANNELS:
                        available = name in {"cell_mass", "growth_rate"} or name in MATRIX_CHANNELS
                        trajectory["channels"][name] = {
                            "available": available,
                            "reason": "" if available else "optional channel omitted from synthetic fixture",
                            "source_samples": 3 if available else None,
                            "source_columns": 2 if name in MATRIX_CHANNELS else None,
                        }
                        if not available:
                            continue
                        channel = group.create_group(name)
                        clock = channel.create_dataset("time", data=np.arange(3, dtype=float) + start)
                        clock.attrs.update(source="Main.time", unit="s")
                        shape = (3, 2) if name in MATRIX_CHANNELS else (3,)
                        value = channel.create_dataset("value", data=np.ones(shape))
                        value.attrs["unit"] = "mmol/gDCW/h" if "flux" in name else (
                            "1/s" if name == "growth_rate" else "fg" if name == "cell_mass" else "molecules")
                    exp["trajectories"].append(trajectory)
                    metadata.append({"key": spec.key, "seed": 0, "generation": generation})
                    db.execute("INSERT INTO simulation_results VALUES (NULL,?,?,0,?,?,?,?)", (
                        index, index, generation, int(generation == 0), int(generation == 1), reason))
            experiments.append(exp)
            qc.append({"key": spec.key, "outcome": exp["outcome"], "reason": exp["reason"]})
    (root / "README.md").write_text("# SYNTHETIC TEST FIXTURE\nNot simulation results.\n")
    for name, rows in [("metadata.jsonl", metadata), ("qc.jsonl", qc)]:
        (root / name).write_text("".join(json.dumps(row) + "\n" for row in rows))
    manifest = {
        "schema_version": "explorer-release-v1", "synthetic_fixture": True,
        "campaign": campaign.model_dump(), "campaign_sha256": fingerprint(campaign.canonical()),
        "provenance": {
            "simulation_source_sha256": "1" * 64, "prepared_model_sha256": "2" * 64,
            "preparation_config_sha256": "3" * 64, "runtime_image_digest": "sha256:" + "4" * 64,
            "initial_condition_binding": "--initial-condition", "model_targets_verified": True,
            "preserve_all_samples": True, "time_basis": "elapsed_lineage_seconds",
        },
        "files": [{"path": path.relative_to(root).as_posix(), "bytes": 0, "sha256": "0" * 64}
                  for path in sorted(root.rglob("*")) if path.is_file()],
        "experiments": experiments,
    }
    write_manifest(root, manifest)
    return root, manifest


def check(bundle):
    return validate_release(bundle[0], allow_synthetic=True)


def test_synthetic_valid_with_opt_in_and_read_only(bundle):
    root, _ = bundle
    before = tree_hashes(root)
    assert not validate_release(root)["valid"]
    report = check(bundle)
    assert report["valid"], report
    assert report["total_bytes"] == sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
    assert tree_hashes(root) == before


@pytest.mark.parametrize("damage", ["shape", "time-order", "time-source", "units", "ids", "sample-count", "column-count", "hidden-data"])
def test_bad_hdf5_rejected(bundle, damage):
    root, manifest = bundle
    exp = manifest["experiments"][0]
    with h5py.File(root / exp["shard"], "r+") as h5:
        channel = h5["seed=0/gen=0/mrna_counts_matrix"]
        if damage == "shape":
            del channel["value"]
            channel.create_dataset("value", data=np.ones((2, 2)))
        elif damage == "time-order":
            channel["time"][:] = [0, 2, 1]
        elif damage == "time-source":
            channel["time"].attrs["source"] = "invented_row_numbers"
        elif damage == "units":
            del channel["value"].attrs["unit"]
        elif damage == "ids":
            h5["reference/mrna_counts_matrix_ids"][:] = ["duplicate", "duplicate"]
        elif damage == "sample-count":
            exp["trajectories"][0]["channels"]["mrna_counts_matrix"]["source_samples"] = 4
        elif damage == "column-count":
            exp["trajectories"][0]["channels"]["mrna_counts_matrix"]["source_columns"] = 3
        else:
            h5.create_dataset("unindexed", data=[1])
    write_manifest(root, manifest)
    assert not check(bundle)["valid"]


@pytest.mark.parametrize("damage", ["checksum", "unlisted-file", "duplicate-key", "renumber", "reset-clock", "missing-reason", "initialization", "thin-policy", "co-targets"])
def test_bad_release_rejected(bundle, damage):
    root, manifest = bundle
    exp = manifest["experiments"][0]
    if damage == "checksum":
        (root / "README.md").write_text("changed payload")
        assert not check(bundle)["valid"]
        return
    if damage == "unlisted-file":
        (root / "extra.env").write_text("not part of the contract")
    elif damage == "duplicate-key":
        manifest["experiments"][1]["key"] = exp["key"]
    elif damage == "renumber":
        exp["trajectories"][1]["generation"] = 3
        exp["trajectories"][1]["h5_group"] = "seed=0/gen=3"
    elif damage == "reset-clock":
        exp["trajectories"][1]["lineage_start_sec"] = 0
    elif damage == "missing-reason":
        exp["trajectories"][0]["channels"]["dry_mass"]["reason"] = ""
    elif damage == "initialization":
        exp["initial_condition"] = "with_aa"
    elif damage == "thin-policy":
        manifest["provenance"]["preserve_all_samples"] = False
    elif damage == "co-targets":
        next(e for e in manifest["experiments"] if e["key"] == "hisG-basal")["co_targeted_genes"] = None
    write_manifest(root, manifest)
    assert not check(bundle)["valid"]


@pytest.mark.parametrize("sql", [
    "CREATE TABLE assistant_provider_configs(secret_value TEXT)",
    "INSERT INTO experiments VALUES (999,'unrelated','wildtype',0,'basal','')",
    "UPDATE simulation_results SET generation=3 WHERE id=1",
    "UPDATE demo_controls SET control_key='missing' WHERE rowid=1",
    "UPDATE experiments SET name='/Users/private/person/file' WHERE id=1",
    "UPDATE experiments SET variant_index=999 WHERE id=1",
])
def test_bad_catalog_rejected(bundle, sql):
    root, manifest = bundle
    with sqlite3.connect(root / "catalog.sqlite") as db:
        db.execute(sql)
    write_manifest(root, manifest)
    assert not check(bundle)["valid"]


def test_max_size_gate_before_reading_payloads(bundle, monkeypatch):
    root, _ = bundle
    original = Path.stat
    def oversized(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if path == root / "README.md":
            values = list(result)
            values[6] = 10_000_000_001
            return os.stat_result(values)
        return result
    monkeypatch.setattr(Path, "stat", oversized)
    report = check(bundle)
    assert not report["valid"]
    assert report["total_bytes"] > 10_000_000_000
    assert "never thin" in report["errors"][0]


def test_biological_termination_is_not_renumbered_or_filled(bundle):
    root, manifest = bundle
    report = check(bundle)
    assert report["valid"], report
    assert all([t["generation"] for t in exp["trajectories"]] == [0, 1]
               for exp in manifest["experiments"])
    assert all(exp["outcome"] == "terminated" for exp in manifest["experiments"])


@pytest.mark.parametrize("outcome", ["missing_output", "execution_error"])
def test_missing_and_failed_runs_remain_distinct_without_fake_data(bundle, outcome):
    root, manifest = bundle
    exp = manifest["experiments"][0]
    shard = exp["shard"]
    (root / shard).unlink()
    manifest["files"] = [item for item in manifest["files"] if item["path"] != shard]
    exp.update(shard=None, trajectories=[], outcome=outcome, reason="synthetic failure example")
    with sqlite3.connect(root / "catalog.sqlite") as db:
        db.execute("DELETE FROM simulation_results WHERE job_id=?", (exp["job_id"],))
        db.execute("UPDATE simulation_jobs SET status='failed' WHERE id=?", (exp["job_id"],))
    rows = [json.loads(line) for line in (root / "metadata.jsonl").read_text().splitlines()]
    (root / "metadata.jsonl").write_text("".join(
        json.dumps(row) + "\n" for row in rows if row["key"] != exp["key"]))
    qc = [json.loads(line) for line in (root / "qc.jsonl").read_text().splitlines()]
    for row in qc:
        if row["key"] == exp["key"]:
            row.update(outcome=outcome, reason=exp["reason"])
    (root / "qc.jsonl").write_text("".join(json.dumps(row) + "\n" for row in qc))
    write_manifest(root, manifest)
    report = check(bundle)
    assert report["valid"], report


def test_private_hdf5_attributes_are_rejected(bundle):
    root, manifest = bundle
    with h5py.File(root / manifest["experiments"][0]["shard"], "r+") as h5:
        h5.attrs["original_path"] = "/Users/person/private-output"
    write_manifest(root, manifest)
    report = check(bundle)
    assert not report["valid"]


def test_catalog_result_outcomes_must_match_trajectory_metadata(bundle):
    root, manifest = bundle
    with sqlite3.connect(root / "catalog.sqlite") as db:
        db.execute("UPDATE simulation_results SET terminated=0 WHERE terminated=1")
    write_manifest(root, manifest)
    assert not check(bundle)["valid"]
