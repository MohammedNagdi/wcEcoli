import json
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine, select

from app.db.models import (
    Condition,
    Experiment,
    Gene,
    MediaRecipe,
    SimulationJob,
    SimulationResult,
    Timeline,
    Variant,
)
from app.main import get_session
from app.routers.experiments import router


def _build_client():
    tempdir = TemporaryDirectory()
    engine = create_engine(f"sqlite:///{tempdir.name}/test.db", echo=False)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        session.add(Variant(name="gene_knockout", parameter_count=10))
        session.add(Variant(name="tf_activity", parameter_count=3))
        session.add(Variant(name="wildtype", parameter_count=1))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="abcA", category="Other", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="abcB", category="Other", ko_index=43))
        session.add(Gene(id=3, ecoli_id="G0-0001", symbol="C0001", category="Other", ko_index=-1))
        session.add(MediaRecipe(media_id="minimal", base_media="MIX0-57", ingredients="[]"))
        session.add(MediaRecipe(media_id="acetate", base_media="MIX0-57", ingredients="[]"))
        session.add(Condition(name="basal", nutrients="minimal", doubling_time=44.0))
        session.add(Condition(name="acetate", nutrients="acetate", doubling_time=136.0))
        session.add(Timeline(name="acetate_shift", definition="0 minimal, 600 acetate"))
        session.commit()

    app = FastAPI()

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    app.include_router(router)
    client = TestClient(app)
    return tempdir, engine, client


def test_create_typed_gene_knockout_batch_with_matching_wildtypes():
    tempdir, engine, client = _build_client()
    try:
        response = client.post(
            "/api/experiments/batch",
            json={
                "name": "KO typed batch",
                "description": "notes",
                "variant_type": "gene_knockout",
                "include_wildtype": True,
                "records": [
                    {
                        "variant_index": 0,
                        "gene_symbol": "abca",
                        "timeline": "acetate_shift",
                        "seed": 0,
                        "generations": 1,
                        "sim_params": json.dumps({"length_sec": 7200}),
                    },
                    {
                        "variant_index": 0,
                        "gene_symbol": "abcB",
                        "timeline": "acetate_shift",
                        "seed": 7,
                        "generations": 1,
                        "sim_params": json.dumps({"length_sec": 7200}),
                    },
                ],
            },
        )

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["created"] == 4

        detail = client.get(f"/api/experiments/batches/{body['batch_id']}")
        assert detail.status_code == 200
        experiments = detail.json()["experiments"]
        knockouts = [exp for exp in experiments if exp["variant_type"] == "gene_knockout"]
        wildtypes = [exp for exp in experiments if exp["variant_type"] == "wildtype"]
        assert len(knockouts) == 2
        assert len(wildtypes) == 2
        assert {exp["variant_index"] for exp in knockouts} == {42, 43}
        assert {json.loads(exp["sim_params"])["seed"] for exp in wildtypes} == {0, 7}
        assert all(exp["condition"] == "basal" for exp in experiments)
        assert all(exp["description"] == "KO typed batch" for exp in experiments)

        with Session(engine) as session:
            db_experiments = session.exec(select(Experiment)).all()
            assert len(db_experiments) == 4
    finally:
        tempdir.cleanup()


def test_typed_batch_allows_same_variant_with_different_explicit_seeds():
    tempdir, engine, client = _build_client()
    try:
        response = client.post(
            "/api/experiments/batch",
            json={
                "name": "TF seeds",
                "variant_type": "tf_activity",
                "records": [
                    {"variant_index": 1, "seed": 0, "generations": 1, "sim_params": "{}"},
                    {"variant_index": 1, "seed": 7, "generations": 1, "sim_params": "{}"},
                ],
            },
        )
        assert response.status_code == 201, response.text
        assert response.json()["created"] == 2

        batch_id = response.json()["batch_id"]
        run_response = client.post(f"/api/experiments/batches/{batch_id}/run")
        assert run_response.status_code == 200, run_response.text

        with Session(engine) as session:
            jobs = session.exec(select(SimulationJob).order_by(SimulationJob.seed)).all()
            assert [job.seed for job in jobs] == [0, 7]
    finally:
        tempdir.cleanup()


def test_cancel_batch_stops_pending_jobs_and_resume_requeues_them():
    tempdir, engine, client = _build_client()
    try:
        create = client.post(
            "/api/experiments/batch",
            json={
                "name": "pausable",
                "variant_type": "tf_activity",
                "records": [
                    {"variant_index": 1, "seed": 0, "generations": 1, "sim_params": "{}"},
                    {"variant_index": 1, "seed": 7, "generations": 1, "sim_params": "{}"},
                ],
            },
        )
        assert create.status_code == 201
        batch_id = create.json()["batch_id"]

        run = client.post(f"/api/experiments/batches/{batch_id}/run")
        assert run.status_code == 200

        with Session(engine) as session:
            first_job = session.exec(select(SimulationJob).order_by(SimulationJob.id)).first()
            assert first_job
            first_job.status = "running_sim"
            session.add(first_job)
            session.commit()

        cancel = client.post(f"/api/experiments/batches/{batch_id}/cancel")
        assert cancel.status_code == 200, cancel.text
        assert cancel.json()["cancelled"] == 1

        with Session(engine) as session:
            jobs = session.exec(select(SimulationJob).order_by(SimulationJob.seed)).all()
            assert [job.status for job in jobs] == ["running_sim", "cancelled"]
            cancelled_experiment = session.get(Experiment, jobs[1].experiment_id)
            assert cancelled_experiment
            assert cancelled_experiment.status == "cancelled"

        resume = client.post(f"/api/experiments/batches/{batch_id}/resume")
        assert resume.status_code == 200, resume.text
        assert resume.json()["resumed"] == 1

        with Session(engine) as session:
            jobs = session.exec(select(SimulationJob).order_by(SimulationJob.seed)).all()
            assert [job.status for job in jobs] == ["running_sim", "pending"]
            resumed_experiment = session.get(Experiment, jobs[1].experiment_id)
            assert resumed_experiment
            assert resumed_experiment.status == "queued"
    finally:
        tempdir.cleanup()


def test_rejects_invalid_typed_batch_requests():
    tempdir, _, client = _build_client()
    try:
        empty = client.post(
            "/api/experiments/batch",
            json={"name": "empty", "variant_type": "gene_knockout", "records": []},
        )
        assert empty.status_code == 400

        bad_wt = client.post(
            "/api/experiments/batch",
            json={
                "name": "bad wt",
                "variant_type": "tf_activity",
                "include_wildtype": True,
                "records": [{"variant_index": 1, "seed": 0, "generations": 1}],
            },
        )
        assert bad_wt.status_code == 400

        bad_seed = client.post(
            "/api/experiments/batch",
            json={
                "name": "bad seed",
                "variant_type": "gene_knockout",
                "records": [{"variant_index": 0, "gene_symbol": "abcA", "seed": -1, "generations": 1}],
            },
        )
        assert bad_seed.status_code == 400

        invalid_ko = client.post(
            "/api/experiments/batch",
            json={
                "name": "invalid ko",
                "variant_type": "gene_knockout",
                "records": [{"variant_index": 0, "gene_symbol": "C0001", "seed": 0, "generations": 1}],
            },
        )
        assert invalid_ko.status_code == 400
        assert "valid knockout index" in invalid_ko.text
    finally:
        tempdir.cleanup()


def test_delete_batch_deletes_experiments_jobs_and_results():
    tempdir, engine, client = _build_client()
    try:
        create = client.post(
            "/api/experiments/batch",
            json={
                "name": "delete me",
                "variant_type": "tf_activity",
                "records": [{"variant_index": 1, "seed": 0, "generations": 1}],
            },
        )
        assert create.status_code == 201
        batch_id = create.json()["batch_id"]

        with Session(engine) as session:
            exp = session.exec(select(Experiment).where(Experiment.batch_id == batch_id)).first()
            assert exp and exp.id
            job = SimulationJob(experiment_id=exp.id, status="failed", seed=0)
            session.add(job)
            session.flush()
            assert job.id
            session.add(SimulationResult(job_id=job.id, experiment_id=exp.id, seed=0, generation=1))
            session.commit()

        delete = client.delete(f"/api/experiments/batches/{batch_id}")
        assert delete.status_code == 204

        with Session(engine) as session:
            assert session.exec(select(Experiment)).all() == []
            assert session.exec(select(SimulationJob)).all() == []
            assert session.exec(select(SimulationResult)).all() == []
    finally:
        tempdir.cleanup()


def test_delete_batch_blocks_active_jobs_and_unknown_batches():
    tempdir, engine, client = _build_client()
    try:
        missing = client.delete("/api/experiments/batches/not-found")
        assert missing.status_code == 404

        create = client.post(
            "/api/experiments/batch",
            json={
                "name": "active",
                "variant_type": "tf_activity",
                "records": [{"variant_index": 1, "seed": 0, "generations": 1}],
            },
        )
        assert create.status_code == 201
        batch_id = create.json()["batch_id"]

        with Session(engine) as session:
            exp = session.exec(select(Experiment).where(Experiment.batch_id == batch_id)).first()
            assert exp and exp.id
            exp.status = "queued"
            session.add(exp)
            session.add(SimulationJob(experiment_id=exp.id, status="pending", seed=0))
            session.commit()

        delete = client.delete(f"/api/experiments/batches/{batch_id}")
        assert delete.status_code == 409
    finally:
        tempdir.cleanup()
