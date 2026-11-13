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
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ci_explorer_package import portable, unpack
from ci_verify_explorer import FRONTEND, mint_dataset_token, mint_repo_token, run


REPOSITORY = "MohammedNagdi/wcEcoli"
SPACE = "Safrot/wcecoli-explorer"
ORIGIN = "https://safrot-wcecoli-explorer.hf.space"
HUB = "https://huggingface.co"
EXPECTED_COUNTS = (48, 3948)
SOURCE_LIMIT = 100 * 1024**2


class ReleaseError(RuntimeError):
    pass


class HubReadError(ReleaseError):
    def __init__(self, label, error):
        self.status = getattr(getattr(error, "response", None), "status_code", None)
        self.transient = isinstance(error, (ConnectionError, TimeoutError)) or (
            type(self.status) is int and (self.status in {404, 409, 429} or 500 <= self.status <= 599)
        )
        detail = f"HTTP {self.status}" if type(self.status) is int else type(error).__name__
        super().__init__(f"Hugging Face {label} failed ({detail})")


class Regression(ReleaseError):
    """A failure attributable to a known deployed revision."""


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def hub_read(label, operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except Exception as exc:
        raise HubReadError(label, exc) from None


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
        f"Space credential did not have the expected repository write permission (HTTP {status})",
    )


def github_json(endpoint, env):
    request = Request(
        f"https://api.github.com/repos/{REPOSITORY}/{endpoint}",
        headers={"Authorization": "Bearer " + env["GH_TOKEN"],
                 "Accept": "application/vnd.github+json"},
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


class Hub:
    def __init__(self, space_token, dataset_token, descriptor, cache, *, settings_token=None):
        from huggingface_hub import HfApi

        self.api = HfApi(endpoint=HUB, token=space_token)
        self.dataset_api = HfApi(endpoint=HUB, token=dataset_token)
        self.descriptor = descriptor
        self.cache = cache
        self.settings_token = settings_token
        self.issued_at = time.monotonic()

    def settings(self):
        if time.monotonic() - self.issued_at >= 50 * 60:
            self.api.token = mint_repo_token("Space", SPACE)
            self.dataset_api.token = mint_dataset_token(self.descriptor["dataset"]["repository"])
            self.issued_at = time.monotonic()
        space = hub_read("Space repository metadata", self.api.repo_info, SPACE, repo_type="space")
        # The repository response includes runtime metadata. The separate
        # /runtime endpoint requires access the content reader does not have.
        runtime = space.runtime
        if runtime is None and self.settings_token:
            runtime = hub_read("Space runtime", self.api.get_space_runtime, SPACE)
        hardware_ok = (
            runtime.hardware == self.descriptor["space"]["hardware"]
            if runtime is not None else not self.settings_token
        )
        dataset = self.descriptor["dataset"]
        info = hub_read(
            "pinned Dataset repository metadata", self.dataset_api.repo_info,
            dataset["repository"], repo_type="dataset", revision=dataset["revision"]
        )
        require(
            space.visibility == self.descriptor["space"]["visibility"]
            and hardware_ok
            and info.private is True and info.sha == dataset["revision"],
            "Space visibility, hardware, or private Dataset pin differs",
        )
        # Repository content read access need not include Space configuration.
        # Read it after production approval, before any commit or rehearsal.
        if self.settings_token:
            self.check_variables(dataset)
        return space.sha, runtime

    def check_variables(self, dataset):
        expected = {
            "EXPLORER_DATA_MODE": "hub",
            "EXPLORER_DATASET_REPO": dataset["repository"],
            "EXPLORER_DATASET_REVISION": dataset["revision"],
            "EXPLORER_DATASET_DIR": dataset["directory"],
            "EXPLORER_MANIFEST_SHA256": dataset["manifest_sha256"],
            "EXPLORER_RELEASE": "/data/current",
            "EXPLORER_CACHE": "/data",
        }
        variables = hub_read(
            "Space runtime variables", self.api.get_space_variables, SPACE, token=self.settings_token,
        )
        require(
            all(getattr(variables.get(name), "value", None) == value for name, value in expected.items()),
            "Space runtime Dataset configuration differs",
        )

    def download(self, api, repo, kind, revision, name):
        from huggingface_hub import hf_hub_download

        return Path(hub_read(
            f"{kind} file download", hf_hub_download,
            repo, name, repo_type=kind, revision=revision, token=api.token,
            endpoint=HUB, cache_dir=self.cache,
        ))

    def inventory(self, revision):
        files = {}
        total = 0
        paths = hub_read("Space source inventory", self.api.list_repo_files,
                         SPACE, repo_type="space", revision=revision)
        for name in paths:
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

    def dataset_file(self, name):
        dataset = self.descriptor["dataset"]
        return self.download(
            self.dataset_api, dataset["repository"], "dataset", dataset["revision"],
            f"{dataset['directory']}/{name}",
        )

    def history(self, revision):
        return hub_read("Space commit history", self.api.list_repo_commits,
                        SPACE, repo_type="space", revision=revision, token=self.settings_token or self.api.token)

    def commit(self, parent, files, remove, title):
        from huggingface_hub import CommitOperationAdd, CommitOperationDelete

        operations = [
            CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path))
            for name, path in files.items()
        ] + [CommitOperationDelete(path_in_repo=name) for name in remove]
        return self.api.create_commit(
            SPACE, repo_type="space", revision="main", parent_commit=parent,
            operations=operations, commit_message=title, num_threads=1,
        ).oid

    def baseline_file(self, revision, name):
        return self.download(self.api, SPACE, "space", revision, name)


def confirmed_commit(hub, head, parent, title, expected):
    history = hub.history(head)
    require(
        len(history) >= 2 and history[0].commit_id == head
        and history[0].title == title and history[1].commit_id == parent
        and portable.fingerprint(hub.inventory(head)) == expected,
        "Hub history or resulting inventory differs from the approved operation",
    )
    return head


def guarded_commit(hub, parent, before, expected, files, remove, title, journal):
    require(
        hub.settings()[0] == parent and portable.fingerprint(hub.inventory(parent)) == before,
        "Space parent or inventory changed before the write",
    )
    journal("write_pending", operation=title, expected_parent=parent)
    try:
        committed = hub.commit(parent, files, remove, title)
    except Exception:
        # The Hub can finish a commit after the runner loses its HTTP response.
        # Only adopt a verified commit from this plan. Never retry the write blindly.
        committed = None
    last_read_error = None
    for delay in (0, 1, 2, 4, 8, 16):
        if delay:
            time.sleep(delay)
        try:
            head = hub.settings()[0]
            if head != parent:
                require(committed is None or head == committed, "Space moved after the write")
                return confirmed_commit(hub, head, parent, title, expected)
        except HubReadError as exc:
            if not exc.transient:
                raise
            last_read_error = exc
    detail = f" Last lookup: {last_read_error}." if last_read_error else ""
    raise ReleaseError(f"Commit confirmation unresolved. Review Space history before retrying.{detail}")


def wait_running(hub, revision):
    deadline = time.monotonic() + 40 * 60
    while time.monotonic() < deadline:
        head, runtime = hub.settings()
        require(head == revision, "Space head changed during hosted verification")
        stage = getattr(runtime.stage, "value", runtime.stage)
        deployed = runtime.raw.get("sha")
        if deployed == revision:
            if stage == "RUNNING":
                return
            if stage in {"BUILD_ERROR", "RUNTIME_ERROR"}:
                raise Regression("Hugging Face reported a failure for the deployed revision")
        require(stage not in {"PAUSED", "STOPPED"}, "Space is paused or stopped")
        time.sleep(20)
    raise ReleaseError("Could not confirm the deployed runtime revision before the deadline")


def hosted_contract(revision, manifest, reference_sha):
    status = request_status(f"{HUB}/spaces/{SPACE}/resolve/{revision}/README.md")
    require(status in {401, 403, 404}, "Anonymous source access could not be confirmed as denied")
    with urlopen(f"{ORIGIN}/api/health", timeout=20) as response:
        health = json.load(response)
    with urlopen(f"{ORIGIN}/api/capabilities", timeout=20) as response:
        capabilities = json.load(response)
    expected = {
        "schema_version": "explorer-capabilities-v1", "mode": "explorer", "read_only": True,
        "execution": False, "shared_persistence": False, "assistant": False, "training": False,
        "browser_drafts": True, "references_available": True,
        "campaign_sha256": manifest["campaign_sha256"], "reference_sha256": reference_sha,
        "model_sha256": manifest["provenance"]["prepared_model_sha256"],
        "source_sha256": manifest["provenance"]["simulation_source_sha256"],
        "molecular_views": ["mRNA", "protein", "reaction_flux", "exchange_flux"],
    }
    if health != {"status": "ok", "read_only": True, "scope": "full", "synthetic": False} or any(
        capabilities.get(key) != value for key, value in expected.items()
    ):
        raise Regression("Hosted health or capabilities differ from the verified Dataset")
    for path in ("/api/jobs", "/api/experiments", "/api/assistant"):
        # An empty body cannot specify a simulation or a valid shared write.
        status = request_status(ORIGIN + path, data=b"{}")
        if status != 405:
            if 200 <= status < 500 and status != 429:
                raise Regression("Hosted server did not reject a shared mutation as expected")
            raise ReleaseError("Hosted mutation check could not establish a result")


def hosted_acceptance(hub, revision, dataset, work):
    manifest_path = hub.dataset_file("manifest.json")
    require(portable.host.sha(manifest_path) == dataset["manifest_sha256"], "Dataset manifest digest differs")
    manifest = json.loads(manifest_path.read_text())
    reference_sha = next(record["sha256"] for record in manifest["files"] if record["path"] == "references.json")
    references = hub.dataset_file("references.json")
    require(portable.host.sha(references) == reference_sha, "Dataset references digest differs")
    wait_running(hub, revision)
    try:
        hosted_contract(revision, manifest, reference_sha)
    except Regression:
        # Confirm a deterministic application regression with the same running revision.
        wait_running(hub, revision)
        hosted_contract(revision, manifest, reference_sha)
    # Browser or network instability alone is not evidence for automatic rollback.
    env = {key: os.environ[key] for key in ("PATH", "HOME", "CI", "LANG") if key in os.environ}
    env.update(EXPLORER_HOSTED_REFERENCES=str(references), EXPLORER_HOSTED_OUTPUT=str(work / "browser"))
    run(work, "hosted-browser", ["npx", "--no-install", "playwright", "test", "-c",
        "playwright.staging.config.ts", "--reporter=json"], env, cwd=FRONTEND)
    report = json.loads((work / "hosted-browser.stdout").read_text())
    require(report["stats"]["expected"] == 3 and report["stats"]["skipped"] == 0,
            "Hosted browser coverage is incomplete")
    require(hub.settings()[0] == revision, "Space head changed during hosted browser checks")
    return 3


def deploy_release(hub, plan, digest, bundle, before, journal, accept, head_check):
    parent = plan["space_parent"]
    require(
        hub.settings()[0] == parent and portable.fingerprint(hub.inventory(parent)) == plan["before_sha256"],
        "Reviewed Space parent or inventory drifted",
    )
    if plan["no_update_required"]:
        count = accept(parent)
        require(
            hub.settings()[0] == parent and portable.fingerprint(hub.inventory(parent)) == plan["before_sha256"],
            "Space changed during rehearsal",
        )
        journal("rehearsal_passed", space_revision=parent, hosted_browser_checks=count)
        return

    # Verify the baseline is healthy before attributing any failure to the release.
    accept(parent)
    head_check()
    changes = plan["forward"]["add"] + plan["forward"]["replace"]
    forward = guarded_commit(
        hub, parent, plan["before_sha256"], plan["after_sha256"],
        {name: bundle / "space" / name for name in changes}, [],
        f"Explorer release {digest}", journal,
    )
    journal("forward_uploaded", forward_revision=forward)
    try:
        count = accept(forward)
    except Regression:
        require(hub.inventory(parent) == before, "Rollback baseline differs from the reviewed inventory")
        restored = {name: hub.baseline_file(parent, name) for name in plan["rollback"]["replace"]}
        require(
            all(portable.host.sha(path) == before[name]["sha256"] for name, path in restored.items()),
            "Rollback source bytes differ from the reviewed inventory",
        )
        rolled_back = guarded_commit(
            hub, forward, plan["after_sha256"], plan["before_sha256"], restored,
            plan["rollback"]["remove"], f"Explorer rollback {digest}", journal,
        )
        journal("rollback_uploaded", rollback_revision=rolled_back)
        count = accept(rolled_back)
        journal("rolled_back", space_revision=rolled_back, hosted_browser_checks=count)
        raise ReleaseError("The release failed acceptance and its rollback passed")
    require(portable.fingerprint(hub.inventory(forward)) == plan["after_sha256"],
            "Deployed Space inventory changed during acceptance")
    journal("accepted", space_revision=forward, hosted_browser_checks=count)


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
    print(f"- Plan SHA-256: `{digest}`")
    print(f"- Forward additions: {paths(plan['forward']['add'])}")
    print(f"- Forward replacements: {paths(plan['forward']['replace'])}")
    print(f"- Rollback replacements: {paths(plan['rollback']['replace'])}")
    print(f"- Rollback removals: {paths(plan['rollback']['remove'])}")
    if plan["run_attempt"] != "1":
        print("\nProduction is available on the first attempt of a new push to `platform`.")
    elif plan["mode"] == "rehearsal" or not plan["no_update_required"]:
        print("\nReview this plan, then select **Review deployments**, **explorer-production**, "
              "and **Approve and deploy**. The approval comment is optional.")


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


def deploy(args, env, context, work):
    require(context["run_attempt"] == "1", "Production requires the first attempt of a new platform push")
    identity, after = candidate(env, context, args.archive, args.report, work / "bundle")
    digest = env["PLAN_SHA256"]
    plan = json.loads(args.plan.read_text())
    require(
        hex_digest(digest) and portable.fingerprint(plan) == digest
        and all(plan.get(key) == value for key, value in identity.items()),
        "Release plan differs from the reviewed candidate",
    )
    plan_id = env["PLAN_ID"]
    require(plan_id.isdecimal() and plan_id not in {
        identity["package_artifact_id"], identity["verification_artifact_id"]
    }, "Invalid release plan artifact")
    require(
        plan["no_update_required"] == (context["mode"] == "rehearsal"),
        "Only a rehearsal or a reviewed application update can enter production",
    )
    def head_check():
        ref = github_json("git/ref/heads/platform", env)
        require(ref["object"]["sha"] == context["source_revision"],
                "Candidate is no longer the tip of platform")

    head_check()
    settings_token = env.get("HF_SPACE_SETTINGS_READ_TOKEN", "").strip()
    require(settings_token, "The explorer-production environment needs HF_SPACE_SETTINGS_READ_TOKEN")
    space_token = mint_repo_token("Space", SPACE)
    verify_space_scope(space_token, write=True)
    dataset_token = mint_dataset_token(identity["dataset"]["repository"])
    hub = Hub(
        space_token, dataset_token, portable.descriptor(), work / "hub", settings_token=settings_token,
    )
    parent = hub.settings()[0]
    require(parent == plan["space_parent"], "Space changed after the plan was approved")
    before = hub.inventory(parent)
    require(build_plan(identity, parent, before, after) == plan,
            "Reconstructed Space operations differ from the approved plan")

    receipt = {
        "schema_version": "explorer-ci-receipt-v1", **identity,
        "space_parent": parent, "plan_artifact_id": plan_id, "plan_sha256": digest, "events": [],
    }

    def journal(phase, **details):
        event = {"phase": phase, **details}
        receipt["events"].append(event)
        portable.save(args.receipt, receipt)
        print(json.dumps(event), flush=True)

    journal("approved")
    deploy_release(
        hub, plan, digest, work / "bundle", before, journal,
        lambda revision: hosted_acceptance(hub, revision, identity["dataset"], work),
        head_check,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, action in (("prepare", prepare), ("deploy", deploy)):
        command = commands.add_parser(name)
        command.set_defaults(action=action)
        for path in ("archive", "report", "plan"):
            command.add_argument(f"--{path}", required=True, type=Path)
        if name == "deploy":
            command.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        context = ci_context(os.environ)
        with tempfile.TemporaryDirectory(prefix="explorer-release-") as temporary:
            args.action(args, os.environ, context, Path(temporary))
    except ReleaseError as exc:
        sys.exit(str(exc))
    except Exception as exc:
        sys.exit(f"Explorer release {args.command} failed ({type(exc).__name__})")


if __name__ == "__main__":
    main()
