"""Locked v0 perturbation matrix for the wcEcoli HF dataset.

This is the *campaign plan* — what to simulate for the v0 pilot release. The dynamics families are
included from day one so the time-series forecasting benchmark (T3) exists immediately. Counts are
tunable constants so you can dial v0 to your compute budget; the converter packages whatever
completed jobs exist regardless of these numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# --- knobs (set to your compute budget) ---------------------------------------------------------
SEEDS = 8           # stochastic replicates per (genotype, condition)
GENERATIONS = 4     # generations per seed lineage (each yields one cell trajectory)

# WT is cheap, so sweep all conditions; KOs are sampled over a core condition set.
WT_CONDITIONS = [
    "basal", "glc_20mM", "glc_5mM", "glc_2mM", "with_aa", "acetate", "succinate",
    "no_oxygen", "fumarate", "malate", "no_glucose", "minus_calcium", "minus_magnesium",
    "minus_phosphate", "plus_arabinose", "plus_gallate", "plus_indole", "plus_nitrate",
    "plus_nitrite", "plus_quercetin",
]
KO_CORE_CONDITIONS = ["basal", "glc_20mM", "acetate", "succinate", "with_aa"]

# ~50 curated knockouts. Selection criterion (resolved from the DB at campaign time):
#   1. all knockout-ready ESSENTIAL genes (richest phenotypes), then
#   2. a stratified sample across functional categories to fill to KO_TARGET.
KO_TARGET = 50

# Dynamics from day one — time-varying media (the T3 forecasting axis).
DYNAMIC_RUNS = [
    {"variant_type": "timelines", "label": "rich_to_minimal",
     "params": {"events": "0 minimal_plus_amino_acids, 1200 minimal"}},
    {"variant_type": "timelines", "label": "minimal_to_acetate",
     "params": {"events": "0 minimal, 1200 minimal_acetate"}},
    {"variant_type": "timelines", "label": "glucose_starvation",
     "params": {"events": "0 minimal_glucose, 1800 minimal_no_glucose"}},
    {"variant_type": "sinusoidal_media", "label": "sinusoidal_glc_acetate",
     "params": {"media_a": "minimal_glucose", "media_b": "minimal_acetate", "period_min": 30}},
]
DYNAMIC_GENOTYPES = ["WT"]  # + a few KOs in v1


@dataclass
class CampaignCell:
    variant_type: str
    label: str
    condition: str | None = None
    params: dict = field(default_factory=dict)
    seeds: int = SEEDS
    generations: int = GENERATIONS


def v0_campaign(ko_genes: list[str]) -> list[CampaignCell]:
    """Expand the locked v0 matrix into experiment descriptors. ``ko_genes`` is the resolved
    curated knockout list (see selection criterion above)."""
    cells: list[CampaignCell] = []
    # 1. Wildtype baseline across all conditions (static).
    for cond in WT_CONDITIONS:
        cells.append(CampaignCell("wildtype", f"WT/{cond}", condition=cond))
    # 2. Curated single knockouts across core conditions.
    for gene in ko_genes[:KO_TARGET]:
        for cond in KO_CORE_CONDITIONS:
            cells.append(CampaignCell("gene_knockout", f"{gene}_KO/{cond}", condition=cond,
                                      params={"gene": gene}))
    # 3. Dynamic-media runs (day-one dynamics benchmark).
    for run in DYNAMIC_RUNS:
        for geno in DYNAMIC_GENOTYPES:
            cells.append(CampaignCell(run["variant_type"], f"{geno}/{run['label']}",
                                      params=run["params"]))
    return cells


def estimate_counts(ko_genes_n: int) -> dict[str, int]:
    """Rough job/trajectory counts for budgeting."""
    wt_jobs = len(WT_CONDITIONS) * SEEDS
    ko_jobs = min(ko_genes_n, KO_TARGET) * len(KO_CORE_CONDITIONS) * SEEDS
    dyn_jobs = len(DYNAMIC_RUNS) * len(DYNAMIC_GENOTYPES) * SEEDS
    jobs = wt_jobs + ko_jobs + dyn_jobs
    return {
        "jobs": jobs,
        "cell_trajectories": jobs * GENERATIONS,
        "wt_jobs": wt_jobs, "ko_jobs": ko_jobs, "dynamic_jobs": dyn_jobs,
    }
