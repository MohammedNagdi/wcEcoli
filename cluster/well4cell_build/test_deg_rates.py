"""deg_rates: the floor / ceiling / imputed / determined classification on synthetic arrays, and
`w4c deg-rates` with the simulation-environment child replaced (no Parca cache exists here).

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_deg_rates.py
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from well4cell_build import deg_rates
from well4cell_build.settings import Settings

LN2 = np.log(2)
# Measured half-lives (s) of the mRNA cistrons c0..c2; c3 and c4 are unmeasured; c5 is a tRNA.
CISTRON_HALF_LIFE = np.array([120.0, 600.0, 60.0, np.nan, np.nan, 300.0])
CISTRON_IS_MRNA = np.array([True, True, True, True, True, False])
AVERAGE = 260.0  # the imputation constant (mean of 120, 600, 60)
FLOOR, CEILING = LN2 / 600.0, LN2 / 60.0
# TU -> (cistrons, stored rate 1/s, TU half-life measured, adjustment factor, basal expression)
TUS = {
    "fit[c]": ([0], LN2 / 120.0, False, 1.0, 10.0),            # determined: its own measured cistron
    "floor[c]": ([0, 1], FLOOR, False, 1.0, 5.0),               # NNLS solution on the lower bound
    "floor_noise[c]": ([1], FLOOR * (1 + 1e-12), False, 1.0, 1.0),  # on the bound within the tolerance
    "near_floor[c]": ([0, 1], FLOOR * (1 + 1e-3), False, 1.0, 1.0),  # a real fit just above the bound
    "ceiling[c]": ([2], CEILING, False, 1.0, 3.0),              # clipped to the fastest measured rate
    "imputed[c]": ([3], LN2 / AVERAGE, False, 1.0, 4.0),        # its only cistron was never measured
    "imputed_pair[c]": ([3, 4], LN2 / 200.0, False, 1.0, 2.0),  # all its cistrons unmeasured
    "measured_tu[c]": ([3], FLOOR, True, 1.0, 6.0),             # own TU half-life: a measurement, not the bound
    "adjusted_floor[c]": ([1, 4], 2 * FLOOR, False, 2.0, 7.0),  # on the floor before the Parca doubled it
    "trna[c]": ([5], LN2 / 300.0, False, 1.0, 50.0),            # not an mRNA: never classified
}
EXPECTED = {"fit[c]": "determined", "floor[c]": "floor", "floor_noise[c]": "floor", "near_floor[c]": "determined",
            "ceiling[c]": "ceiling", "imputed[c]": "imputed", "imputed_pair[c]": "imputed",
            "measured_tu[c]": "determined", "adjusted_floor[c]": "floor", "trna[c]": ""}


def inputs() -> dict:
    ids = list(TUS)
    membership = np.zeros((len(CISTRON_HALF_LIFE), len(ids)))
    for j, (cistrons, *_rest) in enumerate(TUS.values()):
        membership[cistrons, j] = 1
    column = lambda k: np.array([spec[k] for spec in TUS.values()])  # noqa: E731
    return {"tu_ids": ids, "is_mrna": np.array([t != "trna[c]" for t in ids]), "deg_rate": column(1),
            "tu_measured": column(2).astype(bool), "cistron_tu": membership, "cistron_half_life_s": CISTRON_HALF_LIFE,
            "cistron_is_mrna": CISTRON_IS_MRNA, "imputation_half_life_s": AVERAGE, "expression": column(4),
            "adjustment": column(3)}


def test_every_mrna_unit_is_classified_exactly_once():
    data = inputs()
    result = deg_rates.classify(data["is_mrna"], data["deg_rate"], data["tu_measured"], data["cistron_tu"],
                                data["cistron_half_life_s"], data["cistron_is_mrna"], data["adjustment"])
    assert dict(zip(data["tu_ids"], result["classes"])) == EXPECTED
    assert result["floor_rate"] == pytest.approx(FLOOR) and result["ceiling_rate"] == pytest.approx(CEILING)
    stacked = np.stack([result["masks"][c] for c in deg_rates.CLASSES])
    assert (stacked.sum(axis=0) == data["is_mrna"].astype(int)).all()


def test_without_undoing_the_adjustment_a_doubled_floor_unit_looks_fitted():
    data = inputs()
    result = deg_rates.classify(data["is_mrna"], data["deg_rate"], data["tu_measured"], data["cistron_tu"],
                                data["cistron_half_life_s"], data["cistron_is_mrna"])
    assert result["classes"][data["tu_ids"].index("adjusted_floor[c]")] == "determined"


def test_tolerance_is_relative():
    data = inputs()
    loose = deg_rates.classify(data["is_mrna"], data["deg_rate"], data["tu_measured"], data["cistron_tu"],
                               data["cistron_half_life_s"], data["cistron_is_mrna"], data["adjustment"], rtol=1e-2)
    assert loose["classes"][data["tu_ids"].index("near_floor[c]")] == "floor"


def test_document_mirrors_cellarium_keys_and_weights_by_basal_mrna_expression():
    data = inputs()
    conditions = {"basal": data["expression"], "other": np.where(data["is_mrna"], 1.0, 0.0)}
    document = deg_rates.provenance(**data, conditions=conditions)
    json.dumps(document)  # serialisable as is
    cellarium = {"n_mrna_units", "rate_floor_as_half_life_min", "rate_ceiling_as_half_life_min",
                 "imputation_constant_min", "on_floor", "on_ceiling", "imputed_average", "not_a_fit",
                 "most_expressed_not_a_fit", "not_a_fit_across_conditions", "units_not_a_fit", "note"}
    assert cellarium <= set(document)
    mrna_total = sum(spec[4] for t, spec in TUS.items() if t != "trna[c]")  # 39: the tRNA's 50 is excluded
    assert document["n_mrna_units"] == 9
    assert document["on_floor"] == {"n_units": 3, "pct_units": round(100 * 3 / 9, 2),
                                    "pct_expression": round(100 * (5 + 1 + 7) / mrna_total, 3)}
    assert document["on_ceiling"]["n_units"] == 1 and document["imputed_average"]["n_units"] == 2
    assert document["not_a_fit"]["n_units"] == 6 and document["determined"]["n_units"] == 3
    assert document["not_a_fit"]["pct_expression"] == round(100 * (5 + 1 + 3 + 4 + 2 + 7) / mrna_total, 3)
    assert document["rate_floor_as_half_life_min"] == 10.0 and document["rate_ceiling_as_half_life_min"] == 1.0
    assert document["imputation_constant_min"] == round(AVERAGE / 60, 6)
    units = document["units_not_a_fit"]
    assert set(units["floor"]) == {"floor[c]", "floor_noise[c]", "adjusted_floor[c]"}
    assert units["imputed"]["imputed[c]"] == round(100 * 4 / mrna_total, 6)
    assert units["determined_is_the_complement"] == 3
    top = document["most_expressed_not_a_fit"]
    assert [u["id"] for u in top] == ["adjusted_floor[c]", "floor[c]", "imputed[c]", "ceiling[c]",
                                      "imputed_pair[c]", "floor_noise[c]"]
    assert top[0] == {"id": "adjusted_floor[c]", "class": "floor", "pct_of_mrna_expression": round(100 * 7 / mrna_total, 4)}
    assert document["adjusted_units"] == {"adjusted_floor[c]": {"factor": 2.0, "class": "floor"}}
    across = document["not_a_fit_across_conditions"]
    assert across["n_conditions"] == 2 and across["max_condition"] == "other" and across["max_pct"] == round(100 * 6 / 9, 3)
    # Cellarium's value-only rule on the stored rates misses the doubled unit and the multi-cistron
    # imputed unit, and counts the measured TU that happens to equal the floor.
    assert document["cellarium_rule"]["floor"] == 3 and document["cellarium_rule"]["imputed"] == 1
    assert "warnings" not in document


def test_inconsistent_imputation_constant_is_reported():
    document = deg_rates.provenance(**{**inputs(), "imputation_half_life_s": 300.0})
    assert "differs from the mean" in document["warnings"][0]


def make_settings(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("WCECOLI_CAMPAIGN_ROOT", str(tmp_path / "campaign"))
    monkeypatch.setenv("W4C_ROOT", str(tmp_path / "w4c"))
    monkeypatch.setenv("W4C_SIM_PYTHON", "sim-python")
    return Settings.from_env()


def fake_child(digest: str):
    def run(settings, cache_dir, out, parca_cache):
        deg_rates.write_json({"parca_cache": parca_cache, "kb_sha256": digest,
                              **deg_rates.provenance(**inputs())}, out)
    return run


def test_cmd_writes_one_file_per_indexed_cache_and_checks_kb_sha256(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    assert settings.sim_python == "sim-python"
    settings.repo_dir.mkdir(parents=True)
    pq.write_table(pa.table({"parca_cache": ["abc", "abc"], "kb_sha256": ["f" * 64] * 2}), settings.index_path)
    kb = settings.out_dir / "parca_cache_abc" / "kb"
    kb.mkdir(parents=True)
    (kb / "simData.cPickle").write_bytes(b"x")
    monkeypatch.setattr(deg_rates, "run_child", fake_child("f" * 64))
    reports = deg_rates.cmd_deg_rates(settings, argparse.Namespace(cache=None))
    out = settings.build_dir / "provenance" / "deg_rates_abc.json"
    assert out.exists() and [r["parca_cache"] for r in reports] == ["abc"]
    units = reports[0]["mrna_units"]
    assert units["floor"] + units["ceiling"] + units["imputed"] == 6
    assert units["floor"] + units["ceiling"] + units["imputed"] + units["determined"] == units["total"]
    monkeypatch.setattr(deg_rates, "run_child", fake_child("0" * 64))
    with pytest.raises(SystemExit, match="the index records"):
        deg_rates.cmd_deg_rates(settings, argparse.Namespace(cache=None))
    assert not out.exists() and out.with_name(out.name + ".mismatch").exists()
