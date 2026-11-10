"""Explicit private staging release. No remote writes until every gate passes."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

_spec = importlib.util.spec_from_file_location("hf08_package_host", Path(__file__).with_name("host.py"))
host = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(host)

ROOT = host.ROOT
STATE = ROOT / "interface/.publication"
DATASET = "Safrot/wcecoli-demo-v1"
SPACE = "Safrot/wcecoli-explorer"
ACCOUNT = "Safrot"


class ReleaseError(ValueError):
    pass


def save(name, value):
    STATE.mkdir(parents=True, exist_ok=True)
    dest = STATE / name
    temporary = dest.with_suffix(dest.suffix + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(dest)


def read(name, default=None):
    path = STATE / name
    return json.loads(path.read_text()) if path.exists() else default


@contextmanager
def locked():
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "release.lock").open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError("Another release command is active") from None
        yield


def package():
    receipt = json.loads((ROOT / "interface/.explorer/current.json").read_text())
    base = ROOT / receipt["bundle"]
    allowed = (ROOT / "interface/.explorer/bundles").resolve()
    if base.is_symlink() or base.resolve().parent != allowed:
        raise ReleaseError("Package must be a frozen explorer bundle")
    for area in ("space", "dataset"):
        folder = base / area
        if folder.is_symlink() or any(p.is_symlink() for p in folder.rglob("*")):
            raise ReleaseError("Upload packages cannot contain symlinks")
        if host.inventory(folder) != receipt[area + "_inventory"]:
            raise ReleaseError("Frozen package changed: " + area)
    if sum(f["bytes"] for f in receipt["dataset_inventory"].values()) > 10_000_000_000:
        raise ReleaseError("Dataset upload exceeds 10 GB")
    if host.sha(base / "dataset/release/manifest.json") != receipt["manifest_sha256"]:
        raise ReleaseError("Manifest fingerprint mismatch")
    return receipt, base


def strict_validate(directory):
    result = subprocess.run([sys.executable, "-m", "hf_export.explorer_contract", str(directory)],
        env={**os.environ, "PYTHONPATH": str(ROOT / "interface/backend")},
        capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise ReleaseError("Strict full-release validation failed; no upload authorized")
    report = json.loads(result.stdout)
    if not report["valid"]:
        raise ReleaseError("Strict full-release validation rejected the data")
    return report


def gates(receipt, base, preserve_runtime=False):
    errors = []
    permission = read("permission.json", {})
    if (permission.get("confirmed_by_user") is not True or not permission.get("scope")
            or not permission.get("confirmed_on") or not permission.get("evidence_reference")
            or permission.get("account") != ACCOUNT
            or permission.get("repositories") != [DATASET, SPACE]
            or permission.get("package_sha256") != receipt["source_sha256"]
            or not isinstance(permission.get("conditions"), list)):
        errors.append("Publication permission is pending or not bound to this package and hosting scope")
    approval = read("approval.json", {})
    if (approval.get("package_sha256") != receipt["source_sha256"]
            or approval.get("manifest_sha256") != receipt["manifest_sha256"]
            or approval.get("build_and_startup_passed") is not True
            or not approval.get("evidence_reference")):
        errors.append("Reviewed release build/startup approval is missing for this package")
    for area in ("space", "dataset"):
        for name in ("PUBLICATION.md", "README.md"):
            text = (base / area / name).read_text().lower()
            if any(s in text for s in ("permission remains pending", "permission has not been confirmed", "clarify the rights", "rights and distribution", "still require clarification")):
                errors.append("Publication-status documents still require rights clarification")
                break
    if not os.environ.get("HF_PUBLISH_TOKEN"):
        errors.append("Separate HF_PUBLISH_TOKEN deployment credential is not configured")
    runtime = os.environ.get("HF_DATASET_READ_TOKEN")
    if not preserve_runtime and (not runtime or runtime == os.environ.get("HF_PUBLISH_TOKEN")):
        errors.append("A distinct HF_DATASET_READ_TOKEN is required")
    return errors


def identity(api, require_write=False):
    person = api.whoami()
    role = person.get("auth", {}).get("accessToken", {}).get("role")
    if person.get("name") != ACCOUNT:
        raise ReleaseError("Authenticated account must be Safrot")
    if not person.get("isPro"):
        raise ReleaseError("Docker Space account eligibility requires review; no billing changes made")
    if require_write and role not in {"write", "fineGrained", "fine-grained"}:
        raise ReleaseError("Deployment credential lacks write access")
    return dict(account=ACCOUNT, pro=True, token_role=role)


def runtime_reader(dataset_only=False):
    from huggingface_hub import HfApi
    reader = HfApi(token=os.environ["HF_DATASET_READ_TOKEN"])
    person = reader.whoami()
    access = person.get("auth", {}).get("accessToken", {})
    fine = access.get("fineGrained", {})
    if (person.get("name") != ACCOUNT or access.get("role") not in {"fineGrained", "fine-grained"}
            or not fine):
        raise ReleaseError("Runtime credential must be fine-grained Dataset-only read access")
    reported_scopes = fine.get("scoped", [])
    # An entity with no granted permissions is not an additional access grant.
    # Retain the original counts for safe diagnostics, but validate only grants.
    scoped = [entry for entry in reported_scopes if entry.get("permissions")]
    global_permissions = set(fine.get("global", []))
    if dataset_only:
        # HF scope entities have their own IDs; their display name need not be
        # the owner/name repository path. Resolve the authoritative Dataset ID
        # instead of rejecting a correctly scoped token over its display name.
        target = reader.repo_info(DATASET, repo_type="dataset")
        if target.id != DATASET:
            raise ReleaseError("Selected Dataset identity could not be verified")
        selected_id = getattr(target, "_id", None)

        def matches(entry):
            entity = entry.get("entity", {})
            if entity.get("type") != "dataset":
                return False
            if entity.get("_id") is not None:
                return bool(selected_id and entity["_id"] == selected_id)
            return entity.get("name") == DATASET

        matched = [matches(entry) for entry in scoped]
        if global_permissions or not scoped or not all(matched):
            # Booleans/counts only: never dump whoami, token metadata or IDs.
            detail = dict(global_permissions_count=len(global_permissions),
                          scoped_resources_count=len(reported_scopes), active_scoped_resources_count=len(scoped),
                          scoped_permission_counts=[len(s.get("permissions", [])) for s in reported_scopes],
                          selected_dataset_matches=matched)
            save("runtime-scope-error.json", detail)
            raise ReleaseError("Runtime credential scope is not exclusively the selected Dataset. "
                               + json.dumps(detail) + ". Keep only Dataset-specific read access; do not recreate the Dataset.")
    permissions = global_permissions | {p for s in scoped for p in s.get("permissions", [])}
    if permissions != {"repo.content.read"}:
        raise ReleaseError("Runtime credential permissions require review; read-only Dataset scope was not verified")
    return reader


def create_owned(api, kind, repo, receipt):
    save(kind + "-upload.json", dict(package_sha256=receipt["source_sha256"], phase="creation_pending", repository=repo))
    api.create_repo(repo, repo_type=kind, private=True, exist_ok=False,
                    **(dict(space_sdk="docker", space_hardware="cpu-basic") if kind == "space" else {}))
    observed = info(api, kind, repo)
    if observed is None or not observed.private:
        raise ReleaseError("Created repository privacy could not be verified")
    with tempfile.TemporaryDirectory(prefix="created-metadata-", dir=STATE) as cache:
        baseline = remote_inventory(api, kind, repo, observed.sha, receipt[("space" if kind == "space" else "dataset") + "_inventory"], Path(cache))
    # Only a newly created Space may have a Hub-generated README. Record its
    # exact bytes before permitting replacement; subsequent external edits fail.
    if baseline and (kind != "space" or set(baseline) != {"README.md"}):
        raise ReleaseError("Unexpected initial repository files; review required")
    journal = dict(package_sha256=receipt["source_sha256"], phase="created", repository=repo, bootstrap_inventory=baseline)
    save(kind + "-upload.json", journal)
    return observed, journal


def info(api, kind, repo):
    try:
        return api.repo_info(repo, repo_type=kind)
    except Exception as exc:
        if getattr(getattr(exc, "response", None), "status_code", None) == 404:
            return None
        raise ReleaseError("Repository access could not be verified") from None


def remote_inventory(api, kind, repo, revision, expected, cache):
    from huggingface_hub import hf_hub_download
    names = set(api.list_repo_files(repo, repo_type=kind, revision=revision))
    if names - set(expected) - {".gitattributes"}:
        raise ReleaseError("Remote repository contains unexpected files; refusing overwrite")
    actual = {}
    for name in sorted(names & set(expected)):
        path = Path(hf_hub_download(repo, name, repo_type=kind, revision=revision,
                                   token=api.token, cache_dir=str(cache)))
        actual[name] = dict(bytes=path.stat().st_size, sha256=host.sha(path))
    return actual


def upload(api, kind, repo, receipt, base):
    """Missing files can resume; differing remote files require explicit review."""
    from huggingface_hub import CommitOperationAdd
    journal = read(kind + "-upload.json", {})
    if journal and journal.get("package_sha256") != receipt["source_sha256"]:
        raise ReleaseError("Existing upload state belongs to another package")
    observed = info(api, kind, repo)
    if observed is None:
        observed, journal = create_owned(api, kind, repo, receipt)
    elif not journal or journal.get("phase") == "creation_pending":
        raise ReleaseError("Repository already exists without established ownership receipt; review before adoption")
    if observed is None or not observed.private:
        raise ReleaseError("Repository must exist and remain private")
    area = "dataset" if kind == "dataset" else "space"
    expected = receipt[area + "_inventory"]
    with tempfile.TemporaryDirectory(prefix="remote-inventory-", dir=STATE) as cache:
        actual = remote_inventory(api, kind, repo, observed.sha, expected, Path(cache))
    bootstrap = journal.get("bootstrap_inventory", {})
    if any(value != expected[name] and value != bootstrap.get(name) for name, value in actual.items()):
        raise ReleaseError("Remote content differs from approved package; refusing overwrite")
    missing = {name for name in expected if actual.get(name) != expected[name]}
    if missing:
        api.create_commit(repo, repo_type=kind, parent_commit=observed.sha,
            operations=[CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(base / area / name)) for name in sorted(missing)],
            commit_message="Publish verified explorer " + receipt["source_sha256"][:20], num_threads=1)
    observed = info(api, kind, repo)
    with tempfile.TemporaryDirectory(prefix="verify-upload-", dir=STATE) as cache:
        if remote_inventory(api, kind, repo, observed.sha, expected, Path(cache)) != expected:
            raise ReleaseError("Remote upload inventory is incomplete")
    result = dict(package_sha256=receipt["source_sha256"], manifest_sha256=receipt["manifest_sha256"],
                  repository=repo, revision=observed.sha, phase="uploaded", inventory_verified=True)
    save(kind + "-upload.json", result)
    return result


def publish_dataset(api, receipt, base):
    uploaded = upload(api, "dataset", DATASET, receipt, base)
    from huggingface_hub import hf_hub_download
    reader = runtime_reader()
    if not reader.repo_info(DATASET, repo_type="dataset", revision=uploaded["revision"]).private:
        raise ReleaseError("Dataset privacy changed")
    with tempfile.TemporaryDirectory(prefix="dataset-verification-", dir=STATE) as tmp:
        stage = Path(tmp) / "release"
        stage.mkdir()
        for name in receipt["dataset_inventory"]:
            if not name.startswith("release/"):
                continue
            source = hf_hub_download(DATASET, name, repo_type="dataset", revision=uploaded["revision"],
                                     token=reader.token, cache_dir=str(Path(tmp) / "cache"))
            target = stage / name.removeprefix("release/")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        validation = strict_validate(stage)
    uploaded.update(phase="verified", runtime_read_verified=True, validation=validation)
    save("dataset.json", uploaded)
    return uploaded


def publish_space(api, receipt, base):
    dataset = read("dataset.json", {})
    if (dataset.get("phase") != "verified" or dataset.get("package_sha256") != receipt["source_sha256"]
            or dataset.get("manifest_sha256") != receipt["manifest_sha256"]
            or not re.fullmatch(r"[0-9a-f]{40}", dataset.get("revision", ""))):
        raise ReleaseError("Verified matching Dataset publication receipt is required")
    reader = runtime_reader(dataset_only=True)
    remote_dataset = reader.repo_info(DATASET, repo_type="dataset", revision=dataset["revision"])
    if not remote_dataset.private:
        raise ReleaseError("Dataset is no longer private")
    observed = info(api, "space", SPACE)
    if observed is None:
        if read("space-upload.json"):
            raise ReleaseError("Space disappeared after prior publication; review required")
        create_owned(api, "space", SPACE, receipt)
    elif (not observed.private or read("space-upload.json", {}).get("package_sha256") != receipt["source_sha256"]
          or read("space-upload.json", {}).get("phase") == "creation_pending"):
        raise ReleaseError("Unexpected existing Space or non-private visibility")
    # Verify repository ownership/content before changing any settings.
    observed = info(api, "space", SPACE)
    with tempfile.TemporaryDirectory(prefix="space-check-", dir=STATE) as cache:
        actual = remote_inventory(api, "space", SPACE, observed.sha, receipt["space_inventory"], Path(cache))
    bootstrap = read("space-upload.json", {}).get("bootstrap_inventory", {})
    if any(v != receipt["space_inventory"][k] and v != bootstrap.get(k) for k, v in actual.items()):
        raise ReleaseError("Unexpected Space content; settings were not changed")
    variables = dict(EXPLORER_DATA_MODE="hub", EXPLORER_RELEASE="/data/current", EXPLORER_CACHE="/data",
                     EXPLORER_DATASET_REPO=DATASET, EXPLORER_DATASET_REVISION=dataset["revision"],
                     EXPLORER_DATASET_DIR="release", EXPLORER_MANIFEST_SHA256=receipt["manifest_sha256"])
    settings = dict(package_sha256=receipt["source_sha256"], variables=variables,
                    credential_fingerprint=hashlib.sha256(os.environ["HF_DATASET_READ_TOKEN"].encode()).hexdigest())
    prior = read("space-settings.json")
    if prior and prior != settings:
        raise ReleaseError("Space settings or runtime credential changed; explicit review required")
    if prior:
        remote_variables = api.get_space_variables(SPACE)
        if any(getattr(remote_variables.get(k), "value", None) != v for k, v in variables.items()):
            raise ReleaseError("Remote settings differ from recorded deployment; refusing automatic overwrite")
    else:
        for key, value in variables.items():
            api.add_space_variable(SPACE, key, value)
        api.add_space_secret(SPACE, "HF_TOKEN", os.environ["HF_DATASET_READ_TOKEN"])
        save("space-settings.json", settings)
    uploaded = upload(api, "space", SPACE, receipt, base)
    return monitor_space(api, uploaded, variables)


def monitor_space(api, uploaded, variables):
    deadline = time.monotonic() + 45 * 60
    while time.monotonic() < deadline:
        runtime = api.get_space_runtime(SPACE)
        stage = getattr(runtime.stage, "value", runtime.stage)
        deployed_revision = getattr(runtime, "raw", {}).get("sha")
        save("space.json", dict(uploaded, runtime_stage=stage, deployed_revision=deployed_revision,
                                variables=variables, phase="awaiting_acceptance"))
        if stage == "RUNNING" and (not uploaded.get("revision") or deployed_revision == uploaded["revision"]):
            return dict(uploaded, runtime_stage=stage, phase="awaiting_hosted_acceptance")
        if stage in {"BUILD_ERROR", "RUNTIME_ERROR", "PAUSED", "STOPPED"}:
            raise ReleaseError("Space requires diagnosis; inspect sanitized build/runtime logs")
        time.sleep(60)
    raise ReleaseError("Space readiness deadline exceeded; no automatic redeploy or upgrade")


def update_space(api, receipt, base):
    """Apply a reviewed forward update to the existing Protected Space."""
    return _update_space(api, receipt, base, read("space-update.json", {}))


def _update_space(api, receipt, base, plan, *, rollback=False):
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete
    if plan.get("package_sha256") != receipt["source_sha256"] or plan.get("approved_by_user") is not True:
        raise ReleaseError("A reviewed Space update bound to this package is required")
    prior_path = ROOT / plan.get("baseline_bundle", "")
    if prior_path.resolve().parent != (ROOT / "interface/.explorer/bundles").resolve():
        raise ReleaseError("Update baseline must be a retained frozen bundle")
    baseline = json.loads((prior_path / "evidence/package.json").read_text())
    if baseline["source_sha256"] != plan.get("baseline_package_sha256"):
        raise ReleaseError("Update baseline fingerprint mismatch")
    # Updates cannot silently change publication data, configuration or secrets.
    if baseline["dataset_inventory"] != receipt["dataset_inventory"]:
        raise ReleaseError("Space-only update cannot change any Dataset file")
    before, after = baseline["space_inventory"], receipt["space_inventory"]
    changed = {name for name in after if before.get(name) != after[name]}
    # A reviewed guide may introduce frontend modules. Permit exactly those
    # approved additions as well as replacements, but never remote deletions.
    removed = set(before) - set(after)
    if (changed != set(plan.get("allowed_files", [])) or not (changed or removed)
            or (removed and not rollback)
            or (rollback and removed != set(plan.get("allowed_deletions", [])))):
        raise ReleaseError("Space changes differ from the exact approved file list")
    dataset = read("dataset.json", {})
    if (dataset.get("phase") != "verified" or dataset.get("revision") != plan.get("dataset_revision")
            or dataset.get("manifest_sha256") != receipt["manifest_sha256"]):
        raise ReleaseError("Verified unchanged Dataset receipt required")
    remote_dataset = info(api, "dataset", DATASET)
    if remote_dataset is None or not remote_dataset.private or remote_dataset.sha != dataset["revision"]:
        raise ReleaseError("Dataset revision or privacy changed; update stopped")
    settings = read("space-settings.json", {})
    variables = settings.get("variables", {})
    remote_variables = api.get_space_variables(SPACE)
    if (variables.get("EXPLORER_DATASET_REVISION") != dataset["revision"]
            or variables.get("EXPLORER_MANIFEST_SHA256") != receipt["manifest_sha256"]
            or any(getattr(remote_variables.get(k), "value", None) != v for k, v in variables.items())):
        raise ReleaseError("Hosted configuration differs; no settings were changed")
    observed = info(api, "space", SPACE)
    if observed is None or getattr(observed, "visibility", None) != "protected":
        raise ReleaseError("Existing Space visibility must remain Protected")
    if api.get_space_runtime(SPACE).hardware != "cpu-basic":
        raise ReleaseError("Existing Space hardware differs from CPU Basic")
    with tempfile.TemporaryDirectory(prefix="update-check-", dir=STATE) as cache:
        actual = remote_inventory(api, "space", SPACE, observed.sha, {**before, **after}, Path(cache))
    if actual != after:
        if actual != before or observed.sha != plan.get("baseline_revision"):
            raise ReleaseError("Space changed since update approval; refusing overwrite")
        plan["phase"] = "commit_pending"
        save("space-rollback.json" if rollback else "space-update.json", plan)
        committed = api.create_commit(SPACE, repo_type="space", parent_commit=observed.sha,
            operations=([CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(base / "space" / name)) for name in sorted(changed)]
                        + [CommitOperationDelete(path_in_repo=name) for name in sorted(removed)]),
            commit_message="Roll back reviewed explorer update" if rollback else "Apply reviewed explorer update", num_threads=1)
        revision = committed.oid
    else:
        # Resume after a completed commit; exact complete inventory prevents a
        # retry from creating another revision or adopting unexpected content.
        revision = observed.sha
    with tempfile.TemporaryDirectory(prefix="verify-update-", dir=STATE) as cache:
        if remote_inventory(api, "space", SPACE, revision, after, Path(cache)) != after:
            raise ReleaseError("Updated Space inventory verification failed")
    uploaded = dict(repository=SPACE, revision=revision, package_sha256=receipt["source_sha256"],
                    manifest_sha256=receipt["manifest_sha256"], phase="uploaded", inventory_verified=True)
    save("space-upload.json", uploaded)
    save("space-settings.json", dict(settings, package_sha256=receipt["source_sha256"]))
    plan.update(phase="uploaded", revision=revision)
    save("space-rollback.json" if rollback else "space-update.json", plan)
    return monitor_space(api, uploaded, variables)


def rollback_space(api, receipt, base):
    """Reverse only this reviewed release, retaining full inventory/parent guards."""
    forward = read("space-update.json", {})
    rollback = read("space-rollback.json", {})
    uploaded = read("space-upload.json", {})
    if (forward.get("package_sha256") != receipt["source_sha256"]
            or forward.get("approved_by_user") is not True
            or rollback.get("approved_by_user") is not True
            or rollback.get("forward_package_sha256") != receipt["source_sha256"]
            or forward.get("phase") != "uploaded"
            or not re.fullmatch(r"[0-9a-f]{40}", forward.get("revision", ""))):
        raise ReleaseError("Reviewed completed forward release and bound rollback approval required")
    target = ROOT / forward.get("baseline_bundle", "")
    if target.resolve().parent != (ROOT / "interface/.explorer/bundles").resolve():
        raise ReleaseError("Rollback target must be the retained forward baseline")
    if target.is_symlink() or any(p.is_symlink() for p in target.rglob("*")):
        raise ReleaseError("Rollback packages cannot contain symlinks")
    baseline = json.loads((target / "evidence/package.json").read_text())
    if baseline["source_sha256"] != forward.get("baseline_package_sha256"):
        raise ReleaseError("Rollback target fingerprint mismatch")
    for area in ("space", "dataset"):
        if host.inventory(target / area) != baseline[area + "_inventory"]:
            raise ReleaseError("Rollback target inventory changed")
    before, after = receipt["space_inventory"], baseline["space_inventory"]
    added = set(before) - set(after)
    changed = {name for name in after if before.get(name) != after[name]}
    if (set(rollback.get("allowed_deletions", [])) != added
            or set(rollback.get("allowed_files", [])) != changed
            or rollback.get("package_sha256") != baseline["source_sha256"]):
        raise ReleaseError("Rollback operations differ from the exact reviewed inverse")
    prior_rollback_revision = rollback.get("revision") if rollback.get("phase") == "uploaded" else None
    if uploaded.get("revision") not in {forward["revision"], prior_rollback_revision}:
        raise ReleaseError("Current publication receipt is not the reviewed forward release")
    plan = dict(rollback, baseline_bundle=str(base.relative_to(ROOT)),
                baseline_package_sha256=receipt["source_sha256"],
                baseline_revision=forward["revision"], dataset_revision=forward["dataset_revision"])
    return _update_space(api, baseline, target, plan, rollback=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "dataset", "space", "update-space", "rollback-space", "status"])
    args = parser.parse_args(argv)
    phase = "local release lock"
    try:
        with locked():
            if args.command == "status":
                space = read("space.json", {})
                acceptance = read("proofs/hosted-acceptance.json", {})
                verified = (space.get("phase") == "verified" and acceptance.get("complete") is True
                            and acceptance.get("space", {}).get("revision") == space.get("revision")
                            and acceptance.get("space", {}).get("package_sha256") == space.get("package_sha256"))
                update = read("space-update.json", {})
                update_pending = bool(update and update.get("package_sha256") != space.get("package_sha256"))
                result = dict(observations="last recorded; no background polling by status",
                              stage="reviewed Space update pending deployment" if update_pending else "private staging verified; HF-09 ready" if verified else "publication incomplete until acceptance passes",
                              check=read("check.json"), dataset=read("dataset.json"), space=space,
                              update=update, last_error=read("last-error.json"))
            else:
                phase = "local package verification"
                receipt, base = package()
                phase = "local publication gates"
                blockers = gates(receipt, base, preserve_runtime=args.command in {"update-space", "rollback-space"})
                if args.command in {"dataset", "space", "update-space", "rollback-space"} and blockers:
                    raise ReleaseError("; ".join(blockers))
                from huggingface_hub import HfApi
                phase = "Hugging Face account authentication"
                api = HfApi(token=os.environ.get("HF_PUBLISH_TOKEN") or None)
                account = identity(api, require_write=args.command != "check")
                if args.command == "check":
                    if account["token_role"] not in {"write", "fineGrained", "fine-grained"}:
                        blockers.append("Configured authentication is read-only; deployment requires separate write access")
                    phase = "strict local dataset validation"
                    validation = strict_validate(base / "dataset/release")
                    phase = "Hugging Face repository access checks"
                    repos = {}
                    for kind, repo in (("dataset", DATASET), ("space", SPACE)):
                        remote = info(api, kind, repo)
                        repos[kind] = dict(repository=repo, exists=remote is not None,
                                           private=remote.private if remote else None,
                                           visibility=getattr(remote, "visibility", None) if remote else None)
                    phase = "local Git provenance"
                    git_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
                    dirty = bool(subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
                    result = dict(local_valid=True, ready_to_publish=not blockers, blockers=blockers, account=account,
                                  package_sha256=receipt["source_sha256"], bundle=receipt["bundle"],
                                  manifest_sha256=receipt["manifest_sha256"], validation=validation,
                                  repositories=repos, git_head=git_head, working_tree_dirty=dirty,
                                  source_provenance="frozen package fingerprint, not Git HEAD alone")
                    phase = "saving local check receipt"
                    save("check.json", result)
                elif args.command == "dataset":
                    phase = "Dataset validation and publication"
                    strict_validate(base / "dataset/release")
                    runtime_reader()  # Never start upload with an unverified credential scope.
                    result = publish_dataset(api, receipt, base)
                elif args.command == "rollback-space":
                    phase = "reviewed Space rollback"
                    result = rollback_space(api, receipt, base)
                elif args.command == "update-space":
                    phase = "reviewed Space-only update"
                    result = update_space(api, receipt, base)
                else:
                    phase = "Space validation and publication"
                    strict_validate(base / "dataset/release")
                    result = publish_space(api, receipt, base)
            if args.command != "status":
                save("last-error.json", None)
            print(json.dumps(result, indent=2))
            return 0
    except ReleaseError as exc:
        print("Publication blocked: " + str(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        # Only fixed phases, exception class and numeric HTTP status are exposed.
        # Never serialize the exception, response body, request or headers.
        status = getattr(getattr(exc, "response", None), "status_code", None)
        status = status if type(status) is int and 100 <= status <= 599 else None
        category = type(exc).__name__
        detail = dict(command=args.command, phase=phase, exception_type=category, http_status=status)
        try:
            save("last-error.json", detail)
        except OSError:
            pass
        hint = {
            401: "Token was rejected. Re-enter it without quotes/spaces; check expiry or revocation.",
            403: "Access was denied. Check token permissions and account access.",
            429: "Hugging Face rate limit reached. Wait before retrying.",
        }.get(status, "Check connectivity or the indicated local stage; credential values remain hidden.")
        suffix = f", HTTP {status}" if status else ""
        print(f"Publication failed during {phase} ({category}{suffix}). {hint} No automatic retry or cleanup was performed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
