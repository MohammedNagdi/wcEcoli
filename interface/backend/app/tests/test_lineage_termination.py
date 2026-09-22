"""Tests for lineage termination on the ingest side.

The simulator (wholecell/sim/simulation.py, runscripts/manual/runSim.py) turns a
NegativeCountsError into a LineageTerminated exception, finalizes the dying generation's
tables, and leaves ``metadata/lineage_termination.json`` in the run directory. That side
runs in the sim environment and is not importable here. These tests cover everything
downstream of the marker: reading it, accepting a short lineage as a finished job with the
dying generation flagged, carrying the flag through the sentinel, migrating the columns, and
requeueing terminal jobs by hand.
"""

from __future__ import annotations

import json
import sqlite3
from collections import deque
from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, select

from app.config import settings
from app.db.models import Experiment, SimulationJob, SimulationResult
from app.services import sim_worker, slurm_campaign, table_reader_bridge
from app.services.table_reader_bridge import (
    read_lineage_terminations,
    termination_reason,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _make_run(base: Path, seed: int, generations: int, terminated_at: int | None = None,
              marker_seed: int | None = None):
    """Lay out <run>/<variant>/<seed>/generation_N/000000/simOut like runSim does."""
    for generation in range(generations):
        (base / "wildtype_000000" / "{:06d}".format(seed)
         / "generation_{:06d}".format(generation) / "000000" / "simOut").mkdir(parents=True)
    if terminated_at is not None:
        (base / "metadata").mkdir()
        (base / "metadata" / "lineage_termination.json").write_text(json.dumps({
            "version": 1,
            "terminations": [{
                "exception": "NegativeCountsError",
                "message": "Negative value(s) in self._countsAllocatedFinal:\n"
                           "ATP[c] in PolypeptideElongation (-3900)",
                "time_sec": 3012.0, "simulation_step": 1400,
                "variant_index": 0, "seed": marker_seed if marker_seed is not None else seed,
                "generation": terminated_at,
                "generations_requested": generations,
            }],
        }))


class _FakeReader:
    """Stands in for SimOutReader: a mass summary for every generation but an empty one."""

    empty: set[int] = set()

    def __init__(self, sim_out_path):
        self.generation = int(Path(sim_out_path).parts[-3].split("_")[1])

    def extract_summary(self):
        if self.generation in self.empty:
            return {"division_time_sec": None, "final_mass_fg": None, "growth_rate": None,
                    "doubling_time_min": None, "divided": False}
        return {"division_time_sec": 2600.0, "final_mass_fg": 900.0, "growth_rate": 2.6e-4,
                "doubling_time_min": 44.0, "divided": True}

    def export_parquet(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(b"")


@pytest.fixture
def out_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "sim_output_dir", tmp_path / "out")
    (tmp_path / "out").mkdir()
    monkeypatch.setattr(table_reader_bridge, "SimOutReader", _FakeReader)
    _FakeReader.empty = set()
    return tmp_path / "out"


def _job(sim_dir: str, seed: int = 3, generations: int = 4):
    return SimulationJob(id=105, experiment_id=7, sim_dir=sim_dir, seed=seed,
                         generations=generations)


# ── Marker ───────────────────────────────────────────────────────────────────

def test_read_lineage_terminations_absent(tmp_path):
    assert read_lineage_terminations(tmp_path) == {}


def test_read_lineage_terminations_keys_by_seed_and_generation(tmp_path):
    _make_run(tmp_path, seed=3, generations=4, terminated_at=1)
    records = read_lineage_terminations(tmp_path)
    assert list(records) == [(3, 1)]
    assert records[(3, 1)]["exception"] == "NegativeCountsError"


def test_termination_reason_names_the_molecule():
    record = {"exception": "NegativeCountsError",
              "message": "Negative value(s) in self._countsAllocatedFinal:\n"
                         "ATP[c] in PolypeptideElongation (-3900)"}
    assert termination_reason(record) == \
        "NegativeCountsError: ATP[c] in PolypeptideElongation (-3900)"
    assert termination_reason({"exception": "X", "message": ""}) == "X"


# ── _collect_results ─────────────────────────────────────────────────────────

def test_full_lineage_is_unchanged(out_dir):
    _make_run(out_dir / "run", seed=3, generations=4)
    results = sim_worker._collect_results(_job("run"), None, deque())
    assert [r.generation for r in results] == [0, 1, 2, 3]
    assert not any(r.terminated for r in results)


def test_short_lineage_without_marker_is_still_an_error(out_dir):
    _make_run(out_dir / "run", seed=3, generations=2)
    with pytest.raises(RuntimeError, match="Generation output mismatch"):
        sim_worker._collect_results(_job("run"), None, deque())


def test_terminated_lineage_is_accepted_through_the_dying_generation(out_dir):
    _make_run(out_dir / "run", seed=3, generations=2, terminated_at=1)
    log = deque()
    results = sim_worker._collect_results(_job("run"), None, log)
    assert [(r.generation, r.terminated) for r in results] == [(0, False), (1, True)]
    assert results[1].termination_reason == \
        "NegativeCountsError: ATP[c] in PolypeptideElongation (-3900)"
    assert results[0].termination_reason == ""
    assert any("Lineage terminated in generation 1 of 4" in line for line in log)


def test_marker_does_not_excuse_missing_earlier_generations(out_dir):
    # Marker says generation 2 died, but generation 1 is not on disk.
    _make_run(out_dir / "run", seed=3, generations=1, terminated_at=2)
    with pytest.raises(RuntimeError, match="Generation output mismatch"):
        sim_worker._collect_results(_job("run"), None, deque())


def test_marker_for_another_seed_is_ignored(out_dir):
    _make_run(out_dir / "run", seed=4, generations=2, terminated_at=1, marker_seed=3)
    with pytest.raises(RuntimeError, match="Generation output mismatch"):
        sim_worker._collect_results(_job("run", seed=4), None, deque())


def test_dying_generation_may_have_no_mass_rows(out_dir):
    _make_run(out_dir / "run", seed=3, generations=2, terminated_at=1)
    _FakeReader.empty = {1}
    results = sim_worker._collect_results(_job("run"), None, deque())
    assert results[1].terminated and results[1].final_mass_fg is None


def test_complete_generation_without_mass_is_still_an_error(out_dir):
    _make_run(out_dir / "run", seed=3, generations=2, terminated_at=1)
    _FakeReader.empty = {0}
    with pytest.raises(RuntimeError, match="no mass summary"):
        sim_worker._collect_results(_job("run"), None, deque())


# ── Sentinel round trip ──────────────────────────────────────────────────────

def test_sentinel_carries_termination(out_dir, tmp_path, monkeypatch):
    from app.services import slurm_ingest

    monkeypatch.setattr(slurm_ingest, "PRUNE_SIMOUT", False)
    _make_run(out_dir / "run", seed=3, generations=2, terminated_at=1)
    manifest = tmp_path / "m.jsonl"
    manifest.write_text(json.dumps({
        "job_id": 105, "experiment_id": 7, "attempt": 4, "run_id": "run", "sim_dir": "run",
        "parca_run_id": "p", "seed": 3, "generations": 4, "argv": ["python"], "env": {},
    }) + "\n")
    payload = slurm_ingest.ingest(manifest, 0, 0)
    assert payload["status"] == "done"
    assert payload["lineage_terminated"] is True
    assert payload["termination_reason"].startswith("NegativeCountsError: ATP[c]")
    assert [r["terminated"] for r in payload["results"]] == [False, True]


# ── Database: commit, migration, requeue ─────────────────────────────────────

@pytest.fixture
def campaign_db(tmp_path, monkeypatch):
    root = tmp_path / "campaign"
    (root / "state").mkdir(parents=True)
    (root / "out").mkdir()
    monkeypatch.setenv("WCECOLI_CAMPAIGN_ROOT", str(root))
    monkeypatch.setattr(settings, "database_path", root / "state" / "wcecoli.db")
    monkeypatch.setattr(settings, "sim_output_dir", root / "out")
    engine = slurm_campaign._engine()
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(Experiment(id=7, name="x", status="failed"))
        session.add(SimulationJob(id=105, experiment_id=7, status="failed", attempt=3,
                                  sim_dir="old_run", worker_id="slurm-dispatcher",
                                  error_message="Simulation failed with exit code 1",
                                  log_tail="Traceback ..."))
        session.add(SimulationJob(id=106, experiment_id=7, status="done", attempt=1,
                                  sim_dir="good_run"))
        session.add(SimulationResult(id=1, job_id=105, experiment_id=7, generation=0))
        session.commit()
    return engine, root


def test_commit_marks_job_lineage_terminated(campaign_db):
    engine, _ = campaign_db
    with Session(engine) as session:
        job = session.get(SimulationJob, 105)
        job.status = "ingesting"
        session.add(job)
        session.commit()
    results = [
        SimulationResult(job_id=105, experiment_id=7, generation=0),
        SimulationResult(job_id=105, experiment_id=7, generation=1, terminated=True,
                         termination_reason="NegativeCountsError: ATP[c] in X (-1)"),
    ]
    sim_worker._commit_results_and_complete(engine, 105, "slurm-dispatcher", 3, results, deque())
    with Session(engine) as session:
        job = session.get(SimulationJob, 105)
        assert job.status == "done"
        assert bool(job.lineage_terminated) is True
        assert job.termination_reason == "NegativeCountsError: ATP[c] in X (-1)"
        assert "generation 1" in job.phase
        rows = session.exec(select(SimulationResult).where(SimulationResult.job_id == 105)).all()
        assert sorted((r.generation, bool(r.terminated)) for r in rows) == [(0, False), (1, True)]


def test_status_groups_terminations(campaign_db):
    engine, _ = campaign_db
    with Session(engine) as session:
        job = session.get(SimulationJob, 106)
        job.lineage_terminated = True
        job.termination_reason = "NegativeCountsError: ATP[c]"
        session.add(job)
        session.commit()
    report = slurm_campaign.status()
    assert report["lineage_terminated"] == 1
    assert report["terminations"] == {"NegativeCountsError: ATP[c]": [106]}
    text = slurm_campaign.format_status(report)
    assert "lineage terminated" in text and "NegativeCountsError: ATP[c]" in text


def test_migration_adds_termination_columns(tmp_path, monkeypatch):
    from app.db.migrations import run_migrations

    db_path = tmp_path / "old.db"
    monkeypatch.setattr(settings, "database_path", db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE simulation_jobs (id INTEGER PRIMARY KEY, status TEXT, condition TEXT)")
    conn.execute("CREATE TABLE simulation_results (id INTEGER PRIMARY KEY, job_id INTEGER, divided INTEGER)")
    conn.execute("CREATE TABLE experiments (id INTEGER PRIMARY KEY, batch_id TEXT)")
    conn.execute("CREATE TABLE genes (id INTEGER PRIMARY KEY, is_mechanistic INTEGER)")
    conn.execute("CREATE TABLE variants (id INTEGER PRIMARY KEY, name TEXT, docstring TEXT, filename TEXT, parameter_count INTEGER)")
    conn.execute("INSERT INTO simulation_jobs (id, status, condition) VALUES (1, 'done', 'basal')")
    conn.commit()
    conn.close()

    run_migrations()
    run_migrations()  # idempotent

    conn = sqlite3.connect(db_path)
    jobs = {row[1] for row in conn.execute("PRAGMA table_info(simulation_jobs)")}
    results = {row[1] for row in conn.execute("PRAGMA table_info(simulation_results)")}
    assert {"lineage_terminated", "termination_reason"} <= jobs
    assert {"terminated", "termination_reason"} <= results
    assert conn.execute("SELECT lineage_terminated, termination_reason FROM simulation_jobs").fetchone() == (0, "")


def test_requeue_failed_jobs(campaign_db):
    engine, root = campaign_db
    (root / "out" / "old_run").mkdir()
    (root / "out" / "old_run" / "x").write_text("stale")

    dry = slurm_campaign.requeue(None, {"failed"}, purge_output=True, dry_run=True)
    assert dry == {"requeued": 0, "selected": 1, "by_status": {"failed": 1}, "job_ids": [105]}
    assert (root / "out" / "old_run").exists()
    with Session(engine) as session:
        assert session.get(SimulationJob, 105).status == "failed"

    report = slurm_campaign.requeue(None, {"failed"}, purge_output=True, dry_run=False)
    assert report["requeued"] == 1 and report["job_ids"] == [105] and report["purged"] == 1
    assert Path(report["backup"]).is_file()
    assert not (root / "out" / "old_run").exists()
    with Session(engine) as session:
        job = session.get(SimulationJob, 105)
        assert job.status == "pending"
        assert job.attempt == 3  # bumped on claim, not here
        assert job.sim_dir == "" and job.worker_id == "" and job.error_message == ""
        assert job.log_tail == "" and not job.lineage_terminated
        assert session.exec(select(SimulationResult).where(SimulationResult.job_id == 105)).all() == []
        assert session.get(SimulationJob, 106).status == "done"
        assert session.get(Experiment, 7).status == "queued"


def test_requeue_by_id_reports_missing(campaign_db, caplog):
    report = slurm_campaign.requeue([105, 106, 999], {"failed"}, purge_output=False, dry_run=False)
    assert report["job_ids"] == [105]
    assert "not in status" in caplog.text
