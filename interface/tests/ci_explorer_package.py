"""Archive the Phase 3 bundle and verify it before CI or local rehearsal uses it."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "explorer"))
import portable


ARCHIVE_LIMIT = 100 * 1024**2


def archive_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_package(directory, revision, fingerprint=None):
    receipt, _ = portable.load_bundle(directory)
    if (
        receipt["schema_version"] != "explorer-package-v2"
        or receipt["source_revision"] != revision
        or receipt["release"] != portable.descriptor()
        or receipt["manifest_sha256"] != receipt["release"]["dataset"]["manifest_sha256"]
        or (fingerprint is not None and receipt["source_sha256"] != fingerprint)
    ):
        raise ValueError("Bundle source or release identity differs from the expected candidate")
    expected_files = set(portable.host.inputs()) | {"THIRD_PARTY_NOTICES.txt"}
    if set(receipt["space_inventory"]) != expected_files:
        raise ValueError("Bundle files differ from the application allowlist")
    return receipt


def pack(directory, archive, revision):
    receipt = validate_package(directory, revision)
    with tarfile.open(archive, "x:gz") as output:
        output.add(directory / "space", arcname="space")
        output.add(directory / "evidence" / "package.json", arcname="evidence/package.json")
    return {"sha256": archive_digest(archive), "fingerprint": receipt["source_sha256"]}


def unpack(archive, directory, revision, sha256, fingerprint):
    if archive.stat().st_size > ARCHIVE_LIMIT or archive_digest(archive) != sha256:
        raise ValueError("Application archive digest or size differs")
    if directory.exists() or directory.is_symlink():
        raise ValueError("Select a fresh extraction directory")
    with tempfile.TemporaryDirectory(dir=directory.parent) as temporary:
        stage = Path(temporary) / "bundle"
        stage.mkdir()
        with tarfile.open(archive, "r:gz") as source:
            names = set()
            total = 0
            for member in source:
                name = PurePosixPath(member.name)
                if (
                    name.is_absolute()
                    or ".." in name.parts
                    or name.as_posix() != member.name
                    or name in names
                    or not (member.isdir() or member.isfile())
                    or not (
                        member.name == "evidence/package.json" and member.isfile()
                        or member.name == "space" and member.isdir()
                        or len(name.parts) > 1 and name.parts[0] == "space"
                    )
                ):
                    raise ValueError("Unexpected application archive entry")
                names.add(name)
                total += member.size
                if total > ARCHIVE_LIMIT or len(names) > 2000:
                    raise ValueError("Application archive exceeds extraction limits")
                source.extract(member, stage, filter="data")
        receipt = validate_package(stage, revision, fingerprint)
        stage.rename(directory)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("pack", "unpack"):
        command = commands.add_parser(name)
        command.add_argument("--bundle", type=Path, required=True)
        command.add_argument("--archive", type=Path, required=True)
        command.add_argument("--revision", required=True)
    commands.choices["unpack"].add_argument("--sha256", required=True)
    commands.choices["unpack"].add_argument("--fingerprint", required=True)
    args = parser.parse_args()
    if args.command == "pack":
        values = pack(args.bundle, args.archive, args.revision)
        if output := os.environ.get("GITHUB_OUTPUT"):
            with Path(output).open("a") as stream:
                for key, value in values.items():
                    stream.write(f"{key}={value}\n")
        print(json.dumps(values))
    else:
        unpack(args.archive, args.bundle, args.revision, args.sha256, args.fingerprint)


if __name__ == "__main__":
    main()
