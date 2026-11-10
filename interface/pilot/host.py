#!/usr/bin/env python3
"""Host-only Docker orchestration. No container receives the Docker socket."""

from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "interface/.pilot"
PROJECT = "wcecoli-hf-demo-v1"
GIB = 1024**3
SETTINGS = dict(
    cpus=2,
    parca_cpus=2,
    concurrency=1,
    memory_bytes=4 * GIB,
    parca_seconds=5400,
    simulation_seconds=14400,
    drain_seconds=1800,
)


def call(args, *, capture=False, env=None):
    result = subprocess.run(
        args,
        text=True,
        check=True,
        env=env,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else None


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def source_files():
    names = call(
        ["git", "-C", str(ROOT), "ls-files", "-co", "--exclude-standard", "-z"],
        capture=True,
    )
    for name in sorted(set(names.split("\0"))):
        path = ROOT / name
        if not name or not path.is_file() or path.is_symlink():
            continue
        if any(
            part in {".pilot", "node_modules", ".venv", "__pycache__", ".git", "dist"}
            for part in path.relative_to(ROOT).parts
        ):
            continue
        if name.startswith(("out/", "output/", "cache/", "interface/backend/data/")):
            continue
        if path.name.startswith(".env") and not path.name.endswith(".example"):
            continue
        yield name, path


def tree_hash(directory, names):
    digest = hashlib.sha256()
    for name in sorted(names):
        path = directory / name
        digest.update(
            name.encode() + b"\0" + str(path.stat().st_mode & 0o777).encode() + b"\0"
        )
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def freeze():
    snapshot = STATE / "snapshot"
    if (STATE / "frozen.json").exists():
        frozen = json.loads((STATE / "frozen.json").read_text())
        if tree_hash(snapshot, frozen["files"]) != frozen["source_sha256"]:
            raise RuntimeError(
                "frozen inputs changed; readiness invalid. Preserve output and investigate."
            )
        return frozen
    names = []
    for name, path in source_files():
        dest = snapshot / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        names.append(name)
    frozen = dict(
        source_sha256=tree_hash(snapshot, names),
        files=names,
        settings=SETTINGS,
        frozen_at=time.time(),
    )
    write(STATE / "frozen.json", frozen)
    return frozen


def preparation_names(names):
    return [
        name
        for name in names
        if name.startswith(
            ("models/", "reconstruction/", "wholecell/", "runscripts/", "docker/")
        )
        or name
        in {
            "requirements.txt",
            "setup.py",
            "Makefile",
            "interface/pilot/Runner.Dockerfile",
        }
    ]


def refresh_source():
    old = config()
    verify_images(old)
    if (STATE / "readiness.json").exists():
        ready = json.loads((STATE / "readiness.json").read_text())
        inside("verify")
    else:
        # Recovery of a failed serving-only receipt refresh, before any jobs.
        # Recheck the retained original preparation against its verified receipt.
        origin = old.get("preparation_origin")
        if not origin:
            raise RuntimeError("finish initial preparation before source refresh")
        ready = json.loads(
            (
                STATE / "revisions" / origin["source_sha256"] / "readiness.json"
            ).read_text()
        )
        kb = json.loads(
            compose(
                "exec",
                "-T",
                "tools",
                "python",
                "-c",
                "import json; from hf_export.pilot_inside import prepared_fingerprints; print(json.dumps(prepared_fingerprints()))",
                capture=True,
            )
        )
        if kb != ready["kb"]:
            raise RuntimeError(
                "retained preparation differs from the original verified receipt"
            )
    status = json.loads(inside("status"))
    if status.get("jobs"):
        raise RuntimeError("source refresh is prohibited after any pilot submission")
    names = [name for name, _ in source_files()]
    old_names = preparation_names(old["files"])
    new_names = preparation_names(names)
    if old_names != new_names or tree_hash(STATE / "snapshot", old_names) != tree_hash(
        ROOT, new_names
    ):
        raise RuntimeError(
            "simulation/preparation inputs changed; KB reuse is prohibited"
        )
    archive = STATE / "revisions" / old["source_sha256"]
    if archive.exists():
        raise RuntimeError("revision archive already exists; inspect before refreshing")
    archive.mkdir(parents=True)
    for name in ("snapshot", "frozen.json", "inputs.json", "readiness.json"):
        if (STATE / name).exists():
            (STATE / name).rename(archive / name)
    current = freeze()
    current["preparation_origin"] = old.get("preparation_origin") or ready[
        "inputs"
    ].get(
        "preparation_origin",
        dict(
            source_sha256=old["source_sha256"],
            runner_image_id=old["image_ids"]["runner"],
            preparation_inputs_sha256=tree_hash(archive / "snapshot", old_names),
        ),
    )
    write(STATE / "frozen.json", current)


def config():
    frozen = json.loads((STATE / "frozen.json").read_text())
    if tree_hash(STATE / "snapshot", frozen["files"]) != frozen["source_sha256"]:
        raise RuntimeError("frozen source fingerprint changed")
    return frozen


def compose(*args, capture=False):
    frozen = config()
    env = {
        k: v for k, v in os.environ.items() if not k.startswith(("COMPOSE_", "PILOT_"))
    }
    images = dict(frozen["images"])
    if (STATE / "serving.json").exists():
        images.update(json.loads((STATE / "serving.json").read_text())["images"])
    env.update({f"PILOT_{k.upper()}_IMAGE": v for k, v in images.items()})
    return call(
        [
            "docker",
            "compose",
            "--project-name",
            PROJECT,
            "--project-directory",
            str(STATE / "snapshot/interface/pilot"),
            "-f",
            str(STATE / "snapshot/interface/pilot/compose.yaml"),
            *args,
        ],
        capture=capture,
        env=env,
    )


def inside(*args, capture=True):
    return compose(
        "exec",
        "-T",
        "tools",
        "python",
        "-m",
        "hf_export.pilot_inside",
        *args,
        capture=capture,
    )


def observations(start=False):
    info = json.loads(call(["docker", "info", "--format", "{{json .}}"], capture=True))
    stats = call(
        ["docker", "stats", "--no-stream", "--format", "{{json .}}"], capture=True
    )
    records = [json.loads(line) for line in stats.splitlines() if line]

    # Memory usage strings are converted conservatively; Docker stats is observation,
    # not a reservation guarantee. The runner's cgroup remains the hard ceiling.
    def memory(text):
        import re

        number, unit = re.fullmatch(r"([\d.]+)([A-Za-z]+)", text.strip()).groups()
        return (
            float(number)
            * {
                "B": 1,
                "KiB": 1024,
                "MiB": 1024**2,
                "GiB": GIB,
                "kB": 1000,
                "MB": 10**6,
                "GB": 10**9,
            }[unit]
        )

    used = sum(memory(row["MemUsage"].split("/")[0]) for row in records)
    base = call(
        ["docker", "image", "inspect", "wcecoli-sim:latest", "--format", "{{.Id}}"],
        capture=True,
    )
    free = int(
        call(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--entrypoint",
                "python",
                base,
                "-c",
                'import shutil; print(shutil.disk_usage("/").free)',
            ],
            capture=True,
        )
    )
    report = dict(
        at=time.time(),
        host_free_bytes=shutil.disk_usage(ROOT).free,
        docker_free_bytes=free,
        docker_memory_bytes=info["MemTotal"],
        docker_cpus=info["NCPU"],
        container_usage=records,
    )
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "resources.jsonl").open("a") as stream:
        stream.write(json.dumps(report, sort_keys=True) + "\n")
    limit = 25 * GIB if start else 15 * GIB
    if min(report["host_free_bytes"], free) < limit:
        raise RuntimeError(
            f"storage gate failed: host={report['host_free_bytes'] / GIB:.2f} GiB, "
            f"Docker={free / GIB:.2f} GiB; require {limit / GIB:.0f} GiB each"
        )
    pilot_running = any(row["Name"].startswith(PROJECT + "-runner") for row in records)
    if (
        start
        and not pilot_running
        and info["MemTotal"] - used < SETTINGS["memory_bytes"] + 512 * 1024**2
    ):
        raise RuntimeError(
            "insufficient observed Docker RAM for 4 GiB runner plus 512 MiB headroom"
        )
    return report


def wait_task(task_id, kind):
    while True:
        status = json.loads(inside("task-status", task_id))
        print(json.dumps(status), flush=True)
        if status["status"] in ("done", "failed", "cancelled"):
            if status["status"] != "done":
                if kind in ("wt-basal", "hisG-basal", "wt-add-aa"):
                    inside("finish", kind, capture=False)
                raise RuntimeError(
                    f"{kind} {status['status']}: inspect pilot status/logs; never biological termination"
                )
            return status
        try:
            observations()
        except RuntimeError:
            inside("cancel", task_id)
            raise
        time.sleep(300)


def prepare(refresh=False):
    observations(start=True)
    if refresh:
        refresh_source()
    frozen = freeze()
    suffix = frozen["source_sha256"][:16]
    if "images" not in frozen:
        images, ids = {}, {}
        for name, base, dockerfile in [
            ("runner", "wcecoli-sim:latest", "Runner.Dockerfile"),
            ("tools", "interface-api", "Tools.Dockerfile"),
        ]:
            image_id = call(
                ["docker", "image", "inspect", base, "--format", "{{.Id}}"],
                capture=True,
            )
            base_tag = f"{PROJECT}-base-{name}:{image_id[7:23]}"
            call(["docker", "tag", image_id, base_tag])
            tag = f"{PROJECT}-{name}:{suffix}"
            call(
                [
                    "docker",
                    "build",
                    "--build-arg",
                    "PILOT_BASE=" + base_tag,
                    "-t",
                    tag,
                    "-f",
                    str(STATE / "snapshot/interface/pilot" / dockerfile),
                    str(STATE / "snapshot"),
                ]
            )
            images[name] = tag
            ids[name] = call(
                ["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture=True
            )
        tag = f"{PROJECT}-web:{suffix}"
        call(
            [
                "docker",
                "build",
                "-t",
                tag,
                "-f",
                str(STATE / "snapshot/interface/pilot/Web.Dockerfile"),
                str(STATE / "snapshot"),
            ]
        )
        images["web"] = tag
        ids["web"] = call(
            ["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture=True
        )
        frozen.update(images=images, image_ids=ids)
        write(STATE / "frozen.json", frozen)
    verify_images(frozen)
    compose("up", "-d", "runner", "tools")
    write(STATE / "inputs.json", {k: v for k, v in frozen.items() if k != "files"})
    compose("cp", str(STATE / "inputs.json"), "tools:/pilot/inputs.next.json")
    inside("accept-inputs", capture=False)
    for _ in range(30):
        try:
            inside("health")
            break
        except subprocess.CalledProcessError:
            time.sleep(2)
    task = json.loads(inside("prepare-start"))
    if task.get("ready"):
        print(json.dumps(task))
        return
    if task.get("status") != "done":
        wait_task(task["task_id"], "Parca")
    inside("prepare-finish", capture=False)
    compose("cp", "tools:/pilot/readiness.json", str(STATE / "readiness.json"))


def refresh_serving():
    observations(start=True)
    frozen = config()
    verify_images(frozen)
    inside("verify")
    health = json.loads(inside("health"))
    status = json.loads(inside("status"))
    if (
        health["running"]
        or health["queued"]
        or any(
            job["state"] not in ("complete", "failed") for job in status.get("jobs", [])
        )
    ):
        raise RuntimeError(
            "serving refresh requires an idle runner and terminal jobs; execution continues unchanged"
        )
    names = [name for name, _ in source_files()]
    old_names = preparation_names(frozen["files"])
    if old_names != preparation_names(names) or tree_hash(
        STATE / "snapshot", old_names
    ) != tree_hash(ROOT, old_names):
        raise RuntimeError(
            "serving refresh cannot change any simulation/preparation input"
        )
    staging = STATE / "serving" / "staging"
    if staging.exists():
        raise RuntimeError("retained partial serving snapshot requires inspection")
    for name, path in source_files():
        dest = staging / "snapshot" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
    source_sha = tree_hash(staging / "snapshot", names)
    revision = STATE / "serving" / source_sha
    if revision.exists():
        raise RuntimeError(
            "serving revision already exists; inspect/reuse its recorded images"
        )
    staging.rename(revision)
    snapshot = revision / "snapshot"
    images, ids = {}, {}
    base_tag = f"{PROJECT}-serving-base:{frozen['image_ids']['tools'][7:23]}"
    call(["docker", "tag", frozen["image_ids"]["tools"], base_tag])
    for name, dockerfile in (("tools", "Tools.Dockerfile"), ("web", "Web.Dockerfile")):
        tag = f"{PROJECT}-{name}:{source_sha[:16]}"
        command = [
            "docker",
            "build",
            "-t",
            tag,
            "-f",
            str(snapshot / "interface/pilot" / dockerfile),
        ]
        if name == "tools":
            command += ["--build-arg", "PILOT_BASE=" + base_tag]
        call([*command, str(snapshot)])
        images[name] = tag
        ids[name] = call(
            ["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture=True
        )
    serving = dict(
        source_sha256=source_sha,
        files=names,
        images=images,
        image_ids=ids,
        execution_source_sha256=frozen["source_sha256"],
        runner_image_id=frozen["image_ids"]["runner"],
    )
    write(revision / "serving.json", serving)
    write(STATE / "serving.json", serving)
    compose("up", "-d", "tools")  # never replace/restart the frozen runner
    compose("cp", str(STATE / "serving.json"), "tools:/pilot/serving.json")
    inside("verify", capture=False)
    print("Serving-only images updated; frozen execution/model/receipt retained.")


def verify_images(frozen):
    configurations = [frozen]
    if (STATE / "serving.json").exists():
        serving = json.loads((STATE / "serving.json").read_text())
        snapshot = STATE / "serving" / serving["source_sha256"] / "snapshot"
        if tree_hash(snapshot, serving["files"]) != serving["source_sha256"]:
            raise RuntimeError("frozen serving source changed")
        configurations.append(serving)
    for configuration in configurations:
        for name, tag in configuration["images"].items():
            actual = call(
                ["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture=True
            )
            if actual != configuration["image_ids"][name]:
                raise RuntimeError("image identity changed: " + name)


def preview():
    for port in (8001, 5175):
        with socket.socket() as sock:
            # A stopped preview can leave client connections in TIME_WAIT.
            # Reuse that address while still refusing an active listener.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError as exc:
                raise RuntimeError(
                    f"preview port {port} occupied; no services changed"
                ) from exc
    compose("--profile", "preview", "up", "-d", "preview-api", "preview-web")
    import urllib.request

    for _ in range(60):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8001/api/health", timeout=2
            ) as response:
                health = json.load(response)
            with urllib.request.urlopen("http://127.0.0.1:5175", timeout=2) as response:
                if (
                    health.get("read_only")
                    and health.get("status") == "ok"
                    and response.status == 200
                ):
                    print(
                        "Read-only preview: http://localhost:5175 ; API: http://localhost:8001"
                    )
                    return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError(
        "preview did not become healthy; inspect pilot preview container logs"
    )


def run():
    verify_images(config())
    observations(start=True)
    compose("up", "-d", "runner", "tools")
    inside("verify", capture=False)
    for key in ("wt-basal", "hisG-basal", "wt-add-aa"):
        observations(start=True)
        task = json.loads(inside("submit", key))
        if not task.get("complete"):
            if task.get("status") != "done":
                wait_task(task["task_id"], key)
            inside("finish", key, capture=False)
        inside("export", capture=False)
        inside("validate", capture=False)
        if key == "wt-basal":
            proof = json.loads(inside("proof-status"))
            if not proof["passed"]:
                print(
                    "WT export validated. Start pilot preview and record real browser proof before further submissions."
                )
                return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["prepare", "run", "status", "preview", "stop"]
    )
    parser.add_argument(
        "--refresh-source",
        action="store_true",
        help="prepare only: new frozen serving revision, verified unchanged model inputs, no submitted jobs",
    )
    parser.add_argument(
        "--refresh-serving",
        action="store_true",
        help="prepare only: update export/preview images after execution, keeping the frozen runner and receipt",
    )
    args = parser.parse_args()
    if args.refresh_source and args.refresh_serving:
        parser.error("choose one refresh mode")
    if args.refresh_serving and args.command != "prepare":
        parser.error("--refresh-serving is only supported by prepare")
    if args.refresh_source and args.command != "prepare":
        parser.error("--refresh-source is only supported by prepare")
    STATE.mkdir(parents=True, exist_ok=True)
    # flock prevents concurrent host commands creating/restarting pilot execution.
    import fcntl

    with (STATE / "host.lock").open("a") as lock:
        if args.command in ("prepare", "run"):
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "prepare":
            if args.refresh_serving:
                refresh_serving()
            else:
                prepare(args.refresh_source)
        elif args.command == "run":
            run()
        elif args.command == "preview":
            verify_images(config())
            preview()
        elif args.command == "status":
            if not (STATE / "frozen.json").exists():
                print("Pilot not prepared; no jobs submitted.")
                return
            compose("ps")
            status = json.loads(inside("status"))
            # Keep the status command readable; complete raw-file inventories
            # remain in the database, manifest and verification records.
            for job in status.get("jobs", []):
                outcome = json.loads(job.pop("outcome_json", "") or "{}")
                job.pop("command_json", None)
                job["outcome"] = outcome.get("outcome")
                job["reason"] = outcome.get("reason", "")
                job["generations"] = [
                    t["generation"] for t in outcome.get("trajectories", [])
                ]
                job["raw_bytes"] = outcome.get("raw_bytes")
                job["duration_sec"] = outcome.get("metrics", {}).get("duration_sec")
            print(json.dumps(status, indent=2, sort_keys=True))
            print("Runner:", inside("health"))
            for job in status.get("jobs", []):
                try:
                    print("Task:", inside("task-status", job["task_id"]))
                except subprocess.CalledProcessError:
                    print(
                        "Task registry unavailable; retained outcome remains in the pilot database/output."
                    )
            resources = STATE / "resources.jsonl"
            if resources.exists() and resources.read_text().strip():
                observed = json.loads(resources.read_text().splitlines()[-1])
                print(
                    "Latest resource observation:", json.dumps(observed, sort_keys=True)
                )
        else:
            # Runner's existing shutdown drains for 1800s then cancels/kills its
            # own children. Compose allows 1830s; volumes and receipts persist.
            compose("--profile", "preview", "stop")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print("Pilot stopped: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
