"""Lossless explorer-v1 extraction; intentionally separate from legacy v0."""

from __future__ import annotations
from contextlib import closing
from pathlib import Path
import json
import re
import sqlite3

import h5py
import numpy as np

from app.services.iff_reader import list_columns, read_attribute, read_column
from app.services.table_reader_bridge import (
    find_sim_outs,
    read_lineage_terminations,
    termination_reason,
)
from .demo_campaign import DEFAULT_MANIFEST, CampaignSpec, file_sha256, fingerprint
from .explorer_contract import CATALOG_COLUMNS, CHANNELS, ReleaseManifest, validate_release

# Each scalar's source, reduction and unit are explicit. No reader fallback clocks.
SCALARS = {
    "cell_mass": ("Mass", "cellMass", "sum", "fg"),
    "dry_mass": ("Mass", "dryMass", "sum", "fg"),
    "protein_mass": ("Mass", "proteinMass", "sum", "fg"),
    "rna_mass": ("Mass", "rnaMass", "sum", "fg"),
    "dna_mass": ("Mass", "dnaMass", "sum", "fg"),
    "small_molecule_mass": ("Mass", "smallMoleculeMass", "sum", "fg"),
    "growth_rate": ("Mass", "instantaneous_growth_rate", "sum", "1/s"),
    "cell_volume": ("Mass", "cellVolume", "sum", "fL"),
    "ppgpp_conc": ("GrowthLimits", "ppgpp_conc", "sum", "uM"),
    "aa_pool_size": ("GrowthLimits", "aaPoolSize", "sum", "counts"),
    "ntp_pool_size": ("GrowthLimits", "ntpPoolSize", "sum", "counts"),
    "trna_charged_fraction": ("GrowthLimits", "fraction_trna_charged", "scalar", "fraction"),
    "aa_supply_total": ("GrowthLimits", "aa_supply", "sum", "counts/s"),
    "aa_synthesis_total": ("GrowthLimits", "aa_synthesis", "sum", "counts/s"),
    "mrna_counts": ("RNACounts", "mRNA_counts", "sum", "molecules"),
    "fba_objective": ("FBAResults", "objectiveValue", "sum", "model objective"),
    "exchange_flux_total": ("FBAResults", "externalExchangeFluxes", "abs_sum", "mmol/gDCW/h"),
    "reaction_flux_total": ("FBAResults", "reactionFluxes", "abs_sum", "mmol/L/s"),
    "ribosome_elongation_rate": ("RibosomeData", "effectiveElongationRate", "sum", "aa/s"),
    "ribosome_actual_elongations": ("RibosomeData", "actualElongations", "sum", "aa"),
    "n_oric": ("ReplicationData", "numberOfOric", "sum", "count"),
}
MATRICES = {
    "mrna_counts_matrix": ("RNACounts", "mRNA_counts", "mRNA_ids", "molecules"),
    "protein_counts_matrix": ("MonomerCounts", "monomerCounts", "monomerIds", "molecules"),
    "reaction_flux_matrix": ("FBAResults", "reactionFluxes", "reactionIDs", "mmol/L/s"),
    "exchange_flux_matrix": (
        "FBAResults",
        "externalExchangeFluxes",
        "externalMoleculeIDs",
        "mmol/gDCW/h",
    ),
}


# This reviewed logger writes Main and every listener/external-state row in the
# same copyData call (initial state and identical logEvery cadence). Pinning its
# exact source makes equal row counts valid alignment evidence when a listener
# has neither a clock nor a simulationStep column. A changed writer fails closed.
CLOCK_WRITER_SHA256 = "6227156cc42f34959c74e17da365e04eb18e30b72618bb6aa82077b45e2ac9af"


def verified_clock_writer():
    packaged = Path(__file__).with_name("source_clock_writer.data")
    path = (
        packaged
        if packaged.is_file()
        else Path(__file__).resolve().parents[3] / "wholecell/loggers/disk.py"
    )
    return path.is_file() and file_sha256(path) == CLOCK_WRITER_SHA256


def source_channel(path, name):
    """Missing columns are explicit; malformed existing data fails extraction."""
    table, column, operation, unit = (MATRICES if name in MATRICES else SCALARS)[name]
    directory = path / table
    if not directory.is_dir() or column not in list_columns(directory):
        return None
    values = np.asarray(read_column(directory, column, squeeze=False))
    if values.shape[0] == 0:
        return None
    if name in MATRICES:
        if values.ndim != 2:
            raise ValueError(f"{name}: source matrix must be two dimensional")
        ids = [str(x) for x in read_attribute(directory, operation)]
        if len(ids) != values.shape[1] or len(set(ids)) != len(ids):
            raise ValueError(f"{name}: source identifiers do not match columns")
    else:
        ids = None
        if operation == "scalar" and values.ndim > 1 and values.shape[1] != 1:
            return None  # No scientifically defined scalar aggregation for per-tRNA fractions.
        if values.ndim > 1:
            values = (np.abs(values) if operation == "abs_sum" else values).sum(axis=1)
        elif operation == "abs_sum":
            values = np.abs(values)
        if values.ndim != 1:
            raise ValueError(f"{name}: unsupported source dimensions")
    if "time" in list_columns(directory):
        clock = np.asarray(read_column(directory, "time")).reshape(-1)
        source = "listener.time"
    else:
        # Main alignment requires exact row counts AND identical simulationStep
        # vectors. Equal lengths alone are insufficient evidence of alignment.
        main = path / "Main"
        clock = np.asarray(read_column(main, "time")).reshape(-1)
        listener_has_steps = "simulationStep" in list_columns(directory)
        if listener_has_steps:
            aligned = "simulationStep" in list_columns(main) and np.array_equal(
                read_column(directory, "simulationStep"), read_column(main, "simulationStep")
            )
        else:
            aligned = verified_clock_writer()
        if not aligned:
            raise ValueError(f"{name}: no listener clock or verified Main.time alignment")
        source = "Main.time"
    if len(clock) != values.shape[0] or not np.isfinite(clock).all() or np.any(np.diff(clock) <= 0):
        raise ValueError(
            f"{name}: invalid/misaligned source clock; never truncate or invent timestamps"
        )
    return dict(time=clock, value=values, ids=ids, unit=unit, clock_source=source)


def inspect_run(run):
    found = {}
    for path in find_sim_outs(run):
        # Strict parsing; the older helper defaults invalid path parts to zero.
        match = re.search(r"/([0-9]+)/generation_([0-9]+)/([0-9]+)/simOut$", str(path))
        if not match or int(match[1]) != 0 or int(match[3]) != 0:
            raise ValueError("unexpected seed/cell path in pilot output")
        gen = int(match[2])
        if gen in found or gen > 3:
            raise ValueError("duplicate/unexpected actual generation")
        found[gen] = path
    if not found or sorted(found) != list(range(len(found))):
        raise ValueError("missing output or noncontiguous actual generation prefix")
    terminations = read_lineage_terminations(run)
    trajectories = []
    previous = -1.0
    for gen, path in sorted(found.items()):
        clock = np.asarray(read_column(path / "Main", "time")).reshape(-1)
        if not len(clock) or not np.isfinite(clock).all() or np.any(np.diff(clock) <= 0):
            raise ValueError("invalid Main.time clock")
        start, end = float(clock[0]), float(clock[-1])
        if gen == 0 and start != 0 or start < previous:
            raise ValueError("lineage clock reset/overlap")
        previous = end
        termination = terminations.get((0, gen))
        # Daughter state files are actual division evidence, unlike mass ratios.
        daughters = sorted(path.glob("Daughter*_inherited_state.cPickle"))
        if not daughters:
            daughters = sorted(path.parent.glob("Daughter*_inherited_state.cPickle"))
        if termination:
            if termination.get("exception") == "TimeLimitReached":
                outcome, reason = "no_division", ""
            else:
                outcome, reason = "terminated", termination_reason(termination)
        elif daughters:
            outcome, reason = "completed", ""
        else:
            raise ValueError("no authoritative division or biological termination record")
        trajectories.append(
            dict(
                seed=0,
                generation=gen,
                h5_group=f"seed=0/gen={gen}",
                lineage_start_sec=start,
                lineage_end_sec=end,
                outcome=outcome,
                termination_reason=reason,
            )
        )
        if outcome != "completed" and gen != max(found):
            raise ValueError("generation follows a non-dividing/terminated cell")
    if trajectories[-1]["outcome"] == "completed" and len(trajectories) != 4:
        raise ValueError("missing generations without biological termination")
    final = trajectories[-1]
    reason = final["termination_reason"]
    if final["outcome"] == "no_division":
        # Preserve the model-time explanation without turning it into a death
        # label or confusing it with the wrapper's infrastructure deadline.
        reason = termination_reason(terminations[(0, final["generation"])])
    return dict(outcome=final["outcome"], reason=reason, trajectories=trajectories)


def paths_for(run):
    return {int(re.search(r"generation_([0-9]+)", str(p))[1]): p for p in find_sim_outs(run)}


def verify_execution(run, spec):
    from .demo_campaign import parse_timeline

    metadata_path = run / "metadata/metadata.json"
    metadata = json.loads(metadata_path.read_text())
    events = [event.model_dump() for event in spec.events]
    if metadata.get("initial_condition") != spec.initial_condition:
        raise ValueError("actual saved initialization differs from campaign")
    if parse_timeline(metadata.get("timeline", "")) != events:
        raise ValueError("actual saved timeline differs from campaign")
    if metadata.get("seed") != 0 or metadata.get("generations") != 4:
        raise ValueError("actual execution seed/generations differ from campaign")
    clocks, observations = [], []
    all_clock, all_media = [], []
    for generation, path in sorted(paths_for(run).items()):
        clock = np.asarray(read_column(path / "Main", "time")).reshape(-1)
        raw_media = np.asarray(read_column(path / "Environment", "media_id")).reshape(-1)
        media = [
            str(value.decode() if isinstance(value, bytes) else value).strip()
            for value in raw_media
        ]
        # The frozen Disk.copyData appends Main and every external state in one
        # operation, including initial state and the same logEvery cadence.
        # Equal lengths are checked in addition to that known writer contract.
        if len(media) != len(clock):
            raise ValueError("environment/Main logging alignment mismatch")
        for t, actual in zip(clock, media):
            expected = [event.media for event in spec.events if event.time_sec <= t][-1]
            if actual != expected:
                raise ValueError(
                    f"environment schedule differs at lineage time {t:g}: expected {expected}, observed {actual}"
                )
        try:
            initial = float(read_attribute(path / "Main", "initialTime"))
            final = float(read_attribute(path / "Main", "lengthSec"))
            if initial != float(clock[0]) or final < float(clock[-1]):
                raise ValueError("Main metadata clock differs from saved trajectory")
        except (FileNotFoundError, KeyError):
            initial, final = None, None
        clocks.append(
            dict(
                generation=generation,
                start_sec=float(clock[0]),
                end_sec=float(clock[-1]),
                samples=len(clock),
                actual_initial_sec=initial,
                actual_final_sec=final,
            )
        )
        all_clock.extend(clock.tolist())
        all_media.extend(media)
    for event in spec.events[1:]:
        reached = [
            float(t)
            for t, media in zip(all_clock, all_media)
            if t >= event.time_sec and media == event.media
        ]
        observations.append(
            dict(
                requested_lineage_sec=event.time_sec,
                media=event.media,
                first_saved_observation_sec=min(reached) if reached else None,
                status="verified" if reached else "not_reached_before_lineage_end",
            )
        )
    source_files = [
        dict(path=p.relative_to(run).as_posix(), bytes=p.stat().st_size, sha256=file_sha256(p))
        for p in sorted(run.rglob("*"))
        if p.is_file() and not p.is_symlink()
    ]
    return dict(
        source_files_sha256=fingerprint(source_files),
        source_files=source_files,
        initial_condition=metadata["initial_condition"],
        events=events,
        saved_run_metadata_sha256=file_sha256(metadata_path),
        simulation_options={
            key: metadata[key]
            for key in (
                "seed",
                "generations",
                "init_sims",
                "mass_distribution",
                "d_period_division",
                "variable_elongation_transcription",
                "variable_elongation_translation",
                "translation_supply",
                "trna_charging",
                "aa_supply_in_charging",
                "ppgpp_regulation",
                "disable_ppgpp_elongation_inhibition",
                "superhelical_density",
                "recycle_stalled_elongation",
                "mechanistic_replisome",
                "mechanistic_translation_supply",
                "mechanistic_aa_transport",
                "trna_attenuation",
                "adjust_timestep_for_charging",
            )
            if key in metadata
        },
        environment_clock_alignment="frozen Disk.copyData common Main/external-state append, exact sample counts",
        clock_writer_sha256=CLOCK_WRITER_SHA256,
        generation_clocks=clocks,
        event_observations=observations,
    )


def write_shard(path, run, trajectories):
    source_paths = paths_for(run)
    with h5py.File(path, "w") as h5:
        for trajectory in trajectories:
            group = h5.create_group(trajectory["h5_group"])
            for field, value in trajectory.items():
                if field != "channels":
                    group.attrs[field] = value
            availability = {}
            for name in CHANNELS:
                data = source_channel(source_paths[trajectory["generation"]], name)
                if data is None:
                    availability[name] = dict(
                        available=False,
                        reason="Source absent/empty, or no defined scalar aggregation",
                    )
                    continue
                channel = group.create_group(name)
                time_ds = channel.create_dataset(
                    "time", data=data["time"], compression="gzip", shuffle=True
                )
                time_ds.attrs.update(unit="s", source=data["clock_source"])
                values = channel.create_dataset(
                    "value", data=data["value"], compression="gzip", shuffle=True
                )
                values.attrs["unit"] = data["unit"]
                entry = dict(available=True, source_samples=len(data["time"]))
                if name == "growth_rate" and np.isnan(data["value"][0]):
                    if not np.isfinite(data["value"][1:]).all():
                        raise ValueError("undefined growth rate outside initial sample")
                    entry.update(
                        undefined_samples=1,
                        undefined_reason="Initial growth rate is undefined before the first simulation step",
                    )
                if data["ids"] is not None:
                    ids_path = "reference/" + name + "_ids"
                    if ids_path in h5:
                        if h5[ids_path].asstr()[:].tolist() != data["ids"]:
                            raise ValueError("identifiers change between generations: " + name)
                    else:
                        h5.create_dataset(ids_path, data=data["ids"], dtype=h5py.string_dtype())
                    entry["source_columns"] = len(data["ids"])
                availability[name] = entry
                del data
            trajectory["channels"] = availability


def compare_source(shard, run, trajectories):
    """Independent second read of raw data, separate from structural validation."""
    compared = []
    with h5py.File(shard, "r") as h5:
        for gen, source in sorted(paths_for(run).items()):
            trajectory = next(t for t in trajectories if t["generation"] == gen)
            for name in CHANNELS:
                raw = source_channel(source, name)
                available = trajectory["channels"][name]["available"]
                if available != (raw is not None):
                    raise ValueError("source availability differs: " + name)
                if raw is None:
                    continue
                group = h5[trajectory["h5_group"] + "/" + name]
                if not np.array_equal(group["time"][:], raw["time"]):
                    raise ValueError("source timestamp comparison failed: " + name)
                if (
                    group["value"].shape != raw["value"].shape
                    or group["value"].dtype != raw["value"].dtype
                ):
                    raise ValueError("source count/dtype comparison failed: " + name)
                for start in range(0, len(raw["time"]), 256):
                    if not np.array_equal(
                        group["value"][start : start + 256].view(np.uint8),
                        raw["value"][start : start + 256].view(np.uint8),
                    ):
                        raise ValueError("source value comparison failed: " + name)
                if (
                    raw["ids"] is not None
                    and h5["reference/" + name + "_ids"].asstr()[:].tolist() != raw["ids"]
                ):
                    raise ValueError("source identifier comparison failed: " + name)
                if group["value"].attrs["unit"] != raw["unit"]:
                    raise ValueError("source units differ: " + name)
                compared.append(
                    dict(
                        generation=gen,
                        channel=name,
                        samples=len(raw["time"]),
                        columns=len(raw["ids"]) if raw["ids"] is not None else None,
                    )
                )
                del raw
    return compared


def project_catalog(source, target, campaign, experiments):
    with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(target)) as dst:
        src.row_factory = sqlite3.Row
        # Copy only allowed reference tables/columns into a newly created database.
        for table in (
            "genes",
            "conditions",
            "media_recipes",
            "timelines",
            "variants",
            "tf_edges",
            "aa_pathways",
            "complexes",
        ):
            info = src.execute("PRAGMA table_info(" + table + ")").fetchall()
            if not info:
                continue
            columns = [row for row in info if row["name"] in CATALOG_COLUMNS[table]]
            dst.execute(
                "CREATE TABLE "
                + table
                + " ("
                + ",".join('"' + row["name"] + '" ' + row["type"] for row in columns)
                + ")"
            )
            names = ",".join('"' + row["name"] + '"' for row in columns)
            rows = src.execute("SELECT " + names + " FROM " + table)
            dst.executemany(
                "INSERT INTO " + table + " VALUES (" + ",".join("?" for _ in columns) + ")", rows
            )
        dst.executescript("""
        CREATE TABLE demo_experiments (key TEXT, experiment_id INTEGER, job_id INTEGER);
        CREATE TABLE demo_controls (experiment_key TEXT, control_key TEXT, role TEXT);
        CREATE TABLE experiments (id INTEGER PRIMARY KEY,name TEXT,variant_type TEXT,variant_index INTEGER,condition TEXT,gene_symbol TEXT);
        CREATE TABLE simulation_jobs (id INTEGER PRIMARY KEY,experiment_id INTEGER,seed INTEGER,generations INTEGER,status TEXT);
        CREATE TABLE simulation_results (id INTEGER PRIMARY KEY,job_id INTEGER,experiment_id INTEGER,seed INTEGER,generation INTEGER,divided INTEGER,terminated INTEGER,termination_reason TEXT);
        """)
        specs = {e.key: e for e in campaign.experiments}
        rid = 0
        for exp in experiments:
            spec = specs[exp["key"]]
            eid, jid = exp["experiment_id"], exp["job_id"]
            dst.execute("INSERT INTO demo_experiments VALUES (?,?,?)", (spec.key, eid, jid))
            dst.execute(
                "INSERT INTO experiments VALUES (?,?,?,?,?,?)",
                (
                    eid,
                    spec.key,
                    spec.variant,
                    exp["variant_index"],
                    exp["initial_condition"],
                    spec.gene or "",
                ),
            )
            dst.execute(
                "INSERT INTO simulation_jobs VALUES (?,?,0,4,?)",
                (
                    jid,
                    eid,
                    "failed" if exp["outcome"] in ("execution_error", "missing_output") else "done",
                ),
            )
            for link in spec.controls:
                dst.execute(
                    "INSERT INTO demo_controls VALUES (?,?,?)", (spec.key, link.key, link.role)
                )
            for trajectory in exp["trajectories"]:
                rid += 1
                dst.execute(
                    "INSERT INTO simulation_results VALUES (?,?,?,0,?,?,?,?)",
                    (
                        rid,
                        jid,
                        eid,
                        trajectory["generation"],
                        int(trajectory["outcome"] == "completed"),
                        int(trajectory["outcome"] == "terminated"),
                        trajectory["termination_reason"],
                    ),
                )
        dst.commit()


def export_pilot(state, output, release, receipt):
    if (state / "demo-authorization.json").exists() and any((state / "cleanup").glob("*.json")):
        # HF-05 deliberately removes raw listeners after a verified checkpoint.
        # Pilot commands continue to validate the active publication without
        # rebuilding old raw output or replacing a completed full release.
        from .demo_checkpoint import verify_checkpoint

        for key in CampaignSpec.model_validate_json(DEFAULT_MANIFEST.read_text()).pilot_keys:
            verify_checkpoint(release / "checkpoints" / key,
                              campaign_sha256=receipt["campaign_sha256"],
                              readiness_sha256=receipt["receipt_sha256"])
        report = validate_release(release / "current", allow_pilot=True)
        if not report["valid"]:
            raise ValueError(str(report))
        return report
    campaign = CampaignSpec.model_validate_json(DEFAULT_MANIFEST.read_text())
    with closing(sqlite3.connect(state / "catalog.sqlite")) as db:
        db.row_factory = sqlite3.Row
        rows = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM pilot_submissions WHERE state IN ('complete','failed') ORDER BY job_id"
            )
        ]
        attempted = db.execute("SELECT count(*) FROM pilot_submissions").fetchone()[0]
    if not rows or len(rows) != attempted:
        raise ValueError(
            "export waits for every attempted job to have an accounted scientific outcome"
        )
    serving_path = state / "serving.json"
    serving = json.loads(serving_path.read_text()) if serving_path.is_file() else receipt["inputs"]
    # Exporter revisions get separate immutable bundles. Retain failed drafts.
    identity = fingerprint(
        dict(
            receipt=receipt["receipt_sha256"],
            outcomes=[r["outcome_json"] for r in rows],
            exporter_image_digest=serving["image_ids"]["tools"],
        )
    )
    dest = release / ("bundle-" + identity[:20])
    if (dest / "manifest.json").exists():
        report = validate_release(dest, allow_pilot=True)
        if not report["valid"]:
            raise ValueError(str(report))
        published = json.loads((dest / "manifest.json").read_text())
        for row in rows:
            exp = next(e for e in published["experiments"] if e["key"] == row["key"])
            if exp["shard"]:
                run = output / row["run_dir"]
                compare_source(dest / exp["shard"], run, exp["trajectories"])
                spec = next(s for s in campaign.experiments if s.key == exp["key"])
                if (
                    verify_execution(run, spec)["source_files_sha256"]
                    != exp["execution_provenance"]["source_files_sha256"]
                ):
                    raise ValueError("retained raw output changed after publication")
        activate_bundle(release, dest)
        return report
    if dest.exists():
        raise ValueError("partial export retained; inspect it before explicit recovery")
    (dest / "trajectories").mkdir(parents=True)
    experiments, comparison, metadata, qc = [], [], [], []
    specs = {e.key: e for e in campaign.experiments}
    for row in rows:
        spec = specs[row["key"]]
        run = output / row["run_dir"]
        failed = row["state"] == "failed"
        info = (
            dict(
                outcome="execution_error",
                reason="Infrastructure failure; inspect retained local pilot logs and metrics",
                trajectories=[],
            )
            if failed
            else inspect_run(run)
        )
        execution_provenance = None if failed else verify_execution(run, spec)
        if execution_provenance is not None:
            observed = json.loads(row["outcome_json"])
            execution_provenance["resource_observations"] = dict(
                metrics={
                    k: observed["metrics"][k]
                    for k in ("duration_sec", "peak_process_group_rss_bytes", "returncode")
                    if k in observed.get("metrics", {})
                },
                raw_bytes=observed.get("raw_bytes"),
                raw_files=observed.get("raw_files"),
                preparation_cache_reused=observed.get("preparation_cache_reused"),
            )
        index = receipt["verified_targets"][spec.gene]["index"] if spec.gene else 0
        target = receipt["verified_targets"][spec.gene] if spec.gene else None
        exp = dict(
            key=spec.key,
            experiment_id=row["experiment_id"],
            job_id=row["job_id"],
            variant_index=index,
            initial_condition=spec.initial_condition,
            events=[event.model_dump() for event in spec.events],
            execution_sha256=fingerprint(spec.execution(index)),
            execution_provenance=execution_provenance,
            transcription_unit_id=target["rna_id"] if target else None,
            co_targeted_genes=[g for g in target["genes"] if g != spec.gene] if target else None,
            outcome=info["outcome"],
            reason=info["reason"],
            shard=None if failed else f"trajectories/{spec.key}.h5",
            trajectories=info["trajectories"],
        )
        if not failed:
            write_shard(dest / exp["shard"], run, exp["trajectories"])
            comparison.append(
                dict(
                    key=spec.key,
                    channels=compare_source(dest / exp["shard"], run, exp["trajectories"]),
                )
            )
        metadata.extend(
            dict(key=spec.key, seed=0, generation=t["generation"]) for t in exp["trajectories"]
        )
        qc.append(dict(key=spec.key, outcome=exp["outcome"], reason=exp["reason"]))
        experiments.append(exp)
        if sum(p.stat().st_size for p in dest.rglob("*") if p.is_file()) > campaign.max_bytes:
            raise ValueError(
                "10 GB release ceiling exceeded; retained output requires explicit review, no thinning"
            )
    project_catalog(state / "reference.sqlite", dest / "catalog.sqlite", campaign, experiments)
    for name, records in [("metadata.jsonl", metadata), ("qc.jsonl", qc)]:
        (dest / name).write_text(
            "".join(json.dumps(record, sort_keys=True) + "\n" for record in records)
        )
    (dest / "README.md").write_text(
        """# hf-demo-v1 real pilot\n\nAn explicitly partial release: one seed, sequential generations, no independent replicates.\nResults describe model expression perturbations, including recorded co-targeted genes.\nBiological hypotheses are questions, not guaranteed rescue/inhibition. Unrun controls are unavailable.\nAll saved samples and matrix columns are preserved with actual elapsed lineage clocks.\nReaction flux values retain their native mmol/L/s units; exchange flux uses mmol/gDCW/h.\nNo assistant/provider data, credentials or host paths are included.\nPreparation/source/image fingerprints and exact initialization/schedule are in manifest.json.\nThe full release targets <5 GB and cannot exceed 10 GB. This pilot requires explicit validation opt-in.\n"""
    )
    actual_preparation = json.loads((state / "preparation-started.json").read_text())["inputs"]
    parca_metadata = json.loads((output / "hf-demo-v1-prepared/metadata/metadata.json").read_text())
    manifest = dict(
        schema_version="explorer-release-v1",
        scope="pilot",
        synthetic_fixture=False,
        campaign=campaign.model_dump(),
        campaign_sha256=fingerprint(campaign.canonical()),
        provenance=dict(
            simulation_source_sha256=receipt["inputs"]["source_sha256"],
            exporter_source_sha256=serving["source_sha256"],
            exporter_image_digest=serving["image_ids"]["tools"],
            clock_writer_sha256=CLOCK_WRITER_SHA256,
            preparation_details=dict(
                source_sha256=actual_preparation["source_sha256"],
                runtime_image_digest=actual_preparation["image_ids"]["runner"],
                settings=actual_preparation["settings"],
                options={
                    key: parca_metadata[key]
                    for key in (
                        "operons",
                        "new_genes",
                        "protein_degradation_combo",
                        "remove_rrna_operons",
                        "remove_rrff",
                        "stable_rrna",
                    )
                    if key in parca_metadata
                },
                duration_sec=receipt["preparation"]["duration_sec"],
                peak_process_group_rss_bytes=receipt["preparation"]["peak_process_group_rss_bytes"],
            ),
            prepared_model_sha256=receipt["kb"]["simData.cPickle"]["sha256"],
            preparation_config_sha256=fingerprint(receipt["inputs"]["settings"]),
            runtime_image_digest=receipt["inputs"]["image_ids"]["runner"],
            initial_condition_binding="--initial-condition",
            model_targets_verified=True,
            preserve_all_samples=True,
            time_basis="elapsed_lineage_seconds",
        ),
        files=[
            dict(path=p.relative_to(dest).as_posix(), bytes=p.stat().st_size, sha256=file_sha256(p))
            for p in sorted(dest.rglob("*"))
            if p.is_file()
        ],
        experiments=experiments,
    )
    ReleaseManifest.model_validate(manifest)
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    report = validate_release(dest, allow_pilot=True)
    (state / "source-comparison.json").write_text(
        json.dumps(dict(passed=True, bundle=dest.name, experiments=comparison), indent=2) + "\n"
    )
    if not report["valid"]:
        raise ValueError(str(report))
    activate_bundle(release, dest)
    return report


def activate_bundle(release, dest):
    temporary = release / "next"
    if temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(dest.name, target_is_directory=True)
    temporary.replace(release / "current")
