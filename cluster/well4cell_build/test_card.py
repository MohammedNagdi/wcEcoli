"""card: the "What is in this repo" section, rendered from fabricated summaries.

    PYTHONPATH=cluster python -m pytest cluster/well4cell_build/test_card.py
"""

from __future__ import annotations

import yaml

from well4cell_build import card
from well4cell_build.settings import CONFIGS, FAMILIES, Settings

COUNTS = dict(zip(FAMILIES, (641, 83937, 18599, 2046, 11951)))


def make_settings(tmp_path, monkeypatch) -> Settings:
    monkeypatch.setenv("WCECOLI_CAMPAIGN_ROOT", str(tmp_path / "campaign"))
    monkeypatch.setenv("W4C_ROOT", str(tmp_path / "w4c"))
    return Settings.from_env()


def summary_for(coverage: dict[str, list[str]], held_back=()) -> dict:
    configs = {}
    for config, families in coverage.items():
        per_family = {f: {"files": 1, "bytes": 10**9, "rows": 10 * COUNTS[f], "trajectories": COUNTS[f]}
                      for f in families}
        configs[config] = {"stride": CONFIGS[config].stride, "files": len(families),
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
    summary = summary_for({"core": FAMILIES, "expression": ["wildtype_media"], "metabolism": ["wildtype_media"]})
    text = card.render(settings, summary)
    front = yaml.safe_load(text.split("---")[1])
    splits = {c["config_name"]: [f["split"] for f in c["data_files"]] for c in front["configs"] if c["config_name"] != "index"}
    assert splits == {"core": FAMILIES, "expression": ["wildtype_media"], "metabolism": ["wildtype_media"]}
    assert text.index("## What is in this repo") < text.index("## Configs")
    body = section(text)
    assert "| family | trajectories | `core` | `expression` | `metabolism` | `expression_1s` | `metabolism_1s` |" in body
    assert ("| `wildtype_media` | 641 | yes (1.0 GB) | yes (1.0 GB) | yes (1.0 GB) | not in this release "
            "| not in this release |") in body
    assert ("| `single_knockout` | 83,937 | yes (1.0 GB) | not yet | not yet | not in this release "
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
    assert "| `double_knockout` | 11,951 | not yet | not in this release |" in body
    assert "`core` is currently available for" in body and "`double_knockout` will be added" in body
    assert "Not yet in this repo" in body and "`data/core/double_knockout/`" in body
    # core is incomplete, so the absent configs get no size estimate
    assert ("`expression`, `metabolism`, `expression_1s` and `metabolism_1s` (planned) are not in this "
            "release.") in body


def test_full_coverage_has_no_not_yet(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, monkeypatch)
    text = card.render(settings, summary_for({c: FAMILIES for c in CONFIGS}))
    body = section(text)
    assert "not yet" not in body and "not in this release" not in body
    assert body.count("yes (1.0 GB)") == len(FAMILIES) * len(CONFIGS)
    assert "Every config is complete" in body
    assert "only)" not in text
