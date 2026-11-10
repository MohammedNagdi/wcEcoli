"""Serving-only successor packaging after the completed HF-05 campaign."""

import json
import os
import shutil

import host


def prepare():
    completion = json.loads((host.STATE / "demo-completion.json").read_text())
    original = host.STATE / "demo-release"
    from demo_host import digest

    if digest(original / "manifest.json") != completion["release"]["manifest_sha256"]:
        raise RuntimeError(
            "HF-05 rollback publication changed; explorer packaging stopped"
        )
    proof = host.STATE / "proofs/hf06"
    proof.mkdir(parents=True, exist_ok=True)
    rollback = proof / "rollback.json"
    if not rollback.exists():
        host.write(
            rollback,
            dict(
                serving=json.loads((host.STATE / "serving.json").read_text()),
                release=completion["release"]["directory"],
                manifest_sha256=completion["release"]["manifest_sha256"],
            ),
        )
    names = [name for name, _ in host.source_files()]
    current = json.loads((host.STATE / "serving.json").read_text())
    if host.tree_hash(host.ROOT, names) != current["source_sha256"]:
        host.refresh_serving()
    result = json.loads(
        host.compose(
            "exec",
            "-T",
            "tools",
            "python",
            "-m",
            "hf_export.reference_export",
            "--base",
            json.loads(rollback.read_text())["release"],
            capture=True,
        )
    )
    if not result.get("valid"):
        raise RuntimeError("successor reference validation failed")
    destination = host.STATE / "explorer-release"
    if not destination.exists():
        temporary = host.STATE / ".explorer-release-copying"
        if temporary.exists():
            raise RuntimeError(
                "partial successor copy retained; inspect before retrying"
            )
        temporary.mkdir()
        for name in ("manifest.json", "references.json"):
            host.compose(
                "cp", "tools:" + result["directory"] + "/" + name, str(temporary / name)
            )
        manifest = json.loads((temporary / "manifest.json").read_text())
        for entry in manifest["files"]:
            relative = entry["path"]
            target = temporary / relative
            if relative != "references.json":
                source = original / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                # No scientific array is rewritten. Byte-identical payloads share storage.
                try:
                    os.link(source, target)
                except OSError:
                    shutil.copy2(source, target)
            if (
                target.stat().st_size != entry["bytes"]
                or digest(target) != entry["sha256"]
            ):
                raise RuntimeError("successor payload differs: " + relative)
        temporary.rename(destination)
    if digest(destination / "manifest.json") != result["manifest_sha256"]:
        raise RuntimeError("retained successor differs; refusing publication")
    # The original publication remains intact; only this serving symlink changes.
    host.compose(
        "exec",
        "-T",
        "tools",
        "python",
        "-c",
        "from pathlib import Path; from hf_export.explorer_export import activate_bundle; "
        'activate_bundle(Path("/release"),Path(' + repr(result["directory"]) + "))",
    )
    host.write(
        host.STATE / "explorer-release.json",
        dict(
            **result,
            serving=json.loads((host.STATE / "serving.json").read_text()),
            rollback=str(rollback),
            local_directory=str(destination),
        ),
    )
    print(
        "Explorer successor validated and activated; HF-05 publication and scientific shards retained."
    )
