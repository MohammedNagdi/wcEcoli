"""Explorer contracts use tiny synthetic bundles; live artifact acceptance is separate."""

import json
import sqlite3
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from hf_export.demo_campaign import file_sha256
from hf_export.explorer_contract import validate_release
from hf_export.test_explorer_contract import bundle, write_manifest  # noqa: F401


@pytest.fixture
def referenced(bundle):  # noqa: F811
    root, manifest = bundle
    with sqlite3.connect(root / "catalog.sqlite") as db:
        targets = {
            symbol: dict(index=index, rna_id="synthetic-" + symbol, genes=[symbol])
            for symbol, index in db.execute("SELECT symbol,ko_index FROM genes")
        }
        refs = dict(
            schema_version="explorer-references-v1",
            simulation_source_sha256=manifest["provenance"]["simulation_source_sha256"],
            prepared_model_sha256=manifest["provenance"]["prepared_model_sha256"],
            catalog_sha256=file_sha256(root / "catalog.sqlite"),
            mapping_sha256="a" * 64,
            gene_targets=targets,
            variants=[dict(name=row[0]) for row in db.execute("SELECT name FROM variants")],
            condition_catalog=dict(
                conditions=[
                    dict(condition=r[0]) for r in db.execute("SELECT name FROM conditions")
                ],
                media_recipes=[
                    dict(media_id=r[0]) for r in db.execute("SELECT media_id FROM media_recipes")
                ],
                timelines=[dict(timeline=r[0]) for r in db.execute("SELECT name FROM timelines")],
                tf_conditions=[dict(tf="synthetic")],
                media_stocks=[dict(name="synthetic")],
                environment_molecules=[dict(molecule_id="synthetic")],
            ),
            reactions=[],
            execution_settings={},
        )
    (root / "references.json").write_text(json.dumps(refs))
    manifest["references"] = dict(schema_version="explorer-references-v1", path="references.json")
    manifest["files"].append(dict(path="references.json", bytes=0, sha256="0" * 64))
    write_manifest(root, manifest)
    return root, manifest, refs


def test_optional_reference_contract_and_unchanged_science(referenced):
    root, manifest, refs = referenced
    before = {p.name: file_sha256(p) for p in root.glob("trajectories/*.h5")}
    assert validate_release(root, allow_synthetic=True)["valid"]
    refs["gene_targets"]["hisG"]["index"] += 1
    (root / "references.json").write_text(json.dumps(refs))
    write_manifest(root, manifest)
    report = validate_release(root, allow_synthetic=True)
    assert not report["valid"] and "mapping mismatch: hisG" in str(report["errors"])
    assert before == {p.name: file_sha256(p) for p in root.glob("trajectories/*.h5")}


def test_public_boundaries_and_actual_generation_metrics(referenced, monkeypatch):
    from hf_export import preview

    root, manifest, _ = referenced
    exp = manifest["experiments"][0]
    exp["execution_provenance"] = {
        "generation_clocks": [dict(generation=0, actual_initial_sec=0, actual_final_sec=3)]
    }
    write_manifest(root, manifest)
    before = {str(p): file_sha256(p) for p in root.rglob("*") if p.is_file()}
    monkeypatch.setattr(preview, "ROOT", root)
    monkeypatch.setattr(preview, "_cached", None)
    original = preview.validate_release
    monkeypatch.setattr(
        preview, "validate_release", lambda p, **kw: original(p, allow_synthetic=True, **kw)
    )
    with TestClient(preview.app) as client:
        assert client.get("/api/capabilities").json()["execution"] is False
        for route in [
            "/api/jobs",
            "/api/assistant",
            "/api/providers",
            "/api/train",
            "/api/debug/ingest",
            "/api/experiments",
        ]:
            for method in ["post", "put", "patch", "delete"]:
                assert client.request(method, route, json={}).status_code == 405
        for route in ["/api/assistant", "/api/train", "/api/debug", "/docs", "/openapi.json"]:
            assert client.get(route).status_code == 404
        records = client.get("/api/experiments").json()
        assert len(records) == 12 and records[0]["created_at"] == ""
        report = client.get("/api/explorer/comparison?ids=1&generation=0").json()
        metric = report["experiments"][0]["metrics"]
        assert metric["final_saved_mass_fg"] == 1 and metric["division_duration_sec"] == 3
        assert metric["independent_seeds"] == 1 and report["confidence_intervals"] is None
        missing = client.get("/api/explorer/comparison?ids=1&generation=3").json()
        assert missing["experiments"][0]["metrics"]["available"] is False
        ended = client.get("/api/explorer/comparison?ids=1&generation=1").json()
        assert ended["experiments"][0]["metrics"]["division_duration_sec"] is None
        assert client.get("/api/explorer/comparison?ids=999").status_code == 404
        assert (
            client.get("/api/jobs/1/molecules/metabolite/timeseries?ids=synthetic-A").status_code
            == 409
        )
        assert (
            client.get("/api/explorer/evidence?symbol=unmeasured").json()["classification"]
            == "unclassified"
        )
    assert before == {str(p): file_sha256(p) for p in root.rglob("*") if p.is_file()}


def test_runtime_import_has_no_application_startup():
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import hf_export.preview; assert 'app.main' not in sys.modules; "
            "assert 'app.database' not in sys.modules; assert 'app.services.sim_worker' not in sys.modules",
        ],
        check=True,
    )


def test_concurrent_reads_hold_slots_until_transmission_and_release_on_error():
    import asyncio
    from types import SimpleNamespace
    from hf_export.preview import BoundedReads

    async def exercise():
        active = peak = 0
        state = SimpleNamespace(read_gate=asyncio.Semaphore(2))

        async def response(scope, receive, send):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(0.01)
                if scope.get("fail"):
                    raise ValueError("disconnected test client")
                await send({"type": "http.response.body", "body": b"bounded"})
            finally:
                active -= 1

        async def send(_message):
            await asyncio.sleep(0.01)

        bounded = BoundedReads(response)
        scope = {"type": "http", "app": SimpleNamespace(state=state)}
        results = await asyncio.gather(
            *(bounded(dict(scope, fail=i == 2), None, send) for i in range(9)),
            return_exceptions=True,
        )
        assert peak == 2 and state.read_gate._value == 2
        assert sum(isinstance(r, ValueError) for r in results) == 1

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "field,value",
    [
        ("simulation_source_sha256", "f" * 64),
        ("prepared_model_sha256", "e" * 64),
        ("catalog_sha256", "d" * 64),
    ],
)
def test_reference_fingerprints_are_bound_to_publication(referenced, field, value):
    root, manifest, refs = referenced
    refs[field] = value
    (root / "references.json").write_text(json.dumps(refs))
    write_manifest(root, manifest)
    report = validate_release(root, allow_synthetic=True)
    assert not report["valid"] and "fingerprint mismatch" in str(report["errors"])


def test_decoded_prose_is_allowed_but_real_private_paths_are_rejected(referenced):
    root, manifest, refs = referenced
    refs["variants"][0]["docstring"] = "Modifies:\n\tmodel expression metadata"
    (root / "references.json").write_text(json.dumps(refs))
    write_manifest(root, manifest)
    assert validate_release(root, allow_synthetic=True)["valid"]
    refs["variants"][0]["docstring"] = "Private path: C:\\Users\\someone\\secret"
    (root / "references.json").write_text(json.dumps(refs))
    write_manifest(root, manifest)
    assert not validate_release(root, allow_synthetic=True)["valid"]
