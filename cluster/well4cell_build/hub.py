"""Stage 5: the private Hub dataset repo.

``create``  create W4C_REPO_ID as a private dataset repo (exist_ok); refuse a public one.
``upload``  ``hf upload <repo> repo/ . --repo-type dataset --include ...`` for the named parts.
            Re-runnable: hf upload skips files already committed and resumes a folder upload.
``status``  the remote file tree with sizes.
``verify``  list data/<config>/<family>/ on the Hub and compare each current ok part (path,
            size) with its sentinel; append a build/published.jsonl record for each match.
``prune``   delete local part files that a published record matches (dry run unless --yes).

verify and prune are for configs that do not fit on disk (ADR 0011): export a batch, upload,
verify, prune, repeat, then finalize once; published.py describes the records. ``--parts``
(with ``--manifest``) narrows both to a slice of one export manifest's part indices, the
syntax of ``export dispatch --parts``; outside it everything is ignored, inside it the checks
are the same.

This module can only add or overwrite remote files (``prune`` deletes local files only). It never passes ``--delete`` to
``hf upload`` and never calls a delete API: removing anything remote is done by hand.
Every upload excludes the Parca caches (``provenance/parca_cache_*``, ``*.cPickle``) and the
per-cache degradation-rate classifications (``deg_rates_*.json``), neither of which is published.

huggingface_hub lives in the wcecoli-hf environment (next to WCECOLI_HF_BIN), not in the
builder's; the API calls run there as a short child script that reads HF_TOKEN_PATH itself.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import stat
import subprocess
import sys
import time
from pathlib import Path

from . import export
from . import finalize
from . import published
from .ledger import append_jsonl, format_array, now
from .settings import CONFIGS, FAMILIES, SUMMARY_CONFIG, Settings

# Parts of repo/ and the --include globs that select them.
FIXED_PARTS = {
    "readme": ["README.md"],
    "index": ["index.parquet"],
    "manifest": ["manifest.json"],
    "stats": ["stats/**"],
    "provenance": ["provenance/**"],
}
ALIASES = {"README.md": "readme", "card": "readme", "index.parquet": "index", "manifest.json": "manifest"}
DEFAULT_PARTS = ["readme", "index", "manifest", "stats", "provenance"]
# Data parts: the exported configs plus the summary config (written by summarize).
DATA_CONFIGS = list(CONFIGS) + [SUMMARY_CONFIG]
# Parca caches (wcEcoli's fitted parameters) and the degradation-rate classification derived from
# them are never published (ADR 0009); an older finalize copied both into repo/provenance/, so
# they are excluded even when present locally.
EXCLUDES = ["**/*.tmp", "**/.*", "provenance/parca_cache_*/**", "**/*.cPickle", "**/deg_rates_*.json"]

# Read-only and create-only Hub calls, run in the wcecoli-hf environment. No delete call
# appears here, by design.
_API_SCRIPT = r"""
import json, sys
from huggingface_hub import HfApi
from huggingface_hub.errors import EntryNotFoundError
op, repo_id, allow_create = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
api = HfApi()
out = {}
if op == "create" and allow_create:
    api.create_repo(repo_id, repo_type="dataset", private=True, exist_ok=True)
if op in ("create", "info", "tree", "files"):
    info = api.repo_info(repo_id, repo_type="dataset")
    out["private"] = bool(info.private)
    out["id"] = info.id
    out["sha"] = info.sha
if op == "tree":
    files = []
    for entry in api.list_repo_tree(repo_id, repo_type="dataset", recursive=True):
        size = getattr(entry, "size", None)
        if size is not None:
            files.append({"path": entry.path, "size": int(size)})
    out["files"] = files
if op == "files":  # every file under each prefix (a folder), at the revision just read
    files = []
    for prefix in json.loads(sys.argv[4]):
        try:
            entries = list(api.list_repo_tree(repo_id, path_in_repo=prefix, repo_type="dataset", recursive=True,
                                              revision=out["sha"]))
        except EntryNotFoundError:
            continue
        for entry in entries:
            size = getattr(entry, "size", None)
            if size is not None:
                lfs = getattr(entry, "lfs", None)
                files.append({"path": entry.path, "size": int(size), "sha256": lfs.get("sha256") if lfs else None})
    out["files"] = files
print(json.dumps(out))
"""


def guard_token(settings: Settings) -> None:
    """Same rules as transfer.py: mode 600, under $HOME, not under the repo or campaign root."""
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


def hf_env(settings: Settings) -> dict:
    env = dict(os.environ)
    env.pop("HF_TOKEN", None)  # the token file is the one credential
    env["HF_TOKEN_PATH"] = str(settings.token_path)
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    return env


def _hf_python(settings: Settings) -> str:
    candidate = Path(settings.hf_bin).parent / "python"
    if not candidate.exists():
        raise SystemExit("no python next to {}; WCECOLI_HF_BIN must point into the wcecoli-hf env".format(settings.hf_bin))
    return str(candidate)


def api_call(settings: Settings, op: str, allow_create: bool = False, extra: tuple[str, ...] = ()) -> dict:
    guard_token(settings)
    result = subprocess.run([_hf_python(settings), "-c", _API_SCRIPT, op, settings.repo_id, "1" if allow_create else "0",
                             *extra], capture_output=True, text=True, env=hf_env(settings))
    if result.returncode != 0:
        raise SystemExit("Hub {} for {} failed:\n{}".format(op, settings.repo_id, result.stderr.strip()[-2000:]))
    return json.loads(result.stdout.strip().splitlines()[-1])


def require_private(info: dict, allow_public: bool) -> None:
    if not info.get("private") and not allow_public:
        raise SystemExit("{} is PUBLIC; refusing. Make it private on the Hub, or pass --allow-public "
                         "if publishing is intended.".format(info.get("id")))


def cmd_create(settings: Settings, args: argparse.Namespace) -> dict:
    info = api_call(settings, "create", allow_create=True)
    print("https://huggingface.co/datasets/{}  private={}".format(info["id"], info["private"]))
    require_private(info, args.allow_public)
    append_jsonl(settings.ledger, {"at": now(), "stage": "hub.create", "repo_id": info["id"], "private": info["private"]})
    return info


def include_globs(settings: Settings, parts: list[str], families: list[str] | None = None) -> list[str]:
    """Globs of repo/ for ``parts``; ``families`` narrows every config (and ``data``) part to
    data/<config>/<family>/** for those families only. Fixed parts are not narrowed."""
    if families:
        unknown = [f for f in families if f not in FAMILIES]
        if unknown:
            raise SystemExit("unknown families {}; choose from {}".format(unknown, ", ".join(FAMILIES)))
    globs = []
    for part in parts:
        part = ALIASES.get(part, part)
        if part in FIXED_PARTS:
            globs.extend(FIXED_PARTS[part])
        elif part in DATA_CONFIGS:
            if families:
                globs.extend("data/{}/{}/**".format(part, f) for f in families)
            else:
                globs.append("data/{}/**".format(part))
        elif part == "data":
            if families:
                globs.extend("data/{}/{}/**".format(c, f) for c in DATA_CONFIGS for f in families
                             if (settings.repo_dir / "data" / c / f).is_dir())
            else:
                globs.append("data/**")
        else:
            raise SystemExit("unknown part {!r}; choose from {}".format(
                part, ", ".join(list(FIXED_PARTS) + list(ALIASES) + DATA_CONFIGS + ["data"])))
    return list(dict.fromkeys(globs))


def default_parts(settings: Settings) -> list[str]:
    """The fixed parts plus every config with at least one local file (a pruned config may
    leave empty directories behind)."""
    data = settings.repo_dir / "data"
    present = [c for c in DATA_CONFIGS if (data / c).is_dir() and any(p.is_file() for p in (data / c).rglob("*"))]
    return DEFAULT_PARTS + present


def _matches(settings: Settings, pattern: str) -> int:
    if pattern.endswith("/**"):
        base = settings.repo_dir / pattern[:-3]
        return sum(1 for p in base.rglob("*") if p.is_file()) if base.is_dir() else 0
    return 1 if (settings.repo_dir / pattern).is_file() else 0


def upload_argv(settings: Settings, globs: list[str], message: str) -> list[str]:
    argv = [settings.hf_bin, "upload", settings.repo_id, str(settings.repo_dir), ".",
            "--repo-type", "dataset", "--private", "--commit-message", message]
    for pattern in globs:
        argv += ["--include", pattern]
    for pattern in EXCLUDES:
        argv += ["--exclude", pattern]
    # This tool must be unable to delete remote content.
    if any(a.startswith("--delete") for a in argv):
        raise SystemExit("refusing: a delete flag reached the upload command: {}".format(argv))
    return argv


def cmd_upload(settings: Settings, args: argparse.Namespace) -> dict:
    parts = [p.strip() for p in args.include.split(",") if p.strip()] if args.include else default_parts(settings)
    families = [f.strip() for f in args.families.split(",") if f.strip()] if getattr(args, "families", None) else None
    globs = include_globs(settings, parts, families)
    counts = {g: _matches(settings, g) for g in globs}
    for pattern, count in counts.items():
        print("{:>8} local files  {}".format(count, pattern))
    empty = [g for g, c in counts.items() if c == 0]
    if empty:
        raise SystemExit("nothing local matches {}; run finalize / export first".format(empty))
    argv = upload_argv(settings, globs, "well4cell {}: {}{}".format(
        settings.version, ",".join(parts), " ({})".format(",".join(families)) if families else ""))
    print("command: " + " ".join(shlex.quote(a) for a in argv), flush=True)
    if args.dry_run:
        return {"dry_run": True, "argv": argv}
    info = api_call(settings, "info")
    require_private(info, args.allow_public)
    started = time.time()
    result = subprocess.run(argv, env=hf_env(settings))
    seconds = round(time.time() - started, 1)
    append_jsonl(settings.ledger, {"at": now(), "stage": "hub.upload", "repo_id": settings.repo_id, "include": globs,
                                   "rc": result.returncode, "seconds": seconds})
    if result.returncode != 0:
        raise SystemExit("hf upload exited {} after {} s; re-run the same command to resume".format(result.returncode, seconds))
    print("uploaded {} in {} s".format(",".join(parts), seconds))
    return {"rc": result.returncode, "seconds": seconds}


def _size(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1000 or unit == "TB":
            return "{:.1f} {}".format(value, unit)
        value /= 1000.0
    return str(n)


def cmd_status(settings: Settings, args: argparse.Namespace) -> dict:
    info = api_call(settings, "tree")
    files = sorted(info["files"], key=lambda f: f["path"])
    groups: dict[str, list[int]] = {}
    for entry in files:
        top = entry["path"].split("/")[0] if "/" not in entry["path"] else "/".join(entry["path"].split("/")[:2 if entry["path"].startswith("data/") else 1])
        groups.setdefault(top, []).append(entry["size"])
        if args.files:
            print("{:>12}  {}".format(_size(entry["size"]), entry["path"]))
    print("https://huggingface.co/datasets/{}  private={}  revision={}".format(info["id"], info["private"], info["sha"]))
    for top, sizes in sorted(groups.items()):
        print("{:>12}  {:>7} files  {}".format(_size(sum(sizes)), len(sizes), top))
    total = sum(f["size"] for f in files)
    print("{:>12}  {:>7} files  total".format(_size(total), len(files)))
    if not info["private"]:
        print("WARNING: the repo is PUBLIC", file=sys.stderr)
    return {"private": info["private"], "files": len(files), "bytes": total}


# -- verify / prune (configs that do not fit on disk, ADR 0011) ------------------------------
def _gb(n: int) -> str:
    return "{:.2f} GB".format(n / 1e9)


def selected_parts(settings: Settings, args: argparse.Namespace) -> tuple[dict[str, dict], dict[str, dict], list[str]]:
    """(every current ok part, those of --configs, --families and --parts, problems with --parts).

    --parts takes the part indices of one export manifest (--manifest, default the latest),
    as ``export dispatch --parts`` does; those indices are unique across the configs and
    families of a manifest, so several of either are fine. Indices of other configs or
    families are left out; parts of the manifest outside --parts are ignored entirely. An index of
    the selection without a current ok sentinel for that export attempt is a problem."""
    configs = [c.strip() for c in args.configs.split(",") if c.strip()]
    for config in configs:
        settings.config(config)
    families = [f.strip() for f in args.families.split(",") if f.strip()] if args.families else None
    unknown = [f for f in families or [] if f not in FAMILIES]
    if unknown:
        raise SystemExit("unknown families {}; choose from {}".format(unknown, ", ".join(FAMILIES)))
    sentinels = finalize.export_sentinels(settings)
    parts = finalize.current_parts(sentinels)
    selected = {p: r for p, r in parts.items()
                if r["config"] in configs and (families is None or r["family"] in families)}
    problems: list[str] = []
    if getattr(args, "manifest", None) and not getattr(args, "parts", None):
        raise SystemExit("--manifest only applies with --parts")
    if getattr(args, "parts", None):
        manifest = Path(args.manifest) if getattr(args, "manifest", None) else export._latest_manifest(settings)
        lines, indices = export.manifest_parts(manifest, args.parts)
        attempts = {(r.get("plan"), r.get("part")): r for _, r in sentinels}
        wanted = [line for line in lines if line["part"] in set(indices)
                  and line["config"] in configs and (families is None or line["family"] in families)]
        selected = {}
        for line in wanted:
            sentinel = attempts.get((line["plan"], line["part"]))
            if sentinel is None or sentinel.get("status") != "ok":
                problems.append("part {} of {} has no ok sentinel ({}): {}".format(
                    line["part"], manifest.name, sentinel.get("status") if sentinel else "not exported", line["path"]))
            elif sentinel.get("path") is None:
                continue  # ok, every trajectory failed QC: no file to publish
            elif parts.get(sentinel["path"]) is not sentinel:
                problems.append("part {} of {} is superseded by a later export of {} (select it from that "
                                "manifest)".format(line["part"], manifest.name, sentinel["path"]))
            else:
                selected[sentinel["path"]] = sentinel
        print("--parts {} of {}: {} in the range, {} of {} ({}), {} with a file".format(
            format_array(indices), manifest.name, len(indices), len(wanted), ",".join(configs),
            ",".join(families or ["all families"]), len(selected)))
        if not wanted:
            raise SystemExit("no part of {} in --parts {} is of {} ({})".format(
                manifest.name, args.parts, ",".join(configs), ",".join(families or ["all families"])))
    elif not selected:
        raise SystemExit("no ok export parts of {} ({})".format(",".join(configs), ",".join(families or ["all families"])))
    return parts, selected, problems


def cmd_verify(settings: Settings, args: argparse.Namespace) -> dict:
    """Compare the Hub's data/<config>/<family>/ with the ok sentinels; record the matches."""
    parts, selected, problems = selected_parts(settings, args)
    prefixes = sorted({"data/{}/{}".format(r["config"], r["family"]) for r in selected.values()})
    info = api_call(settings, "files", extra=(json.dumps(prefixes),)) if prefixes else {"files": [], "sha": None}
    remote = {f["path"]: f for f in info["files"]}
    already = published.published_parts(settings, parts)
    matched, new = [], []
    for path, part in sorted(selected.items()):
        entry, local = remote.get(path), settings.repo_dir / path
        if entry is None:
            problems.append("not on the Hub: {}".format(path))
            continue
        if part.get("bytes") is None or entry["size"] != int(part["bytes"]):
            problems.append("size on the Hub {} != sentinel {}: {}".format(entry["size"], part.get("bytes"), path))
            continue
        if local.exists():
            if local.stat().st_size != int(part["bytes"]):
                problems.append("local size {} != sentinel {}: {}".format(local.stat().st_size, part["bytes"], path))
                continue
            published.keep_schema(settings, part["config"], local)
        matched.append(path)
        if path not in already:
            new.append(published.record(settings, part, entry, info.get("sha")))
    # Every current ok part counts, inside --parts or not: a later slice uploaded early is not stale.
    stale = sorted(p for p in remote if p not in parts)
    problems += ["on the Hub without a current ok part (stale or a duplicate; remove it by hand): {}".format(p)
                 for p in stale]
    published.append(settings, new)
    append_jsonl(settings.ledger, {"at": now(), "stage": "hub.verify", "repo_id": settings.repo_id,
                                   "revision": info.get("sha"), "prefixes": prefixes,
                                   "parts": getattr(args, "parts", None), "matched": len(matched),
                                   "recorded": len(new), "problems": len(problems)})
    print("{}: {} of {} part(s) match the Hub at {} ({}; {} newly recorded in {})".format(
        settings.repo_id, len(matched), len(selected), info.get("sha"),
        _gb(sum(int(selected[p]["bytes"]) for p in matched)), len(new), published.records_path(settings)))
    for line in problems[:50]:
        print("  " + line, file=sys.stderr)
    if problems:
        raise SystemExit("{} problem(s); re-run `hub upload` for the parts not on the Hub, then verify again".format(
            len(problems)))
    return {"matched": len(matched), "recorded": len(new)}


def cmd_prune(settings: Settings, args: argparse.Namespace) -> dict:
    """Delete local part files that build/published.jsonl publishes; dry run unless --yes."""
    parts, selected, problems = selected_parts(settings, args)
    on_hub = published.published_parts(settings, parts)
    data = (settings.repo_dir / "data").resolve()
    doomed, gone = [], 0
    for path, part in sorted(selected.items()):
        local = settings.repo_dir / path
        if not local.exists():
            gone += 1
            continue
        entry = on_hub.get(path)
        if entry is None:
            problems.append("no published record matching its sentinel (hub upload, hub verify): {}".format(path))
            continue
        size = local.stat().st_size
        if size != int(part["bytes"]) or size != int(entry["bytes"]):
            problems.append("local size {} vs sentinel {} vs published {}: {}".format(
                size, part["bytes"], entry["bytes"], path))
            continue
        if local.is_symlink() or local.resolve().parent != data / part["config"] / part["family"]:
            problems.append("not a plain file under data/{}/{}/: {}".format(part["config"], part["family"], path))
            continue
        doomed.append((part["config"], local, size))
    if problems:
        for line in problems[:50]:
            print("  " + line, file=sys.stderr)
        raise SystemExit("refusing to prune: {} problem(s); nothing deleted".format(len(problems)))
    for config, local, _ in doomed:  # the schema outlives the last local part of a config
        published.keep_schema(settings, config, local)
    total = sum(size for _, _, size in doomed)
    print("{} part(s) to delete ({}), {} already gone, of {} selected".format(
        len(doomed), _gb(total), gone, len(selected)))
    if not args.yes:
        for _, local, _ in doomed[:20]:
            print("  would delete {}".format(local))
        print("dry run: pass --yes to delete")
        return {"dry_run": True, "parts": len(doomed), "bytes": total}
    for _, local, _ in doomed:
        local.unlink()
    append_jsonl(settings.ledger, {"at": now(), "stage": "hub.prune", "repo_id": settings.repo_id,
                                   "configs": args.configs, "families": args.families,
                                   "parts": getattr(args, "parts", None), "deleted": len(doomed), "bytes": total})
    print("deleted {} part(s), {}".format(len(doomed), _gb(total)))
    return {"deleted": len(doomed), "bytes": total}


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("hub", help="private Hub dataset repo: create, upload, status, verify, prune "
                                        "(never deletes remotely)")
    stage = parser.add_subparsers(dest="action", required=True)
    create = stage.add_parser("create", help="create W4C_REPO_ID as a private dataset repo")
    create.add_argument("--allow-public", action="store_true", help="accept an existing public repo")
    create.set_defaults(func=cmd_create)
    upload = stage.add_parser("upload", help="hf upload the named parts of repo/ (resumable)")
    upload.add_argument("--include", help="comma-separated parts: readme, index, manifest, stats, provenance, data, "
                                          "or config names, including summary (default: all present)")
    upload.add_argument("--families", help="comma-separated families: narrow config parts to "
                                           "data/<config>/<family>/** (fixed parts are unaffected)")
    upload.add_argument("--dry-run", action="store_true", help="print the command only")
    upload.add_argument("--allow-public", action="store_true", help="upload even if the repo is public")
    upload.set_defaults(func=cmd_upload)
    status = stage.add_parser("status", help="remote files and sizes")
    status.add_argument("--files", action="store_true", help="list every file")
    status.set_defaults(func=cmd_status)
    for name, func, text in (
            ("verify", cmd_verify, "compare the Hub's parts (path, size) with the ok sentinels; record the matches "
                                   "in build/published.jsonl (exits non-zero on any mismatch)"),
            ("prune", cmd_prune, "delete local parts recorded as published (dry run unless --yes)")):
        action = stage.add_parser(name, help=text)
        action.add_argument("--configs", required=True, help="comma-separated exported configs, e.g. expression_1s")
        action.add_argument("--families", help="comma-separated families (default: all)")
        action.add_argument("--parts", help="only these part indices of the export manifest, the syntax of "
                                            "`export dispatch --parts` (0-161,170); the rest is ignored")
        action.add_argument("--manifest", help="with --parts: the export manifest (default: the latest)")
        if name == "prune":
            action.add_argument("--yes", action="store_true", help="delete (default: list what would be deleted)")
        action.set_defaults(func=func)
