"""Docker-first release tooling. No implicit simulation or publication operations."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'interface/backend'))
spec = importlib.util.spec_from_file_location('explorer_legacy_host', Path(__file__).with_name('host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def fingerprint(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    temporary.replace(path)


def descriptor():
    value = json.loads((ROOT / 'interface/explorer/release.json').read_text())
    d, s = value['dataset'], value['space']
    if (value['schema_version'] != 'explorer-release-v1' or value['platform'] != 'linux/amd64'
            or not re.fullmatch(r'[\w.-]+/[\w.-]+', d['repository'])
            or not re.fullmatch(r'[0-9a-f]{40}', d['revision'])
            or not re.fullmatch(r'[0-9a-f]{64}', d['manifest_sha256'])
            or d['directory'] != 'release' or s['visibility'] != 'protected'
            or s['hardware'] != 'cpu-basic'):
        raise ValueError('Invalid immutable release descriptor')
    return value


def ordinary(directory):
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir() or any(p.is_symlink() for p in directory.rglob('*')):
        raise ValueError('Artifact must contain ordinary files/directories, not symlinks')
    return directory


def load_bundle(directory):
    directory = ordinary(directory)
    receipt = json.loads((directory / 'evidence/package.json').read_text())
    if receipt['schema_version'] not in {'explorer-package-v1', 'explorer-package-v2'}:
        raise ValueError('Unsupported package schema')
    if host.inventory(directory / 'space') != receipt['space_inventory']:
        raise ValueError('Application artifact inventory changed')
    if receipt['schema_version'] == 'explorer-package-v1':
        if host.inventory(directory / 'dataset') != receipt['dataset_inventory']:
            raise ValueError('Legacy Dataset inventory changed')
    else:
        identity = {k:receipt[k] for k in ('schema_version','source_revision','release','tooling_inventory','space_inventory')}
        if fingerprint(identity) != receipt['source_sha256']:
            raise ValueError('Application artifact fingerprint changed')
        if (directory / 'dataset').exists():
            raise ValueError('Application-only artifact cannot contain a Dataset')
    return receipt, directory


def bundle(args):
    revision = os.environ.get('EXPLORER_GIT_REVISION', '')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Packaging requires a committed source revision from the launcher')
    release = descriptor()
    source = host.inputs()
    for name, path in source.items():
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing/symlinked source: ' + name)
        if path.suffix != '.webp' and host.TOKEN.search(path.read_text()):
            raise ValueError('Credential-like content in source: ' + name)
    notices = host.notices(Path('/opt/frontend'))
    space_inventory = {name:dict(bytes=path.stat().st_size, sha256=host.sha(path)) for name,path in source.items()}
    space_inventory['THIRD_PARTY_NOTICES.txt'] = dict(bytes=len(notices.encode()), sha256=hashlib.sha256(notices.encode()).hexdigest())
    tooling_inventory = {name:host.sha(ROOT / 'interface/explorer' / name) for name in ('tooling.Dockerfile','requirements.lock','portable.py','portable_publish.py','release.sh','host.py','publish.py')}
    identity = dict(schema_version='explorer-package-v2', source_revision=revision, release=release,
                    tooling_inventory=tooling_inventory, space_inventory=space_inventory)
    digest = fingerprint(identity)
    receipt = dict(identity, source_sha256=digest, manifest_sha256=release['dataset']['manifest_sha256'],
                   image='wcecoli-explorer:'+digest[:20], space_bytes=sum(v['bytes'] for v in space_inventory.values()))
    output = Path(args.output_dir) / digest[:20]
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        existing,_ = load_bundle(output)
        if existing != receipt:
            raise ValueError('Existing frozen artifact differs')
    else:
        with tempfile.TemporaryDirectory(prefix='.bundle-', dir=output.parent) as temporary:
            stage=Path(temporary)/'artifact';stage.mkdir()
            for name,path in source.items():
                target=stage/'space'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
                target.chmod(0o644)
            (stage/'space/THIRD_PARTY_NOTICES.txt').write_text(notices)
            save(stage/'evidence/package.json',receipt)
            stage.rename(output)
    save(Path(args.state_dir)/'current.json', dict(bundle=str(output.resolve()), source_sha256=digest))
    return dict(bundle=str(output.resolve()), source_sha256=digest, manifest_sha256=receipt['manifest_sha256'],
                schema_version=receipt['schema_version'], space_bytes=receipt['space_bytes'])


def cache_release(cache):
    d=descriptor()['dataset']
    identity=hashlib.sha256(f"{d['repository']}\n{d['revision']}\n{d['directory']}\n{d['manifest_sha256']}".encode()).hexdigest()
    return Path(cache)/'releases'/identity


def verify_release(directory):
    from hf_export.release_bootstrap import verify_payloads
    from hf_export.explorer_contract import validate_release
    directory=ordinary(directory)
    verify_payloads(directory,descriptor()['dataset']['manifest_sha256'])
    report=validate_release(directory)
    if not report['valid']:
        raise ValueError('Strict scientific release validation failed')
    return report


def fetch_data(args):
    from hf_export.release_bootstrap import prepare
    d=descriptor()['dataset']
    env=dict(EXPLORER_DATA_MODE='hub',EXPLORER_RELEASE=str(Path(args.cache_dir)/'current'),
             EXPLORER_CACHE=args.cache_dir,EXPLORER_DATASET_REPO=d['repository'],
             EXPLORER_DATASET_REVISION=d['revision'],EXPLORER_DATASET_DIR=d['directory'],
             EXPLORER_MANIFEST_SHA256=d['manifest_sha256'],
             HF_TOKEN=os.environ.get('HF_TOKEN') or os.environ.get('HF_DATASET_READ_TOKEN',''))
    prepare(env)
    directory=cache_release(args.cache_dir)
    report=verify_release(directory)
    marker=dict(schema_version='explorer-data-verification-v1',dataset=d,report=report)
    save(Path(args.cache_dir)/'verified'/ (directory.name+'.json'),marker)
    return dict(release=str(directory),dataset=d,valid=True,total_bytes=report['total_bytes'])


def selected_bundle(args):
    if args.bundle:
        return load_bundle(args.bundle)
    pointer=Path(args.explorer_state_dir)/'current.json'
    if not pointer.exists():
        raise ValueError('Select --bundle or run explorer bundle first')
    value=json.loads(pointer.read_text())
    path=Path(value['bundle'])
    if not path.is_absolute():
        path=Path(os.environ.get('EXPLORER_CALLER_ROOT',str(ROOT)))/path
    return load_bundle(path)


def verify(args):
    receipt,base=selected_bundle(args)
    if receipt.get('release') and receipt['release']!=descriptor():
        raise ValueError('Artifact Dataset identity differs from selected release descriptor')
    directory=Path(args.release) if args.release else cache_release(args.cache_dir)
    if not directory.exists():
        raise ValueError('Scientific release unavailable; run ./platform.sh explorer fetch-data first')
    report=verify_release(directory)
    result=dict(schema_version='explorer-verification-v2',source_sha256=receipt['source_sha256'],
                manifest_sha256=receipt['manifest_sha256'],release=descriptor(),valid=True,validation=report)
    save(Path(args.state_dir)/'verification'/ (receipt['source_sha256']+'.json'),result)
    return result


def preview_config(args):
    receipt,base=selected_bundle(args)
    verify(args)
    directory=Path(args.release) if args.release else cache_release(args.cache_dir)
    config=host.compose_config(dict(receipt,bundle=str(base)),{'EXPLORER_DATA_MODE':'local'},release=directory)
    config['services']['web']['platform']='linux/amd64'
    save(Path(args.state_dir)/'compose.json',config)
    (Path(args.state_dir)/'empty.env').write_text('# No credentials.\n')
    return dict(compose=str(Path(args.state_dir)/'compose.json'))


def load_publisher():
    spec=importlib.util.spec_from_file_location('legacy_explorer_publish',ROOT/'interface/explorer/publish.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def publish(args):
    if args.bundle:
        receipt,base=load_bundle(args.bundle)
        if receipt['schema_version']=='explorer-package-v1':
            legacy=load_publisher()
            legacy.ROOT=Path(os.environ.get('EXPLORER_CALLER_ROOT',str(ROOT)))
            legacy.STATE=Path(args.state_dir)
            legacy.package=lambda:(receipt,base)
            legacy.strict_validate=verify_release
            code=legacy.main([args.command])
            if code:raise ValueError('Legacy publication failed; see sanitized diagnostic above')
            return None
    if args.command in {'dataset','space'}:
        raise ValueError('Dataset/initial publication requires an explicit legacy v1 package, not an application-only artifact')
    from portable_publish import execute
    return execute(args,sys.modules[__name__])


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['bundle','fetch-data','verify','preview-config','prepare-update','approve','update-space','rollback-space','check','status','dataset','space'])
    parser.add_argument('--state-dir',required=True)
    parser.add_argument('--output-dir',required=True)
    parser.add_argument('--family',choices=['explorer','publish'],default='explorer')
    parser.add_argument('--cache-dir',required=True)
    parser.add_argument('--explorer-state-dir',required=True)
    parser.add_argument('--authorization')
    parser.add_argument('--evidence')
    parser.add_argument('--bundle')
    parser.add_argument('--release')
    args=parser.parse_args(argv)
    try:
        result=publish(args) if args.family=='publish' else {'bundle':bundle,'fetch-data':fetch_data,'verify':verify,'preview-config':preview_config}[args.command](args)
        if result is not None:print(json.dumps(result,sort_keys=True,indent=2))
        return 0
    except Exception as exc:
        print(str(exc) if isinstance(exc,ValueError) else 'Release tooling failed: '+type(exc).__name__,file=sys.stderr)
        return 2


if __name__=='__main__':
    raise SystemExit(main())
