#!/usr/bin/env python
"""Push campaign output to a Hugging Face bucket, one SLURM array task per shard.

Run through ``cluster/hfx`` (which sources cluster/transfer_env.sh first)::

    plan        snapshot what still needs transferring into a manifest of shards
    dispatch    submit one array for a manifest, after the safety checks
    pilot       plan one shard and dispatch it at concurrency 1
    run         (inside the array task) transfer one shard; always exits 0
    reconcile   fold sentinels into the ledger, report lost or failed work
    status      what is transferred, pending, in flight, failed
    report      measured throughput from the sentinels

Vocabulary
----------
unit      the thing one ``hf sync`` call moves: one experiment directory under out/,
          one parca cache, or the whole logs/ or state/ tree. A unit is done or not.
shard     ~SHARD_SIZE units, transferred sequentially by one array task.
manifest  the frozen list of shards for one plan (JSONL, one shard per line).
sentinel  the atomically written per-unit (and per-shard) outcome the task leaves
          behind; the only channel from the task back to the controller.
ledger    the append-only, fsync'd record of every unit outcome ever reconciled.
          "Done" means the unit's latest ledger entry says ok.

Durability comes from the ledger, not from the job. The task always exits 0 and a
re-run of a shard skips units whose success sentinel is already there, so a requeue, a
node failure and a retry dispatch are the same code path. The bucket is never told to
delete anything, and nothing under the campaign root is ever deleted or modified.

Symlinks: the per-experiment ``kb -> ../parca_cache_<hash>/kb`` link is the only record
of which parca cache an experiment used, and ``hf sync`` silently drops directory
symlinks. Each one is therefore uploaded as a tiny ``<name>.symlink`` object holding the
link target, and all of them are indexed in ``transfer/symlinks.jsonl`` at bucket root.

Stdlib-only, no ``app.*`` imports: this runs under the wcecoli-hf environment, which
exists only to provide the ``hf`` CLI (huggingface_hub>=2.1, Python>=3.10).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shlex
import sqlite3
import stat
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

README_NAME = "README.md"
SYMLINK_INDEX_NAME = "symlinks.jsonl"
MARKER_SUFFIX = ".symlink"
META_UNIT = "transfer"
KIND_ORDER = ("parca", "experiment", "logs", "state", "meta")
PARCA_PREFIX = "parca_cache_"


# =============================================================================
# Configuration
# =============================================================================


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "")
    return value if value.strip() else default


def _env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in _env(name, default).split(",") if item.strip()]


@dataclass
class Settings:
    """Every knob, read once from the environment (see cluster/transfer_env.sh)."""

    campaign_root: Path
    transfer_root: Path
    dest: str
    token_path: Path
    hf_bin: str
    shard_size: int
    concurrency: int
    retries: int
    partition: str
    accounts: list[str]
    cpus: int
    mem: str
    time_limit: str
    requeue: bool
    guard_prefixes: list[str]
    job_prefix: str
    exclude: list[str]
    state_exclude: list[str]
    statuses: list[str]
    database: Path
    repo_root: Path

    @classmethod
    def from_env(cls) -> "Settings":
        repo_root = Path(__file__).resolve().parent.parent
        root = _env("WCECOLI_CAMPAIGN_ROOT", "")
        if not root:
            raise SystemExit("WCECOLI_CAMPAIGN_ROOT is not set; source cluster/transfer_env.sh")
        campaign_root = Path(root).expanduser()
        return cls(
            campaign_root=campaign_root,
            transfer_root=Path(_env("WCECOLI_TRANSFER_ROOT", str(campaign_root / "transfer"))),
            dest=_env("WCECOLI_TRANSFER_DEST", "").rstrip("/"),
            token_path=Path(_env("HF_TOKEN_PATH", "~/.config/huggingface/well4cell.token")).expanduser(),
            hf_bin=_env("WCECOLI_HF_BIN", "hf"),
            shard_size=int(_env("WCECOLI_TRANSFER_SHARD_SIZE", "100")),
            concurrency=int(_env("WCECOLI_TRANSFER_CONCURRENCY", "16")),
            retries=int(_env("WCECOLI_TRANSFER_RETRIES", "3")),
            partition=_env("WCECOLI_TRANSFER_PARTITION", "cpu-g2"),
            accounts=_env_list("WCECOLI_TRANSFER_ACCOUNTS", "cpu-g2-amath,cpu-g2-stf"),
            cpus=int(_env("WCECOLI_TRANSFER_CPUS", "2")),
            mem=_env("WCECOLI_TRANSFER_MEM", "4G"),
            time_limit=_env("WCECOLI_TRANSFER_TIME", "02:00:00"),
            requeue=_env("WCECOLI_TRANSFER_REQUEUE", "1") not in ("0", "false", "no"),
            guard_prefixes=_env_list("WCECOLI_TRANSFER_GUARD_PREFIXES", "wce"),
            job_prefix=_env("WCECOLI_TRANSFER_JOB_PREFIX", "hfx"),
            exclude=_env_list("WCECOLI_TRANSFER_EXCLUDE", "*.tmp"),
            state_exclude=_env_list(
                "WCECOLI_TRANSFER_STATE_EXCLUDE",
                "assistant_secret.key,wcecoli.db.bak-*,wcecoli.db.lock,wcecoli.db-journal",
            ),
            statuses=_env_list("WCECOLI_TRANSFER_STATUSES", "done"),
            database=Path(_env("DATABASE_PATH", str(campaign_root / "state" / "wcecoli.db"))),
            repo_root=repo_root,
        )

    # -- layout ---------------------------------------------------------------
    @property
    def manifest_dir(self) -> Path:
        return self.transfer_root / "manifests"

    @property
    def log_dir(self) -> Path:
        return self.transfer_root / "logs"

    @property
    def meta_dir(self) -> Path:
        """Local staging for the objects that land under <dest>/transfer/."""
        return self.transfer_root / "bucket_meta"

    @property
    def ledger(self) -> Path:
        return self.transfer_root / "transfer_ledger.jsonl"

    @property
    def dispatch_log(self) -> Path:
        return self.transfer_root / "dispatch_log.jsonl"

    @property
    def bucket_id(self) -> str:
        match = re.match(r"^hf://buckets/([^/]+/[^/]+)", self.dest)
        if not match:
            raise SystemExit("WCECOLI_TRANSFER_DEST must look like hf://buckets/<namespace>/<bucket>[/prefix]")
        return match.group(1)

    def ensure_layout(self) -> None:
        for path in (self.manifest_dir, self.log_dir, self.meta_dir):
            path.mkdir(parents=True, exist_ok=True)


# =============================================================================
# Small utilities
# =============================================================================


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_atomic(path: Path, payload: dict) -> None:
    """tmp -> fsync -> rename -> fsync(dir): a reader never sees a torn file, and the
    file survives a node loss the instant the rename returns."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    _fsync_dir(path.parent)


def _append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, sort_keys=True, default=str) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _run(argv: list[str], *, timeout: int = 120, stdin: str | None = None,
         env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv, input=stdin, capture_output=True, text=True, timeout=timeout, env=env, check=False,
    )


def _unit_slug(unit: str) -> str:
    return unit.replace("/", "__")


def _excluded(rel_path: str, patterns: list[str]) -> bool:
    """Mirror hf sync's filter: fnmatchcase on the '/'-joined relative path."""
    return any(fnmatch.fnmatchcase(rel_path, pattern) for pattern in patterns)


def _walk_unit(src: Path, patterns: list[str]) -> tuple[int, int]:
    """(files, bytes) that hf sync will consider: regular files, directory symlinks
    not followed, file symlinks dereferenced, exclusions applied."""
    files = 0
    size = 0
    for root, _dirs, names in os.walk(src):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(src).as_posix()
            if _excluded(rel, patterns):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode):
                continue
            files += 1
            size += st.st_size
    return files, size


def _find_symlinks(src: Path) -> list[dict]:
    """Every symlink under src, as {path, target}. Directory symlinks are not
    descended, exactly as hf sync's walker behaves. scandir rather than os.walk: on GPFS
    the per-entry lstat os.walk needs is what makes a 32,000-directory plan slow."""
    found = []
    stack = [src]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.is_symlink():
                        found.append({
                            "path": Path(entry.path).relative_to(src).as_posix(),
                            "target": os.readlink(entry.path),
                        })
                    elif entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
        except OSError:
            continue
    found.sort(key=lambda item: item["path"])
    return found


def _symlinks_for(settings: Settings, units: list[tuple[str, str]]) -> dict[str, list[dict]]:
    """unit -> symlinks, walked once and in parallel: the walk is metadata-latency bound
    on GPFS, so threads buy an order of magnitude."""
    targets = [unit for unit, kind in units if kind in ("experiment", "parca")]
    with ThreadPoolExecutor(max_workers=32) as pool:
        walked = pool.map(lambda unit: _find_symlinks(settings.campaign_root / unit), targets)
        return dict(zip(targets, walked))


def _parse_shards(spec: str, count: int) -> list[int]:
    """'0,3-5' -> [0, 3, 4, 5], validated against the manifest size."""
    chosen: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            low, high = part.split("-", 1)
            chosen.update(range(int(low), int(high) + 1))
        else:
            chosen.add(int(part))
    bad = [index for index in chosen if index < 0 or index >= count]
    if bad:
        raise SystemExit("shard index out of range for this manifest: {}".format(sorted(bad)))
    return sorted(chosen)


def _format_array(indices: list[int]) -> str:
    """[0,1,2,5,7,8] -> '0-2,5,7-8' so sbatch gets a compact spec."""
    if not indices:
        return ""
    runs = []
    start = prev = indices[0]
    for index in indices[1:]:
        if index == prev + 1:
            prev = index
            continue
        runs.append((start, prev))
        start = prev = index
    runs.append((start, prev))
    return ",".join(str(a) if a == b else "{}-{}".format(a, b) for a, b in runs)


# =============================================================================
# Units and the ledger
# =============================================================================


def _dest_for(settings: Settings, unit: str) -> str:
    return settings.dest + "/" + unit


def _unit_record(settings: Settings, unit: str, kind: str, symlinks: list[dict]) -> dict:
    src = settings.campaign_root / unit if kind != "meta" else settings.meta_dir
    patterns = list(settings.exclude)
    if kind == "state":
        patterns.extend(settings.state_exclude)
    return {
        "unit": unit,
        "kind": kind,
        "src": str(src),
        "dest": _dest_for(settings, unit),
        "exclude": patterns,
        "symlinks": symlinks,
    }


def _discover_units(settings: Settings) -> list[tuple[str, str]]:
    """(unit, kind) for everything under the campaign root that is transferable, in
    transfer order: parca caches, experiments by name, logs, state, then the meta unit."""
    out_dir = settings.campaign_root / "out"
    parcas: list[str] = []
    experiments: list[str] = []
    if out_dir.is_dir():
        with os.scandir(out_dir) as entries:
            for entry in entries:
                # is_dir() follows symlinks; a symlinked run directory would be dropped by
                # hf sync anyway, so only real directories count.
                if entry.is_symlink() or not entry.is_dir():
                    continue
                (parcas if entry.name.startswith(PARCA_PREFIX) else experiments).append(entry.name)
    units = [("out/" + name, "parca") for name in sorted(parcas)]
    units += [("out/" + name, "experiment") for name in sorted(experiments)]
    for name in ("logs", "state"):
        if (settings.campaign_root / name).is_dir():
            units.append((name, name))
    units.append((META_UNIT, "meta"))
    return units


def _job_statuses(settings: Settings) -> dict[str, str]:
    """run directory name -> job status, read-only from the campaign database. The
    database is the authority on which runs are finished; the filesystem only knows
    which directories exist (failed attempts leave one too)."""
    if not settings.database.is_file():
        raise SystemExit("campaign database not found at {} (set DATABASE_PATH)".format(settings.database))
    uri = "file:{}?mode=ro".format(settings.database)
    with sqlite3.connect(uri, uri=True, timeout=60) as connection:
        rows = connection.execute("SELECT sim_dir, status FROM simulation_jobs WHERE sim_dir IS NOT NULL")
        return {os.path.basename(sim_dir.rstrip("/")): status for sim_dir, status in rows}


def _filter_by_status(settings: Settings, units: list[tuple[str, str]],
                      statuses: list[str]) -> tuple[list[tuple[str, str]], dict[str, int]]:
    """Keep experiment units whose job status is in `statuses` ("all" disables the
    filter). Parca caches, logs, state and meta are never filtered."""
    if "all" in statuses:
        return units, {}
    by_dir = _job_statuses(settings)
    kept = []
    dropped: dict[str, int] = {}
    for unit, kind in units:
        if kind != "experiment":
            kept.append((unit, kind))
            continue
        status = by_dir.get(unit.split("/", 1)[1], "not in database")
        if status in statuses:
            kept.append((unit, kind))
        else:
            dropped[status] = dropped.get(status, 0) + 1
    return kept, dropped


def _ledger_state(settings: Settings) -> dict[str, dict]:
    """unit -> its latest ledger record."""
    latest: dict[str, dict] = {}
    for record in _read_jsonl(settings.ledger):
        latest[record["unit"]] = record
    return latest


def _done_units(settings: Settings) -> set[str]:
    return {unit for unit, record in _ledger_state(settings).items() if record.get("status") == "ok"}


# =============================================================================
# Guards
# =============================================================================


def _queued_job_names() -> list[str]:
    user = os.environ.get("USER") or os.environ.get("LOGNAME") or ""
    result = _run(["squeue", "-u", user, "-h", "-o", "%j"])
    if result.returncode != 0:
        raise SystemExit("squeue failed: {}".format(result.stderr.strip()))
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _guard_campaign_idle(settings: Settings, force: bool) -> None:
    """Refuse while campaign jobs are queued: a snapshot taken under a writer is stale
    before it is dispatched, and a task could sync a run directory mid-write."""
    busy = [name for name in _queued_job_names()
            if any(name.startswith(prefix) for prefix in settings.guard_prefixes)]
    if busy:
        message = "campaign jobs are in squeue ({} job(s), e.g. {}); not starting a transfer".format(
            len(busy), ", ".join(sorted(set(busy))[:3]))
        if force:
            print("WARNING: {} -- overridden by --force".format(message), file=sys.stderr)
        else:
            raise SystemExit(message + " (use --force to override)")


def _guard_no_active_transfer(settings: Settings, force: bool) -> None:
    active = [name for name in _queued_job_names() if name.startswith(settings.job_prefix + "-")]
    if active:
        message = "a transfer array is still in squeue ({}); dispatching another would race it".format(
            ", ".join(sorted(set(active))))
        if force:
            print("WARNING: {} -- overridden by --force".format(message), file=sys.stderr)
        else:
            raise SystemExit(message + " (use --force to override)")


def _guard_token(settings: Settings) -> None:
    path = settings.token_path
    if not path.is_file():
        raise SystemExit("HF token file missing: {} (see cluster/RUN_SLURM.md)".format(path))
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise SystemExit("HF token file {} has mode {:o}; it must be 600".format(path, mode))
    home = Path.home().resolve()
    resolved = path.resolve()
    if home not in resolved.parents:
        raise SystemExit("HF token file must live under {}; got {}".format(home, resolved))
    for forbidden in (settings.campaign_root, settings.repo_root):
        if forbidden.resolve() in resolved.parents:
            raise SystemExit("HF token file must not live under {}".format(forbidden))


def _hf_env(settings: Settings) -> dict:
    env = dict(os.environ)
    env["HF_TOKEN_PATH"] = str(settings.token_path)
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    return env


def _bucket_info(settings: Settings) -> dict:
    result = _run([settings.hf_bin, "buckets", "info", settings.bucket_id, "--json"],
                  env=_hf_env(settings), timeout=120)
    if result.returncode != 0:
        raise SystemExit("cannot read bucket {}: {}".format(
            settings.bucket_id, (result.stderr or result.stdout).strip().splitlines()[-1:]))
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise SystemExit("unexpected `hf buckets info` output: {!r}".format(result.stdout[:200]))


def _guard_bucket(settings: Settings, allow_public: bool) -> dict:
    """The bucket must exist (creating one is a human, org-level act) and must be private
    unless explicitly allowed: a public bucket makes every byte world-readable the moment
    it lands, and state/ contains the campaign database."""
    info = _bucket_info(settings)
    if not info.get("private", False):
        message = "bucket {} is PUBLIC; everything uploaded is world-readable immediately".format(settings.bucket_id)
        if allow_public:
            print("WARNING: {} -- allowed by --allow-public".format(message), file=sys.stderr)
        else:
            raise SystemExit(message + " (run `hf buckets settings {} --private`, or pass --allow-public)".format(
                settings.bucket_id))
    return info


# =============================================================================
# plan
# =============================================================================


def _write_bucket_meta(settings: Settings, units: list[tuple[str, str]],
                       symlinks: dict[str, list[dict]]) -> None:
    """Regenerate the staging dir for <dest>/transfer/: the symlink index over every
    experiment and parca directory currently present, and a README describing the layout."""
    settings.meta_dir.mkdir(parents=True, exist_ok=True)
    index_path = settings.meta_dir / SYMLINK_INDEX_NAME
    temporary = index_path.with_name(index_path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for unit, kind in units:
            if kind not in ("experiment", "parca"):
                continue
            for link in symlinks.get(unit, []):
                stream.write(json.dumps({
                    "path": unit + "/" + link["path"],
                    "target": link["target"],
                    "marker": unit + "/" + link["path"] + MARKER_SUFFIX,
                }, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(index_path)

    readme = settings.meta_dir / README_NAME
    readme.write_text(
        "# well4cell campaign transfer\n\n"
        "Mirror of a wcEcoli campaign root pushed from UW Hyak (klone) by `cluster/transfer.py`\n"
        "in the wcEcoli repository, branch `feature/wcecoli-platform`.\n\n"
        "## Layout\n\n"
        "| Prefix | Contents |\n|---|---|\n"
        "| `out/parca_cache_<hash>/` | The frozen Parca knowledge bases every simulation read |\n"
        "| `out/<timestamp>_<variant>_job<N>_attempt<K>/` | One simulation job: `export/` (pruned HDF5 + per-generation parquet), `metadata/`, and the variant tree with its `kb/simData_Modified.cPickle` |\n"
        "| `logs/` | SLURM stdout of every array task |\n"
        "| `state/` | Campaign database, manifests, sentinels, dispatch and campaign ledgers |\n"
        "| `transfer/` | This file and `symlinks.jsonl` |\n\n"
        "## Symlinks\n\n"
        "Object storage has no symlinks. On disk every job directory holds `kb -> ../parca_cache_<hash>/kb`,\n"
        "the only record of which Parca cache that job used. Each such link is represented here by a\n"
        "small object named `<link path>.symlink` (for example `out/<job>/kb.symlink`) whose content is the\n"
        "link target exactly as `readlink` prints it. `transfer/symlinks.jsonl` indexes all of them as\n"
        "`{\"path\", \"target\", \"marker\"}` lines. The linked directories themselves are not duplicated.\n\n"
        "## Excluded\n\n"
        "Transient files (`*.tmp`), the campaign database's backups, lock and journal files, and the\n"
        "platform's secret key are not transferred.\n",
        encoding="utf-8",
    )


def cmd_plan(settings: Settings, args: argparse.Namespace) -> dict:
    settings.ensure_layout()
    _guard_campaign_idle(settings, args.force)

    everything = _discover_units(settings)
    statuses = args.status or settings.statuses
    eligible, dropped = _filter_by_status(settings, everything, statuses)
    only = set(args.only or [])
    done = set() if args.verify else _done_units(settings)
    pending = [(unit, kind) for unit, kind in eligible
               if (not only or kind in only) and (unit not in done or kind == "meta")]
    if only and "meta" not in only:
        pending = [(unit, kind) for unit, kind in pending if kind != "meta"]
    if all(kind == "meta" for _unit, kind in pending):
        # The meta unit rides along with real work; alone it is not worth an array.
        pending = []

    # The symlink index covers every eligible run, not just this plan's shards.
    symlinks = _symlinks_for(settings, eligible)
    _write_bucket_meta(settings, eligible, symlinks)

    shard_size = args.shard_size or settings.shard_size
    shards = [pending[i:i + shard_size] for i in range(0, len(pending), shard_size)]
    if args.shards is not None:
        shards = shards[:args.shards]
    excluded = ", ".join("{}={}".format(status, count) for status, count in sorted(dropped.items()))
    if excluded:
        print("status filter {}: left out {}".format("/".join(statuses), excluded))
    if not shards:
        print("nothing to plan: {} eligible unit(s), {} already done".format(len(eligible), len(done)))
        return {"plan_id": None, "shards": 0, "units": 0}

    plan_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
    manifest = settings.manifest_dir / (plan_id + ".jsonl")
    temporary = manifest.with_name(manifest.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        for index, shard in enumerate(shards):
            stream.write(json.dumps({
                "index": index,
                "plan_id": plan_id,
                "planned_at": _now(),
                "statuses": statuses,
                "units": [_unit_record(settings, unit, kind, symlinks.get(unit, [])) for unit, kind in shard],
            }, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(manifest)
    _fsync_dir(manifest.parent)

    planned = sum(len(shard) for shard in shards)
    by_kind: dict[str, int] = {}
    for shard in shards:
        for _unit, kind in shard:
            by_kind[kind] = by_kind.get(kind, 0) + 1
    print("plan {}: {} shard(s), {} unit(s) [{}]; {} eligible, {} already done, manifest {}".format(
        plan_id, len(shards), planned,
        ", ".join("{}={}".format(kind, by_kind[kind]) for kind in KIND_ORDER if kind in by_kind),
        len(eligible), len(done), manifest))
    return {"plan_id": plan_id, "manifest": str(manifest), "shards": len(shards), "units": planned}


# =============================================================================
# dispatch
# =============================================================================


def _latest_manifest(settings: Settings) -> Path:
    dispatched = {record["manifest"] for record in _read_jsonl(settings.dispatch_log)}
    candidates = sorted(settings.manifest_dir.glob("*.jsonl"))
    fresh = [path for path in candidates if str(path) not in dispatched]
    if fresh:
        return fresh[-1]
    if candidates:
        raise SystemExit("every manifest has been dispatched; run `plan` first, or pass --manifest "
                         "with --shards to retry part of one")
    raise SystemExit("no manifest found; run `plan` first")


def _read_manifest(path: Path) -> list[dict]:
    shards = _read_jsonl(path)
    if not shards:
        raise SystemExit("manifest {} is empty".format(path))
    return shards


def _sbatch(settings: Settings, manifest: Path, indices: list[int], concurrency: int,
            job_name: str, dry_run: bool) -> tuple[str, str]:
    """Submit, trying each account in turn; returns (array_job_id, account)."""
    array_spec = _format_array(indices)
    if concurrency > 0:
        array_spec += "%{}".format(concurrency)
    last_error = ""
    for account in settings.accounts:
        argv = [
            "sbatch", "--parsable",
            "--job-name", job_name,
            "--account", account,
            "--partition", settings.partition,
            "--array", array_spec,
            "--cpus-per-task", str(settings.cpus),
            "--mem", settings.mem,
            "--time", settings.time_limit,
            "--output", str(settings.log_dir / "%x-%A_%a.out"),
            "--error", str(settings.log_dir / "%x-%A_%a.out"),
        ]
        if settings.requeue:
            argv.append("--requeue")
        argv += [str(settings.repo_root / "cluster" / "transfer.sbatch"), str(manifest), str(settings.repo_root)]
        if dry_run:
            print("would run: " + " ".join(shlex.quote(part) for part in argv))
            return "DRY-RUN", account
        result = _run(argv)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split(";", 1)[0], account
        last_error = (result.stderr or result.stdout).strip()
        print("sbatch under account {} refused: {}".format(account, last_error), file=sys.stderr)
    raise SystemExit("sbatch failed under every account ({}): {}".format(", ".join(settings.accounts), last_error))


def cmd_dispatch(settings: Settings, args: argparse.Namespace) -> dict:
    settings.ensure_layout()
    manifest = Path(args.manifest) if args.manifest else _latest_manifest(settings)
    shards = _read_manifest(manifest)
    indices = _parse_shards(args.shards, len(shards)) if args.shards else list(range(len(shards)))
    concurrency = args.concurrency if args.concurrency is not None else settings.concurrency

    _guard_campaign_idle(settings, args.force)
    _guard_no_active_transfer(settings, args.force)
    _guard_token(settings)
    if not Path(settings.hf_bin).is_file():
        raise SystemExit("hf CLI not found at {}; run cluster/setup_hf_env.sh".format(settings.hf_bin))
    info = _guard_bucket(settings, args.allow_public)

    plan_id = shards[0]["plan_id"]
    job_name = "{}-{}".format(settings.job_prefix, plan_id[-6:])
    array_job_id, account = _sbatch(settings, manifest, indices, concurrency, job_name, args.dry_run)
    units = sum(len(shards[index]["units"]) for index in indices)
    if args.dry_run:
        return {"array_job_id": None, "shards": len(indices), "units": units}

    _append_jsonl(settings.dispatch_log, {
        "array_job_id": array_job_id,
        "plan_id": plan_id,
        "manifest": str(manifest),
        "shards": indices,
        "units": units,
        "concurrency": concurrency,
        "account": account,
        "partition": settings.partition,
        "job_name": job_name,
        "bucket": settings.bucket_id,
        "bucket_private": bool(info.get("private")),
        "submitted_at": _now(),
    })
    print("submitted array {} ({}): {} shard(s), {} unit(s), concurrency {}, account {} -> {}".format(
        array_job_id, job_name, len(indices), units, concurrency, account, settings.dest))
    return {"array_job_id": array_job_id, "shards": len(indices), "units": units}


def cmd_pilot(settings: Settings, args: argparse.Namespace) -> dict:
    """One shard, one task: the measurement before the fan-out."""
    plan_args = argparse.Namespace(force=args.force, only=None, verify=args.verify, shards=1,
                                   shard_size=args.shard_size, status=args.status)
    planned = cmd_plan(settings, plan_args)
    if not planned["plan_id"]:
        return planned
    dispatch_args = argparse.Namespace(manifest=planned["manifest"], shards=None, concurrency=1,
                                       force=args.force, allow_public=args.allow_public, dry_run=args.dry_run)
    result = cmd_dispatch(settings, dispatch_args)
    print("pilot submitted; when it finishes run `cluster/hfx reconcile` then `cluster/hfx report`")
    return result


# =============================================================================
# run (inside the array task)
# =============================================================================


def _sentinel_dir(manifest: Path, index: int) -> Path:
    return manifest.parent / (manifest.stem + ".sentinels") / str(index)


def _shard_sentinel(manifest: Path, index: int) -> Path:
    return manifest.parent / (manifest.stem + ".sentinels") / "{}.json".format(index)


def _unit_sentinel(manifest: Path, index: int, unit: str) -> Path:
    return _sentinel_dir(manifest, index) / (_unit_slug(unit) + ".json")


def _tail(text: str, lines: int = 20) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


_SUMMARY_RE = re.compile(r"^\s*(Uploads|Skips|Deletes):\s*(\d+)", re.MULTILINE)


def _sync_once(settings: Settings, record: dict, env: dict) -> subprocess.CompletedProcess:
    argv = [settings.hf_bin, "sync", record["src"], record["dest"]]
    for pattern in record["exclude"]:
        argv += ["--exclude", pattern]
    return _run(argv, env=env, timeout=4 * 3600)


def _sync_guarded(settings: Settings, record: dict, env: dict) -> subprocess.CompletedProcess:
    """For the state/ unit: write the plan first, refuse if any upload matches an exclusion
    (belt and braces around the secret key), then apply that exact plan."""
    plan_file = settings.transfer_root / "plans" / (_unit_slug(record["unit"]) + ".plan.jsonl")
    plan_file.parent.mkdir(parents=True, exist_ok=True)
    argv = [settings.hf_bin, "sync", record["src"], record["dest"], "--plan", str(plan_file)]
    for pattern in record["exclude"]:
        argv += ["--exclude", pattern]
    planned = _run(argv, env=env, timeout=3600)
    if planned.returncode != 0:
        return planned
    offenders = []
    for op in _read_jsonl(plan_file):
        if op.get("type") == "operation" and op.get("action") == "upload" \
                and _excluded(op.get("path", ""), record["exclude"]):
            offenders.append(op["path"])
        if op.get("action") == "delete":
            offenders.append("DELETE " + op.get("path", "?"))
    if offenders:
        return subprocess.CompletedProcess(
            argv, 99, stdout=planned.stdout,
            stderr="refusing to apply plan: excluded or destructive operations present: {}".format(offenders[:10]))
    return _run([settings.hf_bin, "sync", "--apply", str(plan_file)], env=env, timeout=4 * 3600)


def _upload_markers(settings: Settings, record: dict, env: dict) -> list[str]:
    """One <path>.symlink object per symlink, content = target. Returns errors."""
    errors = []
    for link in record.get("symlinks", []):
        dest = record["dest"] + "/" + link["path"] + MARKER_SUFFIX
        result = _run([settings.hf_bin, "cp", "-", dest], env=env, stdin=link["target"] + "\n", timeout=600)
        if result.returncode != 0:
            errors.append("{}: {}".format(dest, _tail(result.stderr, 3)))
    return errors


def _transfer_unit(settings: Settings, record: dict, env: dict) -> dict:
    src = Path(record["src"])
    started = time.monotonic()
    outcome: dict = {
        "unit": record["unit"], "kind": record["kind"], "dest": record["dest"],
        "started_at": _now(), "host": os.uname().nodename,
        "slurm_task": "{}_{}".format(os.environ.get("SLURM_ARRAY_JOB_ID", "?"),
                                     os.environ.get("SLURM_ARRAY_TASK_ID", "?")),
        "attempts": 0, "symlinks": record.get("symlinks", []),
    }
    if not src.is_dir():
        outcome.update(status="failed", error="source missing: {}".format(src), seconds=0.0,
                       files=0, bytes=0, finished_at=_now())
        return outcome

    files, size = _walk_unit(src, record["exclude"])
    outcome.update(files=files, bytes=size)

    result = None
    for attempt in range(1, max(1, settings.retries) + 1):
        outcome["attempts"] = attempt
        try:
            if record["kind"] == "state":
                result = _sync_guarded(settings, record, env)
            else:
                result = _sync_once(settings, record, env)
        except (subprocess.TimeoutExpired, OSError) as exc:
            result = subprocess.CompletedProcess([], 98, stdout="", stderr="{}: {}".format(type(exc).__name__, exc))
        if result.returncode == 0 or result.returncode == 99:
            break
        time.sleep(min(60, 5 * 2 ** (attempt - 1)))

    assert result is not None
    outcome["rc"] = result.returncode
    outcome["seconds"] = round(time.monotonic() - started, 3)
    counts = {key: int(value) for key, value in _SUMMARY_RE.findall(result.stdout)}
    outcome["uploads"] = counts.get("Uploads")
    outcome["skips"] = counts.get("Skips")
    outcome["deletes"] = counts.get("Deletes")
    if result.returncode != 0:
        outcome.update(status="failed", error=_tail(result.stderr) or _tail(result.stdout),
                       finished_at=_now())
        return outcome

    marker_errors = _upload_markers(settings, record, env)
    outcome["seconds"] = round(time.monotonic() - started, 3)
    outcome["mb_per_s"] = round(size / outcome["seconds"] / 1e6, 2) if outcome["seconds"] else None
    if marker_errors:
        outcome.update(status="failed", error="symlink markers: " + "; ".join(marker_errors), finished_at=_now())
    else:
        outcome.update(status="ok", error="", finished_at=_now())
    return outcome


def cmd_run(settings: Settings, args: argparse.Namespace) -> int:
    """Transfer one shard. Always returns 0; the sentinels carry the outcome."""
    manifest = Path(args.manifest)
    index = args.index
    shard_started = time.monotonic()
    shard_payload: dict = {"index": index, "manifest": str(manifest), "started_at": _now(),
                           "host": os.uname().nodename, "units": {}}
    try:
        shard = None
        for line in _read_jsonl(manifest):
            if line["index"] == index:
                shard = line
                break
        if shard is None:
            raise RuntimeError("manifest {} has no shard {}".format(manifest, index))
        shard_payload["plan_id"] = shard["plan_id"]
        env = _hf_env(settings)
        for record in shard["units"]:
            sentinel = _unit_sentinel(manifest, index, record["unit"])
            existing = _read_json(sentinel)
            if existing and existing.get("status") == "ok":
                print("skip {} (already ok)".format(record["unit"]), flush=True)
                shard_payload["units"][record["unit"]] = "ok"
                continue
            print("sync {} -> {}".format(record["unit"], record["dest"]), flush=True)
            outcome = _transfer_unit(settings, record, env)
            _write_atomic(sentinel, outcome)
            shard_payload["units"][record["unit"]] = outcome["status"]
            print("  {} files={} bytes={} secs={} rc={} uploads={} skips={} {}".format(
                outcome["status"], outcome.get("files"), outcome.get("bytes"), outcome.get("seconds"),
                outcome.get("rc"), outcome.get("uploads"), outcome.get("skips"),
                outcome.get("error", "")[:200]), flush=True)
        statuses = set(shard_payload["units"].values())
        shard_payload["status"] = "ok" if statuses <= {"ok"} else "partial"
    except Exception as exc:  # noqa: BLE001 -- the sentinel is the only channel back
        shard_payload["status"] = "failed"
        shard_payload["error"] = "{}: {}".format(type(exc).__name__, exc)
        print("shard {} failed: {}".format(index, shard_payload["error"]), file=sys.stderr, flush=True)
    shard_payload["seconds"] = round(time.monotonic() - shard_started, 3)
    shard_payload["finished_at"] = _now()
    try:
        _write_atomic(_shard_sentinel(manifest, index), shard_payload)
    except Exception as exc:  # noqa: BLE001
        print("could not write shard sentinel: {}".format(exc), file=sys.stderr, flush=True)
    return 0


# =============================================================================
# reconcile / status / report
# =============================================================================


def _task_states(array_job_id: str) -> dict[int, str]:
    """index -> SLURM state for one array, from squeue (live) then sacct (finished)."""
    states: dict[int, str] = {}
    live = _run(["squeue", "-r", "-h", "-j", array_job_id, "-o", "%i|%T"])
    if live.returncode == 0:
        for line in live.stdout.splitlines():
            job, _, state = line.partition("|")
            if "_" in job:
                try:
                    states[int(job.split("_", 1)[1])] = state.strip()
                except ValueError:
                    pass
    done = _run(["sacct", "-X", "-n", "-P", "-j", array_job_id, "--format=JobID,State"])
    if done.returncode == 0:
        for line in done.stdout.splitlines():
            job, _, state = line.partition("|")
            if "_" in job and "[" not in job:
                try:
                    states.setdefault(int(job.split("_", 1)[1]), state.strip().split()[0])
                except ValueError:
                    pass
    return states


def cmd_reconcile(settings: Settings, args: argparse.Namespace) -> dict:
    """Fold every unit sentinel under every manifest into the ledger, then classify each
    dispatched shard that has no shard sentinel as in flight or lost via the scheduler."""
    settings.ensure_layout()
    recorded = {(r["plan_id"], r["shard"], r["unit"], r.get("finished_at"))
                for r in _read_jsonl(settings.ledger)}
    counts = {"recorded": 0, "ok": 0, "failed": 0, "in_flight": 0, "lost": 0}
    lost: list[str] = []
    failed_units: list[str] = []
    dispatches = _read_jsonl(settings.dispatch_log)
    array_for = {(d["manifest"], index): d["array_job_id"] for d in dispatches for index in d["shards"]}

    for manifest in sorted(settings.manifest_dir.glob("*.jsonl")):
        sentinel_root = manifest.parent / (manifest.stem + ".sentinels")
        if not sentinel_root.is_dir():
            continue
        plan_id = manifest.stem
        for unit_dir in sorted(p for p in sentinel_root.iterdir() if p.is_dir()):
            index = int(unit_dir.name)
            for sentinel in sorted(unit_dir.glob("*.json")):
                outcome = _read_json(sentinel)
                if not outcome:
                    continue
                key = (plan_id, index, outcome["unit"], outcome.get("finished_at"))
                if key in recorded:
                    continue
                _append_jsonl(settings.ledger, {
                    "at": _now(), "plan_id": plan_id, "shard": index,
                    "array_job_id": array_for.get((str(manifest), index)), "unit": outcome["unit"],
                    "kind": outcome.get("kind"), "status": outcome["status"],
                    "files": outcome.get("files"), "bytes": outcome.get("bytes"),
                    "seconds": outcome.get("seconds"), "uploads": outcome.get("uploads"),
                    "skips": outcome.get("skips"), "rc": outcome.get("rc"),
                    "attempts": outcome.get("attempts"), "error": outcome.get("error", ""),
                    "finished_at": outcome.get("finished_at"),
                })
                recorded.add(key)
                counts["recorded"] += 1
                counts["ok" if outcome["status"] == "ok" else "failed"] += 1
                if outcome["status"] != "ok":
                    failed_units.append("{} ({})".format(outcome["unit"], outcome.get("error", "")[:80]))

    for dispatch in dispatches:
        manifest = Path(dispatch["manifest"])
        states: dict[int, str] | None = None
        for index in dispatch["shards"]:
            if _shard_sentinel(manifest, index).exists():
                continue
            if states is None:
                states = _task_states(dispatch["array_job_id"])
            state = states.get(index, "UNKNOWN")
            if state in ("PENDING", "RUNNING", "CONFIGURING", "COMPLETING", "REQUEUED", "SUSPENDED"):
                counts["in_flight"] += 1
            else:
                counts["lost"] += 1
                lost.append("{} shard {} ({})".format(manifest.name, index, state))

    print("reconcile: recorded {} new unit outcome(s): ok={} failed={}; shards in flight={}, lost={}".format(
        counts["recorded"], counts["ok"], counts["failed"], counts["in_flight"], counts["lost"]))
    for item in failed_units[:20]:
        print("  failed: " + item)
    for item in lost[:20]:
        print("  lost:   " + item + "  -> cluster/hfx dispatch --manifest <manifest> --shards <index>")
    return counts


def cmd_status(settings: Settings, args: argparse.Namespace) -> dict:
    everything, dropped = _filter_by_status(settings, _discover_units(settings), settings.statuses)
    present = {unit for unit, _kind in everything}
    ledger = _ledger_state(settings)
    done = {unit for unit, record in ledger.items() if record.get("status") == "ok"}
    failed = {unit for unit, record in ledger.items() if record.get("status") != "ok"}
    in_flight = 0
    for dispatch in _read_jsonl(settings.dispatch_log):
        manifest = Path(dispatch["manifest"])
        for index in dispatch["shards"]:
            if not _shard_sentinel(manifest, index).exists():
                in_flight += 1
    by_kind: dict[str, dict[str, int]] = {}
    for unit, kind in everything:
        slot = by_kind.setdefault(kind, {"present": 0, "done": 0})
        slot["present"] += 1
        slot["done"] += unit in done
    done_bytes = sum(int(record.get("bytes") or 0) for unit, record in ledger.items()
                     if record.get("status") == "ok")
    report = {
        "dest": settings.dest, "present": len(present), "done": len(present & done),
        "pending": len(present - done), "failed": len(present & failed),
        "shards_without_sentinel": in_flight, "done_bytes": done_bytes, "by_kind": by_kind,
        "statuses": settings.statuses, "left_out_by_status": dropped,
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return report
    print("transfer -> {}  (job status: {})".format(settings.dest, "/".join(settings.statuses)))
    if dropped:
        print("  left out by status: " + ", ".join("{}={}".format(k, v) for k, v in sorted(dropped.items())))
    print("  units: {} present, {} done ({:.1f}%), {} pending, {} failed; {:.2f} TB recorded as done".format(
        report["present"], report["done"],
        100.0 * report["done"] / report["present"] if report["present"] else 0.0,
        report["pending"], report["failed"], done_bytes / 1e12))
    for kind in KIND_ORDER:
        if kind in by_kind:
            print("    {:<10} {}/{}".format(kind, by_kind[kind]["done"], by_kind[kind]["present"]))
    print("  shards dispatched but without a sentinel: {} (run reconcile to classify)".format(in_flight))
    return report


def cmd_report(settings: Settings, args: argparse.Namespace) -> dict:
    manifests = [Path(args.manifest)] if args.manifest else sorted(
        {Path(d["manifest"]) for d in _read_jsonl(settings.dispatch_log)})
    rows = []
    for manifest in manifests:
        for sentinel in sorted((manifest.parent / (manifest.stem + ".sentinels")).glob("*.json")):
            shard = _read_json(sentinel)
            if not shard:
                continue
            index = shard["index"]
            units = [u for u in (_read_json(p) for p in _sentinel_dir(manifest, index).glob("*.json")) if u]
            ok = [u for u in units if u.get("status") == "ok"]
            size = sum(int(u.get("bytes") or 0) for u in ok)
            files = sum(int(u.get("files") or 0) for u in ok)
            unit_secs = sum(float(u.get("seconds") or 0) for u in ok)
            fresh = all((u.get("skips") or 0) == 0 for u in ok)
            rows.append({
                "manifest": manifest.name, "shard": index, "host": shard.get("host"),
                "status": shard.get("status"), "units": len(units), "ok": len(ok),
                "files": files, "bytes": size, "shard_seconds": shard.get("seconds"),
                "unit_seconds": round(unit_secs, 1),
                "mb_per_s": round(size / shard["seconds"] / 1e6, 1) if shard.get("seconds") else None,
                "all_fresh": fresh,
                "slowest_unit_s": round(max((float(u.get("seconds") or 0) for u in units), default=0.0), 1),
            })
    total_bytes = sum(r["bytes"] for r in rows)
    total_secs = sum(float(r["shard_seconds"] or 0) for r in rows)
    summary = {
        "shards": len(rows), "bytes": total_bytes, "files": sum(r["files"] for r in rows),
        "task_seconds": round(total_secs, 1),
        "mb_per_s_per_task": round(total_bytes / total_secs / 1e6, 1) if total_secs else None,
        "rows": rows,
    }
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
        return summary
    if not rows:
        print("no shard sentinels yet")
        return summary
    print("{:<26} {:>5} {:<8} {:>5} {:>6} {:>9} {:>8} {:>7} {:>7} {}".format(
        "manifest", "shard", "status", "units", "files", "GB", "secs", "MB/s", "slow(s)", "host"))
    for r in rows:
        print("{:<26} {:>5} {:<8} {:>3}/{:<2} {:>6} {:>9.2f} {:>8.0f} {:>7} {:>7} {}{}".format(
            r["manifest"][:26], r["shard"], r["status"], r["ok"], r["units"], r["files"],
            r["bytes"] / 1e9, r["shard_seconds"] or 0, r["mb_per_s"] if r["mb_per_s"] is not None else "-",
            r["slowest_unit_s"], r["host"], "" if r["all_fresh"] else "  (some files skipped: rate understated)"))
    print("total: {} shard(s), {:.2f} GB, {} files, {:.0f} task-seconds -> {} MB/s per task".format(
        len(rows), total_bytes / 1e9, summary["files"], total_secs, summary["mb_per_s_per_task"]))
    remaining = 0
    present, _dropped = _filter_by_status(settings, _discover_units(settings), settings.statuses)
    done = _done_units(settings)
    for unit, kind in present:
        if unit not in done and kind in ("experiment", "parca"):
            remaining += 1
    if summary["mb_per_s_per_task"] and rows:
        per_unit = total_bytes / max(1, sum(r["ok"] for r in rows))
        est = remaining * per_unit / (summary["mb_per_s_per_task"] * 1e6)
        print("remaining: {} out/ unit(s) ~{:.2f} TB; at this per-task rate ~{:.1f} h at concurrency 1, "
              "~{:.1f} h at {}".format(remaining, remaining * per_unit / 1e12, est / 3600,
                                        est / 3600 / settings.concurrency, settings.concurrency))
    return summary


# =============================================================================
# CLI
# =============================================================================


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    plan = sub.add_parser("plan", help="snapshot pending units into a manifest of shards")
    plan.add_argument("--shards", type=int, default=None, help="keep only the first N shards")
    plan.add_argument("--shard-size", type=int, default=None, help="override WCECOLI_TRANSFER_SHARD_SIZE")
    plan.add_argument("--only", action="append", choices=KIND_ORDER, help="restrict to a kind (repeatable)")
    plan.add_argument("--status", action="append", default=None,
                      help="job statuses to transfer (repeatable; 'all' disables the filter); "
                           "default WCECOLI_TRANSFER_STATUSES")
    plan.add_argument("--verify", action="store_true", help="ignore the ledger and re-plan every unit")
    plan.add_argument("--force", action="store_true", help="plan even while campaign jobs are queued")

    dispatch = sub.add_parser("dispatch", help="submit one array for a manifest")
    dispatch.add_argument("--manifest", default=None, help="default: the newest manifest not yet dispatched")
    dispatch.add_argument("--shards", default=None, help="subset like '0,4-7' (for retries)")
    dispatch.add_argument("--concurrency", type=int, default=None, help="override WCECOLI_TRANSFER_CONCURRENCY")
    dispatch.add_argument("--force", action="store_true", help="ignore the squeue guards")
    dispatch.add_argument("--allow-public", action="store_true", help="allow a public bucket")
    dispatch.add_argument("--dry-run", action="store_true", help="print the sbatch line and stop")

    pilot = sub.add_parser("pilot", help="plan one shard and dispatch it at concurrency 1")
    pilot.add_argument("--shard-size", type=int, default=None)
    pilot.add_argument("--status", action="append", default=None)
    pilot.add_argument("--verify", action="store_true")
    pilot.add_argument("--force", action="store_true")
    pilot.add_argument("--allow-public", action="store_true")
    pilot.add_argument("--dry-run", action="store_true")

    run = sub.add_parser("run", help="(array task) transfer one shard; always exits 0")
    run.add_argument("--manifest", required=True)
    run.add_argument("--index", type=int, required=True)

    sub.add_parser("reconcile", help="fold sentinels into the ledger; list lost and failed work")
    status = sub.add_parser("status", help="progress summary")
    status.add_argument("--json", action="store_true")
    report = sub.add_parser("report", help="measured throughput per shard")
    report.add_argument("--manifest", default=None)
    report.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    settings = Settings.from_env()
    handlers = {
        "plan": cmd_plan, "dispatch": cmd_dispatch, "pilot": cmd_pilot, "run": cmd_run,
        "reconcile": cmd_reconcile, "status": cmd_status, "report": cmd_report,
    }
    result = handlers[args.command](settings, args)
    if args.command == "run":
        return 0
    return 0 if result is not None else 1


if __name__ == "__main__":
    sys.exit(main())
