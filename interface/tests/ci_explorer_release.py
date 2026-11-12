"""Review the exact verified package and operate only on the configured Space."""

import argparse
from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ci_explorer_package import portable, unpack
from ci_verify_explorer import mint_dataset_token, mint_repo_token


REPOSITORY = "MohammedNagdi/wcEcoli"
SPACE = "Safrot/wcecoli-explorer"
ORIGIN = "https://safrot-wcecoli-explorer.hf.space"
PRODUCTION = "explorer-production"
HUB = "https://huggingface.co"
EXPECTED_COUNTS = (48, 3948)
SOURCE_LIMIT = 100 * 1024**2


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def hex_digest(value, size=64):
    return isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{size}}}", value)


def ci_context(env):
    require(
        env["GITHUB_REPOSITORY"] == REPOSITORY
        and env["GITHUB_REF"] == "refs/heads/platform"
        and env["GITHUB_EVENT_NAME"] == "push"
        and hex_digest(env["GITHUB_SHA"], 40)
        and env["GITHUB_RUN_ID"].isdecimal()
        and env["GITHUB_RUN_ATTEMPT"].isdecimal(),
        "A platform push in the source repository is required",
    )
    require(env["RELEASE_MODE"] in {"rehearsal", "active"}, "Invalid release mode")
    require(
        env["PACKAGE_ATTEMPT"] == env["GITHUB_RUN_ATTEMPT"],
        "Rerun all jobs to prepare a package and verification from the same attempt",
    )
    return {
        "run_id": env["GITHUB_RUN_ID"],
        "run_attempt": env["GITHUB_RUN_ATTEMPT"],
        "source_revision": env["GITHUB_SHA"],
        "mode": env["RELEASE_MODE"],
    }


def candidate(env, context, archive, report, bundle):
    package_id = env["CANDIDATE_ID"]
    report_id = env["VERIFICATION_ID"]
    archive_sha = env["CANDIDATE_SHA256"]
    fingerprint = env["CANDIDATE_FINGERPRINT"]
    require(
        package_id.isdecimal() and report_id.isdecimal() and package_id != report_id
        and hex_digest(archive_sha) and hex_digest(fingerprint),
        "Invalid candidate artifact identity",
    )
    package = unpack(archive, bundle, context["source_revision"], archive_sha, fingerprint)
    release = package["release"]
    require(release["space"]["repository"] == SPACE, "Unexpected Space target")
    dataset = release["dataset"]
    evidence = json.loads(report.read_text())
    expected = {
        "schema_version": "explorer-ci-verification-v1",
        "source_revision": context["source_revision"],
        "workflow_run_id": context["run_id"],
        "workflow_run_attempt": context["run_attempt"],
        "package_artifact_id": package_id,
        "archive_sha256": archive_sha,
        "source_sha256": fingerprint,
        "dataset_revision": dataset["revision"],
        "manifest_sha256": dataset["manifest_sha256"],
        "build_and_startup_passed": True,
        "strict_dataset_validation_passed": True,
        "isolation_passed": True,
        "scientific_checks_passed": EXPECTED_COUNTS[0],
        "scientific_comparisons_passed": EXPECTED_COUNTS[1],
    }
    require(
        all(type(evidence.get(key)) is type(value) and evidence[key] == value
            for key, value in expected.items())
        and type(evidence.get("browser_tests_passed")) is int
        and evidence["browser_tests_passed"] > 0,
        "Scientific verification is incomplete or belongs to a different candidate",
    )
    identity = {
        **context, "package_artifact_id": package_id, "verification_artifact_id": report_id,
        "verification_sha256": hashlib.sha256(report.read_bytes()).hexdigest(),
        "archive_sha256": archive_sha, "package_fingerprint": fingerprint,
        "space": release["space"], "dataset": dataset,
    }
    return identity, package["space_inventory"]


def release_operations(before, after):
    require(set(before) <= set(after), "Forward release would delete Space source")
    additions = sorted(after.keys() - before.keys())
    replacements = sorted(name for name in before if before[name] != after[name])
    return {"add": additions, "replace": replacements}


def build_plan(identity, parent, before, after):
    require(hex_digest(parent, 40), "Invalid Space revision")
    # The Hub manages .gitattributes. Bind its existing content without writing it.
    target = dict(after)
    require(".gitattributes" not in target, "Unexpected managed .gitattributes")
    if ".gitattributes" in before:
        target[".gitattributes"] = before[".gitattributes"]
    forward = release_operations(before, target)
    changed = bool(forward["add"] or forward["replace"])
    require(identity["mode"] != "rehearsal" or not changed, "Rehearsal requires identical Space files")
    return {
        "schema_version": "explorer-ci-release-v1",
        **identity,
        "space_parent": parent,
        "before_sha256": portable.fingerprint(before),
        "after_sha256": portable.fingerprint(target),
        "forward": forward,
        "rollback": {"replace": forward["replace"], "remove": forward["add"]},
        "no_update_required": not changed,
    }


def request_status(url, token=None, *, data=None):
    headers = {"User-Agent": "wcEcoli-explorer-release"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, headers=headers, data=data)
    try:
        with urlopen(request, timeout=20) as response:
            return response.status
    except HTTPError as exc:
        return exc.code


def verify_space_scope(token, *, write):
    # This permission check obtains no content and does not change the Space.
    url = f"{HUB}/api/spaces/{SPACE}/xet-write-token/main"
    status = request_status(url, token)
    require(
        status == 200 if write else status in {401, 403},
        "Space credential did not have the expected repository write permission",
    )


class Hub:
    def __init__(self, space_token, dataset_token, descriptor, cache):
        from huggingface_hub import HfApi

        self.api = HfApi(endpoint=HUB, token=space_token)
        self.dataset_api = HfApi(endpoint=HUB, token=dataset_token)
        self.descriptor = descriptor
        self.cache = cache

    def settings(self):
        space = self.api.repo_info(SPACE, repo_type="space")
        runtime = self.api.get_space_runtime(SPACE)
        dataset = self.descriptor["dataset"]
        info = self.dataset_api.repo_info(
            dataset["repository"], repo_type="dataset", revision=dataset["revision"]
        )
        require(
            space.visibility == self.descriptor["space"]["visibility"]
            and runtime.hardware == self.descriptor["space"]["hardware"]
            and info.private is True and info.sha == dataset["revision"],
            "Space visibility, hardware, or private Dataset pin differs",
        )
        expected = {
            "EXPLORER_DATA_MODE": "hub",
            "EXPLORER_DATASET_REPO": dataset["repository"],
            "EXPLORER_DATASET_REVISION": dataset["revision"],
            "EXPLORER_DATASET_DIR": dataset["directory"],
            "EXPLORER_MANIFEST_SHA256": dataset["manifest_sha256"],
            "EXPLORER_RELEASE": "/data/current",
            "EXPLORER_CACHE": "/data",
        }
        variables = self.api.get_space_variables(SPACE)
        require(
            all(getattr(variables.get(name), "value", None) == value for name, value in expected.items()),
            "Space runtime Dataset configuration differs",
        )
        return space.sha, runtime

    def download(self, api, repo, kind, revision, name):
        from huggingface_hub import hf_hub_download

        return Path(hf_hub_download(
            repo, name, repo_type=kind, revision=revision, token=api.token,
            endpoint=HUB, cache_dir=self.cache,
        ))

    def inventory(self, revision):
        files = {}
        total = 0
        for name in self.api.list_repo_files(SPACE, repo_type="space", revision=revision):
            path = PurePosixPath(name)
            require(
                not path.is_absolute() and ".." not in path.parts and "\\" not in name
                and str(path) == name and name not in files,
                "Unsafe Space source path",
            )
            downloaded = self.download(self.api, SPACE, "space", revision, name)
            size = downloaded.stat().st_size
            total += size
            require(total <= SOURCE_LIMIT and len(files) < 2000, "Space inventory exceeds review limits")
            files[name] = {"bytes": size, "sha256": portable.host.sha(downloaded)}
        return files


def show_plan(plan, digest):
    def paths(names):
        return ", ".join(f"`{name}`" for name in names) or "None"

    status = "No update required" if plan["no_update_required"] else "Awaiting production review"
    print(f"### Explorer release plan — {status}\n")
    print(f"- Mode: `{plan['mode']}`")
    print(f"- Source commit: `{plan['source_revision']}`")
    print(f"- Package artifact: `{plan['package_artifact_id']}`")
    print(f"- Package fingerprint: `{plan['package_fingerprint']}`")
    print(f"- Verified report artifact: `{plan['verification_artifact_id']}`")
    print(f"- Space parent: `{plan['space_parent']}`")
    print(f"- Dataset revision: `{plan['dataset']['revision']}`")
    print(f"- Forward additions: {paths(plan['forward']['add'])}")
    print(f"- Forward replacements: {paths(plan['forward']['replace'])}")
    print(f"- Rollback replacements: {paths(plan['rollback']['replace'])}")
    print(f"- Rollback removals: {paths(plan['rollback']['remove'])}")
    if plan["mode"] == "rehearsal" or not plan["no_update_required"]:
        print(f"\nUse this exact GitHub approval comment: `{digest}`")


def prepare(args, env, context, work):
    identity, after = candidate(env, context, args.archive, args.report, work / "bundle")
    space_token = mint_repo_token("Space", SPACE)
    verify_space_scope(space_token, write=False)
    dataset_token = mint_dataset_token(identity["dataset"]["repository"])
    hub = Hub(space_token, dataset_token, portable.descriptor(), work / "hub")
    parent, _ = hub.settings()
    before = hub.inventory(parent)
    require(hub.settings()[0] == parent, "Space changed while preparing the release")
    plan = build_plan(identity, parent, before, after)
    digest = portable.fingerprint(plan)
    portable.save(args.plan, plan)
    pending = context["mode"] == "rehearsal" or not plan["no_update_required"]
    with Path(env["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"plan_sha256={digest}\nreview_required={str(pending).lower()}\n")
    with Path(env["GITHUB_STEP_SUMMARY"]).open("a") as summary, redirect_stdout(summary):
        show_plan(plan, digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_command = commands.add_parser("prepare")
    for name in ("archive", "report", "plan"):
        prepare_command.add_argument(f"--{name}", required=True, type=Path)
    args = parser.parse_args()
    try:
        context = ci_context(os.environ)
        with tempfile.TemporaryDirectory(prefix="explorer-release-") as temporary:
            prepare(args, os.environ, context, Path(temporary))
    except ReleaseError as exc:
        sys.exit(str(exc))
    except Exception as exc:
        sys.exit(f"Explorer release {args.command} failed ({type(exc).__name__})")


if __name__ == "__main__":
    main()
