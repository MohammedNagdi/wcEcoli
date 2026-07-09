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

TIER_V0 = "v0"
TIER_T2_CORE = "T2_CORE"
TIER_T2_EXTENDED = "T2_EXTENDED"
TIER_T3 = "T3"
TIER_T4 = "T4"
TIER_T5 = "T5"
SUPPORTED_TIERS = {TIER_V0, TIER_T2_CORE, TIER_T2_EXTENDED, TIER_T3, TIER_T4, TIER_T5}

# WT is cheap, so sweep all conditions; KOs are sampled over a core condition set.
WT_CONDITIONS = [
    "basal", "glc_20mM", "glc_5mM", "glc_2mM", "with_aa", "acetate", "succinate",
    "no_oxygen", "fumarate", "malate", "no_glucose", "minus_calcium", "minus_magnesium",
    "minus_phosphate", "plus_arabinose", "plus_gallate", "plus_indole", "plus_nitrate",
    "plus_nitrite", "plus_quercetin", "plus_tungstate",
]
KO_CORE_CONDITIONS = ["basal", "glc_20mM", "acetate", "succinate", "with_aa"]
T2_CORE_CONDITIONS = KO_CORE_CONDITIONS
T2_EXTENDED_CONDITIONS = WT_CONDITIONS

# ~50 curated knockouts. Selection criterion (resolved from the DB at campaign time):
#   1. all knockout-ready ESSENTIAL genes (richest phenotypes), then
#   2. a stratified sample across functional categories to fill to KO_TARGET.
KO_TARGET = 50
T2_CORE_NONESSENTIAL_PER_CATEGORY = 10
T2_EXTENDED_ESSENTIAL_TARGET = 100
T2_EXTENDED_NONESSENTIAL_PER_CATEGORY = 5
T3_ESSENTIAL_TARGET = 50
T3_NONESSENTIAL_TARGET = 50

# Dynamics from day one — time-varying media (the T3 forecasting axis).
DYNAMIC_RUNS = [
    {"variant_type": "timelines", "label": "rich_to_minimal",
     "params": {"events": "0 minimal_plus_amino_acids, 1200 minimal"}},
    {"variant_type": "timelines", "label": "minimal_to_acetate",
     "params": {"events": "0 minimal, 1200 minimal_acetate"}},
    {"variant_type": "timelines", "label": "glucose_starvation",
     "params": {"events": "0 minimal, 1200 minimal_no_glucose"}},
    {"variant_type": "sinusoidal_media", "label": "sinusoidal_glc_acetate",
     "params": {"media_a": "minimal_glucose", "media_b": "minimal_acetate", "period_min": 30}},
]
DYNAMIC_GENOTYPES = ["WT"]  # + a few KOs in v1

T3_TIMELINE_PROTOCOLS = [
    {"label": "rich_to_minimal", "events": "0 minimal_plus_amino_acids, 1200 minimal"},
    {"label": "minimal_to_acetate", "events": "0 minimal, 1200 minimal_acetate"},
    {"label": "glucose_starvation", "events": "0 minimal, 1200 minimal_no_glucose"},
    {"label": "phosphate_depletion", "events": "0 minimal, 2400 minimal_minus_phosphate"},
    {"label": "cut_oxygen", "events": "0 minimal, 1200 minimal_minus_oxygen"},
    {"label": "add_amino_acids", "events": "0 minimal, 1200 minimal_plus_amino_acids"},
]
T3_SINUSOIDAL_MEDIA_PAIRS = [
    ("minimal", "minimal_acetate"),
    ("minimal", "minimal_plus_amino_acids"),
    ("minimal_GLC_2mM", "minimal_GLC_20mM"),
]
T3_SINUSOIDAL_PERIODS_MIN = [15, 30, 60, 120]
T3_AA_SHIFT_VARIANTS = {
    "add_one_aa_shift": range(0, 21),
    "remove_one_aa_shift": range(0, 21),
    "remove_aas_shift": range(0, 24),
}
T5_PAIR_DEFINITIONS = [
    {"genes": ["pfkA", "pfkB"], "pair_class": "redundant_central_carbon"},
    {"genes": ["pykF", "pykA"], "pair_class": "redundant_central_carbon"},
    {"genes": ["tktA", "tktB"], "pair_class": "redundant_central_carbon"},
    {"genes": ["talA", "talB"], "pair_class": "redundant_central_carbon"},
    {"genes": ["fumA", "fumB"], "pair_class": "redundant_central_carbon"},
    {"genes": ["fumA", "fumC"], "pair_class": "redundant_central_carbon"},
    {"genes": ["fumB", "fumC"], "pair_class": "redundant_central_carbon"},
    {"genes": ["nuoA", "ndh"], "pair_class": "energy_respiration"},
    {"genes": ["cyoA", "cydA"], "pair_class": "energy_respiration"},
    {"genes": ["nrdA", "nrdD"], "pair_class": "nucleotide_metabolism"},
    {"genes": ["nrdB", "nrdG"], "pair_class": "nucleotide_metabolism"},
    {"genes": ["sodA", "sodB"], "pair_class": "stress_global_robustness"},
    {"genes": ["katE", "katG"], "pair_class": "stress_global_robustness"},
    {"genes": ["rpoS", "crp"], "pair_class": "stress_global_robustness"},
    {"genes": ["fis", "ihfA"], "pair_class": "stress_global_robustness"},
    {"genes": ["hupA", "hupB"], "pair_class": "stress_global_robustness"},
    {"genes": ["ackA", "pta"], "pair_class": "central_carbon_assimilation"},
    {"genes": ["pfkA", "pykF"], "pair_class": "central_carbon_assimilation"},
    {"genes": ["gdhA", "gltB"], "pair_class": "central_carbon_assimilation"},
    {"genes": ["thrA", "metL"], "pair_class": "amino_acid_biosynthesis"},
    {"genes": ["thrA", "lysC"], "pair_class": "amino_acid_biosynthesis"},
    {"genes": ["metL", "lysC"], "pair_class": "amino_acid_biosynthesis"},
    {"genes": ["ilvB", "ilvI"], "pair_class": "amino_acid_biosynthesis"},
    {"genes": ["crp", "cyaA"], "pair_class": "regulatory_coupling"},
    {"genes": ["crp", "malT"], "pair_class": "regulatory_coupling"},
    {"genes": ["crp", "araC"], "pair_class": "regulatory_coupling"},
    {"genes": ["crp", "lacI"], "pair_class": "regulatory_coupling"},
    {"genes": ["fis", "crp"], "pair_class": "regulatory_coupling"},
    {"genes": ["recA", "recB"], "pair_class": "dna_repair"},
    {"genes": ["recA", "uvrA"], "pair_class": "dna_repair"},
    {"genes": ["uvrA", "uvrB"], "pair_class": "dna_repair"},
    {"genes": ["uvrB", "uvrC"], "pair_class": "dna_repair"},
    {"genes": ["mutS", "mutL"], "pair_class": "dna_repair"},
    {"genes": ["pgi", "zwf"], "pair_class": "glucose_routing_ppp_ed"},
    {"genes": ["pgi", "edd"], "pair_class": "glucose_routing_ppp_ed"},
    {"genes": ["zwf", "edd"], "pair_class": "glucose_routing_ppp_ed"},
    {"genes": ["edd", "eda"], "pair_class": "glucose_routing_ppp_ed"},
    {"genes": ["sdhA", "frdA"], "pair_class": "energy_respiration"},
    {"genes": ["cyoA", "appB"], "pair_class": "energy_respiration"},
    {"genes": ["cydA", "appB"], "pair_class": "energy_respiration"},
    {"genes": ["ahpC", "katG"], "pair_class": "oxidative_stress_detox"},
    {"genes": ["ahpC", "katE"], "pair_class": "oxidative_stress_detox"},
    {"genes": ["ahpF", "katG"], "pair_class": "oxidative_stress_detox"},
    {"genes": ["trxA", "grxA"], "pair_class": "redox_buffering"},
    {"genes": ["trxB", "gor"], "pair_class": "redox_buffering"},
    {"genes": ["surA", "skp"], "pair_class": "envelope_biogenesis"},
    {"genes": ["surA", "degP"], "pair_class": "envelope_biogenesis"},
    {"genes": ["skp", "degP"], "pair_class": "envelope_biogenesis"},
    {"genes": ["bamB", "surA"], "pair_class": "envelope_biogenesis"},
    {"genes": ["bamB", "skp"], "pair_class": "envelope_biogenesis"},
    {"genes": ["lpxA", "lpxC"], "pair_class": "envelope_biogenesis"},
    {"genes": ["mrcA", "mrcB"], "pair_class": "envelope_biogenesis"},
    {"genes": ["mrdA", "mrcB"], "pair_class": "envelope_biogenesis"},
    {"genes": ["tolC", "acrA"], "pair_class": "transport_efflux"},
    {"genes": ["ruvA", "recG"], "pair_class": "dna_repair"},
    {"genes": ["ruvC", "recG"], "pair_class": "dna_repair"},
    {"genes": ["recA", "ruvA"], "pair_class": "dna_repair"},
    {"genes": ["recA", "recN"], "pair_class": "dna_repair"},
    {"genes": ["xthA", "nfo"], "pair_class": "dna_repair"},
    {"genes": ["mutM", "mutY"], "pair_class": "dna_repair"},
    {"genes": ["nth", "nei"], "pair_class": "dna_repair"},
    {"genes": ["priA", "rep"], "pair_class": "dna_repair"},
    {"genes": ["dnaQ", "mutS"], "pair_class": "dna_repair"},
    {"genes": ["arcA", "fnr"], "pair_class": "regulatory_coupling"},
    {"genes": ["crp", "cra"], "pair_class": "regulatory_coupling"},
    {"genes": ["fur", "oxyR"], "pair_class": "regulatory_coupling"},
    {"genes": ["soxR", "soxS"], "pair_class": "regulatory_coupling"},
    {"genes": ["marA", "rob"], "pair_class": "regulatory_coupling"},
    {"genes": ["dsbA", "dsbC"], "pair_class": "protein_folding_disulfide"},
    {"genes": ["dsbC", "dsbG"], "pair_class": "protein_folding_disulfide"},
    {"genes": ["fabA", "fabB"], "pair_class": "lipid_metabolism"},
    {"genes": ["fabB", "fabF"], "pair_class": "lipid_metabolism"},
    {"genes": ["fabA", "fabF"], "pair_class": "lipid_metabolism"},
    {"genes": ["ftsA", "zipA"], "pair_class": "cell_division_envelope"},
    {"genes": ["ftsZ", "zipA"], "pair_class": "cell_division_envelope"},
]


@dataclass
class CampaignCell:
    variant_type: str
    label: str
    condition: str | None = None
    params: dict = field(default_factory=dict)
    seeds: int = SEEDS
    generations: int = GENERATIONS
    tier: str = TIER_V0


def v0_campaign(ko_genes: list[str]) -> list[CampaignCell]:
    """Expand the locked v0 matrix into experiment descriptors. ``ko_genes`` is the resolved
    curated knockout list (see selection criterion above)."""
    cells: list[CampaignCell] = []
    # 1. Wildtype baseline across all conditions (static).
    for cond in WT_CONDITIONS:
        cells.append(CampaignCell("wildtype", f"WT/{cond}", condition=cond, tier=TIER_V0))
    # 2. Curated single knockouts across core conditions.
    for gene in ko_genes[:KO_TARGET]:
        for cond in KO_CORE_CONDITIONS:
            cells.append(CampaignCell("gene_knockout", f"{gene}_KO/{cond}", condition=cond,
                                      params={"gene": gene}, tier=TIER_V0))
    # 3. Dynamic-media runs (day-one dynamics benchmark).
    for run in DYNAMIC_RUNS:
        for geno in DYNAMIC_GENOTYPES:
            cells.append(CampaignCell(run["variant_type"], f"{geno}/{run['label']}",
                                      params=run["params"], tier=TIER_V0))
    return cells


def t2_core_campaign(genes: list[str]) -> list[CampaignCell]:
    """Expand the fixed T2 Core single-KO campaign."""
    cells: list[CampaignCell] = []
    for gene in genes:
        for cond in T2_CORE_CONDITIONS:
            cells.append(CampaignCell("gene_knockout", f"{gene}_KO/{cond}", condition=cond,
                                      params={"gene": gene}, tier=TIER_T2_CORE))
    return cells


def t2_extended_campaign(genes: list[str]) -> list[CampaignCell]:
    """Expand the fixed T2 Extended all-static-condition single-KO campaign."""
    cells: list[CampaignCell] = []
    for gene in genes:
        for cond in T2_EXTENDED_CONDITIONS:
            cells.append(CampaignCell("gene_knockout", f"{gene}_KO/{cond}", condition=cond,
                                      params={"gene": gene}, tier=TIER_T2_EXTENDED))
    return cells


def t3_campaign(genes: list[str]) -> list[CampaignCell]:
    """Expand the fixed single-tier T3 dynamic-media campaign."""
    cells: list[CampaignCell] = []

    for protocol in T3_TIMELINE_PROTOCOLS:
        label = protocol["label"]
        params = {"events": protocol["events"], "protocol": label}
        cells.append(CampaignCell("timelines", f"WT/{label}", params=params, tier=TIER_T3))
        for gene in genes:
            cells.append(CampaignCell(
                "timelines",
                f"{gene}_KO/{label}",
                params={**params, "gene": gene},
                tier=TIER_T3,
            ))

    for media_a, media_b in T3_SINUSOIDAL_MEDIA_PAIRS:
        for period in T3_SINUSOIDAL_PERIODS_MIN:
            label = f"sinusoidal_{media_a}_to_{media_b}_T{period}min"
            cells.append(CampaignCell(
                "sinusoidal_media",
                f"WT/{label}",
                condition="glc_2mM",
                params={
                    "protocol": label,
                    "variant_index": period,
                    "sim_params": {
                        "sinusoidal_media": {
                            "SINE_MEDIA_A": media_a,
                            "SINE_MEDIA_B": media_b,
                        }
                    },
                },
                tier=TIER_T3,
            ))

    for variant_type, indices in T3_AA_SHIFT_VARIANTS.items():
        for index in indices:
            cells.append(CampaignCell(
                variant_type,
                f"WT/{variant_type}_{index}",
                params={"protocol": variant_type, "variant_index": index},
                tier=TIER_T3,
            ))

    return cells


def t4_campaign(tf_names: list[str], ppgpp_indices: list[int]) -> list[CampaignCell]:
    """Expand the fixed single-tier T4 regulatory campaign."""
    cells: list[CampaignCell] = []

    for offset, tf_name in enumerate(tf_names):
        active_index = 2 * offset + 1
        inactive_index = active_index + 1
        cells.append(CampaignCell(
            "tf_activity",
            f"{tf_name}/active",
            params={"variant_index": active_index, "tf": tf_name, "tf_state": "active"},
            tier=TIER_T4,
        ))
        cells.append(CampaignCell(
            "tf_activity",
            f"{tf_name}/inactive",
            params={"variant_index": inactive_index, "tf": tf_name, "tf_state": "inactive"},
            tier=TIER_T4,
        ))

    for index in ppgpp_indices:
        cells.append(CampaignCell(
            "ppgpp_conc",
            f"ppgpp_conc/{index}",
            params={"variant_index": index},
            tier=TIER_T4,
        ))

    return cells


def t5_campaign(pair_definitions: list[dict]) -> list[CampaignCell]:
    """Expand the fixed single-tier T5 curated multi-gene knockout campaign."""
    cells: list[CampaignCell] = []
    for pair in pair_definitions:
        genes = list(pair["genes"])
        pair_label = pair.get("pair_label") or "+".join(genes)
        pair_class = pair.get("pair_class", "curated_pair")
        for condition in T2_CORE_CONDITIONS:
            cells.append(CampaignCell(
                "multi_gene_knockout",
                f"{pair_label}/{condition}",
                condition=condition,
                params={"genes": genes, "pair_class": pair_class, "pair_label": pair_label},
                tier=TIER_T5,
            ))
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
