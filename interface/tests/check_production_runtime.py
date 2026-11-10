"""Production restart, routing, immutability, resource and import acceptance.

Only restarts the dedicated wcecoli-explorer container. Never changes the main
platform, preparation, scientific runner or HF-05/HF-06 publication records.
"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "interface/.explorer"
CONTAINER = "wcecoli-explorer-web-1"
API = "http://127.0.0.1:7860"


def docker(*args, stdin=None):
    return subprocess.run(["docker", *args], input=stdin, text=True, capture_output=True, check=True).stdout


def get(path):
    with urllib.request.urlopen(API + path, timeout=10) as response:
        return response.status, response.headers.get("Content-Type"), response.read()


def wait_ready():
    began = time.monotonic()
    while time.monotonic() - began < 1800:
        try:
            code, _, body = get("/api/health")
            if code == 200 and json.loads(body)["scope"] == "full":
                return time.monotonic() - began
        except (OSError, ValueError):
            pass
        time.sleep(1)  # Local readiness guard; no agent/model polling.
    raise AssertionError("Production startup did not become ready within 30 minutes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--restart", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    receipt = json.loads((STATE / "current.json").read_text())
    space = ROOT / receipt["bundle"] / "space"
    release = ROOT / receipt["bundle"] / "dataset/release"
    observed = json.loads(docker("inspect", CONTAINER))[0]
    assert observed["Config"]["Image"] == receipt["image"]
    assert observed["Config"]["User"] == "1000:1000"
    assert observed["HostConfig"]["ReadonlyRootfs"] and observed["HostConfig"]["Memory"] == 512 * 1024**2
    assert observed["HostConfig"]["NanoCpus"] == 2 * 10**9
    assert not any("docker.sock" in m["Destination"] for m in observed["Mounts"])
    assert all(not m["RW"] for m in observed["Mounts"] if m["Destination"] == "/published")
    report = dict(passed=False, image=receipt["image"], manifest_sha256=receipt["manifest_sha256"])
    report["initial_wait_seconds"] = wait_ready()
    if args.restart:
        started = time.monotonic()
        docker("stop", "--time", "25", CONTAINER)
        stopped = json.loads(docker("inspect", CONTAINER))[0]["State"]
        assert stopped["ExitCode"] == 0 and not stopped["OOMKilled"]
        report["graceful_stop_seconds"] = time.monotonic() - started
        started = time.monotonic()
        docker("start", CONTAINER)
        wait_ready()
        report["cold_restart_seconds"] = time.monotonic() - started
    before = time.monotonic()
    get("/api/health")
    report["warm_health_seconds"] = time.monotonic() - before
    for path in ("/", "/results/1", "/experiments/new", "/experiments/batch", "/environment-builder"):
        status, mime, _ = get(path)
        assert status == 200 and "text/html" in mime
    missing = []
    for path in ("/api/unknown", "/api/assistant", "/api/providers", "/api/debug", "/docs",
                 "/admin", "/openapi.json", "/assets/missing.js", "/previews/missing.webp"):
        try:
            get(path)
            raise AssertionError(path)
        except urllib.error.HTTPError as error:
            assert error.code == 404
            missing.append(path)
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        try:
            urllib.request.urlopen(urllib.request.Request(API + "/api/jobs", data=b"{}", method=method), timeout=10)
            raise AssertionError(method)
        except urllib.error.HTTPError as error:
            assert error.code == 405
    assets = sorted((space.parent / "space/frontend/public-explorer/previews").glob("*.webp"))
    for path in assets:
        _, mime, body = get("/previews/" + path.name)
        assert mime == "image/webp" and hashlib.sha256(body).hexdigest() == hashlib.sha256(path.read_bytes()).hexdigest()
    program = '''import importlib.metadata as md,json,os,sys
from pathlib import Path
import hf_export.production
blocked=['app.main','app.database','app.services.sim_worker','sqlmodel','sklearn','huggingface_hub']
assert not any(k in sys.modules for k in blocked)
assert not any(Path(p).exists() for p in ['/app/app','/app/models','/app/reconstruction','/app/node_modules','/var/run/docker.sock'])
assert b'HF_TOKEN=' not in Path('/proc/1/environ').read_bytes()
print(json.dumps(dict(uid=os.getuid(),pid1=Path('/proc/1/cmdline').read_text().replace(chr(0),' '),
 files=sorted(str(p.relative_to('/app')) for p in Path('/app').rglob('*') if p.is_file()),
 dependencies={p.metadata['Name']:p.version for p in md.distributions()},
 memory={k:Path('/sys/fs/cgroup/'+k).read_text().strip() for k in ['memory.current','memory.peak','memory.max','memory.events','memory.stat']})))'''
    runtime = json.loads(docker("exec", "-i", CONTAINER, "python", "-", stdin=program))
    events = dict(line.split() for line in runtime["memory"]["memory.events"].splitlines())
    assert events["oom"] == "0" and events["oom_kill"] == "0"
    assert int(runtime["memory"]["memory.peak"]) <= int(runtime["memory"]["memory.max"])
    assert runtime["uid"] == 1000 and "uvicorn" in runtime["pid1"]
    (args.out / "runtime-inventory.json").write_text(json.dumps(runtime, indent=2) + "\n")
    # Reuse the independently established main-platform/KB checks, writing new
    # evidence here instead of modifying any completed HF-06 proof.
    spec = importlib.util.spec_from_file_location("hf07_isolation", ROOT / "interface/tests/check_explorer_isolation.py")
    isolation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(isolation)
    isolation.PROOF = args.out
    shutil.copy2(ROOT / "interface/.pilot/proofs/hf06/rollback.json", args.out / "rollback.json")
    isolation.main()
    # Compare all original and packaged scientific payloads; no journals created.
    for path, item in receipt["dataset_inventory"].items():
        current = ROOT / receipt["bundle"] / "dataset" / path
        with current.open("rb") as stream:
            assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]
        if path.startswith("release/"):
            original = ROOT / "interface/.pilot/explorer-release" / Path(path).relative_to("release")
            with original.open("rb") as stream:
                assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]
    assert not [p for p in release.rglob("*") if p.name.endswith(("-wal", "-shm", "-journal"))]
    image = json.loads(docker("image", "inspect", receipt["image"]))[0]
    report.update(passed=True, architecture=image["Architecture"], image_id=image["Id"],
                  image_bytes=image["Size"], runtime_memory=runtime["memory"], missing_routes=missing,
                  immutable_release=True, main_and_preparation_unchanged=True,
                  host_free_bytes=shutil.disk_usage(ROOT).free)
    (args.out / "runtime.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "runtime_memory"}))


if __name__ == "__main__":
    main()
