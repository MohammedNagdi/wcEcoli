"""Tests for the SLURM execution backend and the task-side helpers.

These cover the parts that are pure logic -- argv construction, scheduler-output parsing,
manifest/sentinel handling and the writer lock -- without needing a live scheduler.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import time
from pathlib import Path

import pytest

from app.services import slurm_backend
from app.services.slurm_backend import SlurmResources
from app.services.slurm_ingest import (
    emit_prelude,
    read_manifest_line,
    sentinel_path,
    write_sentinel,
)


# ── sbatch argv ──────────────────────────────────────────────────────────────

@pytest.fixture
def captured(monkeypatch):
    calls: list[list[str]] = []

    def fake_run(argv, *, timeout=120):
        calls.append(argv)
        return "12345\n"

    monkeypatch.setattr(slurm_backend, "_run", fake_run)
    return calls


def test_submit_array_builds_expected_request(tmp_path, captured):
    resources = SlurmResources(
        account="ckpt-stf", partition="ckpt", cpus=1,
        mem="8G", time_limit="02:00:00", throttle=200,
    )
    job_id = slurm_backend.submit_array(
        tmp_path / "task.sbatch", tmp_path / "m.jsonl", 168, resources, log_dir=tmp_path,
    )
    assert job_id == "12345"
    argv = captured[0]
    assert argv[0] == "sbatch"
    # 168 jobs -> indices 0..167, throttled to 200 concurrent.
    assert "0-167%200" in argv
    assert "--account" in argv and "ckpt-stf" in argv
    # Memory must always be explicit: klone's DefMemPerCPU of 1024 would OOM a generation.
    assert "8G" in argv
    # ckpt preempts with GraceTime=0, so tasks must be requeueable.
    assert "--requeue" in argv


def test_submit_array_honours_no_requeue(tmp_path, captured):
    resources = SlurmResources(throttle=1, requeue=False)
    slurm_backend.submit_array(
        tmp_path / "t.sbatch", tmp_path / "m.jsonl", 1, resources, log_dir=tmp_path,
    )
    assert "--requeue" not in captured[0]
    assert "0-0%1" in captured[0]


def test_submit_array_rejects_empty_array(tmp_path, captured):
    with pytest.raises(ValueError):
        slurm_backend.submit_array(
            tmp_path / "t.sbatch", tmp_path / "m.jsonl", 0, SlurmResources(), log_dir=tmp_path,
        )


def test_resources_from_environment(monkeypatch):
    monkeypatch.setenv("WCECOLI_SLURM_ACCOUNT", "ckpt-amath")
    monkeypatch.setenv("WCECOLI_SLURM_MEM", "16G")
    monkeypatch.setenv("WCECOLI_SLURM_THROTTLE", "800")
    monkeypatch.setenv("WCECOLI_SLURM_REQUEUE", "0")
    resources = SlurmResources.from_env()
    assert resources.account == "ckpt-amath"
    assert resources.mem == "16G"
    assert resources.throttle == 800
    assert resources.requeue is False


# ── scheduler output parsing ─────────────────────────────────────────────────

def test_live_task_states_parses_array_tasks(monkeypatch):
    monkeypatch.setattr(
        slurm_backend, "_run",
        lambda argv, timeout=120: "12345_0|RUNNING\n12345_1|PENDING\n\n",
    )
    states = slurm_backend.live_task_states(["12345_0", "12345_1"])
    assert states == {"12345_0": "RUNNING", "12345_1": "PENDING"}


def test_accounted_task_states_strips_cancellation_actor(monkeypatch):
    # sacct renders cancellations as "CANCELLED by 12345"; only the state token matters.
    monkeypatch.setattr(
        slurm_backend, "_run",
        lambda argv, timeout=120: "12345_0|COMPLETED|0:0\n12345_1|CANCELLED by 4242|0:15\n",
    )
    states = slurm_backend.accounted_task_states(["12345_0", "12345_1"])
    assert states["12345_0"] == "COMPLETED"
    assert states["12345_1"] == "CANCELLED"


def test_state_sets_are_disjoint():
    assert not (slurm_backend.LIVE_SLURM_STATES & slurm_backend.DEAD_SLURM_STATES)


def test_empty_queries_skip_the_scheduler(monkeypatch):
    def explode(argv, timeout=120):
        raise AssertionError("should not shell out for an empty id list")

    monkeypatch.setattr(slurm_backend, "_run", explode)
    assert slurm_backend.live_task_states([]) == {}
    assert slurm_backend.accounted_task_states([]) == {}
    slurm_backend.cancel([])


# ── manifest and sentinels ───────────────────────────────────────────────────

def _manifest(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / "dispatch.jsonl"
    with path.open("w") as stream:
        for entry in entries:
            stream.write(json.dumps(entry) + "\n")
    return path


def _entry(**overrides) -> dict:
    entry = {
        "job_id": 7, "experiment_id": 3, "attempt": 1, "index": 0,
        "run_id": "20260901_120000_rpoB_job7_attempt1",
        "sim_dir": "20260901_120000_rpoB_job7_attempt1",
        "parca_run_id": "parca_cache_abc123",
        "seed": 0, "generations": 4,
        "argv": ["python", "runscripts/manual/runSim.py", "run1"],
        "env": {},
    }
    entry.update(overrides)
    return entry


def test_read_manifest_line_selects_by_index(tmp_path):
    manifest = _manifest(tmp_path, [_entry(job_id=1), _entry(job_id=2), _entry(job_id=3)])
    assert read_manifest_line(manifest, 1)["job_id"] == 2
    with pytest.raises(IndexError):
        read_manifest_line(manifest, 3)


def test_prelude_quotes_arguments_containing_spaces(tmp_path):
    # Timelines arrive as a single argument with spaces and commas:
    #   --timeline "0 minimal, 1200 minimal_plus_amino_acids"
    timeline = "0 minimal, 1200 minimal_plus_amino_acids"
    manifest = _manifest(tmp_path, [_entry(
        argv=["python", "runscripts/manual/runSim.py", "run1", "--timeline", timeline],
        env={"SINE_MEDIA_A": "minimal glucose"},
    )])
    prelude = emit_prelude(manifest, 0)

    assert "WCE_SIM_ARGV=(" in prelude
    # The whole timeline must survive as ONE shell word.
    assert "'0 minimal, 1200 minimal_plus_amino_acids'" in prelude
    assert "export SINE_MEDIA_A='minimal glucose'" in prelude

    # Sourcing it must reconstruct the argv exactly, element for element.
    import subprocess
    script = prelude + '\nprintf "%s\\n" "${WCE_SIM_ARGV[@]}"\n'
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True)
    assert out.stdout.splitlines()[-1] == timeline


def test_prelude_resists_shell_injection(tmp_path):
    hostile = "run1'; touch /tmp/pwned; echo '"
    manifest = _manifest(tmp_path, [_entry(argv=["python", hostile])])
    import subprocess
    script = emit_prelude(manifest, 0) + '\nprintf "%s\\n" "${WCE_SIM_ARGV[@]}"\n'
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True)
    assert out.stdout.splitlines()[-1] == hostile


def test_sentinel_round_trip_is_atomic(tmp_path):
    manifest = _manifest(tmp_path, [_entry()])
    path = sentinel_path(manifest, 0)
    write_sentinel(path, {"status": "done", "job_id": 7, "attempt": 1})
    assert json.loads(path.read_text())["status"] == "done"
    # No temporary files may survive a successful write.
    assert not list(path.parent.glob("*.tmp"))


def test_sentinel_path_is_derived_from_the_manifest(tmp_path):
    manifest = tmp_path / "20260901_x1y2z3.jsonl"
    assert sentinel_path(manifest, 12).name == "12.json"
    assert sentinel_path(manifest, 12).parent.name == "20260901_x1y2z3.sentinels"


def test_ingest_reports_a_failed_simulation_without_reading_output(tmp_path):
    from app.services.slurm_ingest import ingest

    manifest = _manifest(tmp_path, [_entry(sim_dir="does-not-exist")])
    payload = ingest(manifest, 0, returncode=42)
    assert payload["status"] == "failed"
    assert "42" in payload["error"]
    assert payload["results"] == []
