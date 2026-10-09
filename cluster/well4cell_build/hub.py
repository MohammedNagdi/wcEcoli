"""Stage 5: the private Hub dataset repo.

``create``  create W4C_REPO_ID as a private dataset repo (exist_ok); refuse a public one.
``upload``  ``hf upload <repo> repo/ . --repo-type dataset --include ...`` for the named parts.
            Re-runnable: hf upload skips files already committed and resumes a folder upload.
``status``  the remote file tree with sizes.

This module can only add or overwrite remote files. It never passes ``--delete`` to
``hf upload`` and never calls a delete API: removing anything remote is done by hand.

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

from .ledger import append_jsonl, now
from .settings import CONFIGS, FAMILIES, Settings

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
EXCLUDES = ["**/*.tmp", "**/.*"]

# Read-only and create-only Hub calls, run in the wcecoli-hf environment. No delete call
# appears here, by design.
_API_SCRIPT = r"""
import json, sys
from huggingface_hub import HfApi
op, repo_id, allow_create = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
api = HfApi()
out = {}
if op == "create" and allow_create:
    api.create_repo(repo_id, repo_type="dataset", private=True, exist_ok=True)
if op in ("create", "info", "tree"):
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


def api_call(settings: Settings, op: str, allow_create: bool = False) -> dict:
    guard_token(settings)
    result = subprocess.run([_hf_python(settings), "-c", _API_SCRIPT, op, settings.repo_id, "1" if allow_create else "0"],
                            capture_output=True, text=True, env=hf_env(settings))
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
        elif part in CONFIGS:
            if families:
                globs.extend("data/{}/{}/**".format(part, f) for f in families)
            else:
                globs.append("data/{}/**".format(part))
        elif part == "data":
            if families:
                globs.extend("data/{}/{}/**".format(c, f) for c in CONFIGS for f in families
                             if (settings.repo_dir / "data" / c / f).is_dir())
            else:
                globs.append("data/**")
        else:
            raise SystemExit("unknown part {!r}; choose from {}".format(
                part, ", ".join(list(FIXED_PARTS) + list(ALIASES) + list(CONFIGS) + ["data"])))
    return list(dict.fromkeys(globs))


def default_parts(settings: Settings) -> list[str]:
    data = settings.repo_dir / "data"
    present = [c for c in CONFIGS if (data / c).is_dir()]
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


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("hub", help="private Hub dataset repo: create, upload, status (never deletes)")
    stage = parser.add_subparsers(dest="action", required=True)
    create = stage.add_parser("create", help="create W4C_REPO_ID as a private dataset repo")
    create.add_argument("--allow-public", action="store_true", help="accept an existing public repo")
    create.set_defaults(func=cmd_create)
    upload = stage.add_parser("upload", help="hf upload the named parts of repo/ (resumable)")
    upload.add_argument("--include", help="comma-separated parts: readme, index, manifest, stats, provenance, data, "
                                          "or config names (default: all present)")
    upload.add_argument("--families", help="comma-separated families: narrow config parts to "
                                           "data/<config>/<family>/** (fixed parts are unaffected)")
    upload.add_argument("--dry-run", action="store_true", help="print the command only")
    upload.add_argument("--allow-public", action="store_true", help="upload even if the repo is public")
    upload.set_defaults(func=cmd_upload)
    status = stage.add_parser("status", help="remote files and sizes")
    status.add_argument("--files", action="store_true", help="list every file")
    status.set_defaults(func=cmd_status)
