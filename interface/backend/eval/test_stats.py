"""Statistics primitives validated against known/closed-form values."""

import math

import pytest

from eval.stats import cohen_weighted_kappa, holm, mcnemar_exact, paired_bootstrap_diff, wilson


def test_cohen_weighted_kappa():
    assert cohen_weighted_kappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) == 1.0   # perfect agreement
    assert cohen_weighted_kappa([3, 3, 3], [3, 3, 3]) == 1.0               # no variance -> 1.0
    assert cohen_weighted_kappa([1, 2, 4, 5], [5, 4, 2, 1]) < -0.5         # systematic reversal
    assert cohen_weighted_kappa([5, 5, 1, 1, 5], [4, 5, 2, 1, 4]) > 0.6    # off-by-one stays high
    with pytest.raises(ValueError):
        cohen_weighted_kappa([1, 2], [1])


def test_wilson_known_values():
    # 0/10: lower bound 0, upper bound ~0.278 (classic Wilson value).
    p = wilson(0, 10)
    assert p.lo == 0.0 and abs(p.hi - 0.2775) < 0.005
    # 10/10: upper bound 1, lower ~0.722 (symmetric).
    p = wilson(10, 10)
    assert abs(p.hi - 1.0) < 1e-9 and abs(p.lo - 0.7224) < 0.005   # analytically 1.0 (float epsilon)
    # 23/30 (a real model score) -> point 0.767, CI roughly [0.59, 0.89].
    p = wilson(23, 30)
    assert abs(p.p - 0.7667) < 1e-3 and p.lo < 0.62 and p.hi > 0.87


def test_mcnemar_exact():
    assert mcnemar_exact(0, 0) == 1.0          # no discordant pairs
    assert abs(mcnemar_exact(0, 10) - (2 * 0.5 ** 10)) < 1e-9   # all discordant one way
    assert mcnemar_exact(5, 5) == 1.0          # symmetric discordance -> not significant
    # 10 vs 0 discordant is highly significant; 1 vs 8 less so but < 0.05.
    assert mcnemar_exact(8, 1) < 0.05
    assert mcnemar_exact(6, 6) > 0.5


def test_paired_bootstrap_diff():
    # Near-tie WITH discordance (a wins items 22,23; b wins 24,25) -> equal sums, CI straddles 0.
    a = [1] * 24 + [0] * 6                       # passes 0..23
    b = [1] * 22 + [0, 0] + [1, 1] + [0] * 4     # passes 0..21, 24, 25
    assert sum(a) == sum(b) == 24
    diff, lo, hi = paired_bootstrap_diff(a, b, n_boot=4000, seed=1)
    assert abs(diff) < 1e-9 and lo < 0 < hi      # a statistical tie

    # A real difference -> CI excludes 0.
    d2, lo2, hi2 = paired_bootstrap_diff([1] * 30, [0] * 30, n_boot=1000, seed=1)
    assert d2 == 1.0 and lo2 > 0.9


def test_holm_monotone_and_correct():
    adj = holm({"x": 0.01, "y": 0.04, "z": 0.04})
    # 3 tests: smallest *3, next *2, next *1, enforced non-decreasing.
    assert abs(adj["x"] - 0.03) < 1e-9
    assert adj["y"] >= adj["x"] and adj["z"] >= adj["y"]
    assert adj["y"] <= 1.0 and adj["z"] <= 1.0
