"""Pilot control operations inside the isolated tools container, never the live API."""

from __future__ import annotations
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

from .demo_campaign import DEFAULT_MANIFEST, CampaignSpec, file_sha256, fingerprint, plan
from app.services.sim_runner_client import RunnerClient, RunnerTaskNotFound

STATE = Path(os.environ.get("PILOT_STATE", "/pilot"))
OUT = Path(os.environ.get("SIM_OUTPUT_DIR", "/wcEcoli/out"))
RELEASE = Path(os.environ.get("PILOT_RELEASE", "/release"))
DB = STATE / "catalog.sqlite"
MODEL_DIR = "hf-demo-v1-prepared"
REQUIRED_KB = (
    "rawData.cPickle",
    "simData.cPickle",
    "metricsData.cPickle",
    "rawValidationData.cPickle",
    "validationData.cPickle",
)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def load(path):
    return json.loads(path.read_text())


def campaign():
    return CampaignSpec.model_validate_json(DEFAULT_MANIFEST.read_text())


def client():
    return RunnerClient(OUT / ".runner/control.sock")


def database():
    db = sqlite3.connect(DB, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def bounded(task_id, kind, command, seconds):
    metrics = OUT / ".pilot-metrics"
    metrics.mkdir(exist_ok=True)
    return client().submit(
        task_id,
        kind,
        [
            "python",
            "runscripts/manual/hfPilotTask.py",
            "--receipt",
            str(metrics / (task_id + ".json")),
            "--seconds",
            str(seconds),
            "--",
            *command,
        ],
        cpu_slots=2,
    )


def prepared_fingerprints():
    kb = OUT / MODEL_DIR / "kb"
    result = {}
    for name in REQUIRED_KB:
        path = kb / name
        if not path.is_file() or not path.stat().st_size:
            raise ValueError("required preparation file missing/empty: " + name)
        result[name] = dict(bytes=path.stat().st_size, sha256=file_sha256(path))
    return result


def verify():
    receipt = load(STATE / "readiness.json")
    identity = receipt.pop("receipt_sha256")
    if fingerprint(receipt) != identity:
        raise ValueError("readiness receipt fingerprint mismatch")
    if receipt["inputs"] != load(STATE / "inputs.json"):
        raise ValueError("frozen inputs/images/settings differ from readiness")
    if receipt["campaign_sha256"] != fingerprint(campaign().canonical()):
        raise ValueError("campaign differs from readiness")
    if receipt["kb"] != prepared_fingerprints():
        raise ValueError("prepared model differs from readiness")
    for name in ("reference.sqlite", "targets.json"):
        if file_sha256(STATE / name) != receipt["files"][name]:
            raise ValueError("readiness binding differs: " + name)
    # Mutable execution DB keeps its reference tables fixed; job rows can change.
    with (
        closing(database()) as db,
        closing(sqlite3.connect(STATE / "reference.sqlite")) as reference,
    ):
        for table in ("genes", "conditions", "media_recipes", "timelines", "variants"):
            if [
                tuple(r) for r in db.execute("SELECT * FROM " + table + " ORDER BY id")
            ] != reference.execute("SELECT * FROM " + table + " ORDER BY id").fetchall():
                raise ValueError("execution catalog references changed: " + table)
    receipt["receipt_sha256"] = identity
    return receipt


def accept_inputs():
    incoming = load(STATE / "inputs.next.json")
    if (STATE / "readiness.json").exists():
        old = verify()
        if incoming == old["inputs"]:
            return dict(unchanged=True)
        with closing(database()) as db:
            if db.execute("SELECT count(*) FROM pilot_submissions").fetchone()[0]:
                raise ValueError("cannot refresh readiness after any submission")
        origin = incoming.get("preparation_origin", {})
        expected = old["inputs"].get(
            "preparation_origin",
            dict(
                source_sha256=old["inputs"]["source_sha256"],
                runner_image_id=old["inputs"]["image_ids"]["runner"],
            ),
        )
        if any(origin.get(key) != expected[key] for key in ("source_sha256", "runner_image_id")):
            raise ValueError("preparation origin mismatch")
        (STATE / "readiness.json").rename(STATE / ("readiness-" + old["receipt_sha256"] + ".json"))
    save(STATE / "inputs.json", incoming)
    return dict(accepted=True, ready=False)


def prepare_start():
    if (STATE / "readiness.json").exists():
        return dict(ready=True, receipt_sha256=verify()["receipt_sha256"])
    task = "hf-demo-v1-parca"
    marker = STATE / "preparation-started.json"
    if marker.exists():
        try:
            return client().status(task)
        except RunnerTaskNotFound:
            metrics = OUT / ".pilot-metrics" / (task + ".json")
            if metrics.exists() and load(metrics)["classification"] == "completed":
                return dict(task_id=task, status="done")
            raise ValueError(
                "preparation task lost/interrupted; inspect retained logs/output before an explicit recovery"
            )
    save(marker, dict(task_id=task, inputs=load(STATE / "inputs.json"), at=time.time()))
    return bounded(
        task, "parca", ["python", "runscripts/manual/runParca.py", MODEL_DIR, "-c", "2"], 5400
    )


def prepare_finish():
    kb = prepared_fingerprints()
    # This script executes in the simulation environment, with its own pickle/deps.
    task = "hf-demo-v1-targets"
    bounded(
        task,
        "smoke",
        [
            "python",
            "runscripts/manual/hfPilotTargets.py",
            str(OUT / MODEL_DIR / "kb/simData.cPickle"),
            str(OUT / "pilot-targets.json"),
        ],
        180,
    )
    while True:
        status = client().status(task)
        if status["status"] in ("failed", "cancelled"):
            raise ValueError("model target extraction failed: " + status["log_path"])
        if status["status"] == "done":
            break
        time.sleep(1)
    targets = load(OUT / "pilot-targets.json")
    if targets["model_sha256"] != kb["simData.cPickle"]["sha256"]:
        raise ValueError("target mapping/model fingerprint mismatch")
    save(STATE / "targets.json", targets)
    save(STATE / "ko_index_map.json", {gene: t["index"] for gene, t in targets["targets"].items()})
    if not DB.exists():
        from app.db.init_db import init_database

        init_database()
    with closing(database()) as db:
        for gene in ("hisG", "trpA", "pgi"):
            rows = db.execute("SELECT ko_index FROM genes WHERE symbol=?", (gene,)).fetchall()
            if len(rows) != 1 or rows[0][0] != targets["targets"][gene]["index"]:
                raise ValueError("prepared-model/catalog target mismatch for " + gene)
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        with closing(sqlite3.connect(STATE / "reference.sqlite")) as reference:
            db.backup(reference)
            reference.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            reference.execute("PRAGMA journal_mode=DELETE")
        # Ledger submission identity lives in the isolated DB, transactionally
        # with experiment/job insertion; it never enters the public projection.
        db.execute("""CREATE TABLE IF NOT EXISTS pilot_submissions (
            campaign_sha256 TEXT, key TEXT, seed INTEGER, experiment_id INTEGER,
            job_id INTEGER, task_id TEXT, run_dir TEXT, receipt_sha256 TEXT,
            command_json TEXT, state TEXT, outcome_json TEXT DEFAULT '',
            PRIMARY KEY(campaign_sha256,key,seed), UNIQUE(experiment_id), UNIQUE(job_id))""")
        db.commit()
    resolved = plan(campaign(), STATE / "reference.sqlite")
    save(STATE / "resolved-plan.json", resolved)
    if not resolved["catalog_valid"]:
        raise ValueError("catalog planning failed: " + str(resolved["errors"]))
    preparation_metrics = load(OUT / ".pilot-metrics/hf-demo-v1-parca.json")
    if preparation_metrics["classification"] != "completed":
        raise ValueError("Parca infrastructure failure; cannot authorize execution")
    receipt = dict(
        version="pilot-readiness-v1",
        campaign_sha256=fingerprint(campaign().canonical()),
        inputs=load(STATE / "inputs.json"),
        kb=kb,
        files={name: file_sha256(STATE / name) for name in ("reference.sqlite", "targets.json")},
        preparation=preparation_metrics,
        verified_targets={gene: targets["targets"][gene] for gene in ("hisG", "trpA", "pgi")},
        initial_condition_binding="--initial-condition",
        runtime_authority="this receipt, not the catalog-valid planning report",
    )
    receipt["receipt_sha256"] = fingerprint(receipt)
    save(STATE / "readiness.json", receipt)
    return dict(
        ready=True, receipt_sha256=receipt["receipt_sha256"], targets=receipt["verified_targets"]
    )


def submission(key, *, full_campaign=False):
    receipt = verify()
    if full_campaign:
        from .demo_inside import authorize_submission

        authorize_submission(key, receipt)
    elif key not in campaign().pilot_keys:
        raise ValueError("only the three reserved pilot keys may be submitted")
    spec = next(s for s in campaign().experiments if s.key == key)
    fp = fingerprint(campaign().canonical())
    with closing(database()) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM pilot_submissions WHERE campaign_sha256=? AND key=? AND seed=0",
            (fp, key),
        ).fetchone()
        if row:
            if row["receipt_sha256"] != receipt["receipt_sha256"]:
                raise ValueError("submission bound to a different readiness receipt")
            return dict(row)
        # Server-side gate remains effective even if a caller bypasses host.py.
        if key != "wt-basal" and not full_campaign:
            proof = proof_status()
            if not proof["passed"]:
                raise ValueError(
                    "wild-type export/real browser proof required before subsequent submissions"
                )
            previous = "wt-basal" if key == "hisG-basal" else "hisG-basal"
            prior = db.execute(
                "SELECT state FROM pilot_submissions WHERE key=?", (previous,)
            ).fetchone()
            if not prior or prior["state"] != "complete":
                raise ValueError("prior sequential pilot result must be complete")
        if db.execute(
            "SELECT count(*) FROM pilot_submissions WHERE state IN ('submitted','running')"
        ).fetchone()[0]:
            raise ValueError("another pilot simulation is active")
        from sqlmodel import Session
        from app.db.engine import make_sqlite_engine
        from app.db.models import Experiment, SimulationJob
        from app.services.sim_worker import _build_sim_command

        targets = receipt["verified_targets"]
        index = targets[spec.gene]["index"] if spec.gene else 0
        run_dir = "hf-demo-v1-" + key + "-" + fp[:12]
        params = json.dumps(
            dict(
                initial_condition=spec.initial_condition,
                campaign_sha256=fp,
                experiment_key=key,
                receipt_sha256=receipt["receipt_sha256"],
            )
        )
        exp = Experiment(
            name=key,
            variant_type=spec.variant,
            variant_index=index,
            condition=spec.initial_condition,
            timeline=spec.timeline_name or "",
            sim_params=params,
            gene_symbol=spec.gene or "",
            status="running",
        )
        job = SimulationJob(
            experiment_id=1,
            status="running_sim",
            variant_type=spec.variant,
            variant_index=index,
            condition=spec.initial_condition,
            seed=0,
            generations=4,
            timeline=spec.timeline_name or "",
            sim_dir=run_dir,
        )
        # Build with existing logic, but explicit events are frozen with the campaign.
        engine = make_sqlite_engine(DB)
        with Session(engine) as session:
            command, environment = _build_sim_command(session, job, exp, run_dir, [])
        if environment:
            raise ValueError("unexpected environment for pilot")
        # Always pin the exact catalog-validated lineage schedule, including t=0.
        if "--timeline" in command:
            pos = command.index("--timeline")
            del command[pos : pos + 2]
        command += ["--timeline", ", ".join(f"{e.time_sec:g} {e.media}" for e in spec.events)]
        columns = tuple(c for c in type(exp).model_fields if c != "id")
        eid = db.execute(
            "INSERT INTO experiments ("
            + ",".join(columns)
            + ") VALUES ("
            + ",".join("?" for _ in columns)
            + ")",
            tuple(getattr(exp, c) for c in columns),
        ).lastrowid
        job.experiment_id = eid
        columns = tuple(c for c in type(job).model_fields if c != "id")
        jid = db.execute(
            "INSERT INTO simulation_jobs ("
            + ",".join(columns)
            + ") VALUES ("
            + ",".join("?" for _ in columns)
            + ")",
            tuple(getattr(job, c) for c in columns),
        ).lastrowid
        task_id = "hf-demo-v1-" + key + "-" + fp[:12]
        db.execute(
            "INSERT INTO pilot_submissions VALUES (?,?,0,?,?,?,?,?,?,?,?)",
            (
                fp,
                key,
                eid,
                jid,
                task_id,
                run_dir,
                receipt["receipt_sha256"],
                json.dumps(command),
                "submitted",
                "",
            ),
        )
        db.commit()
        return dict(db.execute("SELECT * FROM pilot_submissions WHERE key=?", (key,)).fetchone())


def submit(key, *, full_campaign=False):
    row = submission(key, full_campaign=full_campaign)
    if row["state"] == "complete":
        return dict(complete=True, key=key)
    if row["state"] == "failed":
        raise ValueError(
            "retained execution failure requires explicit investigation; no automatic rerun"
        )
    path = OUT / row["run_dir"]
    path.mkdir(exist_ok=True)
    kb = path / "kb"
    if not kb.exists():
        kb.symlink_to(Path("..") / MODEL_DIR / "kb", target_is_directory=True)
    # Same runner ID and payload are idempotent. If runner state was lost after
    # actual launch, the durable marker refuses re-execution of the same seed.
    marker = path / "pilot-submission.json"
    if marker.exists():
        try:
            return client().status(row["task_id"])
        except RunnerTaskNotFound:
            metrics = OUT / ".pilot-metrics" / (row["task_id"] + ".json")
            if metrics.exists() and load(metrics)["classification"] == "completed":
                return dict(task_id=row["task_id"], status="done")
            raise ValueError(
                "runner lost a submitted task; inspect retained output, never silently duplicate it"
            )
    save(marker, row)
    return bounded(row["task_id"], "sim", json.loads(row["command_json"]), 14400)


def finish(key):
    verify()
    from .explorer_export import inspect_run, verify_execution

    with closing(database()) as db:
        row = dict(db.execute("SELECT * FROM pilot_submissions WHERE key=?", (key,)).fetchone())
        metrics_path = OUT / ".pilot-metrics" / (row["task_id"] + ".json")
        if not metrics_path.exists():
            task = client().status(row["task_id"])
            if task["status"] not in ("failed", "cancelled"):
                raise ValueError("missing durable task outcome; inspect runner OOM state/logs")
            metrics = dict(
                classification="execution_error",
                infrastructure_error="Runner exited without a durable outcome; inspect OOM/process state",
                runner_task=task,
            )
        else:
            metrics = load(metrics_path)
        if metrics["classification"] != "completed":
            db.execute(
                "UPDATE pilot_submissions SET state='failed',outcome_json=? WHERE key=?",
                (json.dumps(metrics), key),
            )
            db.execute("UPDATE experiments SET status='failed' WHERE id=?", (row["experiment_id"],))
            db.execute("UPDATE simulation_jobs SET status='failed' WHERE id=?", (row["job_id"],))
            db.commit()
            return dict(key=key, outcome="execution_error", metrics=metrics, unresolved=True)
        result = inspect_run(OUT / row["run_dir"])
        spec = next(s for s in campaign().experiments if s.key == key)
        result["execution_provenance"] = verify_execution(OUT / row["run_dir"], spec)
        paths = [p for p in (OUT / row["run_dir"]).rglob("*") if p.is_file() and not p.is_symlink()]
        result.update(
            metrics=metrics,
            raw_bytes=sum(p.stat().st_size for p in paths),
            raw_files=len(paths),
            preparation_cache_reused=True,
        )
        db.execute(
            "UPDATE pilot_submissions SET state='complete',outcome_json=? WHERE key=?",
            (json.dumps(result), key),
        )
        db.execute("UPDATE experiments SET status='done' WHERE id=?", (row["experiment_id"],))
        db.execute("UPDATE simulation_jobs SET status='done' WHERE id=?", (row["job_id"],))
        db.commit()
        return result


def proof_status():
    path = STATE / "browser-proof.json"
    if not path.exists():
        return dict(passed=False)
    proof = load(path)
    manifest = load(RELEASE / "current/manifest.json")
    wt = next((f for f in manifest["files"] if f["path"] == "trajectories/wt-basal.h5"), None)
    if not wt or proof.get("wt_shard_sha256") != wt["sha256"]:
        return dict(passed=False, reason="release changed since browser proof")
    return dict(passed=proof.get("passed") is True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=[
            "accept-inputs",
            "health",
            "prepare-start",
            "prepare-finish",
            "verify",
            "submit",
            "finish",
            "task-status",
            "cancel",
            "status",
            "export",
            "validate",
            "proof-status",
        ],
    )
    parser.add_argument("key", nargs="?")
    args = parser.parse_args()
    if args.command == "accept-inputs":
        result = accept_inputs()
    elif args.command == "health":
        result = client().health()
    elif args.command == "prepare-start":
        result = prepare_start()
    elif args.command == "prepare-finish":
        result = prepare_finish()
    elif args.command == "verify":
        result = dict(ready=True, receipt_sha256=verify()["receipt_sha256"])
    elif args.command == "submit":
        result = submit(args.key)
    elif args.command == "finish":
        result = finish(args.key)
    elif args.command == "task-status":
        result = client().status(args.key)
    elif args.command == "cancel":
        result = client().cancel(args.key)
    elif args.command == "proof-status":
        result = proof_status()
    elif args.command == "export":
        from .explorer_export import export_pilot

        result = export_pilot(STATE, OUT, RELEASE, verify())
    elif args.command == "validate":
        from .explorer_contract import validate_release

        result = validate_release(RELEASE / "current", allow_pilot=True)
        if not result["valid"]:
            raise ValueError(str(result["errors"]))
    else:
        result = dict(
            preparation=load(STATE / "preparation-started.json")
            if (STATE / "preparation-started.json").exists()
            else None,
            ready=(STATE / "readiness.json").exists(),
            remaining=campaign().pilot_keys,
        )
        if DB.exists():
            with closing(database()) as db:
                result["jobs"] = [dict(r) for r in db.execute("SELECT * FROM pilot_submissions")]
            result["remaining"] = [
                key
                for key in result["remaining"]
                if not any(r["key"] == key and r["state"] == "complete" for r in result["jobs"])
            ]
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Pilot operation failed: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
