"""Versioned explorer release contract; independent of the legacy v0 exporter.

Validate a bundle: python -m hf_export.explorer_contract RELEASE_DIRECTORY
Synthetic fixtures are rejected unless --allow-synthetic is explicitly supplied.
"""

from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path, PurePosixPath
import re
import sqlite3
from typing import Literal

import h5py
import numpy as np
from pydantic import Field, ValidationError, model_validator

from .converter import MATRIX_CHANNELS, V0_CHANNELS
from .demo_campaign import (
    CampaignSpec,
    ContractModel,
    file_sha256,
    fingerprint,
    open_reference,
    plan,
)

CHANNELS = tuple(V0_CHANNELS) + tuple(MATRIX_CHANNELS)
SHA = r"^[0-9a-f]{64}$"
PRIVATE_TEXT = re.compile(
    r"(?:/(?:Users|home|private|tmp|app|data|wcEcoli)/|[A-Za-z]:\\|"
    r"\bsk-[A-Za-z0-9_-]{12,}|\bhf_[A-Za-z0-9]{12,})"
)

# A publication catalog, not a copy of the live application's schema.
# An explorer adapter will read these columns; no automatic app migrations apply.
CATALOG_COLUMNS = {
    "demo_experiments": {"key", "experiment_id", "job_id"},
    "demo_controls": {"experiment_key", "control_key", "role"},
    "experiments": {"id", "name", "variant_type", "variant_index", "condition", "gene_symbol"},
    "simulation_jobs": {"id", "experiment_id", "seed", "generations", "status"},
    "simulation_results": {
        "id",
        "job_id",
        "experiment_id",
        "seed",
        "generation",
        "divided",
        "terminated",
        "termination_reason",
        "final_mass_fg",
        "growth_rate",
        "division_time_sec",
        "doubling_time_min",
    },
    "genes": {
        "id",
        "ecoli_id",
        "symbol",
        "synonyms",
        "left_end_pos",
        "right_end_pos",
        "direction",
        "rna_ids",
        "category",
        "ko_index",
        "is_mechanistic",
        "monomer_id",
        "monomer_name",
        "complex_ids",
    },
    "conditions": {
        "id",
        "name",
        "nutrients",
        "genotype_perturbations",
        "doubling_time",
        "active_tfs",
        "inactive_tfs",
    },
    "media_recipes": {"id", "media_id", "base_media", "added_media", "ingredients"},
    "timelines": {"id", "name", "definition"},
    "variants": {"id", "name", "docstring", "parameter_count"},
    "tf_edges": {
        "id",
        "tf_symbol",
        "target_symbol",
        "log2fc_mean",
        "log2fc_std",
        "regulation_direct",
    },
    "aa_pathways": {
        "id",
        "amino_acid",
        "enzymes",
        "reverse_enzymes",
        "kcat",
        "ki_lower",
        "ki_upper",
        "upstream_aas",
        "downstream_aas",
        "notes",
    },
    "complexes": {"id", "reaction_id", "complex_id", "stoichiometry", "name"},
}
REQUIRED_TABLES = {
    "demo_experiments",
    "demo_controls",
    "experiments",
    "simulation_jobs",
    "simulation_results",
    "genes",
    "conditions",
    "media_recipes",
    "timelines",
    "variants",
}


class PayloadFile(ContractModel):
    path: str
    bytes: int = Field(ge=0)
    sha256: str = Field(pattern=SHA)

    @model_validator(mode="after")
    def safe_path(self):
        path = PurePosixPath(self.path)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in self.path
            or str(path) != self.path
            or self.path in {".", "manifest.json"}
        ):
            raise ValueError(
                "payload paths must be canonical relative paths, excluding manifest.json"
            )
        return self


class Availability(ContractModel):
    available: bool
    reason: str = ""
    source_samples: int | None = Field(default=None, gt=0)
    source_columns: int | None = Field(default=None, gt=0)
    undefined_samples: int = Field(default=0, ge=0)
    undefined_reason: str = ""

    @model_validator(mode="after")
    def missing_reason(self):
        if self.available == bool(self.reason.strip()):
            raise ValueError(
                "available channels have no reason; unavailable channels require a reason"
            )
        if self.available != (self.source_samples is not None):
            raise ValueError("available channels require original source sample counts")
        if bool(self.undefined_samples) != bool(self.undefined_reason.strip()):
            raise ValueError("undefined samples require an explicit reason")
        if not self.available and self.undefined_samples:
            raise ValueError("unavailable channels cannot claim saved undefined samples")
        if not self.available and self.source_columns is not None:
            raise ValueError("unavailable channels cannot claim source column counts")
        return self


class Trajectory(ContractModel):
    seed: Literal[0]
    generation: int = Field(ge=0, le=3)
    h5_group: str
    lineage_start_sec: float = Field(ge=0)
    lineage_end_sec: float = Field(ge=0)
    outcome: Literal["completed", "no_division", "terminated"]
    termination_reason: str = ""
    channels: dict[str, Availability]

    @model_validator(mode="after")
    def validate_identity(self):
        if self.h5_group != f"seed={self.seed}/gen={self.generation}":
            raise ValueError("HDF5 group must preserve the actual seed/generation")
        if self.lineage_end_sec < self.lineage_start_sec:
            raise ValueError("invalid lineage time bounds")
        if (self.outcome == "terminated") != bool(self.termination_reason.strip()):
            raise ValueError("only biological termination requires a termination reason")
        if set(self.channels) != set(CHANNELS):
            raise ValueError("availability must explicitly cover every scalar and matrix channel")
        if self.outcome != "terminated" and not all(
            self.channels[name].available for name in ("cell_mass", "growth_rate")
        ):
            raise ValueError("non-terminated trajectories require core mass and growth data")
        return self


class PublishedExperiment(ContractModel):
    key: str
    experiment_id: int = Field(gt=0)
    job_id: int = Field(gt=0)
    variant_index: int = Field(ge=0)
    initial_condition: str
    events: list[dict]
    execution_sha256: str = Field(pattern=SHA)
    execution_provenance: dict | None = None
    transcription_unit_id: str | None = None
    co_targeted_genes: list[str] | None = None
    outcome: Literal["completed", "no_division", "terminated", "missing_output", "execution_error"]
    reason: str = ""
    shard: str | None = None
    trajectories: list[Trajectory]

    @model_validator(mode="after")
    def validate_lineage(self):
        generations = [trajectory.generation for trajectory in self.trajectories]
        if generations != list(range(len(generations))):
            raise ValueError("lineage must retain a unique, contiguous actual generation prefix")
        if self.trajectories and self.trajectories[0].lineage_start_sec != 0:
            raise ValueError("the first generation starts at zero lineage seconds")
        if self.outcome in {"missing_output", "execution_error"}:
            if not self.reason or self.trajectories or self.shard:
                raise ValueError(
                    "failed/missing runs need a reason and no claimed publishable trajectory"
                )
        else:
            if not self.trajectories or not self.shard:
                raise ValueError("scientific outcomes require a shard and actual trajectories")
            if self.trajectories[-1].outcome != self.outcome:
                raise ValueError("experiment outcome must match the final trajectory")
            if (
                self.outcome == "terminated"
                and self.reason != self.trajectories[-1].termination_reason
            ):
                raise ValueError("QC reason must retain the actual lineage termination reason")
            if any(t.outcome != "completed" for t in self.trajectories[:-1]):
                raise ValueError("no generations may follow a stopped/non-dividing cell")
            if self.outcome == "completed" and generations != [0, 1, 2, 3]:
                raise ValueError("completed runs must include all four requested generations")
        for previous, following in zip(self.trajectories, self.trajectories[1:]):
            if following.lineage_start_sec < previous.lineage_end_sec:
                raise ValueError("lineage clocks must not restart or overlap across generations")
        return self


class ReleaseProvenance(ContractModel):
    simulation_source_sha256: str = Field(pattern=SHA)
    exporter_source_sha256: str | None = Field(default=None, pattern=SHA)
    exporter_image_digest: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    clock_writer_sha256: str | None = Field(default=None, pattern=SHA)
    preparation_details: dict | None = None
    prepared_model_sha256: str = Field(pattern=SHA)
    preparation_config_sha256: str = Field(pattern=SHA)
    runtime_image_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    initial_condition_binding: Literal["--initial-condition"]
    model_targets_verified: Literal[True]
    preserve_all_samples: Literal[True]
    time_basis: Literal["elapsed_lineage_seconds"]


class ReferenceDescriptor(ContractModel):
    schema_version: Literal["explorer-references-v1"]
    path: Literal["references.json"]


class ReferenceDocument(ContractModel):
    schema_version: Literal["explorer-references-v1"]
    simulation_source_sha256: str = Field(pattern=SHA)
    prepared_model_sha256: str = Field(pattern=SHA)
    catalog_sha256: str = Field(pattern=SHA)
    mapping_sha256: str = Field(pattern=SHA)
    gene_targets: dict[str, dict]
    condition_catalog: dict[str, list]
    variants: list[dict]
    reactions: list[dict]
    execution_settings: dict[str, dict] = Field(default_factory=dict)


class ReleaseManifest(ContractModel):
    schema_version: Literal["explorer-release-v1"]
    scope: Literal["full", "pilot"] = "full"
    synthetic_fixture: bool = False
    campaign: CampaignSpec
    campaign_sha256: str = Field(pattern=SHA)
    provenance: ReleaseProvenance
    files: list[PayloadFile]
    experiments: list[PublishedExperiment]
    references: ReferenceDescriptor | None = None

    @model_validator(mode="after")
    def validate_mapping(self):
        if fingerprint(self.campaign.canonical()) != self.campaign_sha256:
            raise ValueError("campaign fingerprint mismatch")
        paths = [item.path for item in self.files]
        if len(set(paths)) != len(paths):
            raise ValueError("duplicate payload paths")
        keys = [exp.key for exp in self.experiments]
        specs = {exp.key: exp for exp in self.campaign.experiments}
        if (
            len(set(keys)) != len(keys)
            or (self.scope == "full" and set(keys) != set(specs))
            or (
                self.scope == "pilot"
                and (not keys or not set(keys) <= set(self.campaign.pilot_keys))
            )
        ):
            raise ValueError("release must account for every campaign experiment exactly once")
        for field in ("experiment_id", "job_id"):
            values = [getattr(exp, field) for exp in self.experiments]
            if len(set(values)) != len(values):
                raise ValueError(f"duplicate public {field}")
        required = {"catalog.sqlite", "metadata.jsonl", "qc.jsonl", "README.md"}
        if self.references is not None:
            required.add(self.references.path)
        for exp in self.experiments:
            spec = specs[exp.key]
            if exp.initial_condition != spec.initial_condition or exp.events != [
                event.model_dump() for event in spec.events
            ]:
                raise ValueError(f"{exp.key}: actual initialization/timeline differ from campaign")
            if exp.execution_sha256 != fingerprint(spec.execution(exp.variant_index)):
                raise ValueError(f"{exp.key}: execution fingerprint mismatch")
            if spec.gene and (
                not exp.transcription_unit_id
                or exp.co_targeted_genes is None
                or exp.variant_index <= 0
            ):
                raise ValueError(
                    f"{exp.key}: verified transcription-unit target/co-targets required"
                )
            if not spec.gene and exp.variant_index != 0:
                raise ValueError(f"{exp.key}: wild type must use index zero")
            if exp.shard:
                if exp.shard != f"trajectories/{exp.key}.h5":
                    raise ValueError("each experiment must have its own canonical shard")
                required.add(exp.shard)
        if set(paths) != required:
            raise ValueError(
                "payload inventory must contain exactly catalog, metadata, QC, card and shards"
            )
        return self


class MetadataRow(ContractModel):
    key: str
    seed: Literal[0]
    generation: int = Field(ge=0, le=3)


class QCRow(ContractModel):
    key: str
    outcome: Literal["completed", "no_division", "terminated", "missing_output", "execution_error"]
    reason: str


def _jsonl(path: Path, model: type[ContractModel]) -> list[ContractModel]:
    return [
        model.model_validate_json(line) for line in path.read_text().splitlines() if line.strip()
    ]


def _check_catalog(path: Path, manifest: ReleaseManifest) -> None:
    reference = plan(manifest.campaign, path)
    if not reference["catalog_valid"]:
        raise ValueError("publication reference catalog does not resolve the campaign")
    with closing(open_reference(path)) as db:
        objects = db.execute(
            "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        ).fetchall()
        if any(row["type"] not in {"table", "index"} for row in objects):
            raise ValueError("publication catalog must not contain views or triggers")
        tables = {row["name"] for row in objects if row["type"] == "table"}
        if not REQUIRED_TABLES <= tables or not tables <= CATALOG_COLUMNS.keys():
            raise ValueError("publication catalog has missing required or unrelated/private tables")
        for table in tables:
            columns = {row["name"] for row in db.execute(f'PRAGMA table_info("{table}")')}
            if not columns <= CATALOG_COLUMNS[table]:
                raise ValueError(f"{table}: non-public columns present")
            required = {
                "demo_experiments": CATALOG_COLUMNS["demo_experiments"],
                "demo_controls": CATALOG_COLUMNS["demo_controls"],
                "experiments": CATALOG_COLUMNS["experiments"],
                "simulation_jobs": CATALOG_COLUMNS["simulation_jobs"],
                "simulation_results": {
                    "id",
                    "job_id",
                    "experiment_id",
                    "seed",
                    "generation",
                    "divided",
                    "terminated",
                    "termination_reason",
                },
            }.get(table, set())
            if not required <= columns:
                raise ValueError(f"{table}: required publication columns missing")
            for row in db.execute(f'SELECT * FROM "{table}"'):
                if any(isinstance(value, str) and PRIVATE_TEXT.search(value) for value in row):
                    raise ValueError(f"{table}: credential-like text or host-specific paths")
        actual = {
            (row["key"], row["experiment_id"], row["job_id"])
            for row in db.execute("SELECT * FROM demo_experiments")
        }
        expected = {(exp.key, exp.experiment_id, exp.job_id) for exp in manifest.experiments}
        if actual != expected or db.execute("SELECT count(*) FROM demo_experiments").fetchone()[
            0
        ] != len(expected):
            raise ValueError("catalog experiment mapping mismatch")
        expected_controls = {
            (exp.key, link.key, link.role)
            for exp in manifest.campaign.experiments
            if exp.key in {e.key for e in manifest.experiments}
            for link in exp.controls
        }
        controls = [
            (row["experiment_key"], row["control_key"], row["role"])
            for row in db.execute("SELECT * FROM demo_controls")
        ]
        if set(controls) != expected_controls or len(controls) != len(expected_controls):
            raise ValueError("catalog control mapping mismatch")
        if {row[0] for row in db.execute("SELECT id FROM experiments")} != {
            e.experiment_id for e in manifest.experiments
        }:
            raise ValueError("catalog contains unrelated or missing experiments")
        specs = {exp.key: exp for exp in manifest.campaign.experiments}
        for exp in manifest.experiments:
            row = db.execute(
                "SELECT * FROM experiments WHERE id=?", (exp.experiment_id,)
            ).fetchone()
            spec = specs[exp.key]
            if (
                row["variant_type"],
                row["variant_index"],
                row["condition"],
                row["gene_symbol"],
            ) != (
                spec.variant,
                exp.variant_index,
                exp.initial_condition,
                spec.gene or "",
            ):
                raise ValueError("catalog execution configuration mismatch")
            resolved = next(r for r in reference["experiments"] if r["key"] == exp.key)
            if resolved["variant_index"] != exp.variant_index:
                raise ValueError("catalog knockout index differs from release")
        jobs = [
            (row["id"], row["experiment_id"], row["seed"], row["generations"])
            for row in db.execute("SELECT * FROM simulation_jobs")
        ]
        if set(jobs) != {(exp.job_id, exp.experiment_id, 0, 4) for exp in manifest.experiments}:
            raise ValueError("catalog job mapping mismatch")
        expected_results = {
            (exp.job_id, exp.experiment_id, t.seed, t.generation)
            for exp in manifest.experiments
            for t in exp.trajectories
        }
        results = [
            (row["job_id"], row["experiment_id"], row["seed"], row["generation"])
            for row in db.execute("SELECT * FROM simulation_results")
        ]
        if set(results) != expected_results or len(results) != len(expected_results):
            raise ValueError("catalog result mapping mismatch")
        for exp in manifest.experiments:
            job = db.execute(
                "SELECT status FROM simulation_jobs WHERE id=?", (exp.job_id,)
            ).fetchone()
            expected_status = (
                "failed" if exp.outcome in {"missing_output", "execution_error"} else "done"
            )
            if job["status"] != expected_status:
                raise ValueError("catalog job outcome mismatch")
            for trajectory in exp.trajectories:
                row = db.execute(
                    "SELECT divided,terminated,termination_reason FROM simulation_results "
                    "WHERE job_id=? AND seed=? AND generation=?",
                    (exp.job_id, trajectory.seed, trajectory.generation),
                ).fetchone()
                if tuple(row) != (
                    int(trajectory.outcome == "completed"),
                    int(trajectory.outcome == "terminated"),
                    trajectory.termination_reason,
                ):
                    raise ValueError("catalog trajectory outcome mismatch")


def _check_shard(path: Path, exp: PublishedExperiment) -> None:
    with h5py.File(path, "r") as h5:
        expected_datasets = set()
        for trajectory in exp.trajectories:
            group = h5[trajectory.h5_group]
            for field in (
                "seed",
                "generation",
                "lineage_start_sec",
                "lineage_end_sec",
                "outcome",
                "termination_reason",
            ):
                if group.attrs.get(field) != getattr(trajectory, field):
                    raise ValueError(f"{exp.key}: HDF5 {field} differs from metadata")
            for name, availability in trajectory.channels.items():
                if not availability.available:
                    if name in group:
                        raise ValueError(f"{exp.key}: unavailable channel contains data: {name}")
                    continue
                channel = group[name]
                expected_datasets.update({channel.name + "/time", channel.name + "/value"})
                time_ds, values = channel["time"], channel["value"]
                clock = time_ds[:]
                if (
                    clock.ndim != 1
                    or clock.size == 0
                    or not np.isfinite(clock).all()
                    or np.any(np.diff(clock) <= 0)
                ):
                    raise ValueError(f"{exp.key}/{name}: invalid time coordinates")
                if time_ds.attrs.get("source") not in {"Main.time", "listener.time"}:
                    raise ValueError(f"{exp.key}/{name}: real source clock provenance required")
                if time_ds.attrs.get("unit") != "s":
                    raise ValueError("time coordinates must use elapsed lineage seconds")
                if (
                    clock[0] < trajectory.lineage_start_sec
                    or clock[-1] > trajectory.lineage_end_sec
                ):
                    raise ValueError("channel clock outside lineage bounds")
                rank = 2 if name in MATRIX_CHANNELS else 1
                if values.ndim != rank or values.shape[0] != clock.size:
                    raise ValueError(f"{exp.key}/{name}: invalid value dimensions")
                if clock.size != availability.source_samples:
                    raise ValueError("source sample count differs; time thinning is prohibited")
                if (rank == 2 and values.shape[1] != availability.source_columns) or (
                    rank == 1 and availability.source_columns is not None
                ):
                    raise ValueError("source column count differs; column thinning is prohibited")
                if not values.attrs.get("unit"):
                    raise ValueError(f"{exp.key}/{name}: missing units")
                # Preserve the model's genuinely undefined initial growth sample.
                # No other nonfinite values or invalid timestamps are accepted.
                initial_nan = bool(name == "growth_rate" and np.isnan(values[0]))
                if availability.undefined_samples != int(initial_nan):
                    raise ValueError("undefined sample accounting mismatch")
                if initial_nan and (
                    clock[0] != trajectory.lineage_start_sec
                    or availability.undefined_reason
                    != "Initial growth rate is undefined before the first simulation step"
                ):
                    raise ValueError("undefined growth-rate provenance mismatch")
                for start in range(0, len(clock), 256):
                    block = values[start : start + 256]
                    if initial_nan and start == 0:
                        block = block[1:]
                    if not np.isfinite(block).all():
                        raise ValueError(f"{exp.key}/{name}: non-finite values")
                if rank == 2:
                    ids_path = f"/reference/{name}_ids"
                    ids = h5[ids_path].asstr()[:].tolist()
                    expected_datasets.add(ids_path)
                    if (
                        not ids
                        or not all(item.strip() for item in ids)
                        or len(ids) != values.shape[1]
                        or len(set(ids)) != len(ids)
                    ):
                        raise ValueError(f"{exp.key}/{name}: invalid column identifiers")
        actual_datasets = set()

        def collect(name, obj):
            for key, value in obj.attrs.items():
                if re.search(
                    r"secret|api_key|password|token|provider", key, re.I
                ) or PRIVATE_TEXT.search(str(value)):
                    raise ValueError("private HDF5 attributes are not publishable")
            if isinstance(obj, h5py.Dataset):
                actual_datasets.add("/" + name)
                if name.startswith("reference/"):
                    if any(PRIVATE_TEXT.search(item) for item in obj.asstr()[:]):
                        raise ValueError("private text in column identifiers")

        collect("", h5)
        h5.visititems(collect)
        if actual_datasets != expected_datasets:
            raise ValueError(f"{exp.key}: unindexed or missing HDF5 datasets")


def validate_release(
    directory: Path, *, allow_synthetic: bool = False, allow_pilot: bool = False
) -> dict:
    directory = directory.resolve()
    report = {"valid": False, "errors": [], "total_bytes": 0}
    try:
        manifest = ReleaseManifest.model_validate_json((directory / "manifest.json").read_text())
        if manifest.scope == "pilot" and not allow_pilot:
            raise ValueError("pilot bundle requires explicit --allow-pilot; not a full publication")
        if manifest.synthetic_fixture and not allow_synthetic:
            raise ValueError("synthetic test bundle is not a publishable release")
        if PRIVATE_TEXT.search(json.dumps(manifest.model_dump())):
            raise ValueError("manifest contains credential-like text or host-specific paths")
        files = list(directory.rglob("*"))
        if any(path.is_symlink() for path in files):
            raise ValueError("release must not contain symlinks")
        actual = {path.relative_to(directory).as_posix() for path in files if path.is_file()}
        if actual != {item.path for item in manifest.files} | {"manifest.json"}:
            raise ValueError("release contains unlisted or missing files")
        report["total_bytes"] = sum(path.stat().st_size for path in files if path.is_file())
        if report["total_bytes"] > manifest.campaign.max_bytes:
            raise ValueError(
                "release exceeds 10 GB; stop and revise explicitly, never thin automatically"
            )
        report["above_target"] = report["total_bytes"] >= manifest.campaign.target_bytes
        for item in manifest.files:
            path = directory / item.path
            if path.stat().st_size != item.bytes or file_sha256(path) != item.sha256:
                raise ValueError(f"payload size/checksum mismatch: {item.path}")
        _check_catalog(directory / "catalog.sqlite", manifest)
        if manifest.references is not None:
            _check_references(directory, manifest)
        metadata = _jsonl(directory / "metadata.jsonl", MetadataRow)
        expected_rows = {
            (exp.key, t.seed, t.generation)
            for exp in manifest.experiments
            for t in exp.trajectories
        }
        actual_rows = [(row.key, row.seed, row.generation) for row in metadata]
        if set(actual_rows) != expected_rows or len(actual_rows) != len(expected_rows):
            raise ValueError("metadata trajectory index mismatch")
        qc = _jsonl(directory / "qc.jsonl", QCRow)
        expected_qc = {(exp.key, exp.outcome, exp.reason) for exp in manifest.experiments}
        if {(row.key, row.outcome, row.reason) for row in qc} != expected_qc or len(qc) != len(
            expected_qc
        ):
            raise ValueError("QC experiment index mismatch")
        for filename in ("metadata.jsonl", "qc.jsonl", "README.md"):
            if PRIVATE_TEXT.search((directory / filename).read_text()):
                raise ValueError(f"{filename}: credential-like text or host-specific paths")
        if not (directory / "README.md").read_text().strip():
            raise ValueError("dataset card must not be empty")
        for exp in manifest.experiments:
            if exp.shard:
                _check_shard(directory / exp.shard, exp)
        report["valid"] = True
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as exc:
        if isinstance(exc, ValidationError):
            report["errors"].extend(
                f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
                for error in exc.errors(include_input=False, include_context=False)
            )
        else:
            report["errors"].append(str(exc))
    return report


def _check_references(directory: Path, manifest: ReleaseManifest) -> None:
    path = directory / manifest.references.path
    if path.stat().st_size > 16 * 1024**2:
        raise ValueError("reference metadata exceeds its 16 MiB bound")
    text = path.read_text()
    refs = ReferenceDocument.model_validate_json(text)
    # Inspect decoded strings: JSON escapes in prose such as "Modifies:\n"
    # must not be mistaken for a Windows drive path.
    def private(value):
        if isinstance(value, str):
            return bool(PRIVATE_TEXT.search(value))
        if isinstance(value, dict):
            return any(private(k) or private(v) for k, v in value.items())
        if isinstance(value, list):
            return any(private(v) for v in value)
        return False
    if private(refs.model_dump()):
        raise ValueError("reference metadata contains private paths or credentials")
    if (refs.simulation_source_sha256 != manifest.provenance.simulation_source_sha256
        or refs.prepared_model_sha256 != manifest.provenance.prepared_model_sha256
        or refs.catalog_sha256 != file_sha256(directory / "catalog.sqlite")):
        raise ValueError("reference source/model/catalog fingerprint mismatch")
    required = {"media_stocks", "environment_molecules", "media_recipes", "conditions", "tf_conditions", "timelines"}
    if set(refs.condition_catalog) != required or not all(refs.condition_catalog[k] for k in required):
        raise ValueError("reference condition catalog is incomplete")
    with closing(open_reference(directory / "catalog.sqlite")) as db:
        for gene in db.execute("SELECT symbol,ko_index FROM genes WHERE ko_index>0"):
            target = refs.gene_targets.get(gene["symbol"])
            if (not target or target.get("index") != gene["ko_index"] or not target.get("rna_id")
                or gene["symbol"] not in target.get("genes", [])
                or len(set(target["genes"])) != len(target["genes"])):
                raise ValueError("reference transcription-unit mapping mismatch: " + gene["symbol"])
        actual = {v.get("name") for v in refs.variants}
        if len(actual) != len(refs.variants) or actual != {r[0] for r in db.execute("SELECT name FROM variants")}:
            raise ValueError("reference variant inventory mismatch")
        for table, key in (("conditions", "condition"), ("media_recipes", "media_id"), ("timelines", "timeline")):
            expected = {r[0] for r in db.execute("SELECT " + ("media_id" if table == "media_recipes" else "name") + " FROM " + table)}
            if not expected <= {r.get(key) for r in refs.condition_catalog[table]}:
                raise ValueError("reference catalog names differ: " + table)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--allow-synthetic", action="store_true", help="test fixtures only")
    parser.add_argument("--allow-pilot", action="store_true", help="isolated pilot only")
    args = parser.parse_args()
    report = validate_release(
        args.directory, allow_synthetic=args.allow_synthetic, allow_pilot=args.allow_pilot
    )
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
