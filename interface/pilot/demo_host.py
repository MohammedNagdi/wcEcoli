#!/usr/bin/env python3
"""Durable host campaign controller; local polling never invokes a model."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

import host

ORDER = ("wt-with-aa", "wt-acetate", "wt-no-oxygen", "hisG-with-aa", "trpA-basal",
         "trpA-with-aa", "pgi-basal", "pgi-acetate", "wt-cut-aa")
PILOT_KEYS = ("wt-basal", "hisG-basal", "wt-add-aa")
STOP = host.STATE / "demo-stop-requested"
CONTROLLER = host.STATE / "demo-controller.json"


def inside(*args):
    return json.loads(host.compose("exec", "-T", "tools", "python", "-m", "hf_export.demo_inside", *args, capture=True))


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def verify_copy(root):
    root = Path(root)
    if root.is_symlink() or any(p.is_symlink() for p in root.rglob("*")):
        raise RuntimeError("local checkpoint cannot contain symbolic links")
    receipt = json.loads((root / "receipt.json").read_text())
    identity = receipt.pop("receipt_sha256")
    expected = hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    if identity != expected:
        raise RuntimeError("local checkpoint receipt checksum differs")
    inventory = [dict(path=p.relative_to(root).as_posix(), bytes=p.stat().st_size, sha256=digest(p))
                 for p in sorted(root.rglob("*")) if p.is_file() and p.name != "receipt.json"]
    if inventory != receipt["files"]:
        raise RuntimeError("local checkpoint payload checksum/inventory differs")
    return identity


def backup(key):
    info = inside("checkpoint", key)
    target = host.STATE / "checkpoints" / key
    if not target.exists():
        temporary = target.with_name("." + key + ".copying")
        if temporary.exists():
            # A copy is non-authoritative until every byte verifies. Safely retry
            # this known host staging directory; never remove source artifacts.
            if temporary.is_symlink() or temporary.parent != host.STATE / "checkpoints":
                raise RuntimeError("unsafe backup staging path")
            shutil.rmtree(temporary)
        target.parent.mkdir(parents=True, exist_ok=True)
        host.compose("cp", f"tools:/release/checkpoints/{key}", str(temporary))
        if verify_copy(temporary) != info["receipt_sha256"]:
            raise RuntimeError("backup is not identical to verified source checkpoint")
        temporary.rename(target)
    checksum = verify_copy(target)
    if checksum != info["receipt_sha256"]:
        raise RuntimeError("retained local checkpoint differs from current checkpoint")
    inside("backup-ack", key, "--checksum", checksum)
    return checksum


def clean(key, *, dry_run=False):
    checksum = verify_copy(host.STATE / "checkpoints" / key)
    if not dry_run:
        inside("backup-ack", key, "--checksum", checksum)
    return inside("cleanup", key, *(["--dry-run"] if dry_run else []))


def progress(state, **fields):
    record = dict(state=state, pid=os.getpid(), at=time.time(), **fields)
    host.write(CONTROLLER, record)
    print(json.dumps(record, sort_keys=True), flush=True)


def check_stop():
    if STOP.exists():
        raise RuntimeError("operator requested stop; no further submissions or cleanup")


def wait_task(task_id, key):
    last_resource_check = 0.0
    while True:
        check_stop()
        task = json.loads(host.inside("task-status", task_id))
        if task["status"] in ("done", "failed", "cancelled"):
            result = json.loads(host.inside("finish", key))
            if task["status"] != "done" or result.get("unresolved"):
                raise RuntimeError("execution failure retained for diagnosis: " + key)
            return
        if time.monotonic() - last_resource_check >= 300:
            try:
                host.observations()
            except RuntimeError:
                host.inside("cancel", task_id)
                raise
            last_resource_check = time.monotonic()
        # Local-only completion checks; no model calls, log reads or user updates.
        time.sleep(15)


def prepare():
    if (host.STATE / 'demo-completion.json').exists():
        from explorer_host import prepare as prepare_explorer
        prepare_explorer()
        return
    host.verify_images(host.config())
    host.observations(start=True)
    # Reuse unchanged serving images on repeated prepare; never edit snapshots.
    names = [name for name, _ in host.source_files()]
    current = json.loads((host.STATE / "serving.json").read_text())
    if host.tree_hash(host.ROOT, names) != current["source_sha256"]:
        host.refresh_serving()
    host.compose("up", "-d", "runner", "tools")
    authorization = inside("prepare")
    host.write(host.STATE / "demo-authorization.json", authorization)
    for key in PILOT_KEYS:
        backup(key)
        print(json.dumps(clean(key)), flush=True)
    print("Demo ready. Existing Parca reused; pilot raw output verified and removed.", flush=True)


def run_controller():
    host.verify_images(host.config())
    host.compose("up", "-d", "runner", "tools")
    host.inside("verify")
    if not (host.STATE / "demo-authorization.json").exists():
        raise RuntimeError("run demo prepare first")
    for key in PILOT_KEYS + ORDER:
        check_stop()
        jobs = {j["key"]: j for j in inside("status")["jobs"]}
        job = jobs[key]
        if job["execution"] == "failed":
            raise RuntimeError("retained failed job requires diagnosis: " + key)
        if job["execution"] != "complete":
            if key in PILOT_KEYS:
                raise RuntimeError("pilot must already be completed")
            host.observations(start=True)
            progress("running", key=key)
            task = inside("submit", key)
            if not task.get("complete"):
                wait_task(task["task_id"], key)
        progress("verifying", key=key)
        backup(key)
        check_stop()
        result = clean(key)
        progress("experiment_complete", key=key, cleanup=result)
    check_stop()
    progress("packaging")
    result = inside("assemble")
    # Preserve one exact host upload bundle; share identical immutable shard bytes
    # with its already independently verified host checkpoint copy.
    dest = host.STATE / "demo-release"
    if not dest.exists():
        temporary = host.STATE / ".demo-release-copying"
        if temporary.exists():
            raise RuntimeError("partial local full-release copy retained for diagnosis")
        temporary.mkdir()
        host.compose("cp", "tools:/release/current/.", str(temporary))
        manifest = json.loads((temporary / "manifest.json").read_text())
        for item in manifest["files"]:
            path = temporary / item["path"]
            if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
                raise RuntimeError("local full-release copy differs")
            if item["path"].startswith("trajectories/"):
                key = Path(item["path"]).stem
                original = host.STATE / "checkpoints" / key / item["path"]
                if digest(original) != item["sha256"]:
                    raise RuntimeError("local checkpoint differs from full release")
                path.unlink()
                os.link(original, path)
        temporary.rename(dest)
    if digest(dest / "manifest.json") != result["manifest_sha256"]:
        raise RuntimeError("local full-release manifest differs from active verified release")
    for item in json.loads((dest / "manifest.json").read_text())["files"]:
        path = dest / item["path"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise RuntimeError("retained local full-release checksum differs")
    ensure_preview()
    resources = host.observations()
    host.write(host.STATE / "demo-completion.json", dict(release=result, resources=resources, status=inside("status")))
    progress("complete", release=result, preview="http://localhost:5175")


def running():
    if not CONTROLLER.exists():
        return False
    record = json.loads(CONTROLLER.read_text())
    if record["state"] in ("complete", "failed", "stopped"):
        return False
    process = subprocess.run(["ps", "-p", str(record["pid"]), "-o", "command="], capture_output=True, text=True)
    return process.returncode == 0 and "demo_host.py" in process.stdout and "--controller" in process.stdout


def launch():
    if (host.STATE / 'demo-completion.json').exists():
        # Completed seeds never re-enter execution or assembly after HF-06.
        host.verify_images(host.config())
        host.inside('verify')
        ensure_preview()
        print('Campaign already complete; serving the current validated publication. No jobs or Parca started.')
        return
    if running():
        print("Demo controller already running; no duplicate process started.")
        return
    if not (host.STATE / "demo-authorization.json").exists():
        raise RuntimeError("run demo prepare first")
    STOP.unlink(missing_ok=True)
    with (host.STATE / "demo-controller.log").open("a") as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "run", "--controller"],
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True, close_fds=True)
    host.write(CONTROLLER, dict(state="starting", pid=process.pid, at=time.time()))
    print(f"Durable demo controller started (PID {process.pid}). Log: {host.STATE / 'demo-controller.log'}")
    print("Local completion/resource guards run without model calls. Agent fallback checks: at least 30 minutes apart.")


def ensure_preview():
    listed = host.compose("--profile", "preview", "ps", "--status", "running", "--services", capture=True).splitlines()
    # Restart an exited API while our own web container still owns its port.
    # Only running services in this fixed isolated project may bypass binding.
    for service, port in (("preview-api", 8001), ("preview-web", 5175)):
        if service not in listed:
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    sock.bind(("127.0.0.1", port))
                except OSError as exc:
                    raise RuntimeError(f"preview port {port} occupied; no services changed") from exc
    host.compose("--profile", "preview", "up", "-d", "preview-api", "preview-web")
    import urllib.request

    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8001/api/health", timeout=30) as response:
                value = json.load(response)
            with urllib.request.urlopen("http://127.0.0.1:5175", timeout=2) as response:
                if value.get("read_only") and response.status == 200:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError("preview did not become healthy")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run", "status", "cleanup", "preview", "stop"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--key", choices=PILOT_KEYS + ORDER)
    parser.add_argument("--controller", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.dry_run and args.command != "cleanup" or args.key and args.command != "cleanup":
        parser.error("--dry-run and --key apply only to cleanup")
    if args.controller and args.command != "run":
        parser.error("internal controller flag applies only to run")
    host.STATE.mkdir(parents=True, exist_ok=True)
    if args.command == "status":
        print(json.dumps(dict(controller=json.loads(CONTROLLER.read_text()) if CONTROLLER.exists() else None,
                              controller_alive=running(), campaign=inside("status")), indent=2, sort_keys=True))
        return
    if args.command == "stop":
        STOP.touch()
        host.compose("--profile", "preview", "stop")
        return
    if args.command == "preview":
        host.verify_images(host.config())
        ensure_preview()
        return
    # Shared with pilot commands: prepare/cleanup and either controller cannot race.
    with (host.STATE / "host.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "prepare":
            prepare()
        elif args.command == "cleanup":
            jobs = inside("status")["jobs"]
            for job in jobs:
                if args.key and job["key"] != args.key:
                    continue
                if job["checkpoint"]:
                    print(json.dumps(clean(job["key"], dry_run=args.dry_run)), flush=True)
                elif args.key:
                    raise RuntimeError("no verified checkpoint; cleanup blocked")
        elif args.controller:
            try:
                run_controller()
            except Exception as exc:
                progress("stopped" if STOP.exists() else "failed", error=str(exc))
                raise
        else:
            launch()


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print("Demo stopped: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
