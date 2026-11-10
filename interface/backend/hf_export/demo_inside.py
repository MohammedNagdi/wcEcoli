"""Full demo campaign operations in the isolated tools image; no live app startup."""

from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sys
import time

from . import pilot_inside as pilot
from . import explorer_export as export
from .demo_campaign import file_sha256, fingerprint
from .demo_checkpoint import compare_api, inventory, seal, verify_checkpoint
from .explorer_contract import PublishedExperiment, ReleaseManifest, _check_shard, validate_release

ORDER = (
    "wt-with-aa", "wt-acetate", "wt-no-oxygen", "hisG-with-aa", "trpA-basal",
    "trpA-with-aa", "pgi-basal", "pgi-acetate", "wt-cut-aa",
)


def rows():
    with closing(pilot.database()) as db:
        return {r["key"]: dict(r) for r in db.execute("SELECT * FROM pilot_submissions")}


def checkpoint_dir(key):
    if key not in {e.key for e in pilot.campaign().experiments}:
        raise ValueError("unknown campaign experiment")
    return pilot.RELEASE / "checkpoints" / key


def verified(key):
    ready = pilot.verify()
    result = verify_checkpoint(checkpoint_dir(key), campaign_sha256=ready["campaign_sha256"],
                               readiness_sha256=ready["receipt_sha256"])
    row = rows().get(key)
    if not row or row["state"] != "complete" or result["run_dir"] != row["run_dir"]:
        raise ValueError("checkpoint/ledger execution mismatch")
    exp = result["experiment"]
    if (row["campaign_sha256"] != ready["campaign_sha256"] or row["seed"] != 0
        or row["receipt_sha256"] != ready["receipt_sha256"]
        or exp["experiment_id"] != row["experiment_id"] or exp["job_id"] != row["job_id"]):
        raise ValueError("checkpoint/ledger submission identity mismatch")
    spec = next(e for e in pilot.campaign().experiments if e.key == key)
    target = ready["verified_targets"][spec.gene] if spec.gene else None
    index = target["index"] if target else 0
    if (exp["initial_condition"] != spec.initial_condition
        or exp["events"] != [e.model_dump() for e in spec.events]
        or exp["variant_index"] != index or exp["execution_sha256"] != fingerprint(spec.execution(index))
        or exp["transcription_unit_id"] != (target["rna_id"] if target else None)
        or exp["co_targeted_genes"] != ([g for g in target["genes"] if g != spec.gene] if target else None)):
        raise ValueError("checkpoint configuration/model mapping mismatch")
    if result["outcome_sha256"] != fingerprint(json.loads(row["outcome_json"])):
        raise ValueError("checkpoint/ledger outcome changed")
    return result


def cleanup_state(key):
    path = pilot.STATE / "cleanup" / (key + ".json")
    return pilot.load(path) if path.exists() else dict(state="export_verified")


def authorize_submission(key, ready):
    if key not in ORDER:
        # Full controller adopts pilot jobs; it must never submit replacements.
        if key in rows() and rows()[key]["state"] == "complete":
            return
        raise ValueError("full campaign submits only the nine remaining designs")
    authorization = pilot.load(pilot.STATE / "demo-authorization.json")
    if authorization["readiness_sha256"] != ready["receipt_sha256"]:
        raise ValueError("demo preparation/readiness mismatch")
    preceding = list(pilot.campaign().pilot_keys) + list(ORDER[:ORDER.index(key)])
    for prior in preceding:
        verified(prior)
        if cleanup_state(prior)["state"] != "raw_removed":
            raise ValueError("previous raw output must be verified and removed before submission: " + prior)
    # The pilot layer additionally enforces a transactional single-active-job gate.


def prepare():
    ready = pilot.verify()
    previous = pilot.STATE / "demo-authorization.json"
    prior = pilot.load(previous) if previous.exists() else None
    if prior and prior["readiness_sha256"] != ready["receipt_sha256"]:
        raise ValueError("existing demo authorization differs from readiness")
    if not prior and not pilot.proof_status()["passed"]:
        raise ValueError("HF-04 real browser proof required")
    if any(r["state"] != "complete" for r in rows().values()):
        raise ValueError("prepare requires successful terminal jobs; diagnose retained failures first")
    # Load the pickle only in the actual frozen simulation interpreter. No Parca.
    conditions = sorted({e.initial_condition for e in pilot.campaign().experiments})
    result_path = pilot.OUT / "demo-model-conditions.json"
    code = (
        "import json,pickle; from pathlib import Path; "
        f"m=pickle.load(open({str(pilot.OUT / pilot.MODEL_DIR / 'kb/simData.cPickle')!r},'rb')); "
        f"required={conditions!r}; "
        "missing=[c for c in required if c not in m.conditions]; "
        "assert not missing, 'Prepared model lacks conditions: '+repr(missing); "
        f"Path({str(result_path)!r}).write_text(json.dumps(dict(conditions=required,verified=True)))"
    )
    task_id = "hf-demo-v1-conditions-" + ready["receipt_sha256"][:12]
    try:
        task = pilot.client().status(task_id)
    except pilot.RunnerTaskNotFound:
        task = pilot.bounded(task_id, "smoke", ["python", "-c", code], 180)
    while task["status"] not in ("done", "failed", "cancelled"):
        time.sleep(2)
        task = pilot.client().status(task_id)
    if task["status"] != "done" or not pilot.load(result_path)["verified"]:
        raise ValueError("prepared model condition verification failed")
    serving = pilot.load(pilot.STATE / "serving.json")
    authorization = dict(version="demo-authorization-v1", readiness_sha256=ready["receipt_sha256"],
                         campaign_sha256=ready["campaign_sha256"], runner_image=ready["inputs"]["image_ids"]["runner"],
                         controller_source_sha256=serving["source_sha256"], conditions=conditions,
                         parca_reused=True, concurrency=1)
    pilot.save(pilot.STATE / "demo-authorization.json", authorization)
    return authorization


def checkpoint(key):
    ready = pilot.verify()
    dest = checkpoint_dir(key)
    if (dest / "receipt.json").exists():
        return verified(key)
    row = rows()[key]
    if row["state"] != "complete":
        raise ValueError("only accounted scientific outcomes can be checkpointed")
    if cleanup_state(key)["state"] in {"cleanup_pending", "raw_removed"}:
        raise ValueError("raw cleanup already started; cannot re-extract")
    if dest.exists():
        raise ValueError("partial checkpoint retained; diagnose before explicit recovery")
    run = checked_run(row)
    spec = next(e for e in pilot.campaign().experiments if e.key == key)
    info = export.inspect_run(run)
    provenance = export.verify_execution(run, spec)
    serving = pilot.load(pilot.STATE / "serving.json")
    provenance["export_details"] = dict(source_sha256=serving["source_sha256"], image=serving["image_ids"]["tools"])
    observed = json.loads(row["outcome_json"])
    for field in ("outcome", "reason"):
        if info[field] != observed[field]:
            raise ValueError("raw scientific outcome differs from ledger")
    provenance["resource_observations"] = dict(
        metrics={k: observed["metrics"][k] for k in ("duration_sec", "peak_process_group_rss_bytes", "returncode")
                 if k in observed.get("metrics", {})},
        raw_bytes=observed["raw_bytes"], raw_files=observed["raw_files"], preparation_cache_reused=True)
    target = ready["verified_targets"][spec.gene] if spec.gene else None
    index = target["index"] if target else 0
    exp = dict(key=key, experiment_id=row["experiment_id"], job_id=row["job_id"], variant_index=index,
               initial_condition=spec.initial_condition, events=[e.model_dump() for e in spec.events],
               execution_sha256=fingerprint(spec.execution(index)), execution_provenance=provenance,
               transcription_unit_id=target["rna_id"] if target else None,
               co_targeted_genes=[g for g in target["genes"] if g != spec.gene] if target else None,
               shard=f"trajectories/{key}.h5", **info)
    (dest / "trajectories").mkdir(parents=True)
    export.write_shard(dest / exp["shard"], run, exp["trajectories"])
    source = export.compare_source(dest / exp["shard"], run, exp["trajectories"])
    model = PublishedExperiment.model_validate(exp)
    _check_shard(dest / exp["shard"], model)
    api = compare_api(dest, model)
    provenance["artifact_verification"] = dict(
        source_comparison_sha256=fingerprint(source), api_comparison_sha256=fingerprint(api),
        source_channels_compared=len(source), api_series_compared=api["comparison_count"],
        preserve_all_samples=True, preserve_all_columns=True)
    # Keep compact original metadata and complete source inventories; no raw listeners.
    pilot.save(dest / "execution.json", dict(metadata=pilot.load(run / "metadata/metadata.json"),
                                             submission=row, observed=observed))
    pilot.save(dest / "source-comparison.json", dict(passed=True, channels=source))
    pilot.save(dest / "api-comparison.json", api)
    serving = pilot.load(pilot.STATE / "serving.json")
    receipt = seal(dict(version="demo-checkpoint-v1", key=key, run_dir=row["run_dir"],
                        campaign_sha256=ready["campaign_sha256"], readiness_sha256=ready["receipt_sha256"],
                        outcome_sha256=fingerprint(observed), experiment=exp, files=inventory(dest),
                        source_comparison=source, api_comparison=api,
                        exporter_source_sha256=serving["source_sha256"], exporter_image=serving["image_ids"]["tools"]))
    pilot.save(dest / "receipt.json", receipt)
    verified(key)
    return receipt


def checked_run(row):
    root = pilot.OUT.resolve(strict=True)
    expected = "hf-demo-v1-" + row["key"] + "-" + row["campaign_sha256"][:12]
    if row["run_dir"] != expected or Path(row["run_dir"]).name != row["run_dir"]:
        raise ValueError("unsafe/unrecognized raw directory in ledger")
    run = root / row["run_dir"]
    if run.is_symlink() or run.resolve().parent != root or run.name == pilot.MODEL_DIR:
        raise ValueError("raw path escapes isolated experiment root")
    return run


def backup_ack(key, checksum):
    receipt = verified(key)
    if checksum != receipt["receipt_sha256"]:
        raise ValueError("local backup differs from checkpoint")
    pilot.save(pilot.STATE / "backups" / (key + ".json"),
               dict(receipt_sha256=checksum, verified_local_copy=True, at=time.time()))
    return dict(key=key, backup_verified=True)


def cleanup(key, *, dry_run=False):
    receipt = verified(key)
    row = rows()[key]
    run = checked_run(row)
    state = cleanup_state(key)
    if state["state"] == "raw_removed":
        if run.exists():
            raise ValueError("raw directory reappeared after cleanup; refusing deletion")
        return state
    backup = pilot.load(pilot.STATE / "backups" / (key + ".json"))
    if backup["receipt_sha256"] != receipt["receipt_sha256"] or not backup["verified_local_copy"]:
        raise ValueError("verified local copy required before raw deletion")
    health = pilot.client().health()
    if health["running"] or health["queued"] or any(r["state"] != "complete" for r in rows().values()):
        raise ValueError("cleanup requires an idle runner and successful terminal jobs")
    if state["state"] != "cleanup_pending":
        # Recheck the complete inventory before the first destructive operation.
        actual = [dict(path=p.relative_to(run).as_posix(), bytes=p.stat().st_size, sha256=file_sha256(p))
                  for p in sorted(run.rglob("*")) if p.is_file() and not p.is_symlink()]
        expected = receipt["experiment"]["execution_provenance"]["source_files"]
        if actual != expected:
            raise ValueError("raw source changed since verification; cleanup blocked")
        if not run.is_dir():
            raise ValueError("raw directory missing without a cleanup journal")
        state = dict(key=key, state="cleanup_pending", receipt_sha256=receipt["receipt_sha256"],
                     raw_bytes=sum(f["bytes"] for f in actual), raw_files=len(actual), started_at=time.time())
    elif state["receipt_sha256"] != receipt["receipt_sha256"]:
        raise ValueError("cleanup journal receipt mismatch")
    if dry_run:
        return dict(state, dry_run=True, eligible=True, directory=row["run_dir"])
    # Atomic journal precedes deletion; shutil.rmtree unlinks nested symlinks.
    pilot.save(pilot.STATE / "cleanup" / (key + ".json"), state)
    if run.exists():
        shutil.rmtree(run)
    state.update(state="raw_removed", finished_at=time.time(),
                 docker_free_bytes=shutil.disk_usage(pilot.OUT).free)
    pilot.save(pilot.STATE / "cleanup" / (key + ".json"), state)
    return state


def assemble():
    ready = pilot.verify()
    campaign = pilot.campaign()
    receipts = [verified(e.key) for e in campaign.experiments]
    if any(cleanup_state(r["key"])["state"] != "raw_removed" for r in receipts):
        raise ValueError("all verified raw output must be removed before final activation")
    serving = pilot.load(pilot.STATE / "serving.json")
    identity = fingerprint(dict(receipts=[r["receipt_sha256"] for r in receipts], exporter=serving["image_ids"]["tools"]))
    dest = pilot.RELEASE / ("full-" + identity[:20])
    # Serving-only fixes do not re-export scientifically unchanged checkpoints.
    # Keep the actual exporter provenance and the identical existing host copy.
    active = pilot.RELEASE / "current"
    if (active / "manifest.json").exists():
        published = pilot.load(active / "manifest.json")
        if (published.get("scope") == "full" and published["campaign_sha256"] == ready["campaign_sha256"]
            and published["experiments"] == [r["experiment"] for r in receipts]):
            dest = active.resolve(strict=True)
    if not dest.exists():
        (dest / "trajectories").mkdir(parents=True)
        for receipt in receipts:
            shard = receipt["experiment"]["shard"]
            # Immutable checkpoints and final bundles share bytes within the volume.
            os.link(checkpoint_dir(receipt["key"]) / shard, dest / shard)
        experiments = [r["experiment"] for r in receipts]
        export.project_catalog(pilot.STATE / "reference.sqlite", dest / "catalog.sqlite", campaign, experiments)
        for name, records in (
            ("metadata.jsonl", [dict(key=e["key"], seed=0, generation=t["generation"]) for e in experiments for t in e["trajectories"]]),
            ("qc.jsonl", [dict(key=e["key"], outcome=e["outcome"], reason=e["reason"]) for e in experiments]),
        ):
            (dest / name).write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in records))
        (dest / "README.md").write_text(
            "# hf-demo-v1 explorer dataset\n\nTwelve distinct model experiments, seed 0, up to four sequential generations. "
            "Generations are a single lineage, not independent replicates. Valid no-division or biological termination may shorten a lineage. "
            "Expression perturbations can co-target a transcription unit; actual targets are recorded per experiment. "
            "Hypotheses are questions, not guaranteed rescue or inhibition.\n\n"
            "All saved samples and molecule/reaction columns in the scalar and four matrix families are preserved. "
            "Channels have actual elapsed-lineage clocks, identifiers and units. Unavailable channels have explicit reasons. "
            "Initial growth NaNs remain in HDF5 and become null in the API. Reaction flux is mmol/L/s; exchange flux is mmol/gDCW/h.\n\n"
            "Raw output was removed only after exact source comparisons, structural/API checks and a verified local backup. "
            "Source inventories, execution/preparation fingerprints and initialization/timelines remain recorded. "
            "Additional raw-listener extraction may require rerunning an experiment. "
            "Shared Parca preparation is retained locally and is not required for serving.\n\n"
            "Contents: catalog.sqlite, manifest.json, metadata.jsonl, qc.jsonl and one HDF5 shard per experiment. "
            "No credentials, assistant/provider data or host paths. Target <5 GB; hard limit 10 GB; no thinning.\n")
        # Reuse the actual original preparation identity, never infer it from a tools refresh.
        old = pilot.load(pilot.RELEASE / "current/manifest.json")
        provenance = dict(old["provenance"], exporter_source_sha256=serving["source_sha256"],
                          exporter_image_digest=serving["image_ids"]["tools"])
        if provenance["prepared_model_sha256"] != ready["kb"]["simData.cPickle"]["sha256"]:
            raise ValueError("pilot preparation provenance differs from readiness")
        manifest = dict(schema_version="explorer-release-v1", scope="full", synthetic_fixture=False,
                        campaign=campaign.model_dump(), campaign_sha256=ready["campaign_sha256"],
                        provenance=provenance, experiments=experiments, files=inventory(dest))
        ReleaseManifest.model_validate(manifest)
        pilot.save(dest / "manifest.json", manifest)
    report = validate_release(dest)
    if not report["valid"]:
        raise ValueError("full release validation failed: " + str(report))
    comparisons = [dict(key=r["key"], **compare_api(dest, PublishedExperiment.model_validate(r["experiment"]))) for r in receipts]
    pilot.save(pilot.STATE / "demo-final-api-comparison.json", dict(passed=True, experiments=comparisons))
    export.activate_bundle(pilot.RELEASE, dest)
    pilot.save(pilot.STATE / "demo-release-report.json", dict(report, directory=dest.name))
    return dict(report, directory=dest.name, manifest_sha256=file_sha256(dest / "manifest.json"))


def status():
    current = rows()
    jobs = []
    for exp in pilot.campaign().experiments:
        row = current.get(exp.key)
        outcome = json.loads(row["outcome_json"] or "{}") if row else {}
        jobs.append(dict(key=exp.key, execution=row["state"] if row else "unrun", outcome=outcome.get("outcome"),
                         generations=[t["generation"] for t in outcome.get("trajectories", [])],
                         raw_bytes=outcome.get("raw_bytes"), metrics=outcome.get("metrics"),
                         checkpoint=(checkpoint_dir(exp.key) / "receipt.json").exists(),
                         cleanup=cleanup_state(exp.key)))
    return dict(jobs=jobs, remaining=[k for k in ORDER if k not in current or current[k]["state"] != "complete"],
                preparation_reused=True, controller_agent_check_interval_sec=1800)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "checkpoint", "backup-ack", "cleanup", "submit", "assemble", "status"])
    parser.add_argument("key", nargs="?")
    parser.add_argument("--checksum")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare()
    elif args.command == "checkpoint":
        receipt = checkpoint(args.key)
        result = dict(key=args.key, receipt_sha256=receipt["receipt_sha256"])
    elif args.command == "backup-ack":
        result = backup_ack(args.key, args.checksum)
    elif args.command == "cleanup":
        result = cleanup(args.key, dry_run=args.dry_run)
    elif args.command == "submit":
        result = pilot.submit(args.key, full_campaign=True)
    elif args.command == "assemble":
        result = assemble()
    else:
        result = status()
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Demo operation stopped; raw output retained where available: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
