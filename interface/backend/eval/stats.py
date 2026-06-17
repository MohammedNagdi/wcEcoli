"""Statistics primitives for the eval analysis — correct small-sample methods, stdlib only.

No normal-approximation hand-waving: proportions use the **Wilson score interval** (accurate at small
n and near 0/1), paired model comparisons use **McNemar's exact test** (the items are the same across
models), differences use a **paired bootstrap**, and multiple comparisons use **Holm–Bonferroni**.
Every function is unit-tested against known values in test_stats.py.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass


@dataclass(frozen=True)
class Proportion:
    k: int            # successes
    n: int            # trials
    p: float          # point estimate k/n
    lo: float         # Wilson 95% CI lower
    hi: float         # Wilson 95% CI upper

    def pct(self) -> str:
        return f"{self.p * 100:.0f}% [{self.lo * 100:.0f}, {self.hi * 100:.0f}]"


def wilson(k: int, n: int, z: float = 1.959963984540054) -> Proportion:
    """Wilson score confidence interval for a binomial proportion (default 95%)."""
    if n == 0:
        return Proportion(0, 0, float("nan"), float("nan"), float("nan"))
    p = k / n
    z2 = z * z
    denom = 1 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom
    return Proportion(k, n, p, max(0.0, center - half), min(1.0, center + half))


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value for paired binary outcomes.

    b = # items where model A passed and B failed; c = # where A failed and B passed.
    Concordant pairs are ignored. Exact binomial test on the discordant pairs (p=0.5).
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) * (0.5 ** n)
    return min(1.0, 2.0 * tail)


def paired_bootstrap_diff(a: list[int], b: list[int], *, n_boot: int = 10000, seed: int = 0,
                          alpha: float = 0.05) -> tuple[float, float, float]:
    """Bootstrap CI for the paired difference in pass-rate (mean(a) - mean(b)) over the SAME items.

    Resamples item indices with replacement (preserving pairing). Returns (diff, lo, hi).
    """
    if len(a) != len(b) or not a:
        raise ValueError("paired arrays must be equal length and non-empty")
    n = len(a)
    diff = sum(a) / n - sum(b) / n
    rng = random.Random(seed)
    diffs = []
    for _ in range(n_boot):
        idx = [rng.randrange(n) for _ in range(n)]
        da = sum(a[i] for i in idx) / n
        db = sum(b[i] for i in idx) / n
        diffs.append(da - db)
    diffs.sort()
    lo = diffs[int((alpha / 2) * n_boot)]
    hi = diffs[int((1 - alpha / 2) * n_boot) - 1]
    return diff, lo, hi


def bootstrap_mean_ci(values: list[float], *, n_boot: int = 10000, seed: int = 0,
                      alpha: float = 0.05) -> tuple[float, float, float]:
    """Percentile bootstrap CI for the mean of per-item values (the item is the resampling unit).

    Use for multi-sample runs: each value is one item's pass-fraction across repeats, so the CI
    reflects between-item variance without pseudo-replicating the within-item samples.
    """
    if not values:
        return float("nan"), float("nan"), float("nan")
    n = len(values)
    point = sum(values) / n
    rng = random.Random(seed)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(n_boot))
    return point, means[int((alpha / 2) * n_boot)], means[int((1 - alpha / 2) * n_boot) - 1]


def holm(pvalues: dict[str, float]) -> dict[str, float]:
    """Holm–Bonferroni step-down adjusted p-values for a family of comparisons."""
    items = sorted(pvalues.items(), key=lambda kv: kv[1])
    m = len(items)
    adjusted: dict[str, float] = {}
    running = 0.0
    for rank, (key, p) in enumerate(items):
        adj = min(1.0, (m - rank) * p)
        running = max(running, adj)  # enforce monotonicity
        adjusted[key] = running
    return adjusted
