"""Perturbation parsing on literal examples taken from real campaign runs.

    PYTHONPATH=cluster $W4C_PYTHON -m pytest -q cluster/well4cell_build/test_index.py
"""

from __future__ import annotations

import json

import pytest

from well4cell_build import index
from well4cell_build import perturbation as pert

GENES = [("argG", "EG10068", 2042), ("pfkA", "EG10699", 1594), ("pfkB", "EG10700", 2073),
         ("insI2", "G0-10000", 3000), ("insI2", "G0-10001", 3001)]


@pytest.fixture(scope="module")
def tables():
    return pert.load_tables(GENES)


def md(timeline="0 minimal", **extra):
    return {"timeline": timeline, "seed": 0, **extra}


def test_timeline_parse_and_medium_at():
    schedule = pert.parse_timeline("0 minimal, 1200 minimal_acetate")
    assert schedule == [(0, "minimal"), (1200, "minimal_acetate")]
    assert pert.medium_at(schedule, 0) == "minimal"
    assert pert.medium_at(schedule, 1199.0) == "minimal"
    assert pert.medium_at(schedule, 1200.0) == "minimal_acetate"
    assert pert.medium_at(schedule, 5000) == "minimal_acetate"
    assert pert.format_timeline(schedule) == "0 minimal, 1200 minimal_acetate"
    assert pert.medium_at(None, 10) is None
    with pytest.raises(pert.PerturbationError):
        pert.parse_timeline("600 minimal")
    with pytest.raises(pert.PerturbationError):
        pert.parse_timeline("")


def test_names_and_tiers():
    assert pert.tier_of("[T2_CORE] argG_KO/basal") == "T2"
    assert pert.cell_id_for("[T2_CORE] argG_KO/basal") == "T2/argG_KO/basal"
    assert pert.cell_id_for("[T3] argG_KO/rich_to_minimal") == "T3/argG_KO/rich_to_minimal"
    assert pert.cell_id_for("[T5] pfkA+pfkB/basal") == "T5/pfkA+pfkB/basal"
    with pytest.raises(pert.PerturbationError):
        pert.tier_of("WT/basal")


def test_termination_class():
    assert pert.termination_class(False, "NegativeCountsError: x") == "none"
    assert pert.termination_class(True, "NegativeCountsError: ATP[c] in PolypeptideElongation (-886)") == "negative_counts"
    assert pert.termination_class(True, "TimeLimitReached: Time limit") == "time_limit"
    assert pert.termination_class(True, "FBASolveFailed: GLP_ENOPFS") == "fba_infeasible"
    assert pert.termination_class(True, "EquilibriumUnstable: Have") == "equilibrium_unstable"
    assert pert.termination_class(True, "SomethingElse") == "other"


def test_wildtype_static_and_shift(tables):
    p = pert.derive("wildtype", 0, {}, md("0 minimal, 1200 minimal_no_glucose"), "Wildtype simulation, operons\n", tables)
    assert p.variant == "wildtype" and p.media_schedule == [(0, "minimal"), (1200, "minimal_no_glucose")]
    assert p.knockout_genes is None


def test_gene_knockout(tables):
    exp = {"gene_symbol": "argG"}
    p = pert.derive("gene_knockout", 2042, exp, md("0 minimal_plus_amino_acids, 1200 minimal"),
                    "Complete knockout of TU0-5501[c]., operons\n", tables)
    assert p.variant == "argG"
    assert p.knockout_genes == ["argG"] and p.knockout_gene_ids == ["EG10068"] and p.knockout_tu_ids == ["TU0-5501[c]"]
    assert p.timeline == "0 minimal_plus_amino_acids, 1200 minimal"
    with pytest.raises(pert.PerturbationError):
        pert.derive("gene_knockout", 2042, exp, md(), "Complete knockout of TU0-9999[c]., operons", tables)


def test_duplicate_symbol_resolved_by_ko_index(tables):
    assert tables.gene_id("insI2", 3001) == "G0-10001"
    with pytest.raises(pert.PerturbationError):
        tables.ko_index_of("insI2")


def test_multi_gene_knockout(tables):
    exp = {"gene_symbol": "pfkA,pfkB",
           "sim_params": json.dumps({"multi_gene_knockout": {"gene_symbols": ["pfkA", "pfkB"], "ko_indices": [1594, 2073]}})}
    text = "Complete knockout of 2 KO targets by KO index: 1594, 2073., operons\n"
    p = pert.derive("multi_gene_knockout", 0, exp, md(multi_ko_indices=[1594, 2073]), text, tables)
    assert p.variant == "pfkA+pfkB"
    assert p.knockout_genes == ["pfkA", "pfkB"] and p.knockout_gene_ids == ["EG10699", "EG10700"]
    assert p.knockout_tu_ids == ["TU0-14813[c]", "TU0-6408[c]"]
    with pytest.raises(pert.PerturbationError):
        pert.derive("multi_gene_knockout", 0, exp, md(multi_ko_indices=[1594, 2074]), text, tables)


def test_tf_activity_uses_sorted_tf_ids_not_the_db_name(tables):
    # "[T4] araC/active" is variant index 1, which ran CPLX-125 = trpR.
    p = pert.derive("tf_activity", 1, {"condition": "plus_arabinose"}, md(),
                    "Simulation of phenotype CPLX-125__active., operons\n", tables)
    assert (p.tf_target, p.tf_target_id, p.tf_state) == ("trpR", "CPLX-125", "active")
    assert p.media_schedule == [(0, "minimal_plus_amino_acids")]
    assert pert.cell_id_for("[T4] araC/active", p) == "T4/trpR/active"
    q = pert.derive("tf_activity", 38, {}, md(), "Simulation of phenotype PHOSPHO-ARCA__inactive., operons", tables)
    assert (q.tf_target, q.tf_state) == ("arcA", "inactive")
    with pytest.raises(pert.PerturbationError):
        pert.derive("tf_activity", 3, {}, md(), "Simulation of phenotype CPLX-125__active., operons", tables)


def test_ppgpp_conc(tables):
    p = pert.derive("ppgpp_conc", 0, {}, md(), "ppGpp conc adjusted by 0.2x to 9.833114188181234 uM in basal., operons\n", tables)
    assert p.ppgpp_factor == pytest.approx(0.2) and p.ppgpp_setpoint_um == pytest.approx(9.833114188181234)
    assert p.media_schedule == [(0, "minimal")]
    q = pert.derive("ppgpp_conc", 19, {}, md(), "ppGpp conc adjusted by 2x to 98.33114188181234 uM in with_aa., operons", tables)
    assert q.ppgpp_factor == 2 and q.media_schedule == [(0, "minimal_plus_amino_acids")]
    r = pert.derive("ppgpp_conc", 4, {}, md(), "ppGpp conc adjusted by 1x to 49.16557094090617 uM in basal., operons", tables)
    assert r.ppgpp_factor == 1
    with pytest.raises(pert.PerturbationError):
        pert.derive("ppgpp_conc", 1, {}, md(), "ppGpp conc adjusted by 0.2x to 9.8 uM in basal., operons", tables)


def test_sinusoidal(tables):
    exp = {"sim_params": json.dumps({"sinusoidal_media": {"SINE_MEDIA_A": "minimal", "SINE_MEDIA_B": "minimal_acetate"}})}
    p = pert.derive("sinusoidal_media", 15, exp, md(), "Sinusoidal media: period 15min, minimal <-> minimal_acetate, operons\n", tables)
    assert (p.media_a, p.media_b, p.period_sec) == ("minimal", "minimal_acetate", 900)
    assert p.media_schedule is None and p.timeline is None
    with pytest.raises(pert.PerturbationError):
        pert.derive("sinusoidal_media", 30, exp, md(), "Sinusoidal media: period 15min, minimal <-> minimal_acetate", tables)


def test_add_one_aa_shift(tables):
    p = pert.derive("add_one_aa_shift", 0, {}, md(), "Add L-ALPHA-ALANINE to minimal media., operons\n", tables)
    assert p.media_schedule == [(0, "minimal"), (600, "minimal_plus_L-ALPHA-ALANINE")] and p.aa_shift == "+L-ALPHA-ALANINE"
    c = pert.derive("add_one_aa_shift", 19, {}, md(), "Minimal media control, operons", tables)
    assert c.media_schedule == [(0, "minimal")] and c.aa_shift == "control"
    v = pert.derive("add_one_aa_shift", 20, {}, md(), "Add VAL to minimal media., operons", tables)
    assert v.aa_shift == "+VAL"


def test_remove_one_aa_shift(tables):
    p = pert.derive("remove_one_aa_shift", 1, {}, md(), "Remove ARG from rich media., operons", tables)
    assert p.media_schedule == [(0, "minimal_plus_amino_acids"), (600, "minimal_plus_amino_acids_minus_ARG")]
    assert p.aa_shift == "-ARG"
    c = pert.derive("remove_one_aa_shift", 19, {}, md(), "Minimal media with amino acids control, operons", tables)
    assert c.media_schedule == [(0, "minimal_plus_amino_acids")]


@pytest.mark.parametrize("i, text, schedule, label", [
    (0, "Minimal media with amino acids control, operons", [(0, "minimal_plus_amino_acids")], "control_rich"),
    (1, "Remove 8 AAs from rich media., operons", [(0, "minimal_plus_amino_acids"), (600, "minimal_plus_12_amino_acids")], "rich->12aa"),
    (2, "Remove 14 AAs from rich media., operons", [(0, "minimal_plus_amino_acids"), (600, "minimal_plus_6_amino_acids")], "rich->6aa"),
    (3, "Minimal media with no amino acids, operons", [(0, "minimal")], "control_minimal"),
    (4, "Remove all but L-ALPHA-ALANINE from rich media, operons", [(0, "minimal_plus_amino_acids"), (600, "minimal_plus_L-ALPHA-ALANINE")], "rich->only_L-ALPHA-ALANINE"),
    (8, "Remove all but GLT from rich media, operons", [(0, "minimal_plus_amino_acids"), (600, "minimal_plus_GLT")], "rich->only_GLT"),
    (22, "Remove all but VAL from rich media, operons", [(0, "minimal_plus_amino_acids"), (600, "minimal_plus_VAL")], "rich->only_VAL"),
    (23, "Remove all amino acids from rich media, operons", [(0, "minimal_plus_amino_acids"), (600, "minimal")], "rich->minimal"),
])
def test_remove_aas_shift(tables, i, text, schedule, label):
    p = pert.derive("remove_aas_shift", i, {}, md(), text, tables)
    assert p.media_schedule == schedule and p.aa_shift == label


def test_splits_are_deterministic_and_hold_out_genes():
    lineages = [("single_knockout", "T2/g{}_KO/basal".format(c), "T2/g{}_KO/basal/s{}".format(c, s))
                for c in range(50) for s in range(8)]
    a = index.lineage_splits(lineages, 7)
    assert a == index.lineage_splits(lineages, 7)
    counts = {k: list(a.values()).count(k) for k in ("train", "val", "test")}
    assert counts == {"train": 320, "val": 40, "test": 40}
    genes = {"g{}".format(i) for i in range(100)}
    by_gene = index.gene_splits(genes, 7)
    assert sorted(by_gene.values()).count("test") == 10
    held = next(g for g, s in by_gene.items() if s == "test")
    train = next(g for g, s in by_gene.items() if s == "train")
    assert index.row_gene_split([train, held], by_gene) == "test"
    assert index.row_gene_split(None, by_gene) == "train"


def test_sim_options_hash_ignores_per_run_keys():
    h1, _ = index.sim_options({"seed": 0, "time": "a", "description": "x", "variant": "wildtype", "trna_charging": True,
                               "git_hash": "aa", "timeline": "0 minimal"})
    h2, _ = index.sim_options({"seed": 5, "time": "b", "description": "y", "variant": "gene_knockout", "trna_charging": True,
                               "git_hash": "bb", "timeline": "0 minimal_acetate", "multi_ko_indices": [1, 2]})
    h3, _ = index.sim_options({"trna_charging": False})
    assert h1 == h2 != h3


def test_families_are_in_tier_order():
    from well4cell_build.settings import FAMILIES, FAMILY_BY_TIER
    assert FAMILIES == [FAMILY_BY_TIER["T{}".format(k)] for k in range(1, 6)]
    assert FAMILIES == ["wildtype_media", "single_knockout", "dynamic_media", "regulation", "double_knockout"]
