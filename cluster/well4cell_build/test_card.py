"""card: the "What is in this repo" section, rendered from fabricated summaries.

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_card.py
"""

from __future__ import annotations

import yaml

from well4cell_build import card
from well4cell_build.settings import CONFIGS, FAMILIES, SUMMARY_CONFIG, Settings

COUNTS = dict(zip(FAMILIES, (641, 83937, 18599, 2046, 11951)))


def make_settings(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("WCECOLI_CAMPAIGN_ROOT", str(tmp_path / "campaign"))
    monkeypatch.setenv("W4C_ROOT", str(tmp_path / "w4c"))
    return Settings.from_env()


def summary_for(coverage: dict[str, list[str]], held_back=()) -> dict:
    configs = {}
    for config, families in coverage.items():
        per_row = 1 if config == SUMMARY_CONFIG else 10
        per_family = {f: {"files": 1, "bytes": 10**9, "rows": per_row * COUNTS[f], "trajectories": COUNTS[f]}
                      for f in families}
        configs[config] = {"stride": CONFIGS[config].stride if config in CONFIGS else 1, "files": len(families),
                           "bytes": 10**9 * len(families), "rows": sum(v["rows"] for v in per_family.values()),
                           "trajectories": sum(COUNTS[f] for f in families), "families": per_family}
    return {"trajectories": sum(COUNTS.values()), "families": {f: {"trajectories": n, "lineages": 1, "cells": 1}
                                                               for f, n in COUNTS.items()},
            "configs": configs, "held_back": sorted(held_back)}


def section(text: str) -> str:
    start = text.index("## What is in this repo")
    return text[start:text.index("## Configs")]


def test_partial_coverage_is_stated(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    summary = summary_for({"core": FAMILIES, "summary": FAMILIES, "expression": ["wildtype_media"],
                           "metabolism": ["wildtype_media"]})
    text = card.render(settings, summary)
    front = yaml.safe_load(text.split("---")[1])
    splits = {c["config_name"]: [f["split"] for f in c["data_files"]] for c in front["configs"] if c["config_name"] != "index"}
    assert splits == {"summary": FAMILIES, "core": FAMILIES, "expression": ["wildtype_media"],
                      "metabolism": ["wildtype_media"]}
    assert text.index("## What is in this repo") < text.index("## Configs")
    body = section(text)
    assert ("| family | trajectories | `summary` | `core` | `expression` | `metabolism` | `expression_1s` "
            "| `metabolism_1s` |") in body
    assert ("| `wildtype_media` | 641 | yes (1.0 GB) | yes (1.0 GB) | yes (1.0 GB) | yes (1.0 GB) | not in this release "
            "| not in this release |") in body
    assert ("| `single_knockout` | 83,937 | yes (1.0 GB) | yes (1.0 GB) | not yet | not yet | not in this release "
            "| not in this release |") in body
    assert ("`expression` and `metabolism` are currently available for `wildtype_media` only; "
            "`single_knockout`, `dynamic_media`, `regulation` and `double_knockout` will be added in a later "
            "upload.") in body
    assert "`expression_1s` and `metabolism_1s` (1 s matrices, ~" in body and "estimated) are not in this release." in body
    assert "index.expression_file.notnull()" in body
    assert "| `expression` | 10 s |" in text and "| 641 (wildtype_media only) |" in text
    assert "| 117,174 |" in text.split("## Configs")[1].split("| `expression`")[0]


def test_held_back_family_is_not_yet(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    summary = summary_for({"core": FAMILIES[:4]}, held_back=["core/double_knockout"])
    body = section(card.render(settings, summary))
    assert "| `double_knockout` | 11,951 | not in this release | not yet | not in this release |" in body
    assert "`summary` is not in this release." in body
    assert "`core` is currently available for" in body and "`double_knockout` will be added" in body
    assert "Not yet in this repo" in body and "`data/core/double_knockout/`" in body
    # core is incomplete, so the absent configs get no size estimate
    assert ("`expression`, `metabolism`, `expression_1s` and `metabolism_1s` (planned) are not in this "
            "release.") in body


def test_full_coverage_has_no_not_yet(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    text = card.render(settings, summary_for({c: FAMILIES for c in card.CARD_CONFIGS}))
    body = section(text)
    assert "not yet" not in body and "not in this release" not in body
    assert body.count("yes (1.0 GB)") == len(FAMILIES) * (len(CONFIGS) + 1)
    assert "Every config is complete" in body
    assert "only)" not in text


def test_provenance_and_licence_name_the_caches_by_hash_only(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    summary = summary_for({"core": FAMILIES})
    summary["kb_sha256"] = {"5558948af4ad806f21d7c80c": "8f" * 32, "fa6a9ebd4b1c988a36ef9fa1": "b1" * 32}
    summary["index_schema"] = [("parca_cache", "string"), ("kb_sha256", "string")]
    text = card.render(settings, summary)
    provenance = text[text.index("## Provenance"):text.index("## Licence")]
    assert ("- Fitted parameters (`index.parca_cache`, with the sha256 of its `simData.cPickle` in `index.kb_sha256`): "
            "`5558948af4ad806f21d7c80c` (sha256 `{}`), `fa6a9ebd4b1c988a36ef9fa1` (sha256 `{}`). The Parca caches "
            "themselves are not included in this repo (see Licence).".format("8f" * 32, "b1" * 32)) in provenance
    assert "cPickle`:" not in text and "provenance/<cache>" not in text
    assert ("- Every trajectory ran with operons on and the steady-state tRNA charging model (`trna_charging` true, "
            "no kinetic charging), from one of two fitted parameter sets identified by `kb_sha256` and "
            "`parca_cache`; do not pool rows across the two parameter sets without checking `kb_sha256`.") in provenance
    licence = text[text.index("## Licence"):text.index("## Citation")]
    assert "CC BY 4.0 for everything in this repo." in licence
    assert "Stanford Academic Software License; it is not included here." in licence
    assert "identified only by `kb_sha256` / `parca_cache`" in licence
    assert "—" not in text
    assert ("| `kb_sha256` | string | sha256 of the fitted parameter set (simData.cPickle) used; the set itself is "
            "not distributed |") in text


def test_summary_config_is_listed_with_family_splits(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    text = card.render(settings, summary_for({"core": FAMILIES, "summary": FAMILIES}))
    front = yaml.safe_load(text.split("---")[1])
    names = [c["config_name"] for c in front["configs"]]
    assert names == ["index", "summary", "core"]
    summary = next(c for c in front["configs"] if c["config_name"] == "summary")
    assert summary["data_files"] == [{"split": f, "path": "data/summary/{}/*.parquet".format(f)} for f in FAMILIES]
    configs = text[text.index("## Configs"):text.index("## index.parquet")]
    assert "`summary` is one row per trajectory and joins to `index.parquet` on `sample_id`" in configs
    assert "`growth_rate_first` is the value at t = 1" in configs
    assert ("| `summary` | trajectory | none: `n_steps` and `_mean`, `_min`, `_max`, `_first`, `_last` of each "
            "scalar | 117,174 | 117,174 | 5.0 GB |") in configs
    assert "`summary` is" not in section(text)


def test_summary_absent_or_partial_is_stated(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    text = card.render(settings, summary_for({"core": FAMILIES}))
    assert "| `summary` | trajectory |" in text and "| not in this release | | |" in text
    assert "`summary` is not in this release." in section(text)
    assert "config_name: summary" not in text
    partial = section(card.render(settings, summary_for({"core": FAMILIES, "summary": ["wildtype_media"]})))
    assert "`summary` is currently available for `wildtype_media` only;" in partial


def test_outcomes_have_the_cellarium_qc_crosswalk(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    text = card.render(settings, summary_for({"core": FAMILIES}))
    outcomes = text[text.index("## Outcomes"):text.index("## Suggested tasks")]
    table = [
        "| well4cell `termination_class` | Cellarium `qc` | meaning |",
        "|---|---|---|",
        "| `none` | `ok` | the cell divided |",
        "| `time_limit` | `no_division` | the generation ran to the time limit without dividing; the model's "
        "\"did not divide\" |",
        "| `negative_counts` | `crashed` | simulator error (a molecule count went negative) |",
        "| `fba_infeasible` | `fba_infeasible` | metabolism solver failure |",
        "| `equilibrium_unstable` | `crashed` | equilibrium solver failure |",
        "| `other` | `crashed` | any other simulator error |",
    ]
    assert "\n".join(table) in outcomes
    assert outcomes.index("| termination_class | meaning | trajectories |") < outcomes.index(table[0])
    assert ("Only `time_limit` is a prediction of the model about the cell; the other non-`none` classes are "
            "numerical failures of the simulation, and a viability task should treat them as such.") in outcomes
    assert ("Cellarium's `implausible_channel` and `over_replicated` have no counterpart here because well4cell "
            "does not run those checks; its vocabulary is defined in the Cellarium repository's "
            "`docs/QC_STATUSES.md` (https://github.com/evanniko1/cellarium).") in outcomes
    assert "\u2014" not in text


def test_translation_collapse_counts_come_from_the_summary(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    summary = summary_for({"core": FAMILIES, "summary": FAMILIES})
    summary["translation_collapse"] = {"threshold_aa_per_s": 1.0, "trajectories": 6273, "divided": 4188}
    text = card.render(settings, summary)
    outcomes = text[text.index("## Outcomes"):text.index("## Suggested tasks")]
    paragraph = next(p for p in outcomes.split("\n\n") if p.startswith("A generation can divide"))
    assert outcomes.index("| `other` | `crashed` |") < outcomes.index(paragraph)
    assert "chromosome replication does not require ongoing translation" in paragraph
    assert "`translation_collapse` when the mean ribosome elongation rate over the generation is below 1 aa/s" in paragraph
    assert "(Dai et al. 2016)" in paragraph
    assert "`ribosome_elongation_rate_mean < 1` in the `summary` config" in paragraph
    assert ("It flags 6,273 trajectories in this release, 4,188 of them with `termination_class` `none`"
            in paragraph)
    assert "Treat them as inviable in any viability task." in paragraph
    assert "\u2014" not in paragraph
    # no summary config, no counts: the card says so rather than guessing
    absent = card.render(settings, summary_for({"core": FAMILIES}))
    assert "It flags {{TODO}} trajectories in this release, {{TODO}} of them" in absent


def test_summary_pathway_columns_are_described_when_present(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    summary = summary_for({"core": FAMILIES, "summary": FAMILIES, "expression": ["wildtype_media"]})
    plain = card.render(settings, summary)
    assert "pathway" not in plain[plain.index("## Configs"):plain.index("## index.parquet")]
    names = ["pathway_translation_ribosome", "pathway_glycolysis"]
    summary["configs"]["summary"]["pathways"] = names
    summary["configs"]["summary"]["families"]["wildtype_media"]["pathway_columns"] = 2
    text = card.render(settings, summary)
    configs = text[text.index("## Configs"):text.index("## index.parquet")]
    assert ("For `wildtype_media` only it also has 2 pathway proteome fractions, `pathway_translation_ribosome` and "
            "`pathway_glycolysis` (float32, unit `fraction`): for each pathway of the Cellarium pathway panel, the "
            "pathway's protein counts over all protein counts at each 10 s `expression` row, averaged over the "
            "trajectory") in configs
    assert "of each scalar; 2 `pathway_<name>` fractions |" in configs
    for family in FAMILIES:
        summary["configs"]["summary"]["families"][family]["pathway_columns"] = 2
    assert "For every family it also has 2 pathway proteome fractions" in card.render(settings, summary)


def test_deg_rates_paragraph_only_when_classified(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    summary = summary_for({"core": list(FAMILIES)})
    assert "Degradation rates." not in card.render(settings, summary)
    summary["deg_rates"] = {"abc": {"n_mrna_units": 3133, "not_a_fit": {"n_units": 854, "pct_expression": 12.087},
                                    "on_floor": {"n_units": 245}, "rate_floor_as_half_life_min": 91.2}}
    text = card.render(settings, summary)
    provenance = text[text.index("## Provenance"):text.index("## Licence")]
    assert "Degradation rates. Not every mRNA half-life" in provenance
    assert "rests on a bound or a population mean, not on a measurement" in provenance
    assert ("- `abc`: 854 of 3,133 mRNA transcription units, carrying 12.1% of basal mRNA expression, are not a "
            "fit: 245 on the floor (91.2 min), {{TODO}} on the ceiling ({{TODO}} min) and {{TODO}} imputed "
            "({{TODO}} min).") in provenance
    assert "—" not in provenance and "–" not in provenance
