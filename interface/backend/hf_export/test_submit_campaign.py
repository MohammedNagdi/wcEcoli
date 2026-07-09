"""Campaign plan resolution is unit-testable on an in-memory DB (no jobs queued)."""

from types import SimpleNamespace

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db.models import Condition, Gene, TFEdge, Variant
from app.services.experiment_creation import PPGPP_CONDITION_NAMES, PPGPP_FACTORS
from hf_export.matrix import (
    T2_CORE_CONDITIONS,
    T2_EXTENDED_CONDITIONS,
    TIER_T2_CORE,
    TIER_T2_EXTENDED,
    TIER_T1,
    TIER_T3,
    TIER_T4,
    TIER_T5,
    T3_AA_SHIFT_VARIANTS,
    T3_SINUSOIDAL_MEDIA_PAIRS,
    T3_SINUSOIDAL_PERIODS_MIN,
    T3_TIMELINE_PROTOCOLS,
    T5_PAIR_DEFINITIONS,
    WT_CONDITIONS,
    CampaignCell,
    t4_campaign,
    t5_campaign,
    v0_campaign,
)
from hf_export.submit_campaign import (
    _append_campaign_ledger,
    _read_campaign_ledger,
    build_campaign_cells,
    campaign_cell_key,
    parse_tiers,
    plan_cell,
    resolve_ko_genes,
    resolve_t2_gene_sets,
    submit_cell,
    stratified_sample,
)


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Gene(ecoli_id="EG1", symbol="dnaA", ko_index=42))
    s.add(Gene(ecoli_id="EG2", symbol="noko", ko_index=0))
    s.add(Gene(ecoli_id="EG3", symbol="argG", ko_index=43, category="amino_acid_biosynthesis"))
    s.add(Gene(ecoli_id="EG4", symbol="bioA", ko_index=44, category="cofactor_biosynthesis"))
    s.add(Gene(ecoli_id="EG5", symbol="catA1", ko_index=45, category="cat_a"))
    s.add(Gene(ecoli_id="EG6", symbol="catA2", ko_index=46, category="cat_a"))
    s.add(Gene(ecoli_id="EG7", symbol="catB1", ko_index=47, category="cat_b"))
    s.add(Gene(ecoli_id="EG8", symbol="catB2", ko_index=48, category="cat_b"))
    s.add(Gene(ecoli_id="EG9", symbol="sameA", ko_index=49, category="cat_same"))
    s.add(Gene(ecoli_id="EG10", symbol="sameB", ko_index=49, category="cat_same"))
    for variant_name in [
        "wildtype",
        "gene_knockout",
        "timelines",
        "sinusoidal_media",
        "add_one_aa_shift",
        "remove_one_aa_shift",
        "remove_aas_shift",
        "tf_activity",
        "ppgpp_conc",
        "multi_gene_knockout",
    ]:
        s.add(Variant(name=variant_name))
    s.add(TFEdge(tf_symbol="crp", target_symbol="lacZ"))
    s.add(TFEdge(tf_symbol="dnaA", target_symbol="dnaN"))
    s.add(TFEdge(tf_symbol="fis", target_symbol="crp"))
    for condition in WT_CONDITIONS:
        s.add(Condition(name=condition, nutrients=f"minimal_{condition}"))
    s.commit()
    return s


def test_t1_condition_set_matches_campaign_brief():
    assert len(WT_CONDITIONS) == 21
    assert "plus_tungstate" in WT_CONDITIONS


def test_t1_cells_are_wildtype_only():
    cells = v0_campaign(ko_genes=[])
    t1_cells = [cell for cell in cells if cell.condition in WT_CONDITIONS]
    assert len(t1_cells) == len(WT_CONDITIONS)
    assert {cell.variant_type for cell in t1_cells} == {"wildtype"}


def test_plan_cell_resolution():
    s = _session()
    wt = plan_cell(s, CampaignCell("wildtype", "WT/basal", condition="basal"))
    assert wt["submittable"]

    wt_plus_tungstate = plan_cell(
        s,
        CampaignCell("wildtype", "WT/plus_tungstate", condition="plus_tungstate"),
    )
    assert wt_plus_tungstate["submittable"]

    bad_wt = plan_cell(s, CampaignCell("wildtype", "WT/missing", condition="missing"))
    assert not bad_wt["submittable"] and "condition 'missing' not found" in bad_wt["reason"]

    ko = plan_cell(s, CampaignCell("gene_knockout", "dnaA_KO/basal", condition="basal", params={"gene": "dnaA"}))
    assert ko["submittable"] and ko["variant_index"] == 42

    bad = plan_cell(s, CampaignCell("gene_knockout", "noko_KO/basal", condition="basal", params={"gene": "noko"}))
    assert not bad["submittable"] and "knockout-ready" in bad["reason"]

    dyn = plan_cell(s, CampaignCell("timelines", "WT/shift", params={"events": "0 minimal, 1200 minimal_acetate"}))
    assert dyn["submittable"] and dyn["timeline"]

    exotic = plan_cell(s, CampaignCell("sinusoidal_media", "WT/sin", params={}))
    assert not exotic["submittable"] and "not yet submittable" in exotic["reason"]

    t3_sine = plan_cell(
        s,
        CampaignCell("sinusoidal_media", "WT/sin", params={"variant_index": 30}, tier=TIER_T3),
    )
    assert t3_sine["submittable"] and t3_sine["variant_index"] == 30


def test_plan_cell_rejects_missing_variant_row():
    s = _session()
    missing = plan_cell(s, CampaignCell("made_up_variant", "bad", condition="basal"))
    assert not missing["submittable"]
    assert missing["reason"] == "variant 'made_up_variant' not found"


def test_stratified_sample_spans_families():
    cells = [
        CampaignCell("wildtype", "WT/basal"),
        CampaignCell("wildtype", "WT/acetate"),
        CampaignCell("gene_knockout", "dnaA_KO/basal", params={"gene": "dnaA"}),
        CampaignCell("gene_knockout", "argG_KO/basal", params={"gene": "argG"}),
        CampaignCell("timelines", "WT/rich_to_minimal", params={"events": "0 minimal, 1200 minimal_acetate"}),
        CampaignCell("timelines", "WT/glucose_starvation", params={"events": "0 minimal, 1200 minimal_no_glucose"}),
    ]
    picked = stratified_sample(cells, 5)
    families = {c.variant_type for c in picked}
    assert len(picked) == 5
    # A first-N slice would be all wildtype; the stratified sample must span multiple families.
    assert len(families) >= 3 and "gene_knockout" in families and "wildtype" in families


def test_resolve_ko_genes():
    s = _session()
    assert resolve_ko_genes(s, ["x", "y"]) == ["x", "y"]      # explicit wins
    auto = resolve_ko_genes(s, None)
    assert "dnaA" in auto and "noko" not in auto              # only knockout-ready


def test_t2_gene_selection_is_essential_first_and_category_balanced():
    s = _session()
    selected = resolve_t2_gene_sets(s, essential_symbols=["bioA", "argG", "missing"])

    assert selected["essential_ko_ready"] == ["bioA", "argG"]
    assert selected["core"][:2] == ["bioA", "argG"]
    assert {"catA1", "catA2", "catB1", "catB2"}.issubset(set(selected["core"]))
    assert selected["core_category_counts"]["cat_a"] == 2
    assert selected["core_category_counts"]["cat_b"] == 2
    assert selected["extended"][:2] == ["bioA", "argG"]


def test_t2_campaigns_emit_gene_knockouts_over_expected_conditions():
    s = _session()
    cells, _ = build_campaign_cells(s, [TIER_T2_CORE, TIER_T2_EXTENDED], genes=None)
    keys = {(cell.variant_type, cell.condition, cell.params.get("gene")) for cell in cells}

    assert {cell.variant_type for cell in cells} == {"gene_knockout"}
    assert {cell.condition for cell in cells if cell.tier == TIER_T2_CORE} == set(T2_CORE_CONDITIONS)
    assert {cell.condition for cell in cells if cell.tier == TIER_T2_EXTENDED} <= set(T2_EXTENDED_CONDITIONS)
    assert len(keys) == len(cells)


def test_parse_tiers_defaults_and_deduplicates():
    assert parse_tiers("") == [TIER_T1]
    assert parse_tiers("T1,v0,T2_CORE,t2_core,T2_EXTENDED,T3,T4,t4,T5,t5") == [
        TIER_T1,
        TIER_T2_CORE,
        TIER_T2_EXTENDED,
        TIER_T3,
        TIER_T4,
        TIER_T5,
    ]


def test_t3_campaign_includes_timelines_sinusoidal_and_aa_shifts():
    s = _session()
    cells, metadata = build_campaign_cells(s, [TIER_T3], genes=None)

    assert {cell.tier for cell in cells} == {TIER_T3}
    assert metadata["t3"]["essential_genes"] >= 2
    assert metadata["t3"]["timeline_cells"] == (1 + metadata["t3"]["ko_genes"]) * len(T3_TIMELINE_PROTOCOLS)
    assert metadata["t3"]["sinusoidal_cells"] == len(T3_SINUSOIDAL_MEDIA_PAIRS) * len(T3_SINUSOIDAL_PERIODS_MIN)
    assert metadata["t3"]["aa_shift_cells"] == sum(len(list(indices)) for indices in T3_AA_SHIFT_VARIANTS.values())

    glucose = [
        cell for cell in cells
        if cell.variant_type == "timelines" and cell.params.get("protocol") == "glucose_starvation"
    ]
    assert glucose
    assert {cell.params["events"] for cell in glucose} == {"0 minimal, 1200 minimal_no_glucose"}

    timeline_variants = {cell.params.get("gene", "WT") or "WT" for cell in glucose}
    assert "WT" in timeline_variants and "argG" in timeline_variants and "bioA" in timeline_variants

    sine = [cell for cell in cells if cell.variant_type == "sinusoidal_media"]
    assert sine
    assert all("sinusoidal_media" in cell.params.get("sim_params", {}) for cell in sine)

    for variant_type, indices in T3_AA_SHIFT_VARIANTS.items():
        emitted = sorted(
            cell.params["variant_index"]
            for cell in cells
            if cell.variant_type == variant_type
        )
        assert emitted == list(indices)


def test_t4_campaign_emits_tf_activity_and_ppgpp_cells():
    ppgpp_indices = list(range(len(PPGPP_FACTORS) * len(PPGPP_CONDITION_NAMES)))
    cells = t4_campaign(["crp", "dnaA"], ppgpp_indices)

    assert len(cells) == 2 * 2 + len(ppgpp_indices)
    assert {cell.tier for cell in cells} == {TIER_T4}

    tf_cells = [cell for cell in cells if cell.variant_type == "tf_activity"]
    assert [(cell.params["tf"], cell.params["tf_state"], cell.params["variant_index"]) for cell in tf_cells] == [
        ("crp", "active", 1),
        ("crp", "inactive", 2),
        ("dnaA", "active", 3),
        ("dnaA", "inactive", 4),
    ]

    ppgpp_cells = [cell for cell in cells if cell.variant_type == "ppgpp_conc"]
    assert [cell.params["variant_index"] for cell in ppgpp_cells] == list(range(20))


def test_t4_plan_cell_validates_regulatory_indices(monkeypatch):
    monkeypatch.setattr("hf_export.submit_campaign._load_tf_activity_names", lambda session: ["crp", "dnaA"])
    s = _session()

    tf = plan_cell(s, CampaignCell("tf_activity", "dnaA/active", params={"variant_index": 3}, tier=TIER_T4))
    assert tf["submittable"]
    assert tf["variant_index"] == 3
    assert tf["tf"] == "dnaA"
    assert tf["tf_state"] == "active"

    tf_zero = plan_cell(s, CampaignCell("tf_activity", "control", params={"variant_index": 0}, tier=TIER_T4))
    assert not tf_zero["submittable"] and "index 0" in tf_zero["reason"]

    tf_high = plan_cell(s, CampaignCell("tf_activity", "missing", params={"variant_index": 5}, tier=TIER_T4))
    assert not tf_high["submittable"] and "exceeds max 4" in tf_high["reason"]

    ppgpp = plan_cell(s, CampaignCell("ppgpp_conc", "ppgpp/19", params={"variant_index": 19}, tier=TIER_T4))
    assert ppgpp["submittable"]
    assert ppgpp["variant_index"] == 19
    assert ppgpp["ppgpp_condition"] == "with_aa"
    assert ppgpp["ppgpp_factor"] == 2

    ppgpp_high = plan_cell(s, CampaignCell("ppgpp_conc", "ppgpp/20", params={"variant_index": 20}, tier=TIER_T4))
    assert not ppgpp_high["submittable"] and "outside 0..19" in ppgpp_high["reason"]


def test_t4_build_campaign_cells_metadata(monkeypatch):
    monkeypatch.setattr("hf_export.submit_campaign._load_tf_activity_names", lambda session: ["crp", "dnaA"])
    s = _session()

    cells, metadata = build_campaign_cells(s, [TIER_T4], genes=None)

    assert {cell.tier for cell in cells} == {TIER_T4}
    assert {cell.variant_type for cell in cells} == {"tf_activity", "ppgpp_conc"}
    assert len(cells) == 24
    assert metadata["t4"] == {
        "tf_activity_tfs": 2,
        "tf_activity_cells": 4,
        "tf_network_tfs": 3,
        "tf_uncovered_count": 1,
        "ppgpp_cells": 20,
        "total_cells": 24,
    }


def test_t5_pair_definitions_are_expected_size():
    assert len(T5_PAIR_DEFINITIONS) == 75


def test_t5_pair_definitions_are_unique_and_well_formed():
    unordered_pairs = [tuple(sorted(pair["genes"])) for pair in T5_PAIR_DEFINITIONS]

    assert len(unordered_pairs) == len(set(unordered_pairs))
    assert all(len(pair["genes"]) == 2 for pair in T5_PAIR_DEFINITIONS)
    assert all(pair.get("pair_class") for pair in T5_PAIR_DEFINITIONS)


def test_t5_campaign_emits_pairs_over_core_conditions():
    pair_definitions = [
        {"genes": ["dnaA", "argG"], "pair_class": "test_pair", "pair_label": "dnaA+argG"},
        {"genes": ["bioA", "catA1"], "pair_class": "test_pair", "pair_label": "bioA+catA1"},
    ]
    cells = t5_campaign(pair_definitions)

    assert len(cells) == len(pair_definitions) * len(T2_CORE_CONDITIONS)
    assert {cell.tier for cell in cells} == {TIER_T5}
    assert {cell.variant_type for cell in cells} == {"multi_gene_knockout"}
    assert {cell.condition for cell in cells} == set(T2_CORE_CONDITIONS)
    assert cells[0].params == {
        "genes": ["dnaA", "argG"],
        "pair_class": "test_pair",
        "pair_label": "dnaA+argG",
    }


def test_t5_plan_cell_validates_multi_gene_knockouts():
    s = _session()

    valid = plan_cell(
        s,
        CampaignCell(
            "multi_gene_knockout",
            "dnaA+argG/basal",
            condition="basal",
            params={"genes": ["dnaA", "argG"], "pair_class": "test_pair"},
            tier=TIER_T5,
        ),
    )
    assert valid["submittable"]
    assert valid["variant_index"] == 0
    assert valid["genes"] == ["dnaA", "argG"]
    assert valid["ko_indices"] == [42, 43]
    assert valid["pair_class"] == "test_pair"

    duplicate = plan_cell(
        s,
        CampaignCell("multi_gene_knockout", "dup", condition="basal", params={"genes": ["dnaA", "dnaA"]}, tier=TIER_T5),
    )
    assert not duplicate["submittable"] and "Duplicate genes" in duplicate["reason"]

    non_ko = plan_cell(
        s,
        CampaignCell("multi_gene_knockout", "non-ko", condition="basal", params={"genes": ["dnaA", "noko"]}, tier=TIER_T5),
    )
    assert not non_ko["submittable"] and "valid knockout index" in non_ko["reason"]

    missing = plan_cell(
        s,
        CampaignCell("multi_gene_knockout", "missing", condition="basal", params={"genes": ["dnaA", "missing"]}, tier=TIER_T5),
    )
    assert not missing["submittable"] and "Unknown gene" in missing["reason"]

    same_effective = plan_cell(
        s,
        CampaignCell("multi_gene_knockout", "same", condition="basal", params={"genes": ["sameA", "sameB"]}, tier=TIER_T5),
    )
    assert not same_effective["submittable"] and "fewer than two unique" in same_effective["reason"]

    bad_condition = plan_cell(
        s,
        CampaignCell("multi_gene_knockout", "bad-condition", condition="missing", params={"genes": ["dnaA", "argG"]}, tier=TIER_T5),
    )
    assert not bad_condition["submittable"] and "condition 'missing' not found" in bad_condition["reason"]


def test_t5_build_campaign_cells_metadata(monkeypatch):
    pair_definitions = [
        {"genes": ["dnaA", "argG"], "pair_class": "class_a"},
        {"genes": ["sameA", "sameB"], "pair_class": "class_invalid"},
        {"genes": ["bioA", "catA1"], "pair_class": "class_b"},
    ]
    monkeypatch.setattr("hf_export.submit_campaign.T5_PAIR_DEFINITIONS", pair_definitions)
    s = _session()

    cells, metadata = build_campaign_cells(s, [TIER_T5], genes=None)

    assert {cell.tier for cell in cells} == {TIER_T5}
    assert {cell.variant_type for cell in cells} == {"multi_gene_knockout"}
    assert len(cells) == 2 * len(T2_CORE_CONDITIONS)
    assert metadata["t5"]["pair_definitions"] == 3
    assert metadata["t5"]["valid_pairs"] == 2
    assert len(metadata["t5"]["invalid_pairs"]) == 1
    assert metadata["t5"]["conditions"] == T2_CORE_CONDITIONS
    assert metadata["t5"]["cells"] == 10
    assert metadata["t5"]["pair_class_counts"] == {"class_a": 1, "class_b": 1}


def test_t5_submit_cell_passes_gene_symbols(monkeypatch):
    s = _session()
    captured = {}

    def fake_create_experiment_record(session, data):
        captured["data"] = data
        return SimpleNamespace(experiment=SimpleNamespace(id=123, condition=data.condition))

    def fake_create_jobs(experiment, request, session):
        captured["request"] = request
        return SimpleNamespace(job_ids=[1, 2])

    monkeypatch.setattr("hf_export.submit_campaign.create_experiment_record", fake_create_experiment_record)
    monkeypatch.setattr("hf_export.submit_campaign.create_simulation_jobs_for_experiment", fake_create_jobs)

    cell = CampaignCell(
        "multi_gene_knockout",
        "dnaA+argG/basal",
        condition="basal",
        params={"genes": ["dnaA", "argG"]},
        tier=TIER_T5,
    )
    plan = plan_cell(s, cell)
    result = submit_cell(s, cell, plan, seeds=2, generations=3)

    assert result == {"experiment_id": 123, "job_ids": [1, 2]}
    assert captured["data"].variant_type == "multi_gene_knockout"
    assert captured["data"].variant_index == 0
    assert captured["data"].gene_symbol == ""
    assert captured["data"].gene_symbols == ["dnaA", "argG"]
    assert captured["request"].seed_values == [0, 1]
    assert captured["request"].generations == 3


def test_campaign_ledger_read_write_and_cell_key_are_stable(tmp_path):
    cell = CampaignCell(
        "wildtype",
        "WT/basal",
        condition="basal",
        params={"sim_params": {"a": 1}},
        tier="T1",
    )
    plan = {
        "variant_type": "wildtype",
        "condition": "basal",
        "variant_index": 0,
        "gene": "",
        "genes": [],
    }
    first = campaign_cell_key(cell, plan, campaign_id="campaign-a", seeds=2, generations=3)
    second = campaign_cell_key(cell, plan, campaign_id="campaign-a", seeds=2, generations=3)
    changed = campaign_cell_key(cell, plan, campaign_id="campaign-a", seeds=3, generations=3)
    assert first == second
    assert first != changed

    ledger_path = tmp_path / "campaign_ledger.jsonl"
    _append_campaign_ledger(
        {
            "cell_key": first,
            "experiment_id": 10,
            "job_ids": [100, 101],
            "status": "submitted",
        },
        ledger_path,
    )
    entries = _read_campaign_ledger(ledger_path)
    assert entries[first]["experiment_id"] == 10
    assert entries[first]["job_ids"] == [100, 101]
