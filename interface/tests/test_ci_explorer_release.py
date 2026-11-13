"""Exercise the production release boundaries without calling a real service."""

import pytest

import ci_explorer_release as release


PARENT = "a" * 40
OLD = {"bytes": 1, "sha256": "b" * 64}
NEW = {"bytes": 2, "sha256": "c" * 64}


def test_rehearsal_requires_identical_files_and_preserves_hub_metadata():
    before = {"README.md": OLD, ".gitattributes": OLD}
    plan = release.build_plan({"mode": "rehearsal"}, PARENT, before, {"README.md": OLD})
    assert plan["no_update_required"]
    assert plan["before_sha256"] == plan["after_sha256"]
    with pytest.raises(release.ReleaseError, match="identical"):
        release.build_plan({"mode": "rehearsal"}, PARENT, before, {"README.md": NEW})


def test_plan_lists_exact_inverse_and_disallows_forward_deletion():
    before = {"README.md": OLD}
    after = {"README.md": NEW, "Dockerfile": NEW}
    plan = release.build_plan({"mode": "active"}, PARENT, before, after)
    assert plan["forward"] == {"add": ["Dockerfile"], "replace": ["README.md"]}
    assert plan["rollback"] == {"replace": ["README.md"], "remove": ["Dockerfile"]}
    with pytest.raises(release.ReleaseError, match="would delete"):
        release.build_plan({"mode": "active"}, PARENT, before, {"Dockerfile": NEW})


@pytest.mark.parametrize(("status", "write"), [(200, False), (403, True), (500, False)])
def test_scope_probe_fails_closed(monkeypatch, status, write):
    monkeypatch.setattr(release, "request_status", lambda *_: status)
    with pytest.raises(release.ReleaseError, match="expected repository write"):
        release.verify_space_scope("fixture", write=write)


def test_promotion_rejects_fork_and_reused_package_attempt():
    env = {
        "GITHUB_REPOSITORY": release.REPOSITORY, "GITHUB_REF": "refs/heads/platform",
        "GITHUB_EVENT_NAME": "push", "GITHUB_SHA": PARENT, "GITHUB_RUN_ID": "100",
        "GITHUB_RUN_ATTEMPT": "2", "PACKAGE_ATTEMPT": "2", "RELEASE_MODE": "active",
    }
    assert release.ci_context(env)["run_attempt"] == "2"
    with pytest.raises(release.ReleaseError, match="platform push"):
        release.ci_context({**env, "GITHUB_REPOSITORY": "another/wcEcoli"})
    with pytest.raises(release.ReleaseError, match="same attempt"):
        release.ci_context({**env, "PACKAGE_ATTEMPT": "1"})


def test_approval_requires_the_right_reviewer_environment_and_digest():
    approval = {
        "state": "approved", "environments": [{"name": release.PRODUCTION}],
        "user": {"login": "MohammedNagdi"}, "comment": "the-plan",
    }
    release.approved_review([approval], "the-plan")
    for change in (
        {"state": "rejected"}, {"comment": "older-plan"},
        {"environments": [{"name": "scientific-verification"}]},
        {"user": {"login": "another-reviewer"}},
    ):
        with pytest.raises(release.ReleaseError, match="exact plan digest"):
            release.approved_review([{**approval, **change}], "the-plan")


@pytest.fixture
def disposable_space(tmp_path):
    """A real Git repository with the same parent-guarded write contract as Hub."""
    import subprocess
    from types import SimpleNamespace

    root = tmp_path / "remote"
    root.mkdir()

    class GitSpace:
        commits = 0
        lose_response = False

        def git(self, *args):
            return subprocess.run(
                ["git", "-C", str(root), *args], check=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            ).stdout.strip()

        def settings(self):
            return self.git("rev-parse", "HEAD"), None

        def inventory(self, revision):
            from hashlib import sha256

            result = {}
            for name in self.git("ls-tree", "-r", "--name-only", revision).splitlines():
                content = self.git("show", f"{revision}:{name}").encode()
                result[name] = {"bytes": len(content), "sha256": sha256(content).hexdigest()}
            return result

        def baseline_file(self, revision, name):
            path = tmp_path / "baseline"
            path.write_text(self.git("show", f"{revision}:{name}"))
            return path

        def history(self, revision):
            return [
                SimpleNamespace(commit_id=sha, title=title)
                for sha, title in (line.split("\t", 1) for line in
                                   self.git("log", "--format=%H%x09%s", revision).splitlines())
            ]

        def commit(self, parent, files, remove, title):
            assert self.settings()[0] == parent
            self.commits += 1
            for name, path in files.items():
                (root / name).write_bytes(path.read_bytes())
            for name in remove:
                (root / name).unlink()
            self.git("add", "-A")
            self.git("commit", "-m", title)
            if self.lose_response:
                self.lose_response = False
                raise OSError("response lost after committing")
            return self.settings()[0]

    hub = GitSpace()
    hub.git("init", "-q")
    hub.git("config", "user.email", "fixture@example.invalid")
    hub.git("config", "user.name", "Fixture")
    (root / "README.md").write_text("before")
    hub.git("add", "README.md")
    hub.git("commit", "-m", "Baseline")
    return hub


@pytest.mark.parametrize("outcome", ["accepted", "lost_response", "rolled_back", "ambiguous", "drift", "stale"])
def test_deploy_and_restore_on_disposable_space(tmp_path, disposable_space, outcome):
    hub = disposable_space
    parent, _ = hub.settings()
    before = hub.inventory(parent)
    bundle = tmp_path / "bundle"
    (bundle / "space").mkdir(parents=True)
    (bundle / "space" / "README.md").write_text("after")
    (bundle / "space" / "Dockerfile").write_text("new file")
    after = release.portable.host.inventory(bundle / "space")
    plan = release.build_plan({"mode": "active"}, parent, before, after)
    digest = release.portable.fingerprint(plan)
    events = []

    def journal(phase, **details):
        events.append((phase, details))

    def head_check():
        if outcome == "stale":
            raise release.ReleaseError("Stale platform source")

    def accept(revision):
        if revision != parent and hub.commits == 1:
            if outcome == "rolled_back":
                raise release.Regression("Known application failure")
            if outcome == "drift":
                hub.git("commit", "--allow-empty", "-m", "Unrelated commit")
                raise release.Regression("Known application failure")
            if outcome == "ambiguous":
                raise release.ReleaseError("Upstream outage")
        return 3

    if outcome in {"rolled_back", "ambiguous", "drift", "stale"}:
        with pytest.raises(release.ReleaseError):
            release.deploy_release(hub, plan, digest, bundle, before, journal, accept, head_check)
    else:
        hub.lose_response = outcome == "lost_response"
        release.deploy_release(hub, plan, digest, bundle, before, journal, accept, head_check)
    if outcome == "rolled_back":
        assert hub.commits == 2
        assert hub.inventory(hub.settings()[0]) == before
        assert events[-1][0] == "rolled_back"
    elif outcome == "stale":
        assert hub.commits == 0
        assert hub.settings()[0] == parent
    else:
        assert hub.commits == 1
        assert hub.inventory(hub.settings()[0]) == after
        if outcome in {"accepted", "lost_response"}:
            assert events[-1][0] == "accepted"


def test_candidate_requires_science_proof_bound_to_artifact_and_attempt(tmp_path, monkeypatch):
    import json

    fingerprint = "d" * 64
    archive_digest = "e" * 64
    env = {
        "CANDIDATE_ID": "12", "VERIFICATION_ID": "13",
        "CANDIDATE_SHA256": archive_digest, "CANDIDATE_FINGERPRINT": fingerprint,
    }
    context = {"source_revision": PARENT, "run_id": "10", "run_attempt": "1", "mode": "active"}
    descriptor = release.portable.descriptor()
    dataset = descriptor["dataset"]
    report = tmp_path / "verified.json"
    evidence = {
        "schema_version": "explorer-ci-verification-v1",
        "source_revision": PARENT,
        "workflow_run_id": "10",
        "workflow_run_attempt": "1",
        "package_artifact_id": "12",
        "archive_sha256": archive_digest,
        "source_sha256": fingerprint,
        "dataset_revision": dataset["revision"],
        "manifest_sha256": dataset["manifest_sha256"],
        "build_and_startup_passed": True,
        "strict_dataset_validation_passed": True,
        "isolation_passed": True,
        "scientific_checks_passed": 48,
        "scientific_comparisons_passed": 3948,
        "browser_tests_passed": 59,
    }
    monkeypatch.setattr(release, "unpack", lambda *args: {
        "release": descriptor, "space_inventory": {"README.md": NEW},
    })
    report.write_text(json.dumps(evidence))
    identity, _ = release.candidate(env, context, tmp_path / "archive", report, tmp_path / "bundle")
    assert identity["verification_artifact_id"] == "13"
    for wrong in (
        {"workflow_run_attempt": "2"}, {"package_artifact_id": "123"},
        {"dataset_revision": "main"}, {"scientific_comparisons_passed": 3947},
    ):
        report.write_text(json.dumps({**evidence, **wrong}))
        with pytest.raises(release.ReleaseError, match="Scientific verification"):
            release.candidate(env, context, tmp_path / "archive", report, tmp_path / "bundle")


def test_rehearsal_accepts_hosted_baseline_without_writing(tmp_path, disposable_space):
    hub = disposable_space
    parent = hub.settings()[0]
    before = hub.inventory(parent)
    plan = release.build_plan({"mode": "rehearsal"}, parent, before, before)
    events = []
    visited = []

    def accept(revision):
        visited.append(revision)
        return 3

    release.deploy_release(
        hub, plan, "plan-digest", tmp_path, before,
        lambda phase, **details: events.append((phase, details)), accept, lambda: None,
    )
    assert hub.commits == 0
    assert hub.settings()[0] == parent
    assert visited == [parent]
    assert events == [("rehearsal_passed", {"space_revision": parent, "hosted_browser_checks": 3})]


@pytest.mark.parametrize("approved", [False, True])
def test_runtime_variables_are_checked_only_after_production_approval(monkeypatch, approved):
    from types import SimpleNamespace

    class RepositoryNotFoundError(Exception):
        response = SimpleNamespace(status_code=401)

    descriptor = release.portable.descriptor()
    dataset = descriptor["dataset"]

    def read_variables(_space):
        raise RepositoryNotFoundError("response contains a private request diagnostic")

    hub = object.__new__(release.Hub)
    hub.descriptor = descriptor
    hub.approved = approved
    hub.issued_at = release.time.monotonic()
    runtime = SimpleNamespace(hardware=descriptor["space"]["hardware"])
    hub.api = SimpleNamespace(
        repo_info=lambda *args, **kwargs: SimpleNamespace(
            sha=PARENT, visibility=descriptor["space"]["visibility"], runtime=runtime,
        ),
        get_space_variables=read_variables,
    )
    hub.dataset_api = SimpleNamespace(
        repo_info=lambda *args, **kwargs: SimpleNamespace(sha=dataset["revision"], private=True)
    )
    if approved:
        with pytest.raises(
            release.ReleaseError, match=r"^Hugging Face Space runtime variables failed \(HTTP 401\)$"
        ):
            hub.settings()
    else:
        assert hub.settings() == (PARENT, runtime)


@pytest.mark.parametrize(("approved", "hardware"), [
    (False, None), (False, "cpu-upgrade"), (True, None),
])
def test_missing_space_runtime_is_deferred_but_wrong_hardware_blocks(approved, hardware):
    from types import SimpleNamespace

    hub = object.__new__(release.Hub)
    hub.descriptor = release.portable.descriptor()
    hub.approved = approved
    hub.issued_at = release.time.monotonic()
    hub.api = SimpleNamespace(
        repo_info=lambda *args, **kwargs: SimpleNamespace(
            sha=PARENT, visibility="protected",
            runtime=SimpleNamespace(hardware=hardware) if hardware else None,
        ),
        get_space_runtime=lambda _space: None,
    )
    hub.dataset_api = SimpleNamespace(
        repo_info=lambda *args, **kwargs: SimpleNamespace(
            sha=hub.descriptor["dataset"]["revision"], private=True,
        )
    )
    if not approved and hardware is None:
        assert hub.settings() == (PARENT, None)
    else:
        with pytest.raises(release.ReleaseError, match="visibility, hardware, or private Dataset pin differs"):
            hub.settings()
