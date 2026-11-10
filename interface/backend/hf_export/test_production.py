"""Production bootstrap/policy contracts. Tiny transport fixtures contain no science."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from hf_export import release_bootstrap as boot


@pytest.fixture
def transport(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "data.bin").write_bytes(b"synthetic transport fixture\x00")
    manifest = dict(scope="full", synthetic_fixture=False,
                    references=dict(path="references.json"), files=[dict(
                        path="data.bin", bytes=(source / "data.bin").stat().st_size,
                        sha256=boot.digest(source / "data.bin"))])
    (source / "manifest.json").write_text(json.dumps(manifest))
    env = dict(EXPLORER_DATA_MODE="hub", EXPLORER_CACHE=str(tmp_path / "cache"),
               EXPLORER_RELEASE=str(tmp_path / "active"), EXPLORER_DATASET_REPO="test/data",
               EXPLORER_DATASET_REVISION="a" * 40, HF_TOKEN="dummy-test-token",
               EXPLORER_MANIFEST_SHA256=boot.digest(source / "manifest.json"))
    calls = []

    def fetch(repo, revision, filename, destination, token, cache):
        calls.append((repo, revision, filename, token, str(cache)))
        shutil.copyfile(source / filename.removeprefix("release/"), destination)

    return source, env, calls, fetch


def test_pinned_download_atomic_activation_and_offline_cache(transport):
    source, env, calls, fetch = transport
    active = boot.prepare(env, fetch)
    assert active.is_symlink() and active.readlink().is_absolute()
    assert calls[0][2] == "release/manifest.json" and len(calls) == 2
    assert all(c[0] == "test/data" and c[1] == "a" * 40 for c in calls)
    assert boot.verify_payloads(active, env["EXPLORER_MANIFEST_SHA256"]) > 0
    cached = dict(env)
    cached.pop("HF_TOKEN")
    boot.prepare(cached, lambda *_: pytest.fail("offline matching cache must not use network"))
    assert not (active / ".cache").exists()
    (active / "data.bin").write_bytes(b"corrupt")
    with pytest.raises(boot.BootstrapError, match="checksum"):
        boot.prepare(env, fetch)
    assert len(calls) == 2


@pytest.mark.parametrize("change,message", [
    ({"EXPLORER_DATASET_REVISION": "main"}, "immutable"),
    ({"EXPLORER_DATASET_REVISION": ""}, "immutable"),
    ({"EXPLORER_DATASET_REPO": ""}, "owner/name"),
    ({"EXPLORER_DATASET_DIR": "../secret"}, "must be release"),
    ({"EXPLORER_DATA_MODE": "latest"}, "local or hub"),
    ({"EXPLORER_MANIFEST_SHA256": "bad"}, "SHA-256"),
    ({"HF_TOKEN": ""}, "HF_TOKEN"),
])
def test_configuration_errors_do_not_download(transport, change, message):
    _, env, calls, fetch = transport
    with pytest.raises(boot.BootstrapError, match=message):
        boot.prepare(dict(env, **change), fetch)
    assert not calls


def test_wrong_manifest_stops_before_payload_and_keeps_old_revision(transport):
    _, env, calls, fetch = transport
    active = boot.prepare(env, fetch)
    old = active.resolve()
    calls.clear()
    changed = dict(env, EXPLORER_DATASET_REVISION="b" * 40, EXPLORER_MANIFEST_SHA256="0" * 64)
    with pytest.raises(boot.BootstrapError, match="fingerprint"):
        boot.prepare(changed, fetch)
    assert active.resolve() == old and len(calls) == 1
    # A different requested revision cannot accidentally reuse the old revision.
    with pytest.raises(boot.BootstrapError, match="HF_TOKEN"):
        boot.prepare(dict(env, EXPLORER_DATASET_REVISION="b" * 40, HF_TOKEN=""), fetch)


def test_interrupted_download_is_not_active_and_empty_cache_recovers(transport):
    _, env, _, fetch = transport

    def interrupted(*args):
        if args[2] != "release/manifest.json":
            args[3].write_bytes(b"partial")
            raise boot.BootstrapError("interrupted")
        fetch(*args)

    with pytest.raises(boot.BootstrapError, match="interrupted"):
        boot.prepare(env, interrupted)
    assert not Path(env["EXPLORER_RELEASE"]).exists()
    assert not list(Path(env["EXPLORER_CACHE"]).glob(".download-*"))
    assert boot.prepare(env, fetch).is_symlink()


def test_storage_guard_and_deadline(transport, monkeypatch):
    _, env, calls, fetch = transport
    from collections import namedtuple
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(boot.shutil, "disk_usage", lambda *_: usage(100, 99, 1))
    with pytest.raises(boot.BootstrapError, match="storage"):
        boot.prepare(env, fetch)
    assert len(calls) == 1
    import time
    with pytest.raises(boot.BootstrapError, match="deadline"):
        with boot.deadline(0.01):
            time.sleep(0.1)


@pytest.mark.parametrize("path", ["../outside", "/absolute", "a/../b", "a\\b", "manifest.json", "./bad", ""])
def test_untrusted_paths_cannot_escape(transport, path):
    source, env, _, fetch = transport
    m = json.loads((source / "manifest.json").read_text())
    m["files"][0]["path"] = path
    (source / "manifest.json").write_text(json.dumps(m))
    env["EXPLORER_MANIFEST_SHA256"] = boot.digest(source / "manifest.json")
    with pytest.raises(boot.BootstrapError, match="inventory"):
        boot.prepare(env, fetch)


@pytest.mark.parametrize("change", [dict(scope="pilot"), dict(synthetic_fixture=True), dict(references=None)])
def test_production_cannot_opt_into_pilot_or_synthetic(transport, change):
    source, env, _, fetch = transport
    m = json.loads((source / "manifest.json").read_text())
    m.update(change)
    (source / "manifest.json").write_text(json.dumps(m))
    env["EXPLORER_MANIFEST_SHA256"] = boot.digest(source / "manifest.json")
    with pytest.raises(boot.BootstrapError, match="real full"):
        boot.prepare(env, fetch)


def test_local_mode_does_not_download_or_modify(transport):
    source, env, calls, fetch = transport
    before = sorted(source.iterdir())
    assert boot.prepare(dict(env, EXPLORER_DATA_MODE="local", EXPLORER_RELEASE=str(source)), fetch) == source
    assert not calls and before == sorted(source.iterdir())


def test_production_static_errors_and_import_closure(tmp_path):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html>test frontend</html>")
    (static / "assets/main.js").write_text("console.log('fixture')")
    (static / "previews").mkdir()
    (static / "previews/test.webp").write_bytes(b"transport fixture, not scientific data")
    program = '''
import sys
from fastapi.testclient import TestClient
from hf_export import production as p
assert p.preview.REQUIRE_FULL_RELEASE
assert not any(x in sys.modules for x in ['app.main','app.database','sqlmodel','huggingface_hub','sklearn'])
# Static routing is tested independently from structural science validation.
async def no_validation(app):
 import asyncio
 app.state.read_gate=asyncio.Semaphore(2)
 yield
from contextlib import asynccontextmanager
p.app.router.lifespan_context=asynccontextmanager(no_validation)
with TestClient(p.app) as c:
 for path in ['/','/results/1','/experiments/new','/experiments/batch','/environment-builder','/assistant','/ml']:
  assert c.get(path).status_code==200,path
 assert 'javascript' in c.get('/assets/main.js').headers['content-type']
 assert c.get('/previews/test.webp').headers['content-type']=='image/webp'
 for path in ['/api/unknown','/api','/docs','/admin','/openapi.json','/assets/missing.js','/previews/missing.webp','/missing.css']:
  assert c.get(path).status_code==404,path
 for path in ['/','/api/jobs','/api/assistant','/api/debug']:
  assert c.post(path,json={}).status_code==405,path
'''
    subprocess.run([sys.executable, "-c", program], check=True,
                   env={**os.environ, "EXPLORER_STATIC": str(static)})


def test_sdk_download_identity_retries_and_redacted_errors(tmp_path, monkeypatch):
    # Keep this test usable in the existing backend venv; no SDK dependency needed.
    from types import SimpleNamespace
    token = "dummy-private-token-do-not-log"
    def denied(**kwargs):
        assert kwargs["repo_type"] == "dataset" and kwargs["revision"] == "a" * 40
        assert kwargs["token"] == token
        error = RuntimeError(token)
        error.response = SimpleNamespace(status_code=403)
        raise error
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=denied))
    with pytest.raises(boot.BootstrapError, match="permission") as error:
        boot.fetch_hub("owner/data", "a" * 40, "release/a", tmp_path / "dest", token, tmp_path)
    assert token not in str(error.value)
    attempts = []
    def unavailable(**kwargs):
        attempts.append(1)
        raise RuntimeError(token)
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=unavailable))
    monkeypatch.setattr(boot.time, "sleep", lambda *_: None)
    with pytest.raises(boot.BootstrapError, match="bounded retries"):
        boot.fetch_hub("owner/data", "a" * 40, "release/a", tmp_path / "dest", token, tmp_path)
    assert len(attempts) == 3


def load_host():
    path = Path(__file__).resolve().parents[2] / "explorer/host.py"
    spec = importlib.util.spec_from_file_location("hf07_host", path)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    return host


def test_isolated_compose_and_secret_placeholder():
    host = load_host()
    r = dict(bundle="interface/.explorer/bundles/fixture", image="wcecoli-explorer:fixture", manifest_sha256="a" * 64)
    config = host.compose_config(r, dict(HF_TOKEN="dummy-secret", COMPOSE_PROJECT_NAME="interface"))
    assert config["name"] == "wcecoli-explorer"
    assert set(config["services"]) == {"web"}
    web = config["services"]["web"]
    assert web["mem_limit"] == "512m" and web["cpus"] == 2 and web["read_only"]
    assert web["ports"] == ["127.0.0.1:7860:7860"]
    assert web["volumes"][0]["read_only"]
    assert "dummy-secret" not in json.dumps(config) and "/var/run/docker.sock" not in json.dumps(config)
    assert web["environment"]["HF_TOKEN"] == "${HF_TOKEN:-}"


def test_launcher_paths_overrides_exit_code_and_argument_boundaries(tmp_path):
    host = load_host()
    root = tmp_path / "checkout with spaces"
    for name in ("platform.sh", "interface/platform.sh", "interface/explorer/release.sh"):
        dest = root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(host.ROOT / name, dest)
    state = root / "interface/.explorer"
    state.mkdir()
    (state / "current.json").write_text(json.dumps(dict(
        bundle="interface/.explorer/bundles/fixture", image="wcecoli-explorer:fixture", manifest_sha256="a" * 64)))
    (state / "compose.json").write_text("{}")
    (state / "empty.env").write_text("# no credentials\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    capture = tmp_path / "invocation.json"
    docker = bin_dir / "docker"
    docker.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                      'open(os.environ["CAPTURE"],"w").write(json.dumps(dict(argv=sys.argv[1:],env={k:v for k,v in os.environ.items() if k.startswith("COMPOSE_")})))\n'
                      'raise SystemExit(int(os.environ.get("EXIT_CODE","0")))\n')
    docker.chmod(0o755)
    env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"], CAPTURE=str(capture),
               COMPOSE_PROJECT_NAME="interface", COMPOSE_FILE="wrong.yml", HF_TOKEN="dummy-never-print")
    for script in ("platform.sh", "interface/platform.sh"):
        for cwd in (root, root / "interface", tmp_path):
            result = subprocess.run([str(root / script), "explorer", "logs", "--tail=5", "web"],
                                    cwd=cwd, env=env, capture_output=True, text=True)
            assert result.returncode == 0, result.stderr
            call = json.loads(capture.read_text())
            assert call["argv"][-3:] == ["logs", "--tail=5", "web"]
            assert call["argv"][1:3] == ["--project-name", "wcecoli-explorer"]
            assert not call["env"]
            assert "dummy-never-print" not in result.stdout + result.stderr + (state / "compose.json").read_text()
    result = subprocess.run([str(root / "platform.sh"), "explorer", "stop"], env=dict(env, EXIT_CODE="37"))
    assert result.returncode == 37
    custom = tmp_path / "external preview state"
    custom.mkdir()
    (custom / "compose.json").write_text("{}")
    (custom / "empty.env").write_text("# no credentials\n")
    result = subprocess.run([str(root / "platform.sh"), "explorer", "logs", "--state-dir", str(custom), "--tail=5", "web"], env=env, capture_output=True)
    assert result.returncode == 0
    call = json.loads(capture.read_text())
    assert call["argv"][-3:] == ["logs", "--tail=5", "web"]
    assert str(custom / "compose.json") in call["argv"]
    capture.unlink()
    for args in (["config"], ["up", "worker"], ["stop", "-v"], ["logs", "a b;$literal"], ["down", "-v"]):
        result = subprocess.run([str(root / "platform.sh"), "explorer", *args], env=env, capture_output=True)
        assert result.returncode == 2 and not capture.exists()


def test_source_allowlist_excludes_data_and_nonpublic_captures():
    host = load_host()
    names = set(host.inputs())
    assert not any(n.startswith(("app/", "models/", "reconstruction/", "frontend/public/")) for n in names)
    assert not any(".pilot/" in n or ".env" in n or "/e2e/" in n or "test_" in n for n in names)
    assert {n for n in names if n.endswith(".webp")} == {
        "frontend/public-explorer/previews/" + n for n in ("designer.webp", "designer-dark.webp", "results.webp", "results-dark.webp")}


def test_occupied_port_fails_before_compose_up(tmp_path, monkeypatch, capsys):
    host = load_host()
    monkeypatch.setattr(host, "STATE", tmp_path)
    monkeypatch.setattr(host, "bundle", lambda: dict(
        bundle="interface/.explorer/bundles/fixture", image="wcecoli-explorer:fixture", manifest_sha256="a" * 64))
    invoked = []
    def inspect_only(argv, **kwargs):
        invoked.append(argv)
        assert argv[-5:] == ["ps", "--status", "running", "--quiet", "web"]
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
    monkeypatch.setattr(host.subprocess, "run", inspect_only)
    class BusySocket:
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def bind(self, address):
            assert address == ("127.0.0.1", 7860)
            raise OSError("fixture busy port")
    monkeypatch.setattr(host.socket, "socket", BusySocket)
    monkeypatch.setattr(host.os, "execvpe", lambda *_: pytest.fail("occupied port must not start Compose"))
    assert host.main(["up", "-d"]) == 2
    assert len(invoked) == 1 and "occupied" in capsys.readouterr().err


def test_startup_scan_signal_cancels_and_restores_server_handler(monkeypatch):
    import asyncio
    import signal
    from hf_export import preview
    previous = signal.getsignal(signal.SIGTERM)
    monkeypatch.setattr(preview, "REQUIRE_FULL_RELEASE", True)
    with pytest.raises(asyncio.CancelledError, match="before readiness"):
        with preview.startup_signals():
            signal.raise_signal(signal.SIGTERM)
    assert signal.getsignal(signal.SIGTERM) == previous
