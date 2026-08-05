from pathlib import Path
from unittest.mock import patch

from sqlalchemy import text
from sqlmodel import SQLModel, Session, create_engine

import app.main  # noqa: F401 - initialize router dependencies before direct imports
from app.db.init_db import _restore_user_tables, needs_rebuild
from app.db.models import Experiment, SimulationJob, SimulationResult
from app.routers.experiments import _build_comparison_experiment, compare_batch
from app.services.job_recovery import recover_orphaned_simulation_jobs


def _engine(path: Path):
    engine = create_engine(
        "sqlite:///" + str(path),
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_runtime_job_columns_do_not_force_reconstruction_rebuild(tmp_path):
    database_path = tmp_path / "wcecoli.db"
    database_path.touch()
    (tmp_path / ".schema_version").write_text("8")

    with patch("app.db.init_db.settings.database_path", database_path):
        assert needs_rebuild() is False


def test_old_job_rows_restore_with_runner_column_defaults(tmp_path):
    engine = _engine(tmp_path / "restore.db")
    old_columns = (
        "id",
        "experiment_id",
        "status",
        "phase",
        "sim_dir",
        "docker_container_id",
        "log_tail",
        "started_at",
        "finished_at",
        "error_message",
        "created_at",
        "variant_type",
        "variant_index",
        "condition",
        "seed",
        "generations",
        "timeline",
    )
    old_row = (
        42,
        7,
        "done",
        "Complete",
        "20260709_173315_timelines_job42",
        "",
        "",
        "2026-07-09T17:33:15+00:00",
        "2026-07-09T17:39:18+00:00",
        "",
        "2026-07-09T17:33:03+00:00",
        "timelines",
        0,
        "basal",
        0,
        1,
        "0 minimal",
    )

    restored = _restore_user_tables(
        engine,
        {"simulation_jobs": [old_columns, old_row]},
    )

    assert restored == {"simulation_jobs": 1}
    with Session(engine) as session:
        job = session.get(SimulationJob, 42)
        assert job is not None
        assert job.runner_task_id == ""
        assert job.worker_id == ""
        assert job.heartbeat_at == ""
        assert job.lease_expires_at == ""
        assert job.attempt == 0

    with engine.connect() as connection:
        columns = {
            row[1]: row[4]
            for row in connection.execute(text("PRAGMA table_info(simulation_jobs)"))
        }
    assert columns["runner_task_id"] == "''"
    assert columns["attempt"] == "'0'"


def test_orphaned_jobs_are_recovered_for_results_and_batch_comparison(tmp_path):
    engine = _engine(tmp_path / "recovery.db")
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    (output_dir / "20260603_182318_timelines_job14").mkdir()
    expected_run_dir = output_dir / "20260709_173315_timelines_job14"
    expected_run_dir.mkdir()

    with Session(engine) as session:
        experiment = Experiment(
            id=10,
            name="timelines[0] seed 0",
            description="Testing Sim time",
            variant_type="timelines",
            variant_index=0,
            condition="basal",
            timeline="0 minimal",
            status="done",
            batch_id="batch-1",
            created_at="2026-07-09T17:33:03+00:00",
        )
        session.add(experiment)
        session.add(
            SimulationResult(
                id=7,
                job_id=14,
                experiment_id=10,
                seed=0,
                generation=0,
                division_time_sec=2529.0,
                final_mass_fg=2344.45,
                growth_rate=0.000247,
                doubling_time_min=46.73,
                created_at="2026-07-09T17:39:18+00:00",
            )
        )
        session.commit()

    assert recover_orphaned_simulation_jobs(engine, output_dir) == [14]
    assert recover_orphaned_simulation_jobs(engine, output_dir) == []

    with Session(engine) as session:
        job = session.get(SimulationJob, 14)
        assert job is not None
        assert job.status == "done"
        assert job.sim_dir == expected_run_dir.name
        assert job.experiment_id == 10
        assert job.seed == 0
        assert job.generations == 1

        experiment = session.get(Experiment, 10)
        comparison = _build_comparison_experiment(experiment, session)
        assert comparison.total_seeds == 1
        assert comparison.completed_seeds == 1
        assert comparison.division_time_min.mean == 42.15

        batch = compare_batch("batch-1", include_wildtype=False, session=session)
        assert len(batch.experiments) == 1
        assert batch.experiments[0].completed_seeds == 1
        assert batch.experiments[0].final_mass_fg.mean == 2344.45
