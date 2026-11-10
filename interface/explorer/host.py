"""Build reviewed local upload trees and manage only project wcecoli-explorer.

Host orchestration is standard-library only. Neither these commands nor the
generated packages contain upload operations or credentials.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
STATE = ROOT / "interface/.explorer"
RELEASE = ROOT / "interface/.pilot/explorer-release"
BACKEND = ROOT / "interface/backend"
FRONTEND = ROOT / "interface/frontend"
PROJECT = "wcecoli-explorer"
MODULES = (
    "__init__.py", "converter.py", "demo_campaign.py", "explorer_contract.py",
    "explorer_routes.py", "preview.py", "production.py", "release_bootstrap.py",
)
CONFIGS = ("package.json", "package-lock.json", "index.html", "tsconfig.json",
           "vite.config.ts", "tailwind.config.js", "postcss.config.js")
TOKEN = re.compile(r"\bhf_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY")


def sha(path):
    with path.open("rb") as stream:
        value = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
        return value.hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def inventory(directory):
    return {p.relative_to(directory).as_posix(): dict(bytes=p.stat().st_size, sha256=sha(p))
            for p in sorted(directory.rglob("*")) if p.is_file()}


def notices():
    """Preserve installed, locked frontend runtime package license texts."""
    lock = json.loads((FRONTEND / "package-lock.json").read_text())
    parts = ["Third-party frontend dependency notices\n\n"
             "The original wcEcoli license is in LICENSE.md. Python distributions\n"
             "and OS packages retain their own license records inside the image.\n"]
    for name, info in sorted(lock["packages"].items()):
        if not name or info.get("dev"):
            continue
        directory = FRONTEND / name
        package = directory / "package.json"
        if not package.exists():
            raise ValueError("Run npm ci before packaging; missing runtime dependency " + name)
        installed = json.loads(package.read_text())
        if installed["version"] != info["version"]:
            raise ValueError("Installed frontend dependency differs from lock: " + name)
        license_files = [p for p in sorted(directory.iterdir()) if p.is_file()
                         and p.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE"))]
        parts.append(f"\n\n--- {installed['name']} {installed['version']} ---\n"
                     f"Declared license: {installed.get('license', info.get('license', 'see package'))}\n")
        parts.extend(p.name + "\n" + p.read_text(errors="replace") for p in license_files)
    parts.append((FRONTEND / "public/assistant-rendering-notices.txt").read_text())
    return "\n".join(parts)


def inputs():
    files = {"Dockerfile": HERE / "Dockerfile", "README.md": HERE / "Space.README.md",
             "PUBLICATION.md": HERE / "PUBLICATION.md", "LICENSE.md": ROOT / "LICENSE.md",
             "requirements.lock": HERE / "requirements.lock"}
    files.update({"hf_export/" + name: BACKEND / "hf_export" / name for name in MODULES})
    files["hf_export/campaigns/hf-demo-v1.json"] = BACKEND / "hf_export/campaigns/hf-demo-v1.json"
    files.update({"frontend/" + name: FRONTEND / name for name in CONFIGS})
    for directory, suffixes in (("src", {".ts", ".tsx", ".css", ".json"}),
                                ("public-explorer", {".webp"})):
        for p in sorted((FRONTEND / directory).rglob("*")):
            if p.is_file() and p.suffix in suffixes:
                files["frontend/" + p.relative_to(FRONTEND).as_posix()] = p
    return files


def data_copy(expected):
    from importlib.util import module_from_spec, spec_from_file_location
    spec = spec_from_file_location("hf07_bootstrap", BACKEND / "hf_export/release_bootstrap.py")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_payloads(RELEASE, expected)
    store = STATE / "datasets" / expected
    if store.exists():
        module.verify_payloads(store, expected)
        return store
    python = BACKEND / ".venv/bin/python"
    result = subprocess.run([str(python), "-m", "hf_export.explorer_contract", str(RELEASE)],
                            env={**os.environ, "PYTHONPATH": str(BACKEND)},
                            capture_output=True, text=True, check=True)
    if not json.loads(result.stdout)["valid"]:
        raise ValueError("Original HF-06 release failed strict validation")
    store.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".copy-", dir=store.parent) as temp:
        stage = Path(temp) / "release"
        shutil.copytree(RELEASE, stage)
        module.verify_payloads(stage, expected)
        stage.rename(store)
    return store


def bundle():
    STATE.mkdir(parents=True, exist_ok=True)
    source = inputs()
    for name, p in source.items():
        if p.is_symlink() or not p.is_file():
            raise ValueError("Missing or symlinked allowed source: " + name)
        if p.suffix != ".webp" and TOKEN.search(p.read_text()):
            raise ValueError("Credential-like content found in allowed source: " + name)
    expected = sha(RELEASE / "manifest.json")
    # A new release needs an explicit code/config review, not a silent latest-data switch.
    if expected != "5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18":
        raise ValueError("HF-06 release changed; review the expected production fingerprint")
    records = {name: sha(p) for name, p in source.items()}
    orchestration = {"host.py": HERE / "host.py", "root-platform.sh": ROOT / "platform.sh",
                     "interface-platform.sh": ROOT / "interface/platform.sh"}
    records.update({"orchestration/" + name: sha(p) for name, p in orchestration.items()})
    third_party = notices()
    records["THIRD_PARTY_NOTICES.txt"] = hashlib.sha256(third_party.encode()).hexdigest()
    records["dataset/README.md"] = sha(HERE / "Dataset.README.md")
    source_sha = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
    destination = STATE / "bundles" / source_sha[:20]
    receipt_file = destination / "evidence/package.json"
    if receipt_file.exists():
        receipt = json.loads(receipt_file.read_text())
        for name in ("space", "dataset"):
            if inventory(destination / name) != receipt[name + "_inventory"]:
                raise ValueError("Frozen package has changed: " + name)
        write(STATE / "current.json", receipt)
        return receipt
    store = data_copy(expected)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".bundle-", dir=destination.parent) as temp:
        stage = Path(temp)
        for name, p in source.items():
            target = stage / "space" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
        (stage / "space/THIRD_PARTY_NOTICES.txt").write_text(third_party)
        # Links share only the generated checkpoint, never the original HF-06 publication.
        shutil.copytree(store, stage / "dataset/release", copy_function=os.link)
        for name, src in (("README.md", HERE / "Dataset.README.md"),
                          ("LICENSE.md", ROOT / "LICENSE.md"),
                          ("PUBLICATION.md", HERE / "PUBLICATION.md")):
            shutil.copy2(src, stage / "dataset" / name)
        receipt = dict(schema_version="explorer-package-v1", source_sha256=source_sha,
                       manifest_sha256=expected, image="wcecoli-explorer:" + source_sha[:20],
                       bundle=str(destination.relative_to(ROOT)), publication="not uploaded; permission unresolved",
                       source_inventory=records, space_inventory=inventory(stage / "space"),
                       dataset_inventory=inventory(stage / "dataset"))
        receipt["dataset_bytes"] = sum(f["bytes"] for f in receipt["dataset_inventory"].values())
        receipt["space_bytes"] = sum(f["bytes"] for f in receipt["space_inventory"].values())
        if receipt["dataset_bytes"] > 10_000_000_000:
            raise ValueError("Complete Dataset upload package exceeds 10 GB; explicit review required")
        write(stage / "evidence/package.json", receipt)
        for name, p in orchestration.items():
            target = stage / "evidence/orchestration" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
        # TemporaryDirectory owns temp; move only its contents into the immutable destination.
        stage.rename(destination)
    write(STATE / "current.json", receipt)
    return receipt


def compose_config(receipt, env):
    mode = env.get("EXPLORER_DATA_MODE", "local")
    if mode not in {"local", "hub"}:
        raise ValueError("EXPLORER_DATA_MODE must be local or hub")
    base = ROOT / receipt["bundle"]
    return dict(name=PROJECT, services=dict(web=dict(
        image=receipt["image"], build=dict(context=str(base / "space")),
        ports=["127.0.0.1:7860:7860"], cpus=2, mem_limit="512m", read_only=True,
        tmpfs=["/tmp:rw,nosuid,size=64m,mode=1777"], stop_grace_period="25s",
        security_opt=["no-new-privileges:true"], cap_drop=["ALL"],
        environment=dict(EXPLORER_DATA_MODE=mode,
            EXPLORER_RELEASE="/published" if mode == "local" else "/data/current",
            EXPLORER_MANIFEST_SHA256=receipt["manifest_sha256"],
            EXPLORER_DATASET_REPO=env.get("EXPLORER_DATASET_REPO", ""),
            EXPLORER_DATASET_REVISION=env.get("EXPLORER_DATASET_REVISION", ""),
            EXPLORER_DATASET_DIR="release", HF_TOKEN="${HF_TOKEN:-}"),
        volumes=[dict(type="bind", source=str(base / "dataset/release"), target="/published", read_only=True),
                 dict(type="volume", source="cache", target="/data")],
    )), volumes=dict(cache=dict(name=PROJECT + "_cache")))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["bundle", "up", "ps", "logs", "config", "stop"])
    args, extra = parser.parse_known_args(argv)
    if args.command == "config" and extra != ["--quiet"]:
        parser.error("Only config --quiet is supported, to avoid printing runtime secrets")
    if args.command in {"bundle", "stop", "ps"} and extra:
        parser.error("This command accepts no additional arguments")
    if args.command == "up" and any(x not in {"-d", "--build"} for x in extra):
        parser.error("Supported startup: up -d --build")
    if args.command == "logs" and any(not re.fullmatch(r"--tail=\d+|--follow|-f|web", x) for x in extra):
        parser.error("Logs accepts --tail=N, --follow/-f and optional web")
    try:
        receipt = bundle() if args.command in {"bundle", "up"} else json.loads((STATE / "current.json").read_text())
        if args.command == "bundle":
            print(json.dumps({k: receipt[k] for k in ("bundle", "image", "manifest_sha256", "dataset_bytes", "space_bytes")}, indent=2))
            return 0
        # Config includes only an interpolation placeholder; no token is written.
        config = STATE / "compose.json"
        write(config, compose_config(receipt, os.environ))
        empty_env = STATE / "empty.env"
        empty_env.write_text("# No credentials. Configuration uses explicit shell variables only.\n")
        env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
        cmd = ["docker", "compose", "--project-name", PROJECT, "--project-directory", str(STATE),
               "--env-file", str(empty_env), "--file", str(config)]
        if args.command == "up":
            existing = subprocess.run(cmd + ["ps", "--status", "running", "--quiet", "web"],
                                      env=env, text=True, capture_output=True, check=True).stdout.strip()
            if not existing:
                with socket.socket() as probe:
                    try:
                        probe.bind(("127.0.0.1", 7860))
                    except OSError:
                        raise ValueError("Port 7860 is occupied; no existing services were stopped") from None
        os.execvpe("docker", cmd + [args.command, *extra], env)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        # Subprocess errors may contain only our fixed arguments, never env values.
        print("Explorer: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
