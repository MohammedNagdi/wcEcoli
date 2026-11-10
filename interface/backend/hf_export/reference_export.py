"""Offline reference packaging. Serving never imports this module or the model."""

from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
from types import SimpleNamespace

from .demo_campaign import file_sha256, fingerprint
from .explorer_contract import ReferenceDocument, validate_release


def build(base: Path, state: Path, destination: Path):
    from . import pilot_inside as pilot
    from app.routers.condition_catalog import get_condition_catalog, _read_tsv_dicts
    from app.services.variant_metadata import _build_variant_hints
    from app.config import settings
    from sqlmodel import Session, create_engine

    ready = pilot.verify()
    report = validate_release(base)
    if not report["valid"]:
        raise ValueError(str(report))
    manifest = json.loads((base / "manifest.json").read_text())
    if manifest.get("references"):
        return dict(
            directory=str(base.resolve()),
            reused=True,
            manifest_sha256=file_sha256(base / "manifest.json"),
            **report,
        )
    mapping_path = state / "targets.json"
    if file_sha256(mapping_path) != ready["files"]["targets.json"]:
        raise ValueError("authoritative target mapping differs from readiness")
    mapping = json.loads(mapping_path.read_text())
    model = ready["kb"]["simData.cPickle"]["sha256"]
    if mapping["model_sha256"] != model or model != manifest["provenance"]["prepared_model_sha256"]:
        raise ValueError("reference prepared model differs from release")
    catalog = base / "catalog.sqlite"
    engine = create_engine(
        "sqlite:///file:" + str(catalog.resolve()) + "?mode=ro&immutable=1&uri=true"
    )
    with (
        closing(sqlite3.connect(catalog.as_uri() + "?mode=ro&immutable=1", uri=True)) as db,
        Session(engine) as session,
    ):
        db.row_factory = sqlite3.Row
        variants = []
        for row in db.execute("SELECT * FROM variants ORDER BY id"):
            variant = SimpleNamespace(**dict(row))
            hints = _build_variant_hints(variant, session)
            if variant.name == "gene_knockout":
                hints = dict(
                    hints,
                    index_range=[0, max(t["index"] for t in mapping["targets"].values())],
                    index_meaning="Prepared RNA/transcription-unit expression target; use gene search; co-targets are recorded",
                    index_options=[
                        "0: control",
                        "Use the prepared gene-to-transcription-unit mapping; not gene ordering",
                    ],
                )
            variants.append(
                dict(
                    name=variant.name,
                    docstring=variant.docstring,
                    filename=variant.name + ".py",
                    parameter_count=variant.parameter_count,
                    parameter_hints=hints,
                )
            )
    engine.dispose()
    reactions = []
    for row in _read_tsv_dicts(settings.reconstruction_path / "ecoli/flat/metabolic_reactions.tsv"):

        def value(key, default):
            raw = row.get(key, "")
            try:
                return json.loads(raw)
            except (ValueError, TypeError):
                return default

        reactions.append(
            dict(
                id=value("id", row.get("id", "").strip('"')),
                stoichiometry=value("stoichiometry", {}),
                catalysts=value("catalyzed_by", []),
                direction=value("direction", row.get("direction", "").strip('"')),
            )
        )
    execution = {}
    for exp in manifest["experiments"]:
        path = base.parent / "checkpoints" / exp["key"] / "execution.json"
        metadata = json.loads(path.read_text())["metadata"]
        execution[exp["key"]] = {
            k: metadata[k]
            for k in ("length_sec", "generations", "seed", "initial_condition")
            if k in metadata
        }
    refs = dict(
        schema_version="explorer-references-v1",
        simulation_source_sha256=manifest["provenance"]["simulation_source_sha256"],
        prepared_model_sha256=model,
        catalog_sha256=file_sha256(catalog),
        mapping_sha256=file_sha256(mapping_path),
        gene_targets=mapping["targets"],
        condition_catalog=get_condition_catalog().model_dump(),
        variants=variants,
        reactions=reactions,
        execution_settings=execution,
    )
    ReferenceDocument.model_validate(refs)
    identity = fingerprint(refs)
    dest = destination / ("explorer-" + identity[:20])
    if not dest.exists():
        dest.mkdir(parents=True)
        for payload in manifest["files"]:
            source, target = base / payload["path"], dest / payload["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix == ".h5":
                os.link(source, target)
            else:
                shutil.copy2(source, target)
        text = json.dumps(refs, indent=2, sort_keys=True) + "\n"
        (dest / "references.json").write_text(text)
        manifest["references"] = dict(
            schema_version="explorer-references-v1", path="references.json"
        )
        manifest["files"].append(
            dict(
                path="references.json",
                bytes=len(text.encode()),
                sha256=file_sha256(dest / "references.json"),
            )
        )
        (dest / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    report = validate_release(dest)
    if not report["valid"]:
        raise ValueError(str(report))
    return dict(directory=str(dest), manifest_sha256=file_sha256(dest / "manifest.json"), **report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=Path("/release/current"))
    parser.add_argument("--state", type=Path, default=Path("/pilot"))
    parser.add_argument("--destination", type=Path, default=Path("/release"))
    args = parser.parse_args()
    print(
        json.dumps(
            build(args.base.resolve(), args.state, args.destination), indent=2, sort_keys=True
        )
    )


if __name__ == "__main__":
    main()
