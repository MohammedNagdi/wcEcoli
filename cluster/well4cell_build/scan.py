"""Stage 1: read every run's channels.h5 once.

``plan``     shards the run directories named by the campaign database (status done, and
             failed jobs too, so failed_jobs.parquet can say what they completed).
``run``      (array task) per run: generation shapes, attrs, reference hash, active
             matrix columns. Writes one sentinel per run and one per shard.
``reduce``   folds sentinels into build/scan/runs.jsonl plus the active masks, and writes
             provenance/reference/<matrix>.parquet.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import h5io
from .ledger import (append_jsonl, manifest_id, now, read_json, read_jsonl, sbatch, sentinel_dir,
                     squeue_names, write_atomic_json, write_jsonl)
from .settings import MATRIX_CHANNELS, Settings


def _jobs(settings: Settings) -> list[dict]:
    connection = sqlite3.connect("file:{}?mode=ro".format(settings.database), uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        "select id as job_id, experiment_id, status, sim_dir, attempt, seed, variant_type, variant_index, "
        "condition, lineage_terminated, termination_reason from simulation_jobs "
        "where status in ('done', 'failed') and sim_dir is not null and sim_dir != '' order by id"
    ).fetchall()
    connection.close()
    return [dict(row) for row in rows]


def cmd_plan(settings: Settings, args: argparse.Namespace) -> dict:
    settings.ensure_layout()
    done_runs = {r["run_dir"] for r in read_jsonl(settings.scan_dir / "runs.jsonl")}
    jobs = _jobs(settings)
    units = []
    for job in jobs:
        run_dir = Path(job["sim_dir"]).name
        if run_dir in done_runs and not args.force:
            continue
        if not (settings.out_dir / run_dir / "export" / "channels.h5").exists():
            units.append({"job_id": job["job_id"], "run_dir": run_dir, "status": job["status"], "missing": True})
            continue
        units.append({"job_id": job["job_id"], "run_dir": run_dir, "status": job["status"], "missing": False})
    if not units:
        print("nothing to scan")
        return {"shards": 0}
    shards = [units[i:i + settings.scan_shard_size] for i in range(0, len(units), settings.scan_shard_size)]
    plan = manifest_id("scan")
    manifest = settings.manifest_dir / (plan + ".jsonl")
    write_jsonl(manifest, [{"plan": plan, "shard": i, "units": shard} for i, shard in enumerate(shards)])
    print("manifest {}: {} runs in {} shards".format(manifest, len(units), len(shards)))
    return {"manifest": str(manifest), "shards": len(shards)}


def cmd_dispatch(settings: Settings, args: argparse.Namespace) -> dict:
    manifest = Path(args.manifest) if args.manifest else _latest_manifest(settings, "scan")
    lines = read_jsonl(manifest)
    indices = [line["shard"] for line in lines]
    if args.shards:
        indices = [int(s) for s in args.shards.split(",")]
    busy = squeue_names(settings.job_prefix + "-scan")
    if busy and not args.force:
        raise SystemExit("a scan array is already queued ({}); --force to submit anyway".format(len(busy)))
    array_job_id, account = sbatch(settings, "scan", manifest, indices, args.concurrency or settings.concurrency,
                                   time_limit=args.time, dry_run=args.dry_run)
    print("submitted {} under {} ({} shards)".format(array_job_id, account, len(indices)))
    return {"array_job_id": array_job_id}


def _latest_manifest(settings: Settings, stage: str) -> Path:
    candidates = sorted(settings.manifest_dir.glob(stage + "_*.jsonl"))
    if not candidates:
        raise SystemExit("no {} manifest; run `{} plan` first".format(stage, stage))
    return candidates[-1]


def scan_run(settings: Settings, run_dir: str) -> dict:
    path = settings.out_dir / run_dir
    with h5io.open_run(path) as handle:
        ids = h5io.reference_ids(handle)
        ref_hash = h5io.reference_hash(ids)
        shapes = []
        masks = {m: np.zeros(len(ids[m]), dtype=bool) for m in MATRIX_CHANNELS}
        seed, _ = h5io.seed_group(handle)
        for generation, group in h5io.generations(handle):
            shape = h5io.generation_shape(seed, generation, group)
            shapes.append({
                "generation": generation, "n_steps": shape.n_steps, "t0": shape.t0, "t_end": shape.t_end,
                "uniform_1s": shape.uniform_1s, "channels": list(shape.channels_present),
                "matrices": list(shape.matrices_present), "attrs": shape.attrs,
            })
            for matrix in shape.matrices_present:
                masks[matrix] |= h5io.active_columns(group, matrix)
    return {
        "run_dir": run_dir, "seed": seed, "reference_hash": ref_hash,
        "reference_sizes": {m: len(ids[m]) for m in MATRIX_CHANNELS},
        "generations": shapes,
        "masks": {m: np.flatnonzero(masks[m]).tolist() for m in MATRIX_CHANNELS},
    }


def cmd_run(settings: Settings, args: argparse.Namespace) -> dict:
    manifest = Path(args.manifest)
    line = next(l for l in read_jsonl(manifest) if l["shard"] == args.index)
    sdir = sentinel_dir(settings, manifest) / "{:05d}".format(args.index)
    results = {"ok": 0, "skipped": 0, "failed": 0, "missing": 0}
    for unit in line["units"]:
        sentinel = sdir / (unit["run_dir"] + ".json")
        if sentinel.exists() and read_json(sentinel).get("status") == "ok":
            results["skipped"] += 1
            continue
        record = {"run_dir": unit["run_dir"], "job_id": unit["job_id"], "job_status": unit["status"],
                  "started_at": now(), "plan": line["plan"], "shard": args.index}
        if unit.get("missing"):
            record.update(status="missing", error="no export/channels.h5")
            results["missing"] += 1
        else:
            started = time.time()
            try:
                record.update(scan_run(settings, unit["run_dir"]))
                record["status"] = "ok"
                results["ok"] += 1
            except Exception:  # noqa: BLE001 - the sentinel carries the outcome
                record.update(status="failed", error=traceback.format_exc()[-2000:])
                results["failed"] += 1
            record["seconds"] = round(time.time() - started, 3)
        record["finished_at"] = now()
        write_atomic_json(sentinel, record)
        print("{} {}".format(record["status"], unit["run_dir"]), flush=True)
    write_atomic_json(sdir.with_suffix(".json"), {"shard": args.index, "plan": line["plan"], "finished_at": now(), **results})
    print("shard {}: {}".format(args.index, results))
    return results


def cmd_reduce(settings: Settings, args: argparse.Namespace) -> dict:
    """Fold every scan sentinel into runs.jsonl; OR the masks; write reference tables."""
    settings.ensure_layout()
    runs: dict[str, dict] = {r["run_dir"]: r for r in read_jsonl(settings.scan_dir / "runs.jsonl")}
    masks: dict[str, np.ndarray] | None = None
    sizes: dict[str, int] | None = None
    union_path = settings.scan_dir / "active_union.npz"
    if union_path.exists():
        loaded = np.load(union_path)
        masks = {m: loaded[m] for m in MATRIX_CHANNELS}
        sizes = {m: int(masks[m].shape[0]) for m in MATRIX_CHANNELS}
    hashes: dict[str, int] = {}
    mismatched: list[dict] = []
    new = 0
    for manifest in sorted(settings.manifest_dir.glob("scan_*.jsonl")):
        for sentinel in sorted(sentinel_dir(settings, manifest).glob("*/*.json")):
            record = read_json(sentinel)
            if record.get("status") != "ok":
                runs[record["run_dir"]] = {k: v for k, v in record.items() if k != "masks"}
                continue
            if sizes is None:
                sizes = dict(record["reference_sizes"])
                masks = {m: np.zeros(sizes[m], dtype=bool) for m in MATRIX_CHANNELS}
            hashes[record["reference_hash"]] = hashes.get(record["reference_hash"], 0) + 1
            if record["reference_sizes"] != sizes:
                # Columns would not line up with the union; keep the run (its hash flags it)
                # but leave it out of the masks rather than abort the whole reduce.
                mismatched.append({"run_dir": record["run_dir"], "reference_sizes": record["reference_sizes"]})
                runs[record["run_dir"]] = {k: v for k, v in record.items() if k != "masks"}
                continue
            if record["run_dir"] not in runs or runs[record["run_dir"]].get("status") != "ok":
                new += 1
            for matrix in MATRIX_CHANNELS:
                masks[matrix][np.asarray(record["masks"][matrix], dtype=np.int64)] = True
            runs[record["run_dir"]] = {k: v for k, v in record.items() if k != "masks"}
    if masks is None:
        raise SystemExit("no scan sentinels found")
    if len(hashes) != 1:
        print("WARNING: {} distinct reference-id hashes: {}".format(len(hashes), hashes), file=sys.stderr)
    if mismatched:
        print("WARNING: {} runs with reference sizes != {} left out of the masks: {}".format(
            len(mismatched), sizes, mismatched[:20]), file=sys.stderr)
    write_jsonl(settings.scan_dir / "runs.jsonl", sorted(runs.values(), key=lambda r: r["run_dir"]))
    np.savez(union_path, **masks)
    # Reference tables: every column of every matrix, with its position in the pruned product.
    majority = max(hashes, key=hashes.get)
    sample = next(r for r in runs.values() if r.get("status") == "ok" and r.get("reference_hash") == majority)
    with h5io.open_run(settings.out_dir / sample["run_dir"]) as handle:
        ids = h5io.reference_ids(handle)
    for matrix in MATRIX_CHANNELS:
        active = masks[matrix]
        product_column = np.full(active.shape[0], -1, dtype=np.int32)
        product_column[active] = np.arange(int(active.sum()), dtype=np.int32)
        table = pa.table({
            "column": pa.array(np.arange(active.shape[0], dtype=np.int32)),
            "id": pa.array(ids[matrix]),
            "active": pa.array(active),
            "product_column": pa.array(np.where(active, product_column, None), type=pa.int32()),
        })
        pq.write_table(table, settings.reference_dir / (matrix.replace("_matrix", "") + ".parquet"), compression="zstd")
    summary = {m: {"columns": int(masks[m].shape[0]), "active": int(masks[m].sum())} for m in MATRIX_CHANNELS}
    status = {}
    for record in runs.values():
        status[record.get("status")] = status.get(record.get("status"), 0) + 1
    append_jsonl(settings.ledger, {"at": now(), "stage": "scan.reduce", "runs": status, "new": new, "active": summary,
                                   "reference_hashes": hashes, "reference_size_mismatches": mismatched})
    print("runs: {}  new: {}\nactive columns: {}\nreference hashes: {}".format(status, new, summary, hashes))
    return {"runs": status, "active": summary}


def cmd_status(settings: Settings, args: argparse.Namespace) -> dict:
    runs = read_jsonl(settings.scan_dir / "runs.jsonl")
    status: dict[str, int] = {}
    for record in runs:
        status[record.get("status")] = status.get(record.get("status"), 0) + 1
    pending = 0
    for manifest in sorted(settings.manifest_dir.glob("scan_*.jsonl")):
        for line in read_jsonl(manifest):
            sdir = sentinel_dir(settings, manifest) / "{:05d}".format(line["shard"])
            pending += sum(1 for u in line["units"] if not (sdir / (u["run_dir"] + ".json")).exists())
    print("reduced: {}  sentinels pending in manifests: {}  queued arrays: {}".format(
        status, pending, len(squeue_names(settings.job_prefix + "-scan"))))
    return {"reduced": status, "pending": pending}


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("scan", help="read every run once: shapes, attrs, active matrix columns")
    stage = parser.add_subparsers(dest="action", required=True)
    plan = stage.add_parser("plan"); plan.add_argument("--force", action="store_true", help="re-scan runs already reduced")
    plan.set_defaults(func=cmd_plan)
    dispatch = stage.add_parser("dispatch")
    dispatch.add_argument("--manifest"); dispatch.add_argument("--shards"); dispatch.add_argument("--concurrency", type=int)
    dispatch.add_argument("--time"); dispatch.add_argument("--force", action="store_true"); dispatch.add_argument("--dry-run", action="store_true")
    dispatch.set_defaults(func=cmd_dispatch)
    run = stage.add_parser("run"); run.add_argument("--manifest", required=True); run.add_argument("--index", type=int, required=True)
    run.set_defaults(func=cmd_run)
    stage.add_parser("reduce").set_defaults(func=cmd_reduce)
    stage.add_parser("status").set_defaults(func=cmd_status)
