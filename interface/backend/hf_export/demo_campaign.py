"""Read-only demo planner. Does not import the app, worker, ORM or job queue."""

from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


DEFAULT_MANIFEST = Path(__file__).with_name("campaigns") / "hf-demo-v1.json"


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode()).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Event(ContractModel):
    time_sec: float = Field(ge=0)
    media: str = Field(min_length=1)


class Control(ContractModel):
    key: str
    role: Literal["matched", "initial", "endpoint", "reference"]


class ExperimentSpec(ContractModel):
    key: str = Field(pattern=r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
    question: str = Field(min_length=1)
    variant: Literal["wildtype", "gene_knockout"]
    gene: str | None = None
    initial_condition: str
    timeline_name: str | None = None
    events: list[Event] = Field(min_length=1)
    controls: list[Control]
    measurements: list[str] = Field(min_length=1)
    seed: Literal[0] = 0
    generations: Literal[4] = 4

    @model_validator(mode="after")
    def validate_execution(self):
        if (self.variant == "gene_knockout") != bool(self.gene):
            raise ValueError("a gene is required only for gene_knockout")
        times = [event.time_sec for event in self.events]
        if times[0] != 0 or any(a >= b for a, b in zip(times, times[1:])):
            raise ValueError("timeline must start at zero and be strictly increasing")
        if len(self.events) > 1 and not self.timeline_name:
            raise ValueError("dynamic experiments require a reference timeline name")
        pairs = [(control.key, control.role) for control in self.controls]
        if len(set(pairs)) != len(pairs):
            raise ValueError("duplicate control links")
        return self

    def execution(self, variant_index: int | str | None = None) -> dict:
        return {
            "variant": self.variant,
            "target": variant_index if variant_index is not None else self.gene,
            "initial_condition": self.initial_condition,
            "events": [event.model_dump() for event in self.events],
            "seed": self.seed, "generations": self.generations,
        }


class CampaignSpec(ContractModel):
    schema_version: Literal["demo-campaign-v1"]
    campaign_id: Literal["hf-demo-v1"]
    time_basis: Literal["elapsed_lineage_seconds"]
    target_bytes: Literal[5000000000]
    max_bytes: Literal[10000000000]
    preserve_all_samples: Literal[True]
    pilot_keys: list[str]
    experiments: list[ExperimentSpec] = Field(min_length=12, max_length=12)

    @model_validator(mode="after")
    def validate_campaign(self):
        by_key = {exp.key: exp for exp in self.experiments}
        if len(by_key) != len(self.experiments):
            raise ValueError("experiment keys must be unique")
        identities = [fingerprint(exp.execution()) for exp in self.experiments]
        if len(set(identities)) != len(identities):
            raise ValueError("normalized execution configurations must be unique")
        if len(set(self.pilot_keys)) != 3 or not set(self.pilot_keys) <= by_key.keys():
            raise ValueError("pilot must select three distinct campaign members")
        for exp in self.experiments:
            for control in exp.controls:
                other = by_key.get(control.key)
                if other is None or other.key == exp.key:
                    raise ValueError(f"{exp.key}: unknown or self-referencing control {control.key}")
                if control.role == "reference":
                    continue
                if other.variant != "wildtype" or len(other.events) != 1:
                    raise ValueError(f"{exp.key}: {control.role} control must be static wild type")
                media = exp.events[-1].media if control.role == "endpoint" else exp.events[0].media
                if other.events[0].media != media:
                    raise ValueError(f"{exp.key}: {control.role} control has mismatched medium")
                if control.role != "endpoint" and other.initial_condition != exp.initial_condition:
                    raise ValueError(f"{exp.key}: mismatched control initial condition")
                if control.role == "matched" and len(exp.events) != 1:
                    raise ValueError(f"{exp.key}: matched controls require static environments")
            if exp.variant == "gene_knockout" and not any(
                control.role == "matched" for control in exp.controls
            ):
                raise ValueError(f"{exp.key}: perturbations require a matched wild-type control")
            if len(exp.events) > 1 and not {"initial", "endpoint"} <= {
                control.role for control in exp.controls
            }:
                raise ValueError(f"{exp.key}: dynamic runs require initial and endpoint controls")
        return self

    def canonical(self) -> dict:
        result = self.model_dump()
        result["pilot_keys"] = sorted(result["pilot_keys"])
        result["experiments"] = sorted(result["experiments"], key=lambda exp: exp["key"])
        for exp in result["experiments"]:
            exp["controls"] = sorted(exp["controls"], key=lambda item: (item["role"], item["key"]))
            exp["measurements"] = sorted(exp["measurements"])
        return result


def open_reference(path: Path) -> sqlite3.Connection:
    """Require a checkpointed snapshot; immutable prevents even WAL/SHM creation."""
    path = path.resolve(strict=True)
    wal = path.with_name(path.name + "-wal")
    if wal.exists() and wal.stat().st_size:
        raise ValueError("reference database has a WAL; provide a checkpointed, closed snapshot")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def parse_timeline(text: str) -> list[dict]:
    # Seed catalogs can retain the TSV field's outer JSON quotes.
    text = text.strip()
    if text.startswith('"'):
        text = json.loads(text)
    if not isinstance(text, str):
        raise ValueError("reference timeline must be an event string")
    result = []
    for segment in text.split(","):
        time, media = segment.strip().split()
        result.append(Event(time_sec=float(time), media=media).model_dump())
    return result


def plan(campaign: CampaignSpec, database: Path) -> dict:
    report = {
        "campaign_id": campaign.campaign_id,
        "manifest_sha256": fingerprint(campaign.canonical()),
        "catalog_valid": False, "runtime_ready": False,
        "planned_jobs": len(campaign.experiments),
        "max_generation_trajectories": sum(exp.generations for exp in campaign.experiments),
        "pilot_keys": campaign.pilot_keys,
        "runtime_prerequisites": [
            "HF-04: verify indices, transcription-unit IDs and co-targets against prepared simData",
            "HF-04: bind and verify --initial-condition plus the elapsed-lineage timeline",
            "HF-04: use an isolated demo database, output directory and executor",
        ],
        "experiments": [], "errors": [],
    }
    with closing(open_reference(database)) as db:
        report["catalog_sha256"] = file_sha256(database)
        required = {
            "variants": {"name"}, "conditions": {"name", "nutrients"},
            "media_recipes": {"media_id"}, "timelines": {"name", "definition"},
            "genes": {"symbol", "ko_index", "is_mechanistic"},
        }
        for table, columns in required.items():
            actual = {row["name"] for row in db.execute(f'PRAGMA table_info("{table}")')}
            if not columns <= actual:
                report["errors"].append({
                    "key": "reference_catalog",
                    "message": f"{table}: missing required columns {sorted(columns - actual)}; "
                               "provide a current checkpointed catalog; the planner never migrates inputs",
                })
        if report["errors"]:
            return report
        identities: dict[str, str] = {}
        for exp in campaign.experiments:
            row = exp.model_dump()
            row["variant_index"] = 0
            row["target_verification"] = "not_applicable"
            row["transcription_unit_id"] = None
            row["co_targeted_genes"] = None
            errors = []
            try:
                if not db.execute("SELECT 1 FROM variants WHERE name=?", (exp.variant,)).fetchone():
                    errors.append(f"unknown variant: {exp.variant}")
                condition = db.execute(
                    "SELECT nutrients FROM conditions WHERE name=?", (exp.initial_condition,),
                ).fetchone()
                if not condition:
                    errors.append(f"unknown initial condition: {exp.initial_condition}")
                elif condition["nutrients"] != exp.events[0].media:
                    errors.append("initial condition nutrients do not match the first media event")
                for event in exp.events:
                    recipe = db.execute(
                        "SELECT 1 FROM media_recipes WHERE media_id=?", (event.media,),
                    ).fetchone()
                    if not recipe:
                        errors.append(f"unknown media recipe: {event.media}")
                if exp.timeline_name:
                    timeline = db.execute(
                        "SELECT definition FROM timelines WHERE name=?", (exp.timeline_name,),
                    ).fetchone()
                    if not timeline:
                        errors.append(f"unknown timeline: {exp.timeline_name}")
                    elif parse_timeline(timeline["definition"]) != row["events"]:
                        errors.append("manifest events differ from the reference timeline")
                if exp.gene:
                    gene = db.execute(
                        "SELECT ko_index,is_mechanistic FROM genes WHERE symbol=?", (exp.gene,),
                    ).fetchone()
                    if not gene or gene["ko_index"] <= 0 or not gene["is_mechanistic"]:
                        errors.append(f"gene is unknown or not mechanistic/knockout-ready: {exp.gene}")
                    else:
                        row["variant_index"] = gene["ko_index"]
                        row["target_verification"] = "pending_prepared_model"
                        row["catalog_genes_sharing_index"] = [item[0] for item in db.execute(
                            "SELECT symbol FROM genes WHERE ko_index=? ORDER BY symbol",
                            (gene["ko_index"],),
                        )]
                        row["mapping_provenance"] = {
                            "source": "reference_catalog.genes.ko_index",
                            "catalog_sha256": report["catalog_sha256"],
                            "prepared_model_verified": False,
                        }
                identity = fingerprint(exp.execution(row["variant_index"]))
                if identity in identities:
                    errors.append(f"resolved execution duplicates {identities[identity]}")
                identities[identity] = exp.key
                row["execution_sha256"] = identity
            except (ValueError, sqlite3.Error) as exc:
                errors.append(str(exc))
            report["errors"].extend({"key": exp.key, "message": error} for error in errors)
            report["experiments"].append(row)
    report["catalog_valid"] = not report["errors"]
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--database", type=Path, required=True, help="checkpointed reference snapshot")
    parser.add_argument("--out", type=Path, help="optional new report file; never overwritten")
    args = parser.parse_args()
    try:
        campaign = CampaignSpec.model_validate_json(args.manifest.read_text())
        report = plan(campaign, args.database)
        serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.out:
            if args.out.resolve() in {args.manifest.resolve(), args.database.resolve()}:
                raise ValueError("report output must not overwrite an input")
            with args.out.open("x") as stream:
                stream.write(serialized)
    except (OSError, ValueError, sqlite3.Error, ValidationError) as exc:
        errors = [
            {"key": ".".join(str(part) for part in error["loc"]) or "manifest",
             "message": error["msg"]}
            for error in exc.errors(include_input=False, include_context=False)
        ] if isinstance(exc, ValidationError) else [{"key": "input", "message": str(exc)}]
        report = {"catalog_valid": False, "runtime_ready": False, "errors": errors}
        serialized = json.dumps(report, indent=2) + "\n"
    print(serialized, end="")
    return 0 if report["catalog_valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
