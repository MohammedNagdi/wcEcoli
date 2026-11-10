"""Cleanup and resume tests use tiny, explicitly synthetic scientific bundles."""

import importlib.util
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import pytest

from . import demo_checkpoint as checkpoints
from . import demo_inside as demo
from . import pilot_inside as pilot
from .demo_campaign import file_sha256, fingerprint
from .explorer_contract import PublishedExperiment
from .test_explorer_contract import bundle as bundle_fixture

bundle = bundle_fixture


@pytest.fixture
def completed(bundle, tmp_path, monkeypatch):
    source, manifest = bundle
    state, output, release = [tmp_path / name for name in ("state", "output", "publication")]
    for path in (state, output, release):
        path.mkdir()
    exp = manifest["experiments"][0]
    key = exp["key"]
    fp = manifest["campaign_sha256"]
    run_name = "hf-demo-v1-" + key + "-" + fp[:12]
    run = output / run_name
    run.mkdir()
    (run / "original.txt").write_text("SYNTHETIC raw listener")
    model = output / pilot.MODEL_DIR
    (model / "kb").mkdir(parents=True)
    (model / "kb/simData.cPickle").write_text("SYNTHETIC shared model; do not delete")
    (run / "kb").symlink_to(Path("..") / pilot.MODEL_DIR / "kb", target_is_directory=True)
    files = [dict(path="original.txt", bytes=(run / "original.txt").stat().st_size,
                  sha256=file_sha256(run / "original.txt"))]
    exp["execution_provenance"] = dict(source_files=files, source_files_sha256=fingerprint(files))
    dest = release / "checkpoints" / key
    (dest / "trajectories").mkdir(parents=True)
    shutil.copy2(source / exp["shard"], dest / exp["shard"])
    source_comparison = [dict(channel="synthetic", passed=True)]
    api = checkpoints.compare_api(dest, PublishedExperiment.model_validate(exp))
    for name, value in (("execution.json", {"synthetic": True}),
                        ("source-comparison.json", {"passed": True, "channels": source_comparison}),
                        ("api-comparison.json", api)):
        pilot.save(dest / name, value)
    observed = dict(outcome=exp["outcome"], reason=exp["reason"])
    ready = dict(receipt_sha256="a" * 64, campaign_sha256=fp)
    receipt = checkpoints.seal(dict(version="demo-checkpoint-v1", key=key, run_dir=run_name,
                                    campaign_sha256=fp, readiness_sha256=ready["receipt_sha256"],
                                    outcome_sha256=fingerprint(observed), experiment=exp,
                                    files=checkpoints.inventory(dest), source_comparison=source_comparison,
                                    api_comparison=api))
    pilot.save(dest / "receipt.json", receipt)
    row = dict(key=key, campaign_sha256=fp, run_dir=run_name, state="complete", outcome_json=json.dumps(observed),
               seed=0, receipt_sha256=ready["receipt_sha256"], experiment_id=exp["experiment_id"], job_id=exp["job_id"])
    ledger = {key: row}
    monkeypatch.setattr(pilot, "STATE", state)
    monkeypatch.setattr(pilot, "OUT", output)
    monkeypatch.setattr(pilot, "RELEASE", release)
    monkeypatch.setattr(pilot, "verify", lambda: ready)
    monkeypatch.setattr(pilot, "client", lambda: SimpleNamespace(health=lambda: dict(running=0, queued=0)))
    monkeypatch.setattr(demo, "rows", lambda: ledger)
    return SimpleNamespace(key=key, run=run, model=model, dest=dest, receipt=receipt,
                           ready=ready, row=row, ledger=ledger, state=state)


def test_api_compares_real_adapter_all_four_matrix_families(completed):
    api = completed.receipt["api_comparison"]
    assert api["passed"]
    assert {c["channel"] for c in api["comparisons"]} >= {
        "cell_mass", "growth_rate", "mrna_counts_matrix", "protein_counts_matrix",
        "reaction_flux_matrix", "exchange_flux_matrix"}


def test_checkpoint_validates_without_raw_and_detects_corruption(completed):
    shutil.rmtree(completed.run)
    assert demo.verified(completed.key)["key"] == completed.key
    with (completed.dest / completed.receipt["experiment"]["shard"]).open("ab") as stream:
        stream.write(b"corruption")
    with pytest.raises(ValueError, match="checksum"):
        demo.verified(completed.key)


def test_cleanup_requires_verified_backup_and_preserves_preparation(completed):
    with pytest.raises(FileNotFoundError):
        demo.cleanup(completed.key)
    with pytest.raises(ValueError, match="differs"):
        demo.backup_ack(completed.key, "b" * 64)
    demo.backup_ack(completed.key, completed.receipt["receipt_sha256"])
    before = {p.relative_to(completed.state): p.read_bytes() for p in completed.state.rglob("*") if p.is_file()}
    plan = demo.cleanup(completed.key, dry_run=True)
    assert plan["eligible"] and plan["raw_files"] == 1
    assert before == {p.relative_to(completed.state): p.read_bytes() for p in completed.state.rglob("*") if p.is_file()}
    result = demo.cleanup(completed.key)
    assert result["state"] == "raw_removed"
    assert not completed.run.exists()
    assert (completed.model / "kb/simData.cPickle").read_text().startswith("SYNTHETIC")
    assert demo.cleanup(completed.key) == result


@pytest.mark.parametrize("state", ["submitted", "running", "failed"])
def test_cleanup_rejects_nonterminal_and_failed_runs(completed, state):
    completed.row["state"] = state
    with pytest.raises(ValueError, match="ledger execution"):
        demo.cleanup(completed.key)
    assert completed.run.is_dir()


def test_cleanup_rejects_changed_source(completed):
    demo.backup_ack(completed.key, completed.receipt["receipt_sha256"])
    (completed.run / "original.txt").write_text("changed")
    with pytest.raises(ValueError, match="source changed"):
        demo.cleanup(completed.key)


def test_cleanup_rejects_busy_runner(completed, monkeypatch):
    demo.backup_ack(completed.key, completed.receipt["receipt_sha256"])
    monkeypatch.setattr(pilot, "client", lambda: SimpleNamespace(health=lambda: dict(running=1, queued=0)))
    with pytest.raises(ValueError, match="idle runner"):
        demo.cleanup(completed.key)


@pytest.mark.parametrize("name", ["../hf-demo-v1-prepared", "hf-demo-v1-prepared", "/tmp/run", "unknown"])
def test_cleanup_path_guards(completed, name):
    row = dict(completed.row, run_dir=name)
    with pytest.raises(ValueError, match="unsafe"):
        demo.checked_run(row)


def test_cleanup_rejects_top_level_symlink(completed):
    saved = completed.run.with_name("saved")
    completed.run.rename(saved)
    completed.run.symlink_to(saved, target_is_directory=True)
    with pytest.raises(ValueError, match="escapes"):
        demo.checked_run(completed.row)


def test_interrupted_deletion_resumes_without_reexport(completed, monkeypatch):
    demo.backup_ack(completed.key, completed.receipt["receipt_sha256"])
    real_remove = shutil.rmtree

    def interrupted(path):
        (path / "original.txt").unlink()
        raise OSError("synthetic interruption")

    monkeypatch.setattr(demo.shutil, "rmtree", interrupted)
    with pytest.raises(OSError, match="interruption"):
        demo.cleanup(completed.key)
    assert demo.cleanup_state(completed.key)["state"] == "cleanup_pending"
    monkeypatch.setattr(demo.shutil, "rmtree", real_remove)
    assert demo.cleanup(completed.key)["state"] == "raw_removed"
    assert (completed.model / "kb/simData.cPickle").exists()


def test_reappearing_raw_directory_is_never_silently_deleted(completed):
    demo.backup_ack(completed.key, completed.receipt["receipt_sha256"])
    demo.cleanup(completed.key)
    completed.run.mkdir()
    with pytest.raises(ValueError, match="reappeared"):
        demo.cleanup(completed.key)


def test_checkpoint_receipt_and_readiness_tampering(completed):
    changed = dict(completed.receipt, readiness_sha256="b" * 64)
    pilot.save(completed.dest / "receipt.json", changed)
    with pytest.raises(ValueError, match="fingerprint"):
        demo.verified(completed.key)
    pilot.save(completed.dest / "receipt.json", checkpoints.seal(changed))
    with pytest.raises(ValueError, match="readiness mismatch"):
        demo.verified(completed.key)


def test_local_copy_independently_checks_receipt_and_payload(completed, monkeypatch):
    directory = Path(__file__).resolve().parents[2] / "pilot"
    monkeypatch.syspath_prepend(str(directory))
    spec = importlib.util.spec_from_file_location("demo_host_test", directory / "demo_host.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.verify_copy(completed.dest) == completed.receipt["receipt_sha256"]
    (completed.dest / "execution.json").write_text("corrupted")
    with pytest.raises(RuntimeError, match="payload checksum"):
        module.verify_copy(completed.dest)


def test_campaign_requires_prior_cleanup(completed, monkeypatch):
    pilot.save(completed.state / "demo-authorization.json", dict(readiness_sha256=completed.ready["receipt_sha256"]))
    campaign = pilot.campaign()
    monkeypatch.setattr(pilot, "campaign", lambda: SimpleNamespace(pilot_keys=[completed.key], experiments=campaign.experiments))
    with pytest.raises(ValueError, match="previous raw"):
        demo.authorize_submission(demo.ORDER[0], completed.ready)
    demo.backup_ack(completed.key, completed.receipt["receipt_sha256"])
    demo.cleanup(completed.key)
    demo.authorize_submission(demo.ORDER[0], completed.ready)


def test_no_automatic_pilot_resubmission(completed):
    demo.authorize_submission(completed.key, completed.ready)
    completed.row["state"] = "failed"
    with pytest.raises(ValueError, match="only the nine"):
        demo.authorize_submission(completed.key, completed.ready)


def test_full_assembly_rebuilds_without_any_raw_data(bundle, tmp_path, monkeypatch):
    from .demo_campaign import CampaignSpec
    from .explorer_contract import validate_release

    source, manifest = bundle
    state, release = tmp_path / "state", tmp_path / "published"
    state.mkdir()
    release.mkdir()
    shutil.copytree(source, release / "pilot")
    (release / "current").symlink_to("pilot", target_is_directory=True)
    shutil.copy2(source / "catalog.sqlite", state / "reference.sqlite")
    pilot.save(state / "serving.json", dict(source_sha256="8" * 64, image_ids={"tools": "sha256:" + "9" * 64}))
    ready = dict(campaign_sha256=manifest["campaign_sha256"], kb={"simData.cPickle": {"sha256": manifest["provenance"]["prepared_model_sha256"]}})
    monkeypatch.setattr(pilot, "verify", lambda: ready)
    monkeypatch.setattr(pilot, "STATE", state)
    monkeypatch.setattr(pilot, "RELEASE", release)
    monkeypatch.setattr(pilot, "campaign", lambda: CampaignSpec.model_validate(manifest["campaign"]))
    entries = {}
    for exp in manifest["experiments"]:
        target = release / "checkpoints" / exp["key"] / exp["shard"]
        target.parent.mkdir(parents=True)
        shutil.copy2(source / exp["shard"], target)
        entries[exp["key"]] = dict(key=exp["key"], experiment=exp, receipt_sha256=fingerprint(exp))
    monkeypatch.setattr(demo, "verified", lambda key: entries[key])
    monkeypatch.setattr(demo, "cleanup_state", lambda key: dict(state="raw_removed"))

    def validate_synthetic(path):
        # Explicit fixture opt-in stays separate from production validation.
        data = json.loads((path / "manifest.json").read_text())
        data["synthetic_fixture"] = True
        pilot.save(path / "manifest.json", data)
        return validate_release(path, allow_synthetic=True)

    monkeypatch.setattr(demo, "validate_release", validate_synthetic)
    result = demo.assemble()
    assert result["valid"]
    active = release / "current"
    full = json.loads((active / "manifest.json").read_text())
    assert full["scope"] == "full" and len(full["experiments"]) == 12
    assert not validate_release(active)["valid"]  # Synthetic opt-in was never weakened.
    assert validate_release(active, allow_synthetic=True)["valid"]
    assert demo.assemble()["directory"] == result["directory"]
    pilot.save(state / "serving.json", dict(source_sha256="6" * 64, image_ids={"tools": "sha256:" + "7" * 64}))
    assert demo.assemble()["directory"] == result["directory"]
    assert json.loads((active / "manifest.json").read_text())["provenance"]["exporter_source_sha256"] == "8" * 64
    for exp in full["experiments"]:
        assert file_sha256(active / exp["shard"]) == file_sha256(source / exp["shard"])


def test_controller_does_not_submit_next_job_if_cleanup_fails(tmp_path, monkeypatch):
    directory = Path(__file__).resolve().parents[2] / "pilot"
    monkeypatch.syspath_prepend(str(directory))
    spec = importlib.util.spec_from_file_location("demo_controller_test", directory / "demo_host.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.host, "STATE", tmp_path)
    monkeypatch.setattr(module.host, "config", lambda: {})
    monkeypatch.setattr(module.host, "verify_images", lambda value: None)
    monkeypatch.setattr(module.host, "compose", lambda *a, **k: None)
    monkeypatch.setattr(module.host, "inside", lambda *a, **k: None)
    monkeypatch.setattr(module.host, "observations", lambda **k: {})
    monkeypatch.setattr(module, "PILOT_KEYS", ())
    monkeypatch.setattr(module, "ORDER", ("wt-with-aa", "wt-acetate"))
    monkeypatch.setattr(module, "progress", lambda *a, **k: None)
    monkeypatch.setattr(module, "check_stop", lambda: None)
    monkeypatch.setattr(module, "wait_task", lambda *a: None)
    monkeypatch.setattr(module, "backup", lambda key: None)
    (tmp_path / "demo-authorization.json").write_text("{}")
    submitted = []

    def operation(command, *args):
        if command == "status":
            return {"jobs": [dict(key=k, execution="unrun") for k in module.ORDER]}
        if command == "submit":
            submitted.append(args[0])
            return dict(task_id="synthetic-task")
        raise AssertionError(command)

    def failure(key):
        raise RuntimeError("synthetic cleanup interruption")

    monkeypatch.setattr(module, "inside", operation)
    monkeypatch.setattr(module, "clean", failure)
    with pytest.raises(RuntimeError, match="cleanup interruption"):
        module.run_controller()
    assert submitted == ["wt-with-aa"]


def test_concurrent_preview_requests_validate_bundle_once(bundle, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    import time
    from . import preview

    root, _ = bundle
    monkeypatch.setattr(preview, "ROOT", root)
    monkeypatch.setattr(preview, "_cached", None)
    validations = []

    def validate(path, **kwargs):
        validations.append(path)
        time.sleep(0.03)  # Reproduce overlapping requests during a cold load.
        return dict(valid=True)

    monkeypatch.setattr(preview, "validate_release", validate)
    barrier = Barrier(8)

    def request(_):
        barrier.wait()
        return preview.bundle()

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(request, range(8)))
    assert len(validations) == 1
    assert all(result[1] is results[0][1] for result in results)


@pytest.mark.parametrize("occupied", [False, True])
def test_preview_recovers_exited_api_without_rejecting_own_web_port(monkeypatch, occupied):
    import io
    import urllib.request

    directory = Path(__file__).resolve().parents[2] / "pilot"
    monkeypatch.syspath_prepend(str(directory))
    spec = importlib.util.spec_from_file_location("demo_preview_recovery_test", directory / "demo_host.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls, bound = [], []

    def compose(*args, **kwargs):
        calls.append(args)
        return "preview-web\n" if "ps" in args else ""

    class Socket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def setsockopt(self, *args):
            pass

        def bind(self, address):
            bound.append(address)
            if occupied:
                raise OSError("synthetic external listener")

    class Response(io.BytesIO):
        status = 200

    monkeypatch.setattr(module.host, "compose", compose)
    monkeypatch.setattr(module.socket, "socket", Socket)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Response(b'{"read_only": true}'))
    if occupied:
        with pytest.raises(RuntimeError, match="port 8001 occupied"):
            module.ensure_preview()
        assert not any("up" in call for call in calls)
        return
    module.ensure_preview()
    assert bound == [("127.0.0.1", 8001)]
    assert calls[-1] == ("--profile", "preview", "up", "-d", "preview-api", "preview-web")
