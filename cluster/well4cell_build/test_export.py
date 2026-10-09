"""Unit tests for the export stride rule, packing, QC gates and stats.

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_export.py
"""

import numpy as np
import pytest

from well4cell_build.export import n_rows_after_stride, pack, qc_trajectory, stride_rows
from well4cell_build.settings import MATRIX_CHANNELS, SCALAR_CHANNELS
from well4cell_build.stats import Moments


# -- stride ---------------------------------------------------------------------

@pytest.mark.parametrize("n,stride,expected", [
    (0, 10, []),
    (1, 10, [0]),
    (10, 10, [0, 9]),
    (11, 10, [0, 10]),
    (12, 10, [0, 10, 11]),
    (21, 10, [0, 10, 20]),
    (5, 1, [0, 1, 2, 3, 4]),
    (2, 10, [0, 1]),
])
def test_stride_rows(n, stride, expected):
    assert stride_rows(n, stride).tolist() == expected
    assert n_rows_after_stride(n, stride) == len(expected)


@pytest.mark.parametrize("stride", [1, 3, 10])
def test_stride_count_matches_rows(stride):
    for n in range(0, 200):
        rows = stride_rows(n, stride)
        assert len(rows) == n_rows_after_stride(n, stride)
        if n:
            assert rows[0] == 0 and rows[-1] == n - 1
            assert np.all(np.diff(rows) > 0)
            assert all(r % stride == 0 for r in rows[:-1])


def test_pack_never_empty_and_respects_target():
    samples = [{"sample_id": str(i), "n_steps": 100} for i in range(10)]
    parts = pack(samples, bytes_per_row=10, stride=1, target_bytes=2500)  # 1000 bytes each
    assert [len(p) for p in parts] == [2, 2, 2, 2, 2]
    assert pack(samples[:1], 10, 1, 1) == [samples[:1]]  # oversized sample still gets a part
    assert [s for p in parts for s in p] == samples


# -- QC -------------------------------------------------------------------------

N = 25


def good(n=N, t0=100):
    time = np.arange(t0, t0 + n, dtype=np.float32)
    scalars = {c: np.full(n, 3.0, dtype=np.float32) for c in SCALAR_CHANNELS}
    scalars["growth_rate"][0] = np.nan
    matrices = {
        "mrna_counts_matrix": np.ones((n, 4), np.float32),
        "protein_counts_matrix": np.zeros((n, 3), np.float32),
        "reaction_flux_matrix": np.full((n, 5), -5e-7, np.float32),
        "exchange_flux_matrix": np.full((n, 2), -40.0, np.float32),
    }
    sizes = {"mrna_counts_matrix": 4, "protein_counts_matrix": 3, "reaction_flux_matrix": 5, "exchange_flux_matrix": 2}
    return time, scalars, matrices, sizes


def reasons(**overrides):
    time, scalars, matrices, sizes = good()
    kwargs = dict(time_axis=time, n_steps_expected=N, scalars=scalars, matrices=matrices,
                  matrix_times={m: time for m in matrices}, reference_hash="abc", expected_hash="abc",
                  reference_sizes=sizes)
    for key, mutate in overrides.items():
        mutate(kwargs)
    return qc_trajectory(**kwargs)


def test_qc_passes_clean_trajectory():
    assert reasons() == []


def test_qc_growth_rate_nan_at_row0_is_fine_but_not_later():
    def nan_later(k):
        k["scalars"]["growth_rate"][7] = np.nan
    assert any("growth_rate NaN" in r for r in reasons(x=nan_later))

    def no_nan(k):
        k["scalars"]["growth_rate"][0] = 0.1
    assert reasons(x=no_nan) == []


def test_qc_n_steps_mismatch():
    def wrong(k):
        k["n_steps_expected"] = N + 1
    assert any("n_steps" in r for r in reasons(x=wrong))


def test_qc_time_gap_and_repeat():
    def gap(k):
        t = k["time_axis"].copy(); t[10:] += 1; k["time_axis"] = t
        k["matrix_times"] = {m: t for m in k["matrices"]}
    assert any("increasing by 1" in r for r in reasons(x=gap))

    def repeat(k):
        t = k["time_axis"].copy(); t[5] = t[4]; k["time_axis"] = t
        k["matrix_times"] = {m: t for m in k["matrices"]}
    assert any("increasing by 1" in r for r in reasons(x=repeat))


def test_qc_counts_negative_and_fractional():
    def neg(k):
        k["scalars"]["n_oric"][3] = -1
    assert any("n_oric negative" in r for r in reasons(x=neg))

    def frac(k):
        k["scalars"]["mrna_counts"][3] = 2.5
    assert any("mrna_counts not integral" in r for r in reasons(x=frac))

    def mneg(k):
        k["matrices"]["protein_counts_matrix"][2, 1] = -3
    assert any("protein_counts_matrix negative" in r for r in reasons(x=mneg))

    def mfrac(k):
        k["matrices"]["mrna_counts_matrix"][2, 1] = 0.5
    assert any("mrna_counts_matrix not integral" in r for r in reasons(x=mfrac))

    def mnan(k):
        k["matrices"]["mrna_counts_matrix"][2, 1] = np.nan
    assert any("mrna_counts_matrix" in r for r in reasons(x=mnan))


def test_qc_reaction_flux_tolerance():
    def below(k):
        k["matrices"]["reaction_flux_matrix"][4, 0] = -2e-6
    assert any("reaction_flux_matrix" in r for r in reasons(x=below))
    # exchange flux may be negative (uptake): already -40 in the clean trajectory
    assert reasons() == []


def test_qc_reference_hash_and_columns():
    def other(k):
        k["reference_hash"] = "zzz"
    assert any("reference hash" in r for r in reasons(x=other))

    def cols(k):
        k["reference_sizes"] = dict(k["reference_sizes"], mrna_counts_matrix=99)
    assert any("columns" in r for r in reasons(x=cols))


def test_qc_missing_channel_and_short_matrix():
    def missing(k):
        del k["scalars"]["ppgpp_conc"]
    assert any("ppgpp_conc missing" in r for r in reasons(x=missing))

    def short(k):
        k["matrices"]["exchange_flux_matrix"] = k["matrices"]["exchange_flux_matrix"][:-1]
    assert any("exchange_flux_matrix shape" in r for r in reasons(x=short))


def test_qc_only_checks_matrices_present_in_config():
    def core(k):
        k["matrices"] = {}
    assert reasons(x=core) == []


# -- stats ----------------------------------------------------------------------

def test_moments_ignore_nan_and_merge(tmp_path):
    a = Moments(); b = Moments()
    a.add("g", np.array([np.nan, 1.0, 2.0], np.float32))
    a.add("m", np.array([[1, 2], [3, 4]], np.float32))
    b.add("g", np.array([3.0]))
    b.add("m", np.array([[5, -6]]))
    a.merge(b)
    a.save(tmp_path / "x.npz")
    c = Moments.load(tmp_path / "x.npz")
    assert c.names == ["g", "m"]
    assert c.data["g"]["n"].tolist() == [3] and c.data["g"]["sum"].tolist() == [6]
    assert c.data["g"]["sumsq"].tolist() == [14]
    assert c.data["m"]["min"].tolist() == [1, -6] and c.data["m"]["max"].tolist() == [5, 4]
    assert c.summary("g")["mean"].tolist() == [2.0]
