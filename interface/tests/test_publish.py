"""Publication is tested with fake Hub operations; no real remote writes."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
import artifact_http  # noqa: E402

spec = importlib.util.spec_from_file_location("hf08_publish", HERE / "explorer/publish.py")
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


@pytest.fixture
def release(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(CommitOperationAdd=SimpleNamespace, CommitOperationDelete=SimpleNamespace))
    monkeypatch.setattr(publish, "STATE", tmp_path / "state")
    monkeypatch.setattr(publish, "ROOT", tmp_path)
    base = tmp_path / "interface/.explorer/bundles" / ("a" * 20)
    for area in ("space", "dataset"):
        (base / area).mkdir(parents=True)
        for name in ("PUBLICATION.md", "README.md"):
            (base / area / name).write_text("Approved hosting notice; original license retained.")
    (base / "dataset/release").mkdir()
    (base / "dataset/release/manifest.json").write_text("synthetic transport inventory")
    receipt = dict(bundle=str(base.relative_to(tmp_path)), source_sha256="a" * 64,
        manifest_sha256=publish.host.sha(base / "dataset/release/manifest.json"))
    for area in ("space", "dataset"):
        receipt[area + "_inventory"] = publish.host.inventory(base / area)
    (tmp_path / "interface/.explorer/current.json").write_text(json.dumps(receipt))
    for key in ("HF_PUBLISH_TOKEN", "HF_DATASET_READ_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    return receipt, base


def approve(receipt):
    publish.save("permission.json", dict(confirmed_by_user=True, scope="synthetic test only",
        confirmed_on="2026-10-30", evidence_reference="test fixture", conditions=[], account=publish.ACCOUNT,
        repositories=[publish.DATASET, publish.SPACE], package_sha256=receipt["source_sha256"]))
    publish.save("approval.json", dict(package_sha256=receipt["source_sha256"],
        manifest_sha256=receipt["manifest_sha256"], build_and_startup_passed=True, evidence_reference="synthetic fixture"))


@pytest.mark.parametrize("command", ["dataset", "space"])
def test_pending_permission_never_constructs_hub_client(release, monkeypatch, command, capsys):
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(HfApi=lambda **_: pytest.fail("no API before gates")))
    assert publish.main([command]) == 2
    assert "permission is pending" in capsys.readouterr().err


def test_approval_is_bound_to_package_and_credentials_are_distinct(release, monkeypatch):
    receipt, base = release
    approve(receipt)
    monkeypatch.setenv("HF_PUBLISH_TOKEN", "dummy-write")
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-read")
    assert publish.gates(receipt, base) == []
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-write")
    assert any("distinct" in e for e in publish.gates(receipt, base))
    changed = dict(receipt, source_sha256="b" * 64)
    assert any("permission" in e for e in publish.gates(changed, base))


def test_space_update_preserves_existing_runtime_secret(release, monkeypatch):
    receipt, base = release
    approve(receipt)
    monkeypatch.setenv("HF_PUBLISH_TOKEN", "dummy-write")
    assert publish.gates(receipt, base, preserve_runtime=True) == []
    assert any("HF_DATASET_READ_TOKEN" in e for e in publish.gates(receipt, base))


def test_notices_still_pending_prevent_upload(release, monkeypatch):
    receipt, base = release
    approve(receipt)
    monkeypatch.setenv("HF_PUBLISH_TOKEN", "dummy-write")
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-read")
    (base / "space/README.md").write_text("Permission has not been confirmed")
    assert any("rights clarification" in e for e in publish.gates(receipt, base))


def test_frozen_inventory_corruption_and_escape(release, monkeypatch):
    receipt, base = release
    assert publish.package()[0] == receipt
    (base / "space/README.md").write_text("corrupt")
    with pytest.raises(publish.ReleaseError, match="changed"):
        publish.package()
    receipt["bundle"] = "outside"
    (publish.ROOT / "interface/.explorer/current.json").write_text(json.dumps(receipt))
    with pytest.raises(publish.ReleaseError, match="frozen"):
        publish.package()


@pytest.mark.parametrize("name,pro,role", [("other", True, "write"), ("Safrot", False, "write"), ("Safrot", True, "read")])
def test_account_and_write_access_gate(name, pro, role):
    api = SimpleNamespace(whoami=lambda: dict(name=name, isPro=pro, auth=dict(accessToken=dict(role=role))))
    with pytest.raises(publish.ReleaseError):
        publish.identity(api, require_write=True)


def test_sdk_error_output_never_contains_credentials(release, monkeypatch, capsys):
    receipt, _ = release
    approve(receipt)
    monkeypatch.setenv("HF_PUBLISH_TOKEN", "dummy-secret-write")
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-secret-read")
    def failed(**_):
        raise RuntimeError("dummy-secret-write")
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(HfApi=failed))
    assert publish.main(["dataset"]) == 2
    assert "dummy-secret" not in capsys.readouterr().err


def test_authentication_failure_reports_safe_phase_and_status(release, monkeypatch, capsys):
    receipt, _ = release
    approve(receipt)
    monkeypatch.setenv("HF_PUBLISH_TOKEN", "dummy-secret-write")
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-secret-read")
    def whoami():
        error = RuntimeError("Authorization: Bearer dummy-secret-write; private response body")
        error.response = SimpleNamespace(status_code=401, text="dummy-secret-read")
        raise error
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(HfApi=lambda **_: SimpleNamespace(whoami=whoami)))
    assert publish.main(["check"]) == 2
    message = capsys.readouterr().err
    assert "account authentication" in message and "HTTP 401" in message
    assert "dummy-secret" not in message
    saved = publish.read("last-error.json")
    assert saved["http_status"] == 401
    assert "dummy-secret" not in json.dumps(saved)


def test_existing_unknown_repository_never_overwritten(release, monkeypatch):
    receipt, base = release
    monkeypatch.setattr(publish, "info", lambda *_: SimpleNamespace(private=True, sha="f" * 40))
    with pytest.raises(publish.ReleaseError, match="ownership receipt"):
        publish.upload(SimpleNamespace(), "dataset", publish.DATASET, receipt, base)


def test_resume_missing_files_and_verify_final_inventory(release, monkeypatch):
    receipt, base = release
    expected = receipt["dataset_inventory"]
    publish.save("dataset-upload.json", dict(package_sha256=receipt["source_sha256"], phase="created"))
    monkeypatch.setattr(publish, "info", lambda *_: SimpleNamespace(private=True, sha="f" * 40))
    first = dict(list(expected.items())[:1])
    inventories = iter([first, expected])
    monkeypatch.setattr(publish, "remote_inventory", lambda *_: next(inventories))
    calls = []
    api = SimpleNamespace(create_commit=lambda *args, **kwargs: calls.append(kwargs))
    result = publish.upload(api, "dataset", publish.DATASET, receipt, base)
    assert result["inventory_verified"]
    assert {o.path_in_repo for o in calls[0]["operations"]} == set(expected) - set(first)
    assert calls[0]["parent_commit"] == "f" * 40


def test_resume_refuses_changed_remote_files(release, monkeypatch):
    receipt, base = release
    publish.save("dataset-upload.json", dict(package_sha256=receipt["source_sha256"], phase="created"))
    monkeypatch.setattr(publish, "info", lambda *_: SimpleNamespace(private=True, sha="f" * 40))
    monkeypatch.setattr(publish, "remote_inventory", lambda *_: {"README.md": dict(bytes=0, sha256="0" * 64)})
    with pytest.raises(publish.ReleaseError, match="differs"):
        publish.upload(SimpleNamespace(), "dataset", publish.DATASET, receipt, base)


def test_space_requires_dataset_receipt_before_settings(release):
    receipt, base = release
    with pytest.raises(publish.ReleaseError, match="Dataset publication receipt"):
        publish.publish_space(SimpleNamespace(), receipt, base)


def test_runtime_read_token_rejects_write_scope(monkeypatch):
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy")
    person = dict(name="Safrot", auth=dict(accessToken=dict(role="write")))
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(HfApi=lambda **_: SimpleNamespace(whoami=lambda: person)))
    with pytest.raises(publish.ReleaseError, match="fine-grained"):
        publish.runtime_reader()
    person["auth"]["accessToken"] = dict(role="fineGrained", fineGrained=dict(global_=[], scoped=[dict(
        entity=dict(name=publish.DATASET), permissions=["repo.content.read"])]))
    assert publish.runtime_reader()
    person["auth"]["accessToken"]["fineGrained"]["scoped"][0]["permissions"].append("repo.content.write")
    with pytest.raises(publish.ReleaseError, match="permissions"):
        publish.runtime_reader()


@pytest.mark.parametrize("url", ["http://safrot-wcecoli-explorer.hf.space/api/health", "https://evil.example/api/health",
    "https://safrot-wcecoli-explorer.hf.space.evil.example/api/health", "http://localhost:7860/api/health"])
def test_verification_token_never_sent_to_unapproved_host(monkeypatch, url):
    monkeypatch.setenv("HF_VERIFY_TOKEN", "dummy-secret")
    with pytest.raises(ValueError, match="approved HTTPS"):
        artifact_http.get_json(url)


def test_authenticated_redirects_are_not_followed():
    assert artifact_http.NoRedirects().redirect_request(None, None, 302, "redirect", {}, "https://evil.example") is None


def test_created_space_readme_is_replaced_only_if_creation_hash_matches(release, monkeypatch):
    receipt, base = release
    bootstrap = dict(bytes=10, sha256="c" * 64)
    publish.save("space-upload.json", dict(package_sha256=receipt["source_sha256"], phase="created",
                                          bootstrap_inventory={"README.md": bootstrap}))
    monkeypatch.setattr(publish, "info", lambda *_: SimpleNamespace(private=True, sha="f" * 40))
    inventories = iter([{"README.md": bootstrap}, receipt["space_inventory"]])
    monkeypatch.setattr(publish, "remote_inventory", lambda *_: next(inventories))
    calls = []
    api = SimpleNamespace(create_commit=lambda *a, **k: calls.append(k))
    assert publish.upload(api, "space", publish.SPACE, receipt, base)["inventory_verified"]
    assert "README.md" in {o.path_in_repo for o in calls[0]["operations"]}


def test_authenticated_get_uses_header_without_logging(monkeypatch):
    import io
    captured = []
    monkeypatch.setenv("HF_VERIFY_TOKEN", "dummy-never-log")
    class Opener:
        def open(self, request, **kwargs):
            captured.append(request)
            return io.BytesIO(b'{"ok":true}')
    monkeypatch.setattr(artifact_http.urllib.request, "build_opener", lambda *_: Opener())
    assert artifact_http.get_json(artifact_http.ORIGIN + "/api/health") == {"ok": True}
    assert captured[0].get_header("Authorization") == "Bearer dummy-never-log"
    assert "dummy-never-log" not in captured[0].full_url


def test_package_size_ceiling(release):
    receipt, base = release
    receipt["dataset_inventory"]["README.md"]["bytes"] = 10_000_000_001
    (publish.ROOT / "interface/.explorer/current.json").write_text(json.dumps(receipt))
    # A forged size fails the inventory check before any upload or size bypass.
    with pytest.raises(publish.ReleaseError, match="changed"):
        publish.package()


def test_private_repository_creation_is_journaled_before_api_call(release, monkeypatch):
    receipt, base = release
    observed = SimpleNamespace(private=True, sha="f" * 40)
    observations = iter([None, observed, observed])
    monkeypatch.setattr(publish, "info", lambda *_: next(observations))
    inventories = iter([{}, {}, receipt["dataset_inventory"]])
    monkeypatch.setattr(publish, "remote_inventory", lambda *_: next(inventories))
    calls = []
    def create(repo, **kwargs):
        assert publish.read("dataset-upload.json")["phase"] == "creation_pending"
        assert repo == publish.DATASET and kwargs["private"] and kwargs["exist_ok"] is False
        calls.append(kwargs)
    api = SimpleNamespace(create_repo=create, create_commit=lambda *a, **k: calls.append(k))
    assert publish.upload(api, "dataset", publish.DATASET, receipt, base)["inventory_verified"]
    assert len(calls) == 2


def test_monitor_understands_sdk_enums_and_spaces_checks_one_minute(release, monkeypatch):
    from enum import Enum
    class Stage(str, Enum):
        BUILDING = "BUILDING"
        RUNNING = "RUNNING"
    stages = iter([Stage.BUILDING, Stage.RUNNING])
    sleeps = []
    monkeypatch.setattr(publish.time, "sleep", lambda seconds: sleeps.append(seconds))
    api = SimpleNamespace(get_space_runtime=lambda _: SimpleNamespace(stage=next(stages)))
    assert publish.monitor_space(api, {}, {})["phase"] == "awaiting_hosted_acceptance"
    assert sleeps == [60]


def test_monitor_stops_on_runtime_failure_without_redeploy(release, monkeypatch):
    api = SimpleNamespace(get_space_runtime=lambda _: SimpleNamespace(stage="RUNTIME_ERROR"))
    monkeypatch.setattr(publish.time, "sleep", lambda _: pytest.fail("must stop on failure"))
    with pytest.raises(publish.ReleaseError, match="diagnosis"):
        publish.monitor_space(api, {}, {})


def test_update_waits_for_new_runtime_revision_not_old_running_container(release, monkeypatch):
    runtimes=iter([SimpleNamespace(stage="RUNNING",raw={"sha":"old"}),SimpleNamespace(stage="RUNNING",raw={"sha":"new"})])
    sleeps=[]
    monkeypatch.setattr(publish.time,"sleep",lambda seconds:sleeps.append(seconds))
    result=publish.monitor_space(SimpleNamespace(get_space_runtime=lambda _:next(runtimes)),{"revision":"new"},{})
    assert result["revision"]=="new" and sleeps==[60]


@pytest.mark.parametrize("entity,global_perms,valid", [
    ({"type":"dataset","name":"wcecoli-demo-v1","_id":"selected-id"}, [], True),
    ({"type":"dataset","name":publish.DATASET}, [], True),
    ({"type":"dataset","name":publish.DATASET,"_id":"another-id"}, [], False),
    ({"type":"model","name":publish.DATASET,"_id":"selected-id"}, [], False),
    ({"type":"user","name":"Safrot"}, [], False),
    ({"type":"dataset","name":"wcecoli-demo-v1"}, [], False),
    ({"type":"dataset","name":publish.DATASET,"_id":"selected-id"}, ["repo.content.read"], False),
])
def test_runtime_scope_uses_dataset_identity_not_display_name(release, monkeypatch, entity, global_perms, valid):
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-secret-never-log")
    fine = {"global":global_perms,"scoped":[dict(entity=entity,permissions=["repo.content.read"])]}
    person = dict(name="Safrot",auth=dict(accessToken=dict(role="fineGrained",fineGrained=fine)))
    reader = SimpleNamespace(whoami=lambda:person,repo_info=lambda *a,**kw:SimpleNamespace(id=publish.DATASET,_id="selected-id"))
    monkeypatch.setitem(sys.modules,"huggingface_hub",SimpleNamespace(HfApi=lambda **_:reader))
    if valid:
        assert publish.runtime_reader(dataset_only=True) is reader
    else:
        with pytest.raises(publish.ReleaseError,match="scope is not exclusively"):
            publish.runtime_reader(dataset_only=True)
        assert "dummy-secret" not in json.dumps(publish.read("runtime-scope-error.json"))


@pytest.mark.parametrize("extra_permissions,valid", [([], True), (["repo.content.read"], False), (["repo.content.write"], False)])
def test_empty_scope_entries_are_not_extra_access_grants(release, monkeypatch, extra_permissions, valid):
    monkeypatch.setenv("HF_DATASET_READ_TOKEN", "dummy-secret")
    scoped = [dict(entity=dict(type="dataset",_id="selected-id"),permissions=["repo.content.read"]),
              dict(entity=dict(type="user",name="Safrot"),permissions=extra_permissions)]
    person = dict(name="Safrot",auth=dict(accessToken=dict(role="fineGrained",fineGrained={"global":[],"scoped":scoped})))
    reader = SimpleNamespace(whoami=lambda:person,repo_info=lambda *a,**kw:SimpleNamespace(id=publish.DATASET,_id="selected-id"))
    monkeypatch.setitem(sys.modules,"huggingface_hub",SimpleNamespace(HfApi=lambda **_:reader))
    if valid:
        assert publish.runtime_reader(dataset_only=True) is reader
    else:
        with pytest.raises(publish.ReleaseError,match="scope is not exclusively"):
            publish.runtime_reader(dataset_only=True)
        detail = publish.read("runtime-scope-error.json")
        assert detail["active_scoped_resources_count"] == 2
        assert detail["scoped_permission_counts"] == [1,1]


def test_launchers_work_from_both_directories_without_uploads():
    for path, cwd in ((HERE.parent / "platform.sh", HERE.parent), (HERE / "platform.sh", HERE)):
        result = subprocess.run([str(path), "publish", "--help"], cwd=cwd, capture_output=True, text=True)
        assert result.returncode == 0 and "check" in result.stdout


def test_status_recognizes_only_matching_hosted_acceptance(release, capsys):
    state=dict(phase="verified",revision="a"*40,package_sha256="b"*64)
    publish.save("space.json",state)
    (publish.STATE / "proofs").mkdir()
    publish.save("proofs/hosted-acceptance.json",dict(complete=True,space=state))
    assert publish.main(["status"])==0
    assert json.loads(capsys.readouterr().out)["stage"] == "private staging verified; HF-09 ready"
    publish.save("space.json",dict(state,revision="c"*40))
    assert publish.main(["status"])==0
    assert "incomplete" in json.loads(capsys.readouterr().out)["stage"]


@pytest.fixture
def update_release(release, monkeypatch):
    receipt, base = release
    import shutil
    old = base.with_name("b" * 20)
    shutil.copytree(base,old)
    (old / "space/README.md").write_text("old approved notice")
    baseline=dict(receipt,source_sha256="b"*64,space_inventory=publish.host.inventory(old/"space"))
    (old/"evidence").mkdir()
    (old/"evidence/package.json").write_text(json.dumps(baseline))
    plan=dict(package_sha256=receipt["source_sha256"],baseline_package_sha256=baseline["source_sha256"],
              baseline_bundle=str(old.relative_to(publish.ROOT)),baseline_revision="a"*40,dataset_revision="f"*40,
              approved_by_user=True,allowed_files=["README.md"])
    publish.save("space-update.json",plan)
    publish.save("dataset.json",dict(phase="verified",revision="f"*40,manifest_sha256=receipt["manifest_sha256"]))
    variables=dict(EXPLORER_DATASET_REVISION="f"*40,EXPLORER_MANIFEST_SHA256=receipt["manifest_sha256"])
    publish.save("space-settings.json",dict(variables=variables))
    monkeypatch.setattr(publish,"info",lambda api,kind,repo:SimpleNamespace(private=True,visibility="protected",sha="f"*40 if kind=="dataset" else "a"*40))
    monkeypatch.setattr(publish,"monitor_space",lambda *a:dict(ready=True))
    calls=[]
    api=SimpleNamespace(token="dummy",get_space_runtime=lambda _:SimpleNamespace(hardware="cpu-basic"),get_space_variables=lambda _: {k:SimpleNamespace(value=v) for k,v in variables.items()},
                        create_commit=lambda *a,**kw:(calls.append(kw) or SimpleNamespace(oid="c"*40)))
    return receipt,base,baseline,api,calls


def test_update_space_changes_only_exact_files_without_touching_settings_or_dataset(update_release, monkeypatch):
    receipt,base,baseline,api,calls=update_release
    inventories=iter([baseline["space_inventory"],receipt["space_inventory"]])
    monkeypatch.setattr(publish,"remote_inventory",lambda *a:next(inventories))
    assert publish.update_space(api,receipt,base)==dict(ready=True)
    assert len(calls)==1 and calls[0]["parent_commit"]=="a"*40
    assert [o.path_in_repo for o in calls[0]["operations"]]==["README.md"]
    assert publish.read("dataset.json")["revision"]=="f"*40


def test_update_space_resume_does_not_duplicate_commit(update_release, monkeypatch):
    receipt,base,baseline,api,calls=update_release
    monkeypatch.setattr(publish,"remote_inventory",lambda *a:receipt["space_inventory"])
    publish.update_space(api,receipt,base)
    assert not calls


@pytest.mark.parametrize("already_uploaded", [False, True])
def test_update_space_allows_only_reviewed_additions_and_resumes_them(update_release, monkeypatch, already_uploaded):
    receipt, base, baseline, api, calls = update_release
    added = base / "space/frontend/src/explorer/Guide.tsx"
    added.parent.mkdir(parents=True)
    added.write_text("export const Guide = 'approved documentation';")
    receipt["space_inventory"] = publish.host.inventory(base / "space")
    plan = publish.read("space-update.json")
    plan["allowed_files"].append("frontend/src/explorer/Guide.tsx")
    publish.save("space-update.json", plan)
    inventories = iter([receipt["space_inventory"] if already_uploaded else baseline["space_inventory"], receipt["space_inventory"]])
    def inventory(_api, _kind, _repo, _revision, expected, _cache):
        assert expected == receipt["space_inventory"]
        return next(inventories)
    monkeypatch.setattr(publish, "remote_inventory", inventory)
    publish.update_space(api, receipt, base)
    if already_uploaded:
        assert not calls
    else:
        assert len(calls) == 1
        assert sorted(o.path_in_repo for o in calls[0]["operations"]) == sorted(plan["allowed_files"])
        assert calls[0]["parent_commit"] == plan["baseline_revision"]
    assert publish.read("dataset.json")["revision"] == "f" * 40


def test_update_space_never_deletes_remote_files_even_if_plan_lists_them(update_release):
    receipt, base, baseline, api, calls = update_release
    del receipt["space_inventory"]["PUBLICATION.md"]
    plan = publish.read("space-update.json")
    plan["allowed_files"].append("PUBLICATION.md")
    publish.save("space-update.json", plan)
    with pytest.raises(publish.ReleaseError, match="exact approved file list"):
        publish.update_space(api, receipt, base)
    assert not calls


def test_update_space_rejects_new_files_missing_from_approval(update_release):
    receipt, base, baseline, api, calls = update_release
    (base / "space/unreviewed.txt").write_text("unapproved")
    receipt["space_inventory"] = publish.host.inventory(base / "space")
    with pytest.raises(publish.ReleaseError, match="exact approved file list"):
        publish.update_space(api, receipt, base)
    assert not calls


@pytest.mark.parametrize("failure",["unexpected_remote","wrong_revision","changed_dataset","unapproved_files"])
def test_update_space_refuses_unreviewed_changes(update_release, monkeypatch, failure):
    receipt,base,baseline,api,calls=update_release
    monkeypatch.setattr(publish,"remote_inventory",lambda *a:{})
    if failure=="wrong_revision":
        monkeypatch.setattr(publish,"info",lambda api,kind,repo:SimpleNamespace(private=True,sha="f"*40 if kind=="dataset" else "z"*40))
        monkeypatch.setattr(publish,"remote_inventory",lambda *a:baseline["space_inventory"])
    elif failure=="changed_dataset":
        receipt["dataset_inventory"]={}
    elif failure=="unapproved_files":
        plan=publish.read("space-update.json")
        plan["allowed_files"]=[]
        publish.save("space-update.json",plan)
    with pytest.raises(publish.ReleaseError):
        publish.update_space(api,receipt,base)
    assert not calls

@pytest.mark.parametrize('visibility', ['private', 'public', None])
def test_update_requires_explicit_protected_visibility(update_release, monkeypatch, visibility):
    receipt, base, baseline, api, calls = update_release
    monkeypatch.setattr(publish, 'info', lambda api, kind, repo: SimpleNamespace(private=True, visibility=visibility, sha='f'*40 if kind=='dataset' else 'a'*40))
    with pytest.raises(publish.ReleaseError, match='Protected'):
        publish.update_space(api, receipt, base)
    assert calls == []


def prepare_rollback(receipt, base, baseline):
    added = base / 'space/added-by-this-release.txt'
    added.write_text('reviewed addition')
    receipt['space_inventory'] = publish.host.inventory(base/'space')
    (base/'evidence').mkdir(exist_ok=True)
    (base/'evidence/package.json').write_text(json.dumps(receipt))
    forward = publish.read('space-update.json')
    forward.update(phase='uploaded', revision='c'*40, allowed_files=['README.md','added-by-this-release.txt'])
    publish.save('space-update.json', forward)
    publish.save('space-upload.json', dict(revision='c'*40))
    publish.save('space-rollback.json', dict(approved_by_user=True,
        forward_package_sha256=receipt['source_sha256'], package_sha256=baseline['source_sha256'],
        allowed_files=['README.md'], allowed_deletions=['added-by-this-release.txt']))


def test_rollback_reverses_only_reviewed_additions_and_replacements(update_release, monkeypatch):
    receipt, base, baseline, api, calls = update_release
    prepare_rollback(receipt, base, baseline)
    monkeypatch.setattr(publish, 'info', lambda api, kind, repo: SimpleNamespace(private=True, visibility='protected', sha='f'*40 if kind=='dataset' else 'c'*40))
    inventories=iter([receipt['space_inventory'],baseline['space_inventory']])
    def inspect_inventory(api,kind,repo,revision,expected,cache):
        actual=next(inventories)
        # The pre-rollback inventory must permit the reviewed additions that
        # this transaction will delete; post-commit checks remain exact.
        assert not (set(actual)-set(expected))
        return actual
    monkeypatch.setattr(publish,'remote_inventory',inspect_inventory)
    assert publish.rollback_space(api,receipt,base)==dict(ready=True)
    assert calls[0]['parent_commit']=='c'*40
    assert sorted(o.path_in_repo for o in calls[0]['operations'])==['README.md','added-by-this-release.txt']
    assert publish.read('space-rollback.json')['phase']=='uploaded'
    assert publish.read('space-update.json')['package_sha256']==receipt['source_sha256']


@pytest.mark.parametrize('failure',['unapproved','deletion','parent'])
def test_rollback_refuses_unapproved_scope_or_remote_drift(update_release,monkeypatch,failure):
    receipt,base,baseline,api,calls=update_release
    prepare_rollback(receipt,base,baseline)
    if failure=='parent':
        monkeypatch.setattr(publish,'info',lambda api,kind,repo:SimpleNamespace(private=True,visibility='protected',sha='f'*40 if kind=='dataset' else 'd'*40))
        monkeypatch.setattr(publish,'remote_inventory',lambda *a:receipt['space_inventory'])
    else:
        plan=publish.read('space-rollback.json')
        if failure=='unapproved':plan['approved_by_user']=False
        else:plan['allowed_deletions'].append('PUBLICATION.md')
        publish.save('space-rollback.json',plan)
    with pytest.raises(publish.ReleaseError):publish.rollback_space(api,receipt,base)
    assert calls==[]


def test_rollback_resume_does_not_create_another_commit(update_release,monkeypatch):
    receipt,base,baseline,api,calls=update_release
    prepare_rollback(receipt,base,baseline)
    plan=publish.read('space-rollback.json');plan.update(phase='uploaded',revision='d'*40);publish.save('space-rollback.json',plan)
    publish.save('space-upload.json',dict(revision='d'*40))
    monkeypatch.setattr(publish,'info',lambda api,kind,repo:SimpleNamespace(private=True,visibility='protected',sha='f'*40 if kind=='dataset' else 'd'*40))
    monkeypatch.setattr(publish,'remote_inventory',lambda *a:baseline['space_inventory'])
    publish.rollback_space(api,receipt,base)
    assert calls==[]


def test_update_rejects_hardware_drift(update_release,monkeypatch):
    receipt,base,baseline,api,calls=update_release
    api.get_space_runtime=lambda _:SimpleNamespace(hardware='cpu-upgrade')
    with pytest.raises(publish.ReleaseError,match='hardware'):
        publish.update_space(api,receipt,base)
    assert calls==[]
