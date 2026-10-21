"""Parts that are on the Hub but no longer on local disk (the 1 s tier, ADR 0011).

A config that does not fit on disk is published in batches: export a batch, ``hub upload``
it, ``hub verify`` it, ``hub prune`` it, repeat; ``finalize`` runs once at the end. Two
files in build/ carry what finalize needs once the parts are gone:

``build/published.jsonl``  append-only, one line per verified part, written only by ``hub
                           verify``: repo_id, revision, config, family, path, bytes (the
                           size the Hub reports, equal to the sentinel's), sha256 (the Hub's
                           LFS oid, when it has one), and the export attempt it is for
                           (plan, part, finished_at of the ok sentinel).
``build/schemas/<config>.parquet``
                           the arrow schema of the config's parts (``pq.write_metadata``, no
                           rows), written by ``hub verify`` / ``hub prune`` from a local part
                           and checked against every part they read afterwards.

A record publishes a part only while it matches the current ok sentinel at that path: same
repo, same export attempt, same bytes. A re-export (a new sentinel) needs a new upload and a
new verify. Nothing here talks to the Hub.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .ledger import append_jsonl, now, read_jsonl, rename_into_place, temp_path_for
from .settings import Settings


def records_path(settings: Settings) -> Path:
    return settings.build_dir / "published.jsonl"


def schema_path(settings: Settings, config: str) -> Path:
    return settings.build_dir / "schemas" / (config + ".parquet")


# -- published records -----------------------------------------------------------------------
def record(settings: Settings, part: dict, remote: dict, revision: str | None) -> dict:
    return {"at": now(), "repo_id": settings.repo_id, "revision": revision, "config": part["config"],
            "family": part["family"], "path": part["path"], "bytes": int(remote["size"]),
            "sha256": remote.get("sha256"), "plan": part.get("plan"), "part": part.get("part"),
            "finished_at": part.get("finished_at")}


def matches(entry: dict, part: dict) -> bool:
    """Does ``entry`` (a published record) publish this ok sentinel: same path, export attempt and bytes?"""
    return (part.get("bytes") is not None and entry.get("path") == part.get("path")
            and entry.get("bytes") is not None and int(entry["bytes"]) == int(part["bytes"])
            and entry.get("plan") == part.get("plan") and entry.get("finished_at") == part.get("finished_at"))


def published_parts(settings: Settings, parts: dict[str, dict]) -> dict[str, dict]:
    """path -> the newest record (for W4C_REPO_ID) that publishes the current ok part at that path."""
    out = {}
    for entry in read_jsonl(records_path(settings)):
        if entry.get("repo_id") != settings.repo_id:
            continue
        part = parts.get(entry.get("path"))
        if part is not None and matches(entry, part):
            out[entry["path"]] = entry
    return out


def append(settings: Settings, entries: list[dict]) -> None:
    for entry in entries:
        append_jsonl(records_path(settings), entry)


# -- schemas -----------------------------------------------------------------------------------
def _fields(schema: pa.Schema) -> pa.Schema:
    """The part of a schema finalize uses: fields with their types and unit metadata (the
    schema-level metadata names the family and differs between families)."""
    return schema.remove_metadata()


def stored_schema(settings: Settings, config: str) -> pa.Schema | None:
    path = schema_path(settings, config)
    return pq.read_schema(path) if path.exists() else None


def agree(settings: Settings, config: str, schema: pa.Schema, source: str) -> None:
    """Refuse when ``schema`` (read from ``source``) differs from the stored one of ``config``."""
    stored = stored_schema(settings, config)
    if stored is not None and not _fields(stored).equals(_fields(schema), check_metadata=True):
        raise SystemExit("{} has a schema that differs from {}:\n  stored: {}\n  part:   {}".format(
            source, schema_path(settings, config), _fields(stored), _fields(schema)))


def keep_schema(settings: Settings, config: str, part_file: Path) -> pa.Schema:
    """Store the schema of ``part_file`` as config's schema if none is stored yet; otherwise
    refuse unless they agree. Returns the part's schema."""
    schema = pq.read_schema(part_file)
    path = schema_path(settings, config)
    if path.exists():
        agree(settings, config, schema, str(part_file))
        return schema
    temporary = temp_path_for(path)
    pq.write_metadata(schema, temporary)
    rename_into_place(temporary, path)
    print("stored the {} schema from {} in {}".format(config, part_file, path), file=sys.stderr)
    return schema
