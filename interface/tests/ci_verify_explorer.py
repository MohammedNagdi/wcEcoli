"""Verify a downloaded application candidate and retain only sanitized evidence."""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from ci_explorer_package import unpack


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "interface/frontend"
TESTS = Path(__file__).resolve().parent
API = "http://127.0.0.1:7860"
BASELINE_DATASET = "a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6"


def mint_repo_token(kind, repository):
    resource = {"Dataset": "datasets", "Space": "spaces"}[kind]
    try:
        url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
        separator = "&" if "?" in url else "?"
        request = urllib.request.Request(
            url + separator + urllib.parse.urlencode({"audience": "https://huggingface.co"}),
            headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            identity = json.load(response)["value"]
        request = urllib.request.Request(
            "https://huggingface.co/oauth/token",
            data=json.dumps({
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
                "subject_token": identity,
                "resource": resource + "/" + repository,
            }).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            credential = json.load(response)["access_token"]
        if not credential or any(c.isspace() for c in credential):
            raise ValueError("Invalid token")
    except (KeyError, OSError, ValueError, TypeError):
        raise RuntimeError(f"Hugging Face {kind} identity exchange failed") from None
    print("::add-mask::" + credential, flush=True)
    return credential


def mint_dataset_token(repository):
    return mint_repo_token("Dataset", repository)


def run(work, stage, command, env, *, cwd=ROOT):
    output = work / (stage + ".stdout")
    with output.open("w") as stdout, (work / (stage + ".stderr")).open("w") as stderr:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr)
    if result.returncode:
        raise RuntimeError(f"{stage} failed (exit {result.returncode})")
    return output.read_text()


def wait_for_explorer():
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(API + "/api/health", timeout=5) as response:
                health = json.load(response)
            if health == {"status": "ok", "read_only": True, "scope": "full", "synthetic": False}:
                return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError("Production explorer did not become healthy")


def verify(args, work):
    bundle = work / "bundle"
    try:
        receipt = unpack(args.archive, bundle, args.revision, args.sha256, args.fingerprint)
    except (OSError, ValueError, KeyError, TypeError):
        raise RuntimeError("Candidate archive verification failed") from None
    dataset = receipt["release"]["dataset"]
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("HF_", "COMPOSE_", "ACTIONS_ID_TOKEN_"))
    }
    project = "wcecoli-explorer-" + secrets.token_hex(6)
    env["EXPLORER_PREVIEW_PROJECT"] = project
    launcher = [str(ROOT / "platform.sh"), "explorer"]
    state = work / "preview"
    options = [
        "--state-dir", str(state),
        "--output-dir", str(work / "output"),
        "--cache-dir", str(work / "data"),
    ]
    if args.release is None:
        fetch_env = dict(env, HF_DATASET_READ_TOKEN=mint_dataset_token(dataset["repository"]))
        try:
            fetched = run(work, "pinned Dataset fetch", launcher + ["fetch-data", *options], fetch_env)
        finally:
            fetch_env.pop("HF_DATASET_READ_TOKEN", None)
        release = Path(json.loads(fetched)["release"])
    else:
        release = args.release.resolve()
    inputs = ["--bundle", str(bundle), "--release", str(release), *options]
    validated = json.loads(run(work, "strict release validation", launcher + ["verify", *inputs], env))
    if (
        not validated["valid"] or validated["source_sha256"] != args.fingerprint
        or validated["manifest_sha256"] != dataset["manifest_sha256"]
    ):
        raise RuntimeError("Strict verification did not match the candidate")

    compose = [
        "docker", "compose", "--project-name", project, "--project-directory", str(state),
        "--env-file", str(state / "empty.env"), "--file", str(state / "compose.json"),
    ]
    try:
        run(work, "production build and startup", launcher + ["up", *inputs, "-d", "--build"], env)
        wait_for_explorer()
        container = run(work, "locate production container", compose + ["ps", "-q", "web"], env).strip()
        details = json.loads(run(work, "inspect production container", ["docker", "inspect", container], env))[0]
        mounts = [m for m in details["Mounts"] if m["Destination"] == "/published"]
        if (
            len(mounts) != 1 or mounts[0]["RW"] or mounts[0]["Type"] != "bind"
            or not details["HostConfig"]["ReadonlyRootfs"]
            or details["HostConfig"]["Memory"] != 512 * 1024**2
        ):
            raise RuntimeError("Production preview isolation differs from the release contract")
        browser = json.loads(run(work, "production browser suite", [
            str(FRONTEND / "node_modules/.bin/playwright"), "test", "--forbid-only",
            "--config=playwright.explorer.config.ts", "--reporter=json",
        ], dict(env, EXPLORER_URL=API, EXPLORER_PROOFS=str(work / "browser")), cwd=FRONTEND))["stats"]
        if not browser["expected"] or any(browser[key] for key in ("unexpected", "flaky", "skipped")):
            raise RuntimeError("Production browser coverage did not fully pass")
        acceptance = json.loads(run(work, "reference and isolation checks", [
            sys.executable, str(TESTS / "check_explorer_acceptance.py"), "--api", API,
            "--release", str(release), "--out", str(work / "acceptance.json"),
        ], env))
        science = json.loads(run(work, "API to HDF5 comparisons", [
            sys.executable, str(TESTS / "check_full_demo_api.py"), "--api", API,
            "--release", str(release), "--out", str(work / "comparisons"),
        ], env))
        counts = (science["checks"], science["comparisons"])
        if not acceptance["passed"] or not science["passed"] or not all(counts):
            raise RuntimeError("Scientific or isolation checks did not fully pass")
        if dataset["revision"] == BASELINE_DATASET and counts != (48, 3948):
            raise RuntimeError("Unexpected comparison count for the pinned Dataset")
        memory = run(work, "check production memory", [
            "docker", "exec", container, "cat", "/sys/fs/cgroup/memory.events",
        ], env)
        events = dict(line.split() for line in memory.splitlines())
        if events["oom"] != "0" or events["oom_kill"] != "0":
            raise RuntimeError("Production explorer reported memory exhaustion")
    finally:
        if (state / "compose.json").exists():
            run(work, "remove production preview", compose + ["down", "--volumes"], env)

    run_id = os.environ.get("GITHUB_RUN_ID")
    return {
        "schema_version": "explorer-ci-verification-v1",
        "source_revision": args.revision,
        "source_sha256": args.fingerprint,
        "archive_sha256": args.sha256,
        "package_artifact_id": args.artifact_id,
        "workflow_run_id": run_id,
        "workflow_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "evidence_reference": (
            f"https://github.com/MohammedNagdi/wcEcoli/actions/runs/{run_id}"
            if run_id else "local production verification"
        ),
        "dataset_revision": dataset["revision"],
        "manifest_sha256": dataset["manifest_sha256"],
        "build_and_startup_passed": True,
        "strict_dataset_validation_passed": True,
        "isolation_passed": True,
        "browser_tests_passed": browser["expected"],
        "scientific_checks_passed": counts[0],
        "scientific_comparisons_passed": counts[1],
        "reference_metric_comparisons": acceptance["metric_comparisons"],
        "memory_limit_events": int(events["max"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--artifact-id")
    parser.add_argument("--release", type=Path, help="Use a verified local release for rehearsal")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Select a new verification output path")
    if os.environ.get("GITHUB_ACTIONS") == "true" and (
        args.release is not None or not (args.artifact_id or "").isdecimal()
    ):
        parser.error("GitHub verification requires a workflow artifact ID and pinned Dataset fetch")
    try:
        with tempfile.TemporaryDirectory(prefix="explorer-ci-") as temporary:
            report = verify(args, Path(temporary).resolve())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        # Job logs are public. Never include response bodies or runner data.
        print("Explorer verification failed: " + type(exc).__name__, file=sys.stderr)
        return 1
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
