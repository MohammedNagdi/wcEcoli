"""Pilot boundaries and lossless extraction contracts; all scientific fixtures synthetic."""

import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

import h5py
import numpy as np
import pytest
from fastapi.testclient import TestClient

from . import explorer_export as export
from . import preview
from .explorer_contract import ReleaseManifest, validate_release
from .test_explorer_contract import bundle as bundle_fixture, write_manifest

bundle = bundle_fixture

ROOT = Path(__file__).resolve().parents[3]


def pilot_bundle(root, manifest, keys=("wt-basal",)):
    manifest["scope"] = "pilot"
    removed = [exp for exp in manifest["experiments"] if exp["key"] not in keys]
    manifest["experiments"] = [e for e in manifest["experiments"] if e["key"] in keys]
    for exp in removed:
        (root / exp["shard"]).unlink()
    manifest["files"] = [f for f in manifest["files"] if (root / f["path"]).exists()]
    with sqlite3.connect(root / "catalog.sqlite") as db:
        for exp in removed:
            db.execute("DELETE FROM demo_experiments WHERE key=?", (exp["key"],))
            db.execute("DELETE FROM demo_controls WHERE experiment_key=?", (exp["key"],))
            db.execute("DELETE FROM experiments WHERE id=?", (exp["experiment_id"],))
            db.execute("DELETE FROM simulation_jobs WHERE id=?", (exp["job_id"],))
            db.execute("DELETE FROM simulation_results WHERE job_id=?", (exp["job_id"],))
    for name in ("metadata.jsonl", "qc.jsonl"):
        path = root / name
        path.write_text(
            "".join(
                json.dumps(row) + "\n"
                for row in map(json.loads, path.read_text().splitlines())
                if row["key"] in keys
            )
        )
    write_manifest(root, manifest)
    return root, manifest


def test_pilot_optin_independent_of_synthetic(bundle):
    root, manifest = pilot_bundle(*bundle)
    assert "allow-pilot" in str(validate_release(root, allow_synthetic=True)["errors"])
    assert not validate_release(root, allow_pilot=True)["valid"]
    assert validate_release(root, allow_pilot=True, allow_synthetic=True)["valid"]
    manifest.pop("scope")
    with pytest.raises(ValueError, match="every campaign"):
        ReleaseManifest.model_validate(manifest)


def test_pilot_rejects_nonpilot_and_empty(bundle):
    _, manifest = pilot_bundle(*bundle, keys=("wt-acetate",))
    with pytest.raises(ValueError):
        ReleaseManifest.model_validate(manifest)
    manifest["experiments"] = []
    with pytest.raises(ValueError):
        ReleaseManifest.model_validate(manifest)


def source(monkeypatch, tmp_path, clock=True, mismatch=False):
    path = tmp_path / "simOut"
    (path / "Mass").mkdir(parents=True)
    (path / "Main").mkdir()
    arrays = {
        ("Mass", "cellMass"): np.array([[1.1], [2.2], [3.3]]),
        ("Mass", "time"): np.array([0.0, 2.0, 5.0]),
        ("Main", "time"): np.array([0.0, 2.0, 5.0]),
        ("Mass", "simulationStep"): np.array([0, 1, 2]),
        ("Main", "simulationStep"): np.array([0, 1, 2]),
    }
    if mismatch:
        arrays[("Mass", "time")] = np.array([0.0, 2.0])
    monkeypatch.setattr(
        export,
        "list_columns",
        lambda p: ["cellMass", "simulationStep"] + (["time"] if clock or p.name == "Main" else []),
    )
    monkeypatch.setattr(export, "read_column", lambda p, c, **_: arrays[(p.name, c)])
    return path, arrays


def test_real_clocks_and_no_truncation(monkeypatch, tmp_path):
    path, _ = source(monkeypatch, tmp_path, mismatch=True)
    with pytest.raises(ValueError, match="misaligned"):
        export.source_channel(path, "cell_mass")


def test_verified_main_alignment(monkeypatch, tmp_path):
    path, arrays = source(monkeypatch, tmp_path, clock=False)
    data = export.source_channel(path, "cell_mass")
    assert data["clock_source"] == "Main.time"
    arrays[("Mass", "simulationStep")] = np.array([0, 1, 3])
    with pytest.raises(ValueError, match="alignment"):
        export.source_channel(path, "cell_mass")


def test_source_comparison_detects_corruption(monkeypatch, tmp_path):
    path, _ = source(monkeypatch, tmp_path)
    monkeypatch.setattr(export, "CHANNELS", ("cell_mass",))
    monkeypatch.setattr(export, "paths_for", lambda _: {0: path})
    trajectories = [
        dict(
            seed=0,
            generation=0,
            h5_group="seed=0/gen=0",
            lineage_start_sec=0.0,
            lineage_end_sec=5.0,
            outcome="terminated",
            termination_reason="synthetic",
        )
    ]
    shard = tmp_path / "test.h5"
    export.write_shard(shard, tmp_path, trajectories)
    assert export.compare_source(shard, tmp_path, trajectories)
    with h5py.File(shard, "r+") as h5:
        h5["seed=0/gen=0/cell_mass/value"][1] = 9
    with pytest.raises(ValueError, match="value comparison"):
        export.compare_source(shard, tmp_path, trajectories)


def test_preview_is_read_only_and_artifact_only(bundle, monkeypatch):
    root, manifest = pilot_bundle(*bundle)
    # Synthetic tests may exercise adapter shape, but production preview calls
    # the strict validator without any synthetic opt-in.
    monkeypatch.setattr(preview, "ROOT", root)
    monkeypatch.setattr(preview, "_cached", None)
    original = preview.validate_release
    monkeypatch.setattr(
        preview, "validate_release", lambda p, **kw: original(p, allow_synthetic=True, **kw)
    )
    with TestClient(preview.app) as client:
        index = client.get("/api/pilot").json()
        assert len(index["unrun"]) == 11
        jid = index["experiments"][0]["job_id"]
        data = client.get(f"/api/jobs/{jid}/timeseries").json()
        assert data["timeseries"]["cell_mass"][1]["generation"] == 1
        assert data["timeseries"]["cell_mass"][1]["time_basis"] == "elapsed_lineage_seconds"
        assert (
            client.get(f"/api/jobs/{jid}/molecules/protein/timeseries?ids=synthetic-A").status_code
            == 200
        )
        assert client.get(f"/api/jobs/{jid}/molecules/rRNA/ids").status_code == 409
        assert client.get("/api/jobs/99999/timeseries").status_code == 404
        for method in ("post", "put", "patch", "delete"):
            assert getattr(client, method)("/api/jobs").status_code == 405
        assert client.get("/api/assistant").status_code == 404


def test_preview_rejects_synthetic_by_default(bundle, monkeypatch):
    root, _ = pilot_bundle(*bundle)
    monkeypatch.setattr(preview, "ROOT", root)
    monkeypatch.setattr(preview, "_cached", None)
    with pytest.raises(Exception, match="synthetic"):
        with TestClient(preview.app):
            pass


def test_durable_timeout_never_biological(tmp_path):
    receipt = tmp_path / "metrics.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "runscripts/manual/hfPilotTask.py"),
            "--receipt",
            str(receipt),
            "--seconds",
            "1",
            "--",
            sys.executable,
            "-c",
            "import time; time.sleep(30)",
        ],
        timeout=20,
    )
    assert result.returncode != 0
    record = json.loads(receipt.read_text())
    assert record["classification"] == "execution_error"
    assert record["infrastructure_error"] == "wall-time limit exceeded"


def test_compose_isolation():
    text = (ROOT / "interface/pilot/compose.yaml").read_text()
    assert "name: wcecoli-hf-demo-v1" in text
    assert "docker.sock" not in text and "../" not in text and "wcecoli-sim:latest" not in text
    assert "127.0.0.1:8001:8000" in text and "127.0.0.1:5175:80" in text
    assert "mem_limit: 4g" in text and "SIM_RUNNER_CONCURRENCY: 1" in text


def test_initial_binding_and_legacy_omission(tmp_path):
    from sqlmodel import Session, SQLModel
    from app.db.engine import make_sqlite_engine
    from app.db.models import Condition
    from app.services.sim_worker import _build_sim_command

    engine = make_sqlite_engine(tmp_path / "job.sqlite")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.commit()
        job = SimpleNamespace(
            variant_type="wildtype",
            variant_index=0,
            seed=0,
            generations=4,
            timeline="",
            condition="basal",
        )
        exp = SimpleNamespace(sim_params="{}")
        command, _ = _build_sim_command(session, job, exp, "test", [])
        assert "--initial-condition" not in command
        exp.sim_params = '{"initial_condition":"basal"}'
        command, _ = _build_sim_command(session, job, exp, "test", [])
        assert command[command.index("--initial-condition") + 1] == "basal"
        exp.sim_params = '{"initial_condition":"unknown"}'
        with pytest.raises(ValueError, match="unknown initial_condition"):
            _build_sim_command(session, job, exp, "test", [])


def test_atomic_submission_identity_and_readiness_change(tmp_path, monkeypatch):
    from sqlmodel import Session, SQLModel
    from app.db.engine import make_sqlite_engine
    from app.db.models import Condition
    from . import pilot_inside as pilot

    path = tmp_path / "pilot.sqlite"
    engine = make_sqlite_engine(path)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.commit()
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE pilot_submissions (campaign_sha256 TEXT,key TEXT,seed INTEGER,
        experiment_id INTEGER,job_id INTEGER,task_id TEXT,run_dir TEXT,receipt_sha256 TEXT,
        command_json TEXT,state TEXT,outcome_json TEXT,PRIMARY KEY(campaign_sha256,key,seed))""")
    monkeypatch.setattr(pilot, "DB", path)
    receipt = dict(receipt_sha256="a" * 64, verified_targets={})
    monkeypatch.setattr(pilot, "verify", lambda: receipt)
    first = pilot.submission("wt-basal")
    second = pilot.submission("wt-basal")
    assert first == second
    command = json.loads(first["command_json"])
    assert command[command.index("--initial-condition") + 1] == "basal"
    assert command[command.index("--timeline") + 1] == "0 minimal"
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM simulation_jobs").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM experiments").fetchone()[0] == 1
    receipt["receipt_sha256"] = "b" * 64
    with pytest.raises(ValueError, match="different readiness"):
        pilot.submission("wt-basal")
    with pytest.raises(ValueError, match="wild-type export"):
        pilot.submission("hisG-basal")


def test_initial_condition_supported_in_both_simulation_tasks():
    # Parse the real task sources: both must set the prepared model's condition
    # before constructing EcoliSimulation, rather than changing only the timeline.
    import ast

    for name in ("simulation.py", "simulationDaughter.py"):
        tree = ast.parse((ROOT / "wholecell/fireworks/firetasks" / name).read_text())
        assignments = [node for node in ast.walk(tree) if isinstance(node, ast.Assign)]
        binding = [
            node
            for node in assignments
            if any(isinstance(t, ast.Attribute) and t.attr == "condition" for t in node.targets)
        ]
        assert len(binding) == 1
        assert "initial_condition" in ast.unparse(binding[0].value)


def test_readiness_rejects_changed_model_catalog_and_mapping(tmp_path, monkeypatch):
    from . import pilot_inside as pilot
    from .demo_campaign import file_sha256, fingerprint
    from .test_demo_campaign import reference_catalog
    import shutil

    reference_catalog(tmp_path / "reference.sqlite")
    shutil.copy2(tmp_path / "reference.sqlite", tmp_path / "catalog.sqlite")
    pilot.save(tmp_path / "inputs.json", dict(source_sha256="a" * 64))
    pilot.save(tmp_path / "targets.json", dict(targets="clearly synthetic"))
    receipt = dict(
        inputs=pilot.load(tmp_path / "inputs.json"),
        campaign_sha256=fingerprint(pilot.campaign().canonical()),
        kb=dict(model="synthetic"),
        files={name: file_sha256(tmp_path / name) for name in ("reference.sqlite", "targets.json")},
    )
    receipt["receipt_sha256"] = fingerprint(receipt)
    pilot.save(tmp_path / "readiness.json", receipt)
    monkeypatch.setattr(pilot, "STATE", tmp_path)
    monkeypatch.setattr(pilot, "DB", tmp_path / "catalog.sqlite")
    monkeypatch.setattr(pilot, "prepared_fingerprints", lambda: dict(model="synthetic"))
    assert pilot.verify()["receipt_sha256"] == receipt["receipt_sha256"]
    with sqlite3.connect(pilot.DB) as db:
        db.execute("UPDATE genes SET ko_index=999 WHERE symbol='hisG'")
    with pytest.raises(ValueError, match="catalog references changed"):
        pilot.verify()
    shutil.copy2(tmp_path / "reference.sqlite", pilot.DB)
    monkeypatch.setattr(pilot, "prepared_fingerprints", lambda: dict(model="changed"))
    with pytest.raises(ValueError, match="prepared model differs"):
        pilot.verify()
    monkeypatch.setattr(pilot, "prepared_fingerprints", lambda: dict(model="synthetic"))
    (tmp_path / "targets.json").write_text("{}")
    with pytest.raises(ValueError, match="targets.json"):
        pilot.verify()


def test_targets_derive_actual_rna_indices_and_cotargets(tmp_path):
    import importlib.util
    import pickle
    from scipy.sparse import csc_matrix

    module_spec = importlib.util.spec_from_file_location(
        "pilot_targets", ROOT / "runscripts/manual/hfPilotTargets.py"
    )
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    data = SimpleNamespace(
        process=SimpleNamespace(
            transcription=SimpleNamespace(
                rna_data=np.array(
                    [
                        ("TU-multi[c]",),
                        ("hisG-single[c]",),
                        ("trpA-single[c]",),
                        ("pgi-single[c]",),
                    ],
                    dtype=[("id", "U32")],
                ),
                cistron_data=np.array(
                    [("G1_RNA",), ("G2_RNA",), ("G3_RNA",), ("G4_RNA",)], dtype=[("id", "U32")]
                ),
                cistron_tu_mapping_matrix=csc_matrix(
                    [[1, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
                ),
            )
        )
    )
    model = tmp_path / "model.pickle"
    model.write_bytes(pickle.dumps(data))
    genes = tmp_path / "genes.tsv"
    genes.write_text('"id"\t"symbol"\n"G1"\t"hisG"\n"G2"\t"other"\n"G3"\t"trpA"\n"G4"\t"pgi"\n')
    targets = module.extract(model, genes)["targets"]
    assert targets["hisG"]["index"] == 2
    assert targets["hisG"]["rna_id"] == "hisG-single[c]"
    assert targets["other"]["genes"] == ["hisG", "other"]
    assert targets["trpA"]["index"] == 3 and targets["pgi"]["index"] == 4


def test_legacy_malformed_params_keep_default_initialization(tmp_path):
    from sqlmodel import Session
    from app.db.engine import make_sqlite_engine
    from app.services.sim_worker import _build_sim_command

    engine = make_sqlite_engine(tmp_path / "job.sqlite")
    job = SimpleNamespace(
        variant_type="wildtype",
        variant_index=0,
        seed=0,
        generations=4,
        timeline="",
        condition="basal",
    )
    with Session(engine) as session:
        for params in ("not JSON", "[]", "null", "{}"):
            command, _ = _build_sim_command(
                session, job, SimpleNamespace(sim_params=params), "test", []
            )
            assert "--initial-condition" not in command


def test_environment_shift_uses_lineage_clock_across_division(tmp_path, monkeypatch):
    from .demo_campaign import CampaignSpec, DEFAULT_MANIFEST

    spec = next(
        e
        for e in CampaignSpec.model_validate_json(DEFAULT_MANIFEST.read_text()).experiments
        if e.key == "wt-add-aa"
    )
    (tmp_path / "metadata").mkdir()
    (tmp_path / "metadata/metadata.json").write_text(
        json.dumps(
            dict(
                initial_condition="basal",
                timeline="0 minimal, 1200 minimal_plus_amino_acids",
                seed=0,
                generations=4,
            )
        )
    )
    paths = {0: tmp_path / "gen0", 1: tmp_path / "gen1"}
    clocks = {
        "gen0": np.array([0.0, 1199.0, 1200.0, 1400.0]),
        "gen1": np.array([1400.0, 1500.0, 2000.0]),
    }
    media = {
        "gen0": ["minimal", "minimal", "minimal_plus_amino_acids", "minimal_plus_amino_acids"],
        "gen1": ["minimal_plus_amino_acids"] * 3,
    }
    monkeypatch.setattr(export, "paths_for", lambda _: paths)
    monkeypatch.setattr(
        export,
        "read_column",
        lambda p, c: clocks[p.parent.name] if c == "time" else np.array(media[p.parent.name]),
    )
    proof = export.verify_execution(tmp_path, spec)
    assert proof["event_observations"][0]["first_saved_observation_sec"] == 1200
    media["gen1"][1] = "minimal"
    with pytest.raises(ValueError, match="schedule differs at lineage time 1500"):
        export.verify_execution(tmp_path, spec)


def test_repeated_preparation_seals_closed_reference_snapshot(tmp_path, monkeypatch):
    from . import pilot_inside as pilot
    from .demo_campaign import file_sha256
    from .test_demo_campaign import reference_catalog

    state, out = tmp_path / "state", tmp_path / "out"
    state.mkdir()
    out.mkdir()
    reference_catalog(state / "catalog.sqlite")
    with sqlite3.connect(state / "catalog.sqlite") as db:
        db.execute("PRAGMA journal_mode=WAL")
    kb = out / pilot.MODEL_DIR / "kb"
    kb.mkdir(parents=True)
    for name in pilot.REQUIRED_KB:
        (kb / name).write_bytes(b"clearly synthetic preparation fixture")
    pilot.save(
        out / "pilot-targets.json",
        dict(
            model_sha256=file_sha256(kb / "simData.cPickle"),
            targets={
                gene: dict(index=index, rna_id="synthetic-" + gene, genes=[gene])
                for gene, index in [("hisG", 10), ("trpA", 20), ("pgi", 30)]
            },
        ),
    )
    pilot.save(state / "inputs.json", dict(source_sha256="a" * 64))
    pilot.save(out / ".pilot-metrics/hf-demo-v1-parca.json", dict(classification="completed"))
    monkeypatch.setattr(pilot, "STATE", state)
    monkeypatch.setattr(pilot, "OUT", out)
    monkeypatch.setattr(pilot, "DB", state / "catalog.sqlite")
    monkeypatch.setattr(pilot, "bounded", lambda *args: None)
    monkeypatch.setattr(
        pilot, "client", lambda: SimpleNamespace(status=lambda _: dict(status="done"))
    )
    first = pilot.prepare_finish()
    second = pilot.prepare_finish()
    assert first["ready"] and second["ready"]
    assert not (state / "reference.sqlite-wal").exists()
    assert pilot.plan(pilot.campaign(), state / "reference.sqlite")["catalog_valid"]


def test_pilot_keeps_unrun_control_unavailable(bundle, monkeypatch):
    root, _ = pilot_bundle(*bundle, keys=("hisG-basal",))
    monkeypatch.setattr(preview, "ROOT", root)
    monkeypatch.setattr(preview, "_cached", None)
    original = preview.validate_release
    monkeypatch.setattr(
        preview, "validate_release", lambda p, **kw: original(p, allow_synthetic=True, **kw)
    )
    with TestClient(preview.app) as client:
        data = client.get("/api/pilot").json()
        assert [e["key"] for e in data["experiments"]] == ["hisG-basal"]
        assert "wt-basal" in data["unrun"]
        control = data["experiments"][0]["controls"][0]
        assert control["key"] == "wt-basal" and control["available"] is False
        assert "not been run/published" in control["reason"]


def test_clockless_listener_requires_pinned_common_writer(monkeypatch, tmp_path):
    path, _ = source(monkeypatch, tmp_path, clock=False)
    monkeypatch.setattr(
        export, "list_columns", lambda p: ["cellMass"] if p.name == "Mass" else ["time"]
    )
    assert export.source_channel(path, "cell_mass")["clock_source"] == "Main.time"
    monkeypatch.setattr(export, "verified_clock_writer", lambda: False)
    with pytest.raises(ValueError, match="verified Main.time alignment"):
        export.source_channel(path, "cell_mass")


def test_initial_growth_nan_preserved_and_explained(bundle, monkeypatch):
    root, manifest = pilot_bundle(*bundle)
    exp = manifest["experiments"][0]
    trajectory = exp["trajectories"][0]
    entry = trajectory["channels"]["growth_rate"]
    entry.update(
        undefined_samples=1,
        undefined_reason="Initial growth rate is undefined before the first simulation step",
    )
    with h5py.File(root / exp["shard"], "r+") as h5:
        h5[trajectory["h5_group"] + "/growth_rate/value"][0] = float("nan")
    write_manifest(root, manifest)
    assert validate_release(root, allow_pilot=True, allow_synthetic=True)["valid"]
    monkeypatch.setattr(preview, "ROOT", root)
    monkeypatch.setattr(preview, "_cached", None)
    original = preview.validate_release
    monkeypatch.setattr(
        preview, "validate_release", lambda p, **kw: original(p, allow_synthetic=True, **kw)
    )
    with TestClient(preview.app) as client:
        response = client.get(f"/api/jobs/{exp['job_id']}/timeseries")
        assert response.status_code == 200
        series = response.json()["timeseries"]["growth_rate"][0]
        assert series["points"][0]["value"] is None
        assert series["undefined_samples"] == 1 and series["undefined_reason"]
        assert len(series["points"]) == trajectory["channels"]["growth_rate"]["source_samples"]
    with h5py.File(root / exp["shard"], "r+") as h5:
        h5[trajectory["h5_group"] + "/growth_rate/value"][1] = float("nan")
    write_manifest(root, manifest)
    assert not validate_release(root, allow_pilot=True, allow_synthetic=True)["valid"]


def test_initial_nan_source_comparison_is_bit_exact(monkeypatch, tmp_path):
    path = tmp_path / "simOut"
    (path / "Mass").mkdir(parents=True)
    values = np.array([[np.nan], [0.001], [0.002]], dtype=np.float64)
    clock = np.array([0.0, 1.0, 2.0])
    monkeypatch.setattr(export, "list_columns", lambda _: ["time", "instantaneous_growth_rate"])
    monkeypatch.setattr(export, "read_column", lambda p, c, **_: clock if c == "time" else values)
    monkeypatch.setattr(export, "CHANNELS", ("growth_rate",))
    monkeypatch.setattr(export, "paths_for", lambda _: {0: path})
    trajectories = [
        dict(
            seed=0,
            generation=0,
            h5_group="seed=0/gen=0",
            lineage_start_sec=0.0,
            lineage_end_sec=2.0,
            outcome="terminated",
            termination_reason="synthetic",
        )
    ]
    shard = tmp_path / "synthetic.h5"
    export.write_shard(shard, tmp_path, trajectories)
    assert trajectories[0]["channels"]["growth_rate"]["undefined_samples"] == 1
    assert export.compare_source(shard, tmp_path, trajectories)
    with h5py.File(shard, "r+") as h5:
        h5["seed=0/gen=0/growth_rate/value"][0] = 0.0
    with pytest.raises(ValueError, match="source value comparison"):
        export.compare_source(shard, tmp_path, trajectories)


def test_serving_refresh_requires_idle_runner_and_keeps_execution(tmp_path, monkeypatch):
    import importlib.util
    from unittest.mock import Mock

    spec = importlib.util.spec_from_file_location(
        "pilot_host_test", ROOT / "interface/pilot/host.py"
    )
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    root, state = tmp_path / "repo", tmp_path / "repo/interface/.pilot"
    names = ["wholecell/loggers/disk.py", "interface/backend/hf_export/preview.py"]
    for name in names:
        for base in (root, state / "snapshot"):
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic source")
    # Only serving code changes; simulation/preparation source stays identical.
    (root / names[1]).write_text("synthetic serving revision")
    frozen = dict(
        files=names,
        source_sha256="f" * 64,
        images=dict(runner="original-runner", tools="original-tools", web="original-web"),
        image_ids=dict(
            runner="sha256:" + "a" * 64, tools="sha256:" + "b" * 64, web="sha256:" + "c" * 64
        ),
    )
    monkeypatch.setattr(host, "ROOT", root)
    monkeypatch.setattr(host, "STATE", state)
    monkeypatch.setattr(host, "config", lambda: frozen)
    monkeypatch.setattr(host, "observations", lambda **_: None)
    monkeypatch.setattr(host, "verify_images", lambda _: None)
    monkeypatch.setattr(host, "source_files", lambda: iter((name, root / name) for name in names))
    active = True

    def inside(command, *args, **kwargs):
        if command == "health":
            return json.dumps(dict(running=int(active), queued=0))
        if command == "status":
            return json.dumps(dict(jobs=[dict(state="complete")]))
        return json.dumps(dict(ready=True))

    monkeypatch.setattr(host, "inside", inside)
    calls = Mock(return_value="sha256:" + "d" * 64)
    compose = Mock()
    monkeypatch.setattr(host, "call", calls)
    monkeypatch.setattr(host, "compose", compose)
    with pytest.raises(RuntimeError, match="idle runner"):
        host.refresh_serving()
    calls.assert_not_called()
    compose.assert_not_called()
    active = False
    host.refresh_serving()
    serving = json.loads((state / "serving.json").read_text())
    assert set(serving["images"]) == {"tools", "web"}
    assert serving["runner_image_id"] == frozen["image_ids"]["runner"]
    assert (state / "snapshot" / names[0]).read_text() == "synthetic source"
    assert compose.call_args_list[0].args == ("up", "-d", "tools")
    assert all("runner" not in call.args for call in compose.call_args_list)


def test_no_division_retains_model_time_explanation(tmp_path, monkeypatch):
    path = tmp_path / "wildtype_000000/000000/generation_000000/000000/simOut"
    path.mkdir(parents=True)
    monkeypatch.setattr(export, "find_sim_outs", lambda _: [path])
    monkeypatch.setattr(export, "read_column", lambda *args, **kwargs: np.array([0.0, 1.0, 2.0]))
    monkeypatch.setattr(
        export,
        "read_lineage_terminations",
        lambda _: {
            (0, 0): dict(
                exception="TimeLimitReached", message="Model time limit reached without division"
            )
        },
    )
    result = export.inspect_run(tmp_path)
    assert result["outcome"] == "no_division"
    assert result["reason"] == "TimeLimitReached: Model time limit reached without division"
    assert result["trajectories"][0]["termination_reason"] == ""
