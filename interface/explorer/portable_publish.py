"""Portable reviewed updates. Planning performs only Hub reads."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile


def execute(args, tools):
    from huggingface_hub import HfApi, hf_hub_download, CommitOperationAdd, CommitOperationDelete
    release=tools.descriptor()
    state=Path(args.state_dir)
    plan_path=state/'portable-plan.json'
    save=tools.save
    def read_api(write=False):
        token=os.environ.get('HF_PUBLISH_TOKEN') if write else os.environ.get('HF_VERIFY_TOKEN') or os.environ.get('HF_TOKEN')
        if not token:
            raise ValueError('HF_PUBLISH_TOKEN write access required' if write else 'Explicit HF_VERIFY_TOKEN or HF_TOKEN read access required')
        return HfApi(token=token)
    def settings(api):
        space=api.repo_info(release['space']['repository'],repo_type='space')
        dataset=api.repo_info(release['dataset']['repository'],repo_type='dataset',revision=release['dataset']['revision'])
        runtime=api.get_space_runtime(release['space']['repository'])
        if space.visibility!=release['space']['visibility'] or runtime.hardware!=release['space']['hardware'] or not dataset.private:
            raise ValueError('Space visibility/hardware or Dataset privacy differs from descriptor')
        d=release['dataset']
        expected=dict(EXPLORER_DATA_MODE='hub',EXPLORER_DATASET_REPO=d['repository'],
                      EXPLORER_DATASET_REVISION=d['revision'],EXPLORER_DATASET_DIR=d['directory'],
                      EXPLORER_MANIFEST_SHA256=d['manifest_sha256'],EXPLORER_RELEASE='/data/current',EXPLORER_CACHE='/data')
        variables=api.get_space_variables(release['space']['repository'])
        if any(getattr(variables.get(k),'value',None)!=v for k,v in expected.items()):
            raise ValueError('Runtime Dataset/configuration differs from descriptor')
        return space,expected
    def inventory(api,revision,cache,copy_to=None):
        records={}
        for name in sorted(api.list_repo_files(release['space']['repository'],repo_type='space',revision=revision)):
            if name=='.gitattributes':continue
            path=PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name or str(path)!=name:
                raise ValueError('Unsafe remote source path')
            downloaded=Path(hf_hub_download(release['space']['repository'],name,repo_type='space',revision=revision,token=api.token,cache_dir=str(cache)))
            records[name]=dict(bytes=downloaded.stat().st_size,sha256=tools.host.sha(downloaded))
            if sum(v['bytes'] for v in records.values())>100*1024**2:
                raise ValueError('Remote application source exceeds 100 MiB review limit')
            if copy_to is not None:
                target=copy_to/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(downloaded,target)
        return records
    def identity(plan):
        return {k:plan[k] for k in ('source_sha256','baseline_revision','release','before','after','allowed_files','introduced_files')}
    def load_plan():
        if not plan_path.exists():raise ValueError('Run publish prepare-update --bundle DIR first')
        plan=json.loads(plan_path.read_text())
        if plan['release']!=release or tools.fingerprint(identity(plan))!=plan['plan_sha256']:
            raise ValueError('Release plan identity changed')
        receipt,base=tools.load_bundle(args.bundle or plan['bundle'])
        if receipt['source_sha256']!=plan['source_sha256'] or receipt['space_inventory']!=plan['after']:
            raise ValueError('Candidate differs from reviewed plan')
        return plan,receipt,base
    if args.command=='prepare-update':
        receipt,base=tools.selected_bundle(args)
        if receipt['schema_version']!='explorer-package-v2' or receipt['release']!=release:
            raise ValueError('Portable preparation requires a matching v2 application artifact')
        api=read_api();space,variables=settings(api)
        baseline=state/'baselines'/space.sha
        baseline.parent.mkdir(parents=True,exist_ok=True)
        if baseline.exists():
            previous,_=tools.load_bundle(baseline);before=previous['space_inventory']
            if inventory(api,space.sha,state/'hub')!=before:raise ValueError('Retained remote baseline differs')
        else:
            with tempfile.TemporaryDirectory(prefix='.baseline-',dir=baseline.parent) as temporary:
                stage=Path(temporary)/'artifact';(stage/'space').mkdir(parents=True)
                before=inventory(api,space.sha,state/'hub',stage/'space')
                baseline_identity=dict(schema_version='explorer-package-v2',source_revision=space.sha,release=release,
                                       tooling_inventory=receipt['tooling_inventory'],space_inventory=before)
                saved=dict(baseline_identity,source_sha256=tools.fingerprint(baseline_identity),
                           manifest_sha256=receipt['manifest_sha256'],image='wcecoli-explorer:rollback-'+space.sha[:12],
                           space_bytes=sum(v['bytes'] for v in before.values()))
                save(stage/'evidence/package.json',saved);stage.rename(baseline)
        after=receipt['space_inventory']
        if not set(before)<=set(after):raise ValueError('Forward update cannot delete remote source')
        plan=dict(source_sha256=receipt['source_sha256'],baseline_revision=space.sha,release=release,before=before,after=after,
                  allowed_files=sorted(k for k in after if before.get(k)!=after[k]),introduced_files=sorted(set(after)-set(before)),
                  bundle=str(base),baseline_bundle=str(baseline),variables=variables,phase='prepared')
        plan['plan_sha256']=tools.fingerprint(identity(plan));save(plan_path,plan)
        return dict(plan=str(plan_path),plan_sha256=plan['plan_sha256'],source_sha256=receipt['source_sha256'],
                    baseline_revision=space.sha,no_update_required=not plan['allowed_files'],approved=False)
    if args.command=='status':
        return json.loads(plan_path.read_text()) if plan_path.exists() else dict(phase='no portable release prepared')
    plan,receipt,base=load_plan()
    if args.command=='approve':
        if not args.authorization or not args.evidence:raise ValueError('Explicit authorization and build/startup evidence files required')
        authorization=json.loads(Path(args.authorization).read_text());evidence=json.loads(Path(args.evidence).read_text())
        if (authorization.get('confirmed_by_user') is not True or not authorization.get('scope') or not authorization.get('evidence_reference')
                or authorization.get('plan_sha256')!=plan['plan_sha256']
                or evidence.get('source_sha256')!=receipt['source_sha256'] or evidence.get('build_and_startup_passed') is not True
                or evidence.get('manifest_sha256')!=receipt['manifest_sha256'] or not evidence.get('evidence_reference')):
            raise ValueError('Authorization/evidence is absent or not bound to this plan and artifact')
        save(state/'portable-authorization.json',authorization);save(state/'portable-approval.json',evidence)
        return dict(approved=True,plan_sha256=plan['plan_sha256'])
    if args.command=='check':
        api=read_api();space,_=settings(api);actual=inventory(api,space.sha,state/'hub')
        if space.sha!=plan['baseline_revision'] or actual!=plan['before']:raise ValueError('Remote baseline changed; prepare a new plan')
        return dict(valid=True,no_update_required=not plan['allowed_files'],plan_sha256=plan['plan_sha256'])
    if args.command not in {'update-space','rollback-space'}:
        raise ValueError('Dataset/initial publication requires an explicit legacy v1 package; never an application-only artifact')
    if args.command=='update-space' and not plan['allowed_files']:
        api=read_api();space,_=settings(api)
        if space.sha!=plan['baseline_revision'] or inventory(api,space.sha,state/'hub')!=plan['after']:
            raise ValueError('Remote changed after preparation')
        return dict(no_update_required=True,revision=space.sha)
    authorization_path=state/'portable-authorization.json';approval_path=state/'portable-approval.json'
    if not authorization_path.exists() or not approval_path.exists():raise ValueError('Explicit publication approval is required')
    authorization=json.loads(authorization_path.read_text());approval=json.loads(approval_path.read_text())
    if (authorization.get('confirmed_by_user') is not True or authorization.get('plan_sha256')!=plan['plan_sha256']
            or approval.get('source_sha256')!=receipt['source_sha256'] or approval.get('manifest_sha256')!=receipt['manifest_sha256']
            or approval.get('build_and_startup_passed') is not True):raise ValueError('Publication approval binding changed')
    rollback=args.command=='rollback-space'
    if rollback and not plan.get('forward_revision'):raise ValueError('Rollback requires this completed forward release')
    api=read_api(write=True)
    # Reuse the existing account/write-access checks, never runtime secrets.
    legacy=tools.load_publisher();legacy.STATE=state;legacy.identity(api,require_write=True)
    space,variables=settings(api)
    baseline_receipt,baseline=tools.load_bundle(plan['baseline_bundle'])
    if baseline_receipt['space_inventory']!=plan['before']:raise ValueError('Rollback baseline changed')
    target,expected=(plan['before'],plan['after']) if rollback else (plan['after'],plan['before'])
    target_dir=baseline/'space' if rollback else base/'space'
    parent=plan['forward_revision'] if rollback else plan['baseline_revision']
    result_key='rollback_revision' if rollback else 'forward_revision'
    actual=inventory(api,space.sha,state/'hub')
    pending_phase='rollback_commit_pending' if rollback else 'commit_pending'
    if actual==target and (space.sha==plan.get(result_key) or plan.get('phase')==pending_phase):
        revision=space.sha
        plan[result_key]=revision;plan['phase']='rollback_uploaded' if rollback else 'uploaded';save(plan_path,plan)
    else:
        if space.sha!=parent or actual!=expected:raise ValueError('Remote parent/inventory changed; refusing overwrite')
        changed=sorted(k for k in target if expected.get(k)!=target[k]);removed=sorted(set(expected)-set(target))
        if removed and (not rollback or removed!=plan['introduced_files']):raise ValueError('Unrelated remote deletion refused')
        plan['phase']=pending_phase;save(plan_path,plan)
        result=api.create_commit(release['space']['repository'],repo_type='space',parent_commit=parent,
                operations=[CommitOperationAdd(path_in_repo=k,path_or_fileobj=str(target_dir/k)) for k in changed]
                           +[CommitOperationDelete(path_in_repo=k) for k in removed],
                commit_message='Roll back reviewed portable release' if rollback else 'Apply reviewed portable release',num_threads=1)
        revision=result.oid
        # Journal the returned revision before checking content/startup, so retry
        # can resume without creating another commit.
        plan[result_key]=revision;plan['phase']='rollback_uploaded' if rollback else 'uploaded';save(plan_path,plan)
    if inventory(api,revision,state/'hub')!=target:raise ValueError('Committed inventory verification failed')
    uploaded=dict(repository=release['space']['repository'],revision=revision,
                  package_sha256=baseline_receipt['source_sha256'] if rollback else receipt['source_sha256'],phase='uploaded')
    return legacy.monitor_space(api,uploaded,variables)
