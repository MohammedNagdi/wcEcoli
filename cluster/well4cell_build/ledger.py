"""Atomic files, JSONL, and the sbatch helper shared by the array stages."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .settings import Settings


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic_json(path: Path, payload: dict) -> None:
    """tmp -> fsync -> rename -> fsync(dir): never a torn file, durable at the rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, sort_keys=True, default=str) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fsync_dir(path.parent)


def temp_path_for(path: Path) -> Path:
    """A sibling temporary name; the caller renames it into place when complete."""
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")


def rename_into_place(temporary: Path, path: Path) -> None:
    with temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    temporary.replace(path)
    fsync_dir(path.parent)


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, sort_keys=True, default=str) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = temp_path_for(path)
    with temporary.open("w", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps(record, sort_keys=True, default=str) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fsync_dir(path.parent)


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def manifest_id(stage: str) -> str:
    # Microseconds keep names in creation order when two plans land in the same second
    # (the latest manifest is the last one in sorted order).
    return "{}_{}_{}".format(stage, datetime.now().strftime("%Y%m%d_%H%M%S_%f"), uuid.uuid4().hex[:6])


def sentinel_dir(settings: Settings, manifest: Path) -> Path:
    return manifest.with_name(manifest.stem + ".sentinels")


def format_array(indices: list[int]) -> str:
    """[0,1,2,5,7,8] -> '0-2,5,7-8'."""
    indices = sorted(set(indices))
    parts: list[str] = []
    start = previous = indices[0]
    for index in indices[1:]:
        if index == previous + 1:
            previous = index
            continue
        parts.append(str(start) if start == previous else "{}-{}".format(start, previous))
        start = previous = index
    parts.append(str(start) if start == previous else "{}-{}".format(start, previous))
    return ",".join(parts)


def squeue_names(prefix: str) -> list[str]:
    result = subprocess.run(["squeue", "-u", os.environ.get("USER", ""), "-h", "-o", "%j"],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return []
    return [name for name in result.stdout.split() if name.startswith(prefix)]


def sbatch(settings: Settings, stage: str, manifest: Path, indices: list[int], concurrency: int,
           time_limit: str | None = None, mem: str | None = None, dry_run: bool = False) -> tuple[str, str]:
    """Submit one array for a manifest, trying each account in turn."""
    array_spec = format_array(indices)
    if concurrency > 0:
        array_spec += "%{}".format(concurrency)
    job_name = "{}-{}".format(settings.job_prefix, stage)
    last_error = ""
    for account in settings.accounts:
        argv = [
            "sbatch", "--parsable",
            "--job-name", job_name,
            "--account", account,
            "--partition", settings.partition,
            "--array", array_spec,
            "--cpus-per-task", str(settings.cpus),
            "--mem", mem or settings.mem,
            "--time", time_limit or settings.time_limit,
            "--output", str(settings.log_dir / "%x-%A_%a.out"),
            "--error", str(settings.log_dir / "%x-%A_%a.out"),
            "--requeue",
            str(settings.repo_root / "cluster" / "well4cell.sbatch"), stage, str(manifest), str(settings.repo_root),
        ]
        if dry_run:
            print("would run: " + " ".join(shlex.quote(part) for part in argv))
            return "DRY-RUN", account
        result = subprocess.run(argv, capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            array_job_id = result.stdout.strip().split(";", 1)[0]
            append_jsonl(settings.dispatch_log, {
                "at": now(), "stage": stage, "array_job_id": array_job_id, "manifest": str(manifest),
                "indices": array_spec, "account": account, "concurrency": concurrency,
            })
            return array_job_id, account
        last_error = (result.stderr or result.stdout).strip()
        print("sbatch under account {} refused: {}".format(account, last_error), file=sys.stderr)
    raise SystemExit("sbatch failed under every account ({}): {}".format(", ".join(settings.accounts), last_error))
