"""Portable packaging/publication contracts. All Hub mutations are synthetic."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('portable_release_tests',HERE/'explorer/portable.py')
tools=importlib.util.module_from_spec(spec);sys.modules[spec.name]=tools;spec.loader.exec_module(tools)
spec=importlib.util.spec_from_file_location('portable_publish_tests',HERE/'explorer/portable_publish.py')
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)


def args(tmp_path,command='bundle',**kw):
    values=dict(command=command,family='explorer',state_dir=str(tmp_path/'state'),output_dir=str(tmp_path/'output'),
                cache_dir=str(tmp_path/'cache'),explorer_state_dir=str(tmp_path/'state'),bundle=None,release=None,authorization=None,evidence=None)
    values.update(kw);return SimpleNamespace(**values)


def artifact(path,files,release=None,schema='explorer-package-v2'):
    for name,text in files.items():
        p=path/'space'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
    identity=dict(schema_version=schema,source_revision='a'*40,release=release or tools.descriptor(),tooling_inventory={},space_inventory=tools.host.inventory(path/'space'))
    receipt=dict(identity,source_sha256=tools.fingerprint(identity),manifest_sha256=identity['release']['dataset']['manifest_sha256'],image='synthetic:fixture')
    if schema=='explorer-package-v1':
        (path/'dataset').mkdir();(path/'dataset/payload.txt').write_text('explicit synthetic legacy payload')
        receipt['dataset_inventory']=tools.host.inventory(path/'dataset')
    tools.save(path/'evidence/package.json',receipt);return receipt


def test_bundle_is_identical_across_output_paths_and_changes_with_inputs(tmp_path,monkeypatch):
    source=tmp_path/'committed';(source/'interface/explorer').mkdir(parents=True)
    release=tools.descriptor();tools.save(source/'interface/explorer/release.json',release)
    for name in ('tooling.Dockerfile','requirements.lock','portable.py','portable_publish.py','release.sh','host.py','publish.py'):(source/'interface/explorer'/name).write_text('synthetic committed tooling')
    file=source/'README.md';file.write_text('synthetic source')
    monkeypatch.setattr(tools,'ROOT',source);monkeypatch.setenv('EXPLORER_GIT_REVISION','a'*40)
    monkeypatch.setattr(tools.host,'inputs',lambda:{'README.md':file})
    monkeypatch.setattr(tools.host,'notices',lambda *a:'synthetic notices')
    first=tools.bundle(args(tmp_path/'one'));second=tools.bundle(args(tmp_path/'two'))
    assert first['source_sha256']==second['source_sha256']
    left=Path(first['bundle']);right=Path(second['bundle'])
    assert tools.host.inventory(left)==tools.host.inventory(right)
    assert not (left/'dataset').exists()
    assert str(tmp_path) not in (left/'evidence/package.json').read_text()
    file.write_text('changed source');assert tools.bundle(args(tmp_path/'three'))['source_sha256']!=first['source_sha256']
    file.write_text('synthetic source');release['dataset']['revision']='b'*40;tools.save(source/'interface/explorer/release.json',release)
    assert tools.bundle(args(tmp_path/'four'))['source_sha256']!=first['source_sha256']


def test_corruption_and_symlinks_fail_before_use(tmp_path):
    artifact(tmp_path,{'README.md':'synthetic'})
    (tmp_path/'space/README.md').write_text('corrupt')
    with pytest.raises(ValueError,match='inventory'):tools.load_bundle(tmp_path)
    (tmp_path/'space/README.md').unlink();(tmp_path/'space/README.md').symlink_to(tmp_path/'evidence/package.json')
    with pytest.raises(ValueError,match='symlinks'):tools.load_bundle(tmp_path)


def test_legacy_v1_remains_readable_and_validated(tmp_path):
    r=artifact(tmp_path,{'README.md':'synthetic'},schema='explorer-package-v1')
    assert tools.load_bundle(tmp_path)[0]==r
    (tmp_path/'dataset/payload.txt').write_text('corrupt')
    with pytest.raises(ValueError,match='Legacy Dataset'):tools.load_bundle(tmp_path)


def test_missing_private_data_fails_without_credentials(tmp_path,monkeypatch):
    for key in ['HF_TOKEN','HF_DATASET_READ_TOKEN','HF_VERIFY_TOKEN','HF_PUBLISH_TOKEN']:monkeypatch.delenv(key,raising=False)
    with pytest.raises(ValueError,match='HF_TOKEN'):tools.fetch_data(args(tmp_path))
    assert not list((tmp_path/'cache/verified').glob('*'))


def test_v2_never_becomes_a_dataset_upload(tmp_path):
    artifact(tmp_path/'candidate',{'README.md':'synthetic'})
    with pytest.raises(ValueError,match='application-only'):tools.publish(args(tmp_path,'dataset',bundle=str(tmp_path/'candidate')))


@pytest.fixture
def hub(tmp_path,monkeypatch):
    release=tools.descriptor();d=release['dataset']
    variables=dict(EXPLORER_DATA_MODE='hub',EXPLORER_DATASET_REPO=d['repository'],EXPLORER_DATASET_REVISION=d['revision'],
        EXPLORER_DATASET_DIR=d['directory'],EXPLORER_MANIFEST_SHA256=d['manifest_sha256'],EXPLORER_RELEASE='/data/current',EXPLORER_CACHE='/data')
    class Hub:
        token='explicit synthetic token';revision='a'*40;visibility='protected';hardware='cpu-basic';calls=[];drop_response=False
        sources={'a'*40:{'README.md':'old','keep.txt':'keep'}}
        def repo_info(self,repo,repo_type,revision=None):return SimpleNamespace(sha=self.revision if repo_type=='space' else d['revision'],visibility=self.visibility,private=True)
        def get_space_runtime(self,repo):return SimpleNamespace(hardware=self.hardware)
        def get_space_variables(self,repo):return {k:SimpleNamespace(value=v) for k,v in variables.items()}
        def list_repo_files(self,repo,repo_type,revision):return list(self.sources[revision])+['.gitattributes']
        def create_commit(self,repo,**kw):
            assert kw['repo_type']=='space' and kw['parent_commit']==self.revision
            self.calls.append(kw);files=dict(self.sources[self.revision])
            for op in kw['operations']:
                if hasattr(op,'path_or_fileobj'):files[op.path_in_repo]=Path(op.path_or_fileobj).read_text()
                else:files.pop(op.path_in_repo)
            self.revision=('b' if len(self.calls)==1 else 'c')*40;self.sources[self.revision]=files
            if self.drop_response:self.drop_response=False;raise RuntimeError('synthetic interrupted response after commit')
            return SimpleNamespace(oid=self.revision)
    api=Hub()
    def download(repo,name,repo_type,revision,token,cache_dir):
        p=tmp_path/'downloads'/revision/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(api.sources[revision][name]);return str(p)
    monkeypatch.setitem(sys.modules,'huggingface_hub',SimpleNamespace(HfApi=lambda **kw:api,hf_hub_download=download,CommitOperationAdd=SimpleNamespace,CommitOperationDelete=SimpleNamespace))
    monkeypatch.setattr(tools,'load_publisher',lambda:SimpleNamespace(identity=lambda *a,**kw:None,monitor_space=lambda api,uploaded,variables:dict(ready=True,revision=uploaded['revision'])))
    monkeypatch.setenv('HF_VERIFY_TOKEN','synthetic-read');monkeypatch.delenv('HF_PUBLISH_TOKEN',raising=False)
    candidate=tmp_path/'candidate';artifact(candidate,{'README.md':'new','keep.txt':'keep','introduced.py':'reviewed addition'})
    a=args(tmp_path,'prepare-update',family='publish',bundle=str(candidate))
    return api,a,variables


def approve(a,tools):
    plan=json.loads((Path(a.state_dir)/'portable-plan.json').read_text())
    receipt,_=tools.load_bundle(a.bundle)
    authorization=Path(a.state_dir)/'explicit-authorization.json';evidence=Path(a.state_dir)/'synthetic-build.json'
    tools.save(authorization,dict(confirmed_by_user=True,scope='synthetic test only',evidence_reference='fixture',plan_sha256=plan['plan_sha256']))
    tools.save(evidence,dict(source_sha256=receipt['source_sha256'],manifest_sha256=receipt['manifest_sha256'],build_and_startup_passed=True,evidence_reference='synthetic test fixture'))
    a.command='approve';a.authorization=str(authorization);a.evidence=str(evidence)
    publisher.execute(a,tools)


def test_fresh_state_reconstructs_baseline_without_approving(hub):
    api,a,variables=hub
    result=publisher.execute(a,tools)
    assert result['approved'] is False and result['no_update_required'] is False
    plan=json.loads((Path(a.state_dir)/'portable-plan.json').read_text())
    assert tools.load_bundle(plan['baseline_bundle'])[0]['space_inventory']==plan['before']
    assert not (Path(a.state_dir)/'portable-authorization.json').exists()
    assert api.calls==[]


def test_publication_requires_bound_authorization_and_write_access(hub,monkeypatch):
    api,a,_=hub;publisher.execute(a,tools);a.command='update-space'
    with pytest.raises(ValueError,match='approval'):publisher.execute(a,tools)
    approve(a,tools);a.command='update-space'
    with pytest.raises(ValueError,match='HF_PUBLISH_TOKEN'):publisher.execute(a,tools)
    assert api.calls==[]


def test_scoped_update_rollback_and_resume(hub,monkeypatch):
    api,a,_=hub;publisher.execute(a,tools);approve(a,tools);monkeypatch.setenv('HF_PUBLISH_TOKEN','synthetic-write')
    a.command='update-space';assert publisher.execute(a,tools)['ready']
    publisher.execute(a,tools);assert len(api.calls)==1
    assert {o.path_in_repo for o in api.calls[0]['operations']}=={'README.md','introduced.py'}
    a.command='rollback-space';publisher.execute(a,tools);publisher.execute(a,tools)
    assert len(api.calls)==2 and api.sources[api.revision]==api.sources['a'*40]


def test_interrupted_response_resumes_exact_inventory_without_duplicate_commit(hub,monkeypatch):
    api,a,_=hub;publisher.execute(a,tools);approve(a,tools);monkeypatch.setenv('HF_PUBLISH_TOKEN','synthetic-write');api.drop_response=True
    a.command='update-space'
    with pytest.raises(RuntimeError,match='interrupted'):publisher.execute(a,tools)
    assert publisher.execute(a,tools)['ready'] and len(api.calls)==1


@pytest.mark.parametrize('drift',['parent','visibility','hardware','variables','scope'])
def test_drift_and_plan_tampering_never_mutate(hub,monkeypatch,drift):
    api,a,variables=hub;publisher.execute(a,tools);approve(a,tools);monkeypatch.setenv('HF_PUBLISH_TOKEN','synthetic-write')
    if drift=='parent':api.sources['d'*40]=dict(api.sources[api.revision]);api.revision='d'*40
    if drift=='visibility':api.visibility='private'
    if drift=='hardware':api.hardware='cpu-upgrade'
    if drift=='variables':variables['EXPLORER_DATASET_REVISION']='d'*40
    if drift=='scope':
        p=Path(a.state_dir)/'portable-plan.json';plan=json.loads(p.read_text());plan['allowed_files'].append('keep.txt');tools.save(p,plan)
    a.command='update-space'
    with pytest.raises(ValueError):publisher.execute(a,tools)
    assert api.calls==[]


def test_identical_application_needs_no_write_or_new_revision(hub):
    api,a,_=hub
    # Candidate receipt matches the exact currently deployed application.
    root=Path(a.bundle);(root/'space/introduced.py').unlink();(root/'space/README.md').write_text('old')
    artifact(root,{'README.md':'old','keep.txt':'keep'})
    assert publisher.execute(a,tools)['no_update_required']
    a.command='update-space';assert publisher.execute(a,tools)['no_update_required'];assert api.calls==[]
