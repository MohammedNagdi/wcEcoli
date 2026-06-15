"""Converter core is unit-testable with a synthetic channel dict — no real simOut needed."""

import numpy as np

from hf_export.converter import build_record, group_path, write_sim
from hf_export.matrix import estimate_counts, v0_campaign


def _synthetic_channels():
    t = np.linspace(0, 3600, 100)
    return {
        "cell_mass": {"time": t, "values": 300 * np.exp(0.0002 * t), "unit": "fg"},
        "growth_rate": {"time": t, "values": np.full_like(t, 0.0002), "unit": "1/s"},
        "mrna_counts": {"time": t, "values": np.linspace(1000, 2000, 100), "unit": "molecules"},
        "not_in_v0": {"time": t, "values": t, "unit": "x"},  # must be ignored
    }


def test_write_sim_and_record(tmp_path):
    import h5py

    path = group_path("basal", "WT", 0, 0)
    summary = {"divided": True, "division_time_sec": 2528.0, "final_mass_fg": 600.0,
               "growth_rate": 0.0002, "doubling_time_min": 47.9}
    with h5py.File(tmp_path / "t.h5", "w") as h5:
        written = write_sim(h5, path, _synthetic_channels(),
                            {"variant_type": "wildtype", "condition": "basal", "seed": 0,
                             "generation": 0, "job_id": 1, **summary})
        assert set(written) == {"cell_mass", "growth_rate", "mrna_counts"}  # not_in_v0 dropped
        grp = h5[path]
        assert grp.attrs["variant_type"] == "wildtype"
        assert grp["cell_mass"]["value"].shape == (100,)
        assert grp["cell_mass"]["value"].attrs["unit"] == "fg"

    rec = build_record(path=path, variant_type="wildtype", condition="basal", genotype="WT",
                       ko_gene="", seed=0, generation=0, job_id=1, channels_written=written,
                       summary=summary, provenance={"experiment_id": 3})
    assert rec["h5_path"] == path and rec["genotype"] == "WT"
    assert rec["divided"] is True and rec["prov_experiment_id"] == 3
    assert rec["channels"] == written


def test_v0_matrix_includes_dynamics():
    cells = v0_campaign(ko_genes=["dnaA", "crp", "manY"])
    variant_types = {c.variant_type for c in cells}
    # Dynamics families present from day one.
    assert "timelines" in variant_types
    assert "sinusoidal_media" in variant_types
    assert "wildtype" in variant_types and "gene_knockout" in variant_types
    counts = estimate_counts(ko_genes_n=50)
    assert counts["cell_trajectories"] == counts["jobs"] * 4  # GENERATIONS
    assert counts["dynamic_jobs"] > 0
