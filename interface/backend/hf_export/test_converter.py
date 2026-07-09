"""Converter core is unit-testable with a synthetic channel dict — no real simOut needed."""

import numpy as np

from hf_export.converter import build_record, group_path, write_matrix_channels, write_sim
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


def test_group_path_is_collision_safe_for_variant_exports():
    first = group_path(
        "basal", "WT", 0, 0,
        variant_type="ppgpp_conc", variant_index=1, experiment_id=10, job_id=100,
    )
    second = group_path(
        "basal", "WT", 0, 0,
        variant_type="ppgpp_conc", variant_index=2, experiment_id=11, job_id=101,
    )

    assert first != second
    assert first == "variant=ppgpp_conc/idx=1/exp=10/job=100/seed=0/gen=0"
    assert second == "variant=ppgpp_conc/idx=2/exp=11/job=101/seed=0/gen=0"


def test_write_matrix_channels(tmp_path):
    import h5py

    t = np.linspace(0, 3600, 50)
    matrices = {
        "mrna_counts_matrix": {"time": t, "matrix": np.random.rand(50, 8).astype("float32"),
                               "ids": [f"RNA{i}" for i in range(8)], "unit": "molecules"},
        "reaction_flux_matrix": {"time": t, "matrix": np.random.rand(50, 5).astype("float32"),
                                 "ids": [f"RXN{i}" for i in range(5)], "unit": "mmol/gDCW/h"},
    }
    path = group_path("basal", "WT", 0, 0)
    with h5py.File(tmp_path / "m.h5", "w") as h5:
        ids = write_matrix_channels(h5, path, matrices)
        grp = h5[path]
        assert grp["mrna_counts_matrix"]["value"].shape == (50, 8)          # full (T, N) tensor
        assert grp["mrna_counts_matrix"]["value"].attrs["n_columns"] == 8
        assert grp["reaction_flux_matrix"]["value"].shape == (50, 5)
        assert ids["mrna_counts_matrix"] == [f"RNA{i}" for i in range(8)]   # ids returned for /reference


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
