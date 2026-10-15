"""The dataset card (repo/README.md), rendered from the summary finalize computes.

Every number comes from ``summary``; anything it does not know is left as ``{{TODO}}`` so a
missing figure is visible in review rather than silently wrong.
"""

from __future__ import annotations

from .settings import (COLLAPSE_RATE, CONFIGS, FAMILIES, FAMILY_BY_TIER, MATRIX_CHANNELS, SCALAR_CHANNELS,
                       SUMMARY_CONFIG, SUMMARY_STATS, Settings)

TODO = "{{TODO}}"
# Data configs in card order: the per-trajectory summary first, then the exported configs.
CARD_CONFIGS = [SUMMARY_CONFIG] + list(CONFIGS)

# well4cell termination_class -> the Cellarium corpus `qc` vocabulary, and what it means.
QC_CROSSWALK = (
    ("none", "ok", "the cell divided"),
    ("time_limit", "no_division", "the generation ran to the time limit without dividing; the model's \"did not divide\""),
    ("negative_counts", "crashed", "simulator error (a molecule count went negative)"),
    ("fba_infeasible", "fba_infeasible", "metabolism solver failure"),
    ("equilibrium_unstable", "crashed", "equilibrium solver failure"),
    ("other", "crashed", "any other simulator error"),
)
CELLARIUM_URL = "https://github.com/evanniko1/cellarium"

FAMILY_TEXT = {
    "wildtype_media": "wild-type cells in a range of static media",
    "single_knockout": "single-gene knockouts across media",
    "dynamic_media": "media shifts and sinusoidal media schedules",
    "regulation": "transcription-factor activity and ppGpp set-point perturbations",
    "double_knockout": "two-gene knockouts",
}

INDEX_COLUMNS = {
    "sample_id": "trajectory id, `lineage_id + \"/g{generation}\"`",
    "lineage_id": "`cell_id + \"/s{seed}\"`: one simulated lineage",
    "cell_id": "the experimental cell (design x condition), e.g. `T2/argG_KO/basal`; see Ids",
    "parent_id": "sample_id of the mother generation; null at generation 0",
    "experiment_name": "the campaign's experiment name, verbatim (wrong for T4 transcription-factor cells; see Ids)",
    "family": "one of the five families (the split names of every data config)",
    "tier": "campaign tier, T1..T5",
    "variant_type": "wcEcoli variant name",
    "variant_index": "wcEcoli variant index",
    "variant": "gene symbol(s), `wildtype`, or the variant type",
    "condition": "the campaign's condition as designed; ignored by the simulator for TF-activity and "
                 "sinusoidal cells (read `media_schedule`)",
    "timeline": "the media schedule that actually ran, `\"0 minimal, 1200 minimal_acetate\"` "
                "(simulation seconds); null for sinusoidal media",
    "seed": "simulation seed",
    "generation": "generation number within the lineage (0 = first cell)",
    "knockout_genes": "knocked-out gene symbols",
    "knockout_gene_ids": "knocked-out gene ids (EcoCyc)",
    "knockout_tu_ids": "transcription units whose expression was set to zero (a knockout removes a whole TU)",
    "media_schedule": "media changes, lineage-absolute seconds (`t_abs_sec`) and medium",
    "medium_at_birth": "medium at the first row of this generation",
    "medium_at_division": "medium at the last row of this generation",
    "media_a": "first medium of a two-medium schedule",
    "media_b": "second medium of a two-medium schedule",
    "period_sec": "period of a sinusoidal schedule, s (null otherwise)",
    "tf_target": "symbol of the transcription factor that was actually perturbed (regulation family)",
    "tf_target_id": "EcoCyc id of that transcription factor",
    "tf_state": "imposed TF state: active, inactive, or control",
    "ppgpp_setpoint_um": "ppGpp set point, uM (regulation family)",
    "ppgpp_factor": "multiple of the basal ppGpp concentration (0.2..2.0)",
    "aa_shift": "amino-acid shift label, e.g. `+ARG`, `-ARG`, `rich->6aa`, `control`",
    "perturbation_text": "one-sentence plain-language description of the perturbation",
    "n_steps": "rows of this trajectory at 1 s",
    "divided": "the cell divided (= not terminated)",
    "terminated": "the lineage ended in this generation",
    "termination_class": "none, time_limit, negative_counts, fba_infeasible, equilibrium_unstable, other",
    "termination_reason": "the simulator's termination message",
    "division_time_sec": "`n_steps - 1` when divided, else null",
    "final_mass_fg": "cell mass at the last row, fg",
    "growth_rate": "mean instantaneous growth rate over the generation, 1/s",
    "lineage_terminated": "the lineage ended in some generation",
    "lineage_generations": "generations present for this lineage",
    "split_by_lineage": "train/val/test, whole lineages, stratified by cell within family",
    "split_by_gene": "train/val/test holding out whole genes; non-knockout rows are train",
    "job_id": "campaign job id",
    "attempt": "campaign job attempt",
    "started_at": "simulation start time",
    "run_dir": "campaign run directory",
    "h5_group": "group in the run's channels.h5, e.g. `seed0/gen0`",
    "git_hash": "wcEcoli commit that ran the simulation",
    "parca_cache": "Parca (fitted-parameter) cache the run used, by name; the cache itself is not distributed",
    "kb_sha256": "sha256 of the fitted parameter set (simData.cPickle) used; the set itself is not distributed",
    "sim_options_hash": "sha256 of the run's simulation options minus per-run keys and the keys "
                        "carried as columns (git_hash, timeline, multi-knockout indices); key into "
                        "`provenance/sim_options/`",
}

CHANNEL_TEXT = {
    "cell_mass": "total cell mass", "dry_mass": "dry mass", "protein_mass": "protein mass",
    "rna_mass": "RNA mass", "dna_mass": "DNA mass", "small_molecule_mass": "small-molecule mass",
    "cell_volume": "cell volume", "growth_rate": "instantaneous growth rate (null at row 0)",
    "ppgpp_conc": "ppGpp concentration", "aa_supply_total": "total amino-acid supply rate",
    "aa_synthesis_total": "total amino-acid synthesis rate", "mrna_counts": "total mRNA molecules",
    "n_oric": "origins of replication", "fba_objective": "FBA objective value",
    "exchange_flux_total": "sum of exchange fluxes", "reaction_flux_total": "sum of reaction fluxes",
    "ribosome_elongation_rate": "ribosome elongation rate",
    "ribosome_actual_elongations": "amino acids elongated in the step",
    "mrna_counts_matrix": "mRNA counts per transcription unit (ids are mRNA TU ids)", "protein_counts_matrix": "protein counts per monomer",
    "reaction_flux_matrix": "flux per metabolic reaction", "exchange_flux_matrix": "flux per exchange reaction",
}


def _n(value, fmt: str = "{:,}") -> str:
    return fmt.format(value) if isinstance(value, (int, float)) and value is not None else TODO


def _count(counts: dict, key: str) -> str:
    """A tally that exists but lacks ``key`` means zero; a missing tally is unknown."""
    return _n(counts.get(key, 0)) if counts else TODO


def _bytes(value) -> str:
    if not isinstance(value, (int, float)):
        return TODO
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1000 or unit == "TB":
            return "{:.1f} {}".format(value, unit) if unit != "B" else "{} B".format(int(value))
        value /= 1000.0
    return TODO


def _parameter_sets(n: int) -> tuple[str, str]:
    """("one of two fitted parameter sets", "the two parameter sets") for n = 2; TODO when unknown."""
    if n == 1:
        return "one fitted parameter set", "builds with other parameter sets"
    word = {2: "two", 3: "three", 4: "four"}.get(n, str(n)) if n else TODO
    return "one of {} fitted parameter sets".format(word), "the {} parameter sets".format(word)


def size_category(n: int | None) -> str:
    if not isinstance(n, int):
        return "n<1K"
    for limit, label in ((1_000, "n<1K"), (10_000, "1K<n<10K"), (100_000, "10K<n<100K"),
                         (1_000_000, "100K<n<1M"), (10_000_000, "1M<n<10M")):
        if n < limit:
            return label
    return "n>1T" if n >= 10**12 else "10M<n<100M"


def front_matter(summary: dict) -> str:
    lines = [
        "---",
        "license: cc-by-4.0",
        "pretty_name: The Well for The Cell",
        "tags:",
        "- biology",
        "- simulation",
        "- time-series",
        "- whole-cell",
        "- E. coli",
        "size_categories:",
        "- " + size_category(summary.get("trajectories")),
        "configs:",
        "- config_name: index",
        "  data_files: index.parquet",
    ]
    configs = summary.get("configs", {})
    ordered = [c for c in CARD_CONFIGS if c in configs] + sorted(c for c in configs if c not in CARD_CONFIGS)
    for config in ordered:
        families = configs[config].get("families", {})
        ordered_families = [f for f in FAMILIES if f in families] + sorted(f for f in families if f not in FAMILIES)
        if not ordered_families:
            continue
        lines.append("- config_name: " + config)
        lines.append("  data_files:")
        for family in ordered_families:
            lines.append("  - split: " + family)
            lines.append("    path: data/{}/{}/*.parquet".format(config, family))
    lines.append("---")
    return "\n".join(lines)


def _families_table(summary: dict) -> list[str]:
    tier = {family: t for t, family in FAMILY_BY_TIER.items()}
    families = summary.get("families", {})
    rows = ["| family | tier | what varies | cells | lineages | trajectories |", "|---|---|---|---:|---:|---:|"]
    for family in FAMILIES:
        counts = families.get(family, {key: 0 for key in ("cells", "lineages", "trajectories")} if families else {})
        rows.append("| `{}` | {} | {} | {} | {} | {} |".format(
            family, tier[family], FAMILY_TEXT[family], _n(counts.get("cells")), _n(counts.get("lineages")),
            _n(counts.get("trajectories"))))
    rows.append("| **total** | | | {} | {} | {} |".format(
        _n(summary.get("cells")), _n(summary.get("lineages")), _n(summary.get("trajectories"))))
    return rows


def _configs_table(summary: dict) -> list[str]:
    configs = summary.get("configs", {})
    active = summary.get("active_columns", {})
    rows = ["| config | rows every | matrices (active columns) | trajectories | rows | size |",
            "|---|---|---|---:|---:|---:|"]
    info = configs.get(SUMMARY_CONFIG)
    what = "none: `n_steps` and {} of each scalar".format(", ".join("`_{}`".format(s) for s in SUMMARY_STATS))
    if info and info.get("pathways"):
        what += "; {} `pathway_<name>` fractions".format(len(info["pathways"]))
    if info is None:
        rows.append("| `{}` | trajectory | {} | not in this release | | |".format(SUMMARY_CONFIG, what))
    else:
        trajectories = _n(info.get("trajectories"))
        present = _present(summary, SUMMARY_CONFIG)
        if present and len(present) < len(FAMILIES):
            trajectories += " ({} only)".format(", ".join(present))
        rows.append("| `{}` | trajectory | {} | {} | {} | {} |".format(
            SUMMARY_CONFIG, what, trajectories, _n(info.get("rows")), _bytes(info.get("bytes"))))
    for name, config in CONFIGS.items():
        info = configs.get(name)
        matrices = ", ".join("`{}` ({})".format(m, _n(active.get(m, {}).get("active"))) for m in config.matrices) or "scalars only"
        if info is None:
            rows.append("| `{}` | {} s | {} | not in this release | | |".format(name, config.stride, matrices))
            continue
        trajectories = _n(info.get("trajectories"))
        present = _present(summary, name)
        if present and len(present) < len(FAMILIES):
            trajectories += " ({} only)".format(", ".join(present))
        rows.append("| `{}` | {} s | {} | {} | {} | {} |".format(
            name, config.stride, matrices, trajectories, _n(info.get("rows")), _bytes(info.get("bytes"))))
    return rows


def _held_back(summary: dict) -> list[str]:
    held = summary.get("held_back") or []
    if not held:
        return []
    return ["", "**Not yet in this repo:** {} {} been exported and will follow in a later upload; the "
            "tables below and the index locators (`<config>_file`) cover only the data present here."
            .format(", ".join("`data/{}/`".format(h) for h in held), "has" if len(held) == 1 else "have")]


def _present(summary: dict, config: str) -> list[str]:
    """Families of ``config`` on disk in this repo (held-back ones are already removed), tier order."""
    families = summary.get("configs", {}).get(config, {}).get("families", {})
    return [f for f in FAMILIES if f in families]


def _codes(names) -> str:
    """`a`, `a` and `b`, `a`, `b` and `c`."""
    names = ["`{}`".format(n) for n in names]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _estimate_bytes(summary: dict, config: str) -> float | None:
    """Size of an absent config: core's row count (every config has the same rows at 1 s; stride
    10 keeps about a tenth) times the config's bytes_per_row. Only when core is complete."""
    core = summary.get("configs", {}).get("core")
    if not core or len(_present(summary, "core")) < len(FAMILIES) or not core.get("rows"):
        return None
    spec = CONFIGS[config]
    return core["rows"] / spec.stride * spec.bytes_per_row


def _coverage(summary: dict) -> list[str]:
    configs = summary.get("configs", {})
    held = set(summary.get("held_back") or [])
    counts = summary.get("families", {})
    rows = ["| family | trajectories | " + " | ".join("`{}`".format(c) for c in CARD_CONFIGS) + " |",
            "|---|---:|" + "---|" * len(CARD_CONFIGS)]
    for family in FAMILIES:
        cells = []
        for config in CARD_CONFIGS:
            info = configs.get(config, {}).get("families", {}).get(family)
            if info is not None:
                cells.append("yes ({})".format(_bytes(info.get("bytes"))))
            elif config in configs or "{}/{}".format(config, family) in held:
                cells.append("not yet")
            else:
                cells.append("not in this release")
        rows.append("| `{}` | {} | {} |".format(
            family, _n(counts.get(family, {}).get("trajectories", 0) if counts else None), " | ".join(cells)))

    sentences = []
    partial: dict[tuple, list[str]] = {}
    for config in CARD_CONFIGS:
        present = _present(summary, config)
        if present and len(present) < len(FAMILIES):
            partial.setdefault(tuple(present), []).append(config)
    for present, names in partial.items():
        missing = [f for f in FAMILIES if f not in present]
        sentences.append("{} {} currently available for {} only; {} will be added in a later upload.".format(
            _codes(names), "is" if len(names) == 1 else "are", _codes(present), _codes(missing)))
    absent = [c for c in CONFIGS if not _present(summary, c)]
    if absent:
        estimates = [_estimate_bytes(summary, c) for c in absent]
        what = "1 s matrices" if all(CONFIGS[c].stride == 1 and CONFIGS[c].matrices for c in absent) else ""
        size = "~{} estimated".format(_bytes(sum(estimates))) if None not in estimates else "planned"
        sentences.append("{} ({}) {} not in this release.".format(
            _codes(absent), ", ".join(x for x in (what, size) if x), "is" if len(absent) == 1 else "are"))
    if not _present(summary, SUMMARY_CONFIG):
        sentences.append("`{}` is not in this release.".format(SUMMARY_CONFIG))
    if not sentences:
        sentences.append("Every config is complete: all five families are in this repo.")

    return [
        "## What is in this repo",
        "",
        "Which families of each config are uploaded here (size on the Hub):",
        "",
    ] + rows + [
        "",
        " ".join(sentences),
    ] + _held_back(summary) + [
        "",
        "`index.parquet` lists every trajectory, uploaded or not. Its locator columns (`<config>_file`, "
        "`<config>_row_offset`, `<config>_n_rows`) are null for data not in this repo, so "
        "`index[\"<config>_file\"].notnull()` (e.g. `index.expression_file.notnull()`) is the authoritative "
        "availability check. `load_dataset(..., \"<config>\", split=\"<family>\")` fails for a family that has not been uploaded "
        "(e.g. `load_dataset(..., \"expression\", split=\"single_knockout\")` until that "
        "family is uploaded).",
        "",
    ]


def _qc_crosswalk() -> list[str]:
    rows = ["| well4cell `termination_class` | Cellarium `qc` | meaning |", "|---|---|---|"]
    for termination, qc, meaning in QC_CROSSWALK:
        rows.append("| `{}` | `{}` | {} |".format(termination, qc, meaning))
    return rows


def _pathway_text(summary: dict) -> str:
    """The summary's pathway columns (summarize --pathways), when its parts have them; "" otherwise."""
    info = summary.get("configs", {}).get(SUMMARY_CONFIG) or {}
    names = info.get("pathways") or []
    if not names:
        return ""
    families = [f for f in FAMILIES if (info.get("families", {}).get(f) or {}).get("pathway_columns")]
    scope = "every family" if len(families) == len(FAMILIES) else _codes(families) + " only"
    return (" For {} it also has {} pathway proteome fractions, {} (float32, unit `fraction`): for each pathway of "
            "the Cellarium pathway panel, the pathway's protein counts over all protein counts at each 10 s "
            "`expression` row, averaged over the trajectory (Cellarium's definition; the gene lists are in "
            "Cellarium's `pathway_panel.py`).".format(scope, len(names), _codes(names)))


def _translation_collapse(summary: dict) -> list[str]:
    """The Cellarium ``translation_collapse`` predicate on the summary config, with its counts
    (finalize.translation_collapse; TODO when the summary config is not in this release)."""
    collapse = summary.get("translation_collapse") or {}
    return [
        "A generation can divide while its ribosomes have effectively stopped, because chromosome replication "
        "does not require ongoing translation. The Cellarium corpus flags this as `translation_collapse` when "
        "the mean ribosome elongation rate over the generation is below {rate:g} aa/s, an order of magnitude "
        "below the slowest elongation rate measured in *E. coli* (Dai et al. 2016). The same predicate on this "
        "dataset is `ribosome_elongation_rate_mean < {rate:g}` in the `{config}` config. It flags {n} "
        "trajectories in this release, {m} of them with `termination_class` `none` (divided, but with "
        "translation collapsed). Treat them as inviable in any viability task.".format(
            rate=COLLAPSE_RATE, config=SUMMARY_CONFIG, n=_n(collapse.get("trajectories")),
            m=_n(collapse.get("divided"))),
    ]


def _deg_rates(summary: dict) -> list[str]:
    """Which mRNA degradation rates of each Parca cache are not fits (finalize.publish_deg_rates,
    from ``w4c deg-rates``); nothing when no cache has been classified."""
    caches = summary.get("deg_rates") or {}
    if not caches:
        return []
    lines = [
        "Degradation rates. Not every mRNA half-life in the fitted parameters is a fit to that transcript. The fitted "
        "rates are bounded below by the slowest measured mRNA decay (the longest measured half-life), and a unit "
        "whose rate sits on that bound is on the floor. Rates faster than the fastest measured decay (the shortest "
        "measured half-life) are clipped to it, and those units are on the ceiling. A unit none of whose genes "
        "has a measured half-life is imputed: it carries the mean measured half-life. Any claim about the stability of these transcripts, or that depends on it, rests on "
        "a bound or a population mean, not on a measurement of that transcript. "
        "`provenance/deg_rates_<parca_cache>.json` lists the units of each class with their share of expression.",
        "",
    ]
    for cache, figures in caches.items():
        def count(key: str) -> str:
            return _n((figures.get(key) or {}).get("n_units"))
        lines.append(
            "- `{cache}`: {n} of {total} mRNA transcription units, carrying {pct}% of basal mRNA expression, are not "
            "a fit: {floor} on the floor ({floor_min} min), {ceiling} on the ceiling ({ceiling_min} min) and "
            "{imputed} imputed ({imputed_min} min).".format(
                cache=cache, n=count("not_a_fit"), total=_n(figures.get("n_mrna_units")),
                pct=_n((figures.get("not_a_fit") or {}).get("pct_expression"), "{:.1f}"),
                floor=count("on_floor"), floor_min=_n(figures.get("rate_floor_as_half_life_min"), "{:g}"),
                ceiling=count("on_ceiling"), ceiling_min=_n(figures.get("rate_ceiling_as_half_life_min"), "{:g}"),
                imputed=count("imputed_average"), imputed_min=_n(figures.get("imputation_constant_min"), "{:.1f}")))
    return lines + [""]


def _index_schema(summary: dict) -> list[str]:
    rows = ["| column | type | meaning |", "|---|---|---|"]
    schema = summary.get("index_schema") or [(name, TODO) for name in INDEX_COLUMNS]
    for name, kind in schema:
        if any(name == c + suffix for c in CONFIGS for suffix in ("_file", "_row_offset", "_n_rows")):
            continue
        rows.append("| `{}` | {} | {} |".format(name, kind.replace("|", "\\|"), INDEX_COLUMNS.get(name, TODO)))
    rows.append("| `<config>_file`, `<config>_row_offset`, `<config>_n_rows` | string, int64, int32 | "
                "locator of this trajectory in each config: file path in the repo, first row, row count "
                "(null when the trajectory is not in that config) |")
    return rows


def _product_schema(summary: dict) -> list[str]:
    units = summary.get("units", {})
    types = summary.get("product_types", {})
    active = summary.get("active_columns", {})
    rows = ["| column | type | unit | meaning |", "|---|---|---|---|",
            "| `sample_id` | {} | | joins to `index.parquet` |".format(types.get("sample_id", "string")),
            "| `t` | {} | {} | seconds since this cell's birth; row 0 is the birth state |".format(types.get("t", TODO), units.get("t", "s")),
            "| `t_abs` | {} | {} | seconds since the lineage began (continues across generations) |".format(types.get("t_abs", TODO), units.get("t_abs", "s"))]
    for channel in summary.get("scalar_channels", SCALAR_CHANNELS):
        kind = types.get(channel) or ("int32" if channel in ("mrna_counts", "n_oric") else "float32")
        rows.append("| `{}` | {} | {} | {} |".format(channel, kind, units.get(channel, TODO), CHANNEL_TEXT.get(channel, "")))
    for matrix in MATRIX_CHANNELS:
        width = active.get(matrix, {}).get("active")
        kind = types.get(matrix) or "fixed_size_list<{}>[{}]".format("int32" if "counts" in matrix else "float32", _n(width))
        rows.append("| `{}` | {} | {} | {}; column k is the row of `provenance/reference/{}.parquet` with `product_column == k` |".format(
            matrix, kind.replace("|", "\\|"), units.get(matrix, TODO), CHANNEL_TEXT[matrix], matrix.replace("_matrix", "")))
    return rows


def render(settings: Settings, summary: dict) -> str:
    repo = summary.get("repo_id") or settings.repo_id
    example = summary.get("example_sample_id") or "T1/WT/basal/s0/g0"
    terminations = summary.get("termination_class", {})
    active = summary.get("active_columns", {})
    qc = summary.get("qc", {})
    failed = summary.get("failed_jobs", {})
    kb_sha256 = summary.get("kb_sha256", {})
    never = summary.get("never_recorded", [])

    body = [
        "# The Well for The Cell",
        "",
        "Version **{}**, built {} from wcEcoli commit `{}`{}.".format(
            summary.get("version", settings.version), summary.get("built_at", TODO), summary.get("git_commit") or TODO,
            " (working tree had local changes)" if summary.get("git_dirty") else ""),
        "",
        "Time series from the [wcEcoli](https://github.com/CovertLab/wcEcoli) whole-cell model of *Escherichia coli*. "
        "Each sample is **one cell generation**: the cell from birth to division (or to the step at which the "
        "simulation stopped), recorded every **1 s** of simulated time. Lineages are simulated for several "
        "generations, and the samples of one lineage are linked by `parent_id`. The {} trajectories come from {} "
        "lineages of {} distinct cells (design x condition), grouped into five families by campaign tier."
        .format(_n(summary.get("trajectories")), _n(summary.get("lineages")), _n(summary.get("cells"))),
        "",
    ] + _families_table(summary) + [""] + _coverage(summary) + [
        "## Configs",
        "",
        "Each config is one data product. `summary` is one row per trajectory and joins to `index.parquet` on "
        "`sample_id`: `n_steps` and, for each of the 18 scalar channels in the order of the product schema, "
        "`<channel>_mean`, `_min`, `_max`, `_first` and `_last` over the trajectory's 1 s `core` rows (int32 for "
        "`mrna_counts` and `n_oric` except `_mean`, float32 otherwise; the `growth_rate` statistics skip its null "
        "row 0, so `growth_rate_first` is the value at t = 1).{} Every other config carries `sample_id`, `t`, "
        "`t_abs` and the 18 scalar "
        "channels; the matrix configs add per-gene or per-reaction columns. `expression` and `metabolism` keep "
        "the rows with `t % 10 == 0` plus each trajectory's last row (point samples, not averages); "
        "`expression_1s` and `metabolism_1s` keep every row. The split of every config is the family."
        .format(_pathway_text(summary)),
        "",
    ] + _configs_table(summary) + [
        "",
        "Matrix columns are pruned to the columns that are non-zero at least once anywhere in the campaign "
        "(active columns: {}). The full column lists, with an `active` mask and each active column's position "
        "in the product (`product_column`), are in `provenance/reference/<matrix>.parquet`.".format(
            ", ".join("{} {} of {}".format(m.replace("_matrix", ""), _n(v.get("active")), _n(v.get("columns")))
                      for m, v in active.items()) or TODO),
        "",
        "## index.parquet",
        "",
        "One row per trajectory, sorted by family (tier order T1..T5), cell_id, seed, generation.",
        "",
    ] + _index_schema(summary) + [
        "",
        "## Product schema",
        "",
        "Rows of one trajectory are contiguous and in time order within one file. Units are also in each "
        "field's parquet metadata (`unit`).",
        "",
    ] + _product_schema(summary) + [
        "",
        "## Loading",
        "",
        "```python",
        "from datasets import load_dataset",
        "",
        "index = load_dataset(\"{}\", \"index\", split=\"train\")".format(repo),
        "core = load_dataset(\"{}\", \"core\", split=\"single_knockout\", streaming=True)".format(repo),
        "expression = load_dataset(\"{}\", \"expression\", split=\"wildtype_media\")".format(repo),
        "```",
        "",
        "DuckDB, one trajectory:",
        "",
        "```sql",
        "SELECT t, cell_mass, growth_rate",
        "FROM 'hf://datasets/{}/data/core/*/*.parquet'".format(repo),
        "WHERE sample_id = '{}'".format(example),
        "ORDER BY t;",
        "```",
        "",
        "One trajectory by its locator (reads only the row groups it spans):",
        "",
        "```python",
        "import pyarrow.parquet as pq",
        "from huggingface_hub import hf_hub_download",
        "",
        "row = index.filter(lambda r: r[\"sample_id\"] == \"{}\")[0]".format(example),
        "path = hf_hub_download(\"{}\", row[\"expression_file\"], repo_type=\"dataset\")".format(repo),
        "table = pq.read_table(path, filters=[(\"sample_id\", \"=\", row[\"sample_id\"])])",
        "assert table.num_rows == row[\"expression_n_rows\"]",
        "```",
        "",
        "## Ids",
        "",
        "- `cell_id` is the campaign experiment name, slugified, with the tier as a plain `T1`..`T5` "
        "prefix: `[T2_CORE] argG_KO/basal` becomes `T2/argG_KO/basal`. The raw name is in `experiment_name`.",
        "- Regulation (T4) transcription-factor cells are the exception: the campaign named them from the "
        "sorted TF *symbols* while the simulator indexes the sorted TF *ids*, so their experiment names "
        "name the wrong TF (`[T4] araC/active` ran trpR). Their `cell_id`, `tf_target` and `tf_target_id` "
        "use the TF that actually ran (`T4/trpR/active`); `experiment_name` keeps the campaign's name.",
        "- A knockout removes a whole transcription unit: the model sets the expression of one TU to zero, "
        "so other genes of that TU are silenced too. `knockout_genes` lists the targeted genes, "
        "`knockout_tu_ids` the TUs actually knocked out.",
        "- `lineage_id = cell_id + \"/s{seed}\"`; `sample_id = lineage_id + \"/g{generation}\"`, e.g. `" + example + "`.",
        "- `parent_id` is the previous generation's `sample_id` (null at generation 0).",
        "",
        "## Time axis",
        "",
        "- Steps are 1 s. `t` restarts at 0 for every generation; `t_abs` continues across the generations "
        "of a lineage, so generation g+1 starts where generation g ended.",
        "- Row 0 is the birth state: the daughter at half the mother's mass. `growth_rate` is null at row 0 "
        "(no step has been taken yet).",
        "- Only one daughter is followed at each division, so a lineage is a chain, not a tree.",
        "- A generation stopped by the per-generation time limit (`TimeLimitReached`) has 10,801 steps (0..10,800 s).",
        "",
        "## Outcomes",
        "",
        "`divided` is true when the cell divided. `terminated` marks the generation in which the lineage "
        "ended, and `termination_class` says why:",
        "",
        "| termination_class | meaning | trajectories |",
        "|---|---|---:|",
        "| `none` | divided normally | {} |".format(_count(terminations, "none")),
        "| `time_limit` | reached the time limit without dividing: the only clean non-division (slow or arrested growth) | {} |".format(_count(terminations, "time_limit")),
        "| `negative_counts` | a molecule count went negative (numerical failure) | {} |".format(_count(terminations, "negative_counts")),
        "| `fba_infeasible` | the metabolism FBA problem had no solution | {} |".format(_count(terminations, "fba_infeasible")),
        "| `equilibrium_unstable` | the equilibrium solver failed | {} |".format(_count(terminations, "equilibrium_unstable")),
        "| `other` | any other simulator exception | {} |".format(_count(terminations, "other")),
        "",
        "`time_limit` is the only clean non-division; the other classes are solver failures, and the rows "
        "before the failure are kept as recorded.",
        "",
        "The same outcomes in the `qc` vocabulary of the Cellarium corpus:",
        "",
    ] + _qc_crosswalk() + [
        "",
        "Only `time_limit` is a prediction of the model about the cell; the other non-`none` classes are "
        "numerical failures of the simulation, and a viability task should treat them as such. Cellarium's "
        "`implausible_channel` and `over_replicated` have no counterpart here because well4cell does not run "
        "those checks; its vocabulary is defined in the Cellarium repository's `docs/QC_STATUSES.md` ({})."
        .format(CELLARIUM_URL),
        "",
    ] + _translation_collapse(summary) + [
        "",
        "## Suggested tasks",
        "",
        "1. **Growth-rate regression from the perturbation**: predict `growth_rate` (index) from the "
        "perturbation columns (`knockout_genes`, media, `tf_target`, ...) and optionally the first rows of the trajectory.",
        "2. **Viability classification**: predict whether a generation is *not* terminated by the time limit "
        "(`termination_class != 'time_limit'`), i.e. whether the perturbed cell still divides.",
        "3. **Forecasting**: given the trajectory up to time t, predict the channels at t + h, with horizons "
        "h stated in seconds (e.g. 10, 60, 600 s) so 1 s and 10 s products compare directly.",
        "",
        "Use `split_by_lineage` (train {} / val {} / test {}) to hold out whole lineages, or `split_by_gene` "
        "(train {} / val {} / test {}) to hold out whole genes; both are fixed columns of the index (seed {}).".format(
            *[_count(summary.get(split, {}), part) for split in ("split_by_lineage", "split_by_gene")
              for part in ("train", "val", "test")],
            settings.split_seed),
        "",
        "## Provenance",
        "",
        "- Simulator commits (`index.git_hash`): {}.".format(", ".join("`{}`".format(h) for h in summary.get("sim_git_hashes", [])) or TODO),
        "- Simulation options hashes (`index.sim_options_hash`): {}.".format(", ".join("`{}`".format(h) for h in summary.get("sim_options_hashes", [])) or TODO),
        "- Fitted parameters (`index.parca_cache`, with the sha256 of its `simData.cPickle` in "
        "`index.kb_sha256`): {}. The Parca caches themselves are not included in this repo (see Licence).".format(
            ", ".join("`{}` (sha256 `{}`)".format(name, digest) for name, digest in kb_sha256.items()) or TODO),
        "- Every trajectory ran with operons on and the steady-state tRNA charging model (`trna_charging` true, "
        "no kinetic charging), from {} identified by `kb_sha256` and `parca_cache`; do not pool rows across {} "
        "without checking `kb_sha256`.".format(*_parameter_sets(len(kb_sha256))),
        "- `provenance/scan_runs.parquet`: every run directory read ({} runs), with its generation count and reference-id hash.".format(_n(summary.get("scan_runs"))),
        "- `provenance/failed_jobs.parquet`: {} campaign jobs that failed, with the error message and the generations they left behind.".format(_n(failed.get("failed_jobs"))),
        "- `provenance/export_qc.parquet`: the QC verdict of every trajectory in every config ({} checks, {} failed). "
        "Trajectories that fail QC are left out of that config.".format(_n(qc.get("attempts")), _n(qc.get("failed"))),
        "- `stats/<family>.parquet`: per product, channel and matrix column: mean, population std, min, max and row count.",
        "- `manifest.json`: row and byte totals per config, counts per family.",
        "",
    ] + _deg_rates(summary) + [
        "Never recorded: {} are in the exporter's channel list but were not written by any simulation, so they "
        "are absent from every product.".format(", ".join("`{}`".format(c) for c in never) or TODO),
        "",
        "## Licence",
        "",
        "CC BY 4.0 for everything in this repo. The wcEcoli model is by the Covert lab (Stanford) and is licensed "
        "separately under the Stanford Academic Software License; it is not included here. The fitted parameter "
        "sets (Parca caches) are not distributed either and are identified only by `kb_sha256` / `parca_cache`; "
        "reproducing these simulations requires obtaining wcEcoli under its own licence.",
        "",
        "## Citation",
        "",
        "```bibtex",
        "@misc{well4cell,",
        "  title  = {The Well for The Cell: whole-cell E. coli simulation trajectories},",
        "  author = {" + TODO + "},",
        "  year   = {2026},",
        "  url    = {https://huggingface.co/datasets/" + repo + "}",
        "}",
        "```",
        "",
    ]
    return front_matter(summary) + "\n\n" + "\n".join(body)
