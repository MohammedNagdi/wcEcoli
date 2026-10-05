import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine

from app.db.models import Experiment, Gene, MediaRecipe, SimulationJob, SimulationResult, Timeline
from app.main import get_session
from app.routers.design import router
from app.services.design_evidence import DesignEvidenceCatalog


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(
            Gene(id=1, symbol="abcA", ecoli_id="EG1", is_mechanistic=True, category="metabolism")
        )
        session.add(
            Gene(id=2, symbol="abcB", ecoli_id="EG2", is_mechanistic=True, category="regulation")
        )
        session.add(Gene(id=3, symbol="excluded", ecoli_id="EG3", is_mechanistic=False))
        session.add(MediaRecipe(media_id="minimal"))
        session.add(MediaRecipe(media_id="acetate"))
        session.add(Timeline(name="shift", definition="0 minimal, 600 acetate"))
        session.commit()
        yield session
    engine.dispose()


def experiment(db, *, wt=False, date="2026-01-01", params=None, **kwargs):
    exp = Experiment(
        name="wildtype" if wt else "abcA knockout",
        variant_type="wildtype" if wt else "gene_knockout",
        gene_symbol="" if wt else "abcA",
        condition="basal",
        created_at=date,
        sim_params=json.dumps(params or {"seeds": [0, 1], "generations": 1, "length_sec": 10800}),
        **kwargs,
    )
    db.add(exp)
    db.commit()
    return exp


def job(db, exp, *, status="done", result=True, generation=0, divided=True, growth=0.001, **kwargs):
    j = SimulationJob(experiment_id=exp.id, status=status)
    db.add(j)
    db.commit()
    if result:
        db.add(
            SimulationResult(
                job_id=j.id,
                experiment_id=exp.id,
                generation=generation,
                divided=divided,
                division_time_sec=3600 if divided else None,
                growth_rate=growth,
                final_mass_fg=1000,
                doubling_time_min=45,
                **kwargs,
            )
        )
        db.commit()
    return j


def summary(db):
    return DesignEvidenceCatalog(db, "basal").overview().genes[0]


def test_absent_and_draft_are_unclassified_not_simulated(db):
    assert summary(db).evidence_status == "no_experiment"
    experiment(db)
    catalog = DesignEvidenceCatalog(db, "basal")
    overview = catalog.overview()
    assert overview.genes_with_experiments == 1
    assert overview.simulated_genes == overview.genes_with_usable_results == 0
    assert overview.genes[0].evidence_status == "no_completed_jobs"
    assert overview.unclassified_genes == 2


def test_completed_jobs_without_results_never_imply_essential(db):
    exp = experiment(db)
    job(db, exp, result=False)
    s = summary(db)
    assert s.n_completed == 1 and s.usable_result_count == 0
    assert s.phenotype == "unknown" and s.divided is None
    assert s.division_rate is None and s.evidence_status == "missing_results"


def test_partial_results_do_not_classify_missing_records_as_nondivision(db):
    exp = experiment(db)
    job(db, exp, divided=False)
    job(db, exp, result=False)
    s = summary(db)
    assert s.phenotype == "unknown" and s.evidence_status == "partial"
    assert s.division_rate == "0/1 divided"
    assert s.recorded_result_count == s.usable_result_count == 1


def test_no_division_is_observational_not_wildtype_dependent(db):
    exp = experiment(db)
    job(db, exp, divided=False)
    s = summary(db)
    assert s.phenotype == "essential" and s.baseline.status == "unavailable"


def test_terminated_lineage_retains_metrics_but_is_unclassified(db):
    exp = experiment(db)
    job(db, exp, divided=False, terminated=True, termination_reason="NegativeCountsError")
    s = summary(db)
    assert s.phenotype == "unknown" and s.mean_final_mass_fg == 1000
    assert any("terminated" in gap for gap in s.evidence_gaps)


@pytest.mark.parametrize(
    "rate,expected", [(0.000799, "growth_defect"), (0.0008, "neutral"), (0.001, "neutral")]
)
def test_growth_threshold_and_different_seed_sets(db, rate, expected):
    wt = experiment(db, wt=True, params={"seeds": [7], "generations": 1, "length_sec": 10800})
    job(db, wt)
    exp = experiment(db)
    job(db, exp, growth=rate)
    s = summary(db)
    assert s.phenotype == expected
    assert s.baseline.status == "available"
    assert s.baseline.source.configured_seed_count == 1
    assert s.source.configured_seed_count == 2


@pytest.mark.parametrize(
    "difference",
    [dict(timeline="shift"), dict(params={"generations": 2}), dict(params={"length_sec": 7200})],
)
def test_incompatible_wildtype_never_yields_neutral(db, difference):
    wt = experiment(db, wt=True, **difference)
    job(db, wt)
    exp = experiment(db)
    job(db, exp)
    assert summary(db).phenotype == "unknown"
    assert summary(db).baseline.source is None


@pytest.mark.parametrize("rate", [None, 0, -1])
def test_invalid_baseline_growth(db, rate):
    wt = experiment(db, wt=True)
    job(db, wt, growth=rate)
    exp = experiment(db)
    job(db, exp)
    s = summary(db)
    assert s.phenotype == "unknown" and s.baseline.status == "unusable_comparison"


def test_missing_growth_cannot_fall_back_to_neutral(db):
    job(db, experiment(db, wt=True))
    job(db, experiment(db), growth=None)
    s = summary(db)
    assert s.phenotype == "unknown"
    assert s.metric_sample_counts["growth_rate"] == 0
    assert s.mean_growth_rate is None


def test_newest_usable_experiment_is_selected_without_merging(db):
    old = experiment(db, date="2025-01-01")
    job(db, old, growth=0.0004)
    newer = experiment(db)
    job(db, newer, growth=0.0006)
    newest_draft = experiment(db, date="2026-02-01")
    s = summary(db)
    assert s.experiment_id == newer.id and s.mean_growth_rate == 0.0006
    catalog = DesignEvidenceCatalog(db, "basal")
    detail = catalog.detail("abcA", old.id)
    assert detail.summary.experiment_id == old.id
    assert [e.experiment_id for e in detail.experiments] == [newest_draft.id, newer.id, old.id]
    assert catalog.detail("abcA", newest_draft.id).summary.evidence_status == "no_completed_jobs"


def test_generation_scope_and_protocol_resolution_match(db):
    wt = experiment(db, wt=True, timeline="shift")
    job(db, wt)
    exp = experiment(db, timeline="0 minimal, 600 acetate")
    j = job(db, exp, generation=1, growth=0.0008)
    db.add(
        SimulationResult(
            job_id=j.id,
            experiment_id=exp.id,
            generation=2,
            divided=True,
            division_time_sec=5000,
            growth_rate=0.0001,
        )
    )
    db.commit()
    s = summary(db)
    assert s.mean_growth_rate == 0.0008 and s.phenotype == "neutral"
    detail = DesignEvidenceCatalog(db, "basal").detail("abcA")
    assert len(detail.jobs[0].results) == 2
    assert detail.jobs[0].earliest_result_id == detail.jobs[0].results[0]["id"]
    assert detail.summary.mean_division_time_min == 60


def test_query_count_is_constant_and_categories_agree(db):
    queries = []
    event.listen(db.get_bind(), "before_cursor_execute", lambda *args: queries.append(args[2]))
    catalog = DesignEvidenceCatalog(db, "basal")
    initial = len(queries)
    assert sum(s.unknown for s in catalog.category_stats()) == catalog.overview().unknown_genes
    for n in range(100):
        db.add(Gene(id=n + 10, symbol=f"x{n}", ecoli_id=f"E{n}", is_mechanistic=True))
    db.commit()
    queries.clear()
    assert DesignEvidenceCatalog(db, "basal").overview().total_genes == 102
    assert len(queries) == initial == 7


def test_endpoint_scope_invalid_source_and_condition_isolation(db):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = lambda: db
    client = TestClient(app)
    assert client.get("/api/design/genes/excluded").status_code == 422
    assert "mechanistic" in client.get("/api/design/genes/excluded").json()["detail"]
    assert client.get("/api/design/genes/missing").status_code == 404
    assert client.get("/api/design/genes/abcA?experiment_id=999").status_code == 404
    job(db, experiment(db))
    response = client.get("/api/design/genes/ABCA").json()
    assert response["jobs"][0]["result_url"].startswith("/results/")
    assert (
        client.get("/api/design/overview?condition=acetate").json()["genes_with_experiments"] == 0
    )
    assert client.get("/api/design/overview?category=regulation").json()["total_genes"] == 1


def test_unavailable_and_invalid_metrics_remain_unclassified(db):
    exp = experiment(db)
    j = job(db, exp, result=False)
    db.add(
        SimulationResult(
            job_id=j.id,
            experiment_id=exp.id,
            divided=True,
            division_time_sec=None,
            final_mass_fg=-1,
            doubling_time_min=0,
        )
    )
    db.commit()
    s = summary(db)
    assert s.evidence_status == "unavailable_metrics"
    assert s.phenotype == "unknown" and s.division_sample_count == 0


def test_invalid_protocol_or_run_parameters_disable_comparison(db):
    job(db, experiment(db, wt=True))
    exp = experiment(db)
    job(db, exp)
    exp.sim_params = "invalid json"
    db.add(exp)
    db.commit()
    s = summary(db)
    assert s.phenotype == "unknown"
    assert s.source.duration_sec is None
    assert "cannot be resolved" in s.baseline.reason


def test_newest_wildtype_with_usable_results_and_id_tiebreak(db):
    old = experiment(db, wt=True)
    job(db, old)
    newer = experiment(db, wt=True)
    job(db, newer, growth=0.002)
    experiment(db, wt=True, date="2026-02-01")  # Draft does not override usable evidence.
    exp = experiment(db)
    job(db, exp)
    s = summary(db)
    assert s.baseline.source.experiment_id == newer.id
    assert s.phenotype == "growth_defect"


def test_partial_wildtype_cannot_support_growth_maintained(db):
    wt = experiment(db, wt=True)
    job(db, wt)
    job(db, wt, result=False)
    job(db, experiment(db))
    assert summary(db).baseline.status == "unusable_comparison"
    assert summary(db).phenotype == "unknown"


def test_detail_decodes_description_as_text_and_nonfinite_records_are_inspectable(db):
    g = db.get(Gene, 1)
    g.monomer_name = "subunit &alpha; &lt;source&gt;"
    db.add(g)
    job(db, experiment(db), growth=float("inf"))
    catalog = DesignEvidenceCatalog(db, "basal")
    result = catalog.detail("abcA")
    assert result.gene["description"] == "subunit α <source>"
    assert result.summary.mean_growth_rate is None
    assert result.jobs[0].results[0]["invalid_metric_values"] == {"growth_rate": "inf"}
    assert result.jobs[0].results[0]["growth_rate"] is None
    json.dumps(result.model_dump(), allow_nan=False)


def test_bulk_queries_stay_bounded_with_experiments_jobs_and_results(db):
    for n in range(40):
        e = experiment(db, date=f"2026-01-{n % 28 + 1:02}")
        job(db, e)
    queries = []
    event.listen(db.get_bind(), "before_cursor_execute", lambda *args: queries.append(args[2]))
    catalog = DesignEvidenceCatalog(db, "basal")
    catalog.overview()
    catalog.category_stats()
    assert len(catalog.detail("abcA").experiments) == 40
    assert len(queries) == 7
