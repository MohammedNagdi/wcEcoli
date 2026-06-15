"""Campaign plan resolution is unit-testable on an in-memory DB (no jobs queued)."""

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db.models import Condition, Gene
from hf_export.matrix import CampaignCell
from hf_export.submit_campaign import plan_cell, resolve_ko_genes


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Gene(ecoli_id="EG1", symbol="dnaA", ko_index=42))
    s.add(Gene(ecoli_id="EG2", symbol="noko", ko_index=0))
    s.add(Condition(name="basal", nutrients="minimal"))
    s.commit()
    return s


def test_plan_cell_resolution():
    s = _session()
    wt = plan_cell(s, CampaignCell("wildtype", "WT/basal", condition="basal"))
    assert wt["submittable"]

    ko = plan_cell(s, CampaignCell("gene_knockout", "dnaA_KO/basal", condition="basal", params={"gene": "dnaA"}))
    assert ko["submittable"] and ko["variant_index"] == 42

    bad = plan_cell(s, CampaignCell("gene_knockout", "noko_KO/basal", condition="basal", params={"gene": "noko"}))
    assert not bad["submittable"] and "knockout-ready" in bad["reason"]

    dyn = plan_cell(s, CampaignCell("timelines", "WT/shift", params={"events": "0 minimal, 1200 minimal_acetate"}))
    assert dyn["submittable"] and dyn["timeline"]

    exotic = plan_cell(s, CampaignCell("sinusoidal_media", "WT/sin", params={}))
    assert not exotic["submittable"] and "not yet submittable" in exotic["reason"]


def test_resolve_ko_genes():
    s = _session()
    assert resolve_ko_genes(s, ["x", "y"]) == ["x", "y"]      # explicit wins
    auto = resolve_ko_genes(s, None)
    assert "dnaA" in auto and "noko" not in auto              # only knockout-ready
