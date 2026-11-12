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
