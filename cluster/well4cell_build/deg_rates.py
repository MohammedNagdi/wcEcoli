"""Degradation-rate provenance of a Parca cache: which mRNA half-lives are fits, and which are not.

The Parca (``reconstruction/ecoli/dataclasses/process/transcription.py``) gives each mRNA
transcription unit (TU) a degradation rate in one of four ways, and ``sim_data`` stores all of
them as the same kind of float:

* **imputed**: none of the TU's mRNA cistrons has a measured half-life, so each was given
  ``average_mRNA_cistron_half_life``, the mean of the measured mRNA cistron half-lives
  (transcription.py:331-361), and the TU's rate rests on that population mean.
* **floor**: a TU without a measured TU half-life is solved by NNLS with a lower bound equal to
  the slowest measured mRNA cistron rate (transcription.py:711-731); a TU whose solution equals
  the bound carries the bound, not a fit.
* **ceiling**: mRNA rates above the fastest measured mRNA cistron rate are clipped to it
  (transcription.py:734-737).
* **determined**: everything else, a rate fitted to (or measured for) that unit.

Floor and ceiling take precedence over imputed, as in Cellarium, so every mRNA TU is in
exactly one class. A TU whose only measured cistron is itself the slowest (fastest) one sits
on the floor (ceiling) and is counted there; that is indistinguishable from the bound. "Equals
the bound" is a relative tolerance (``RTOL``). The Parca later multiplies the rates of a few
TUs by hand-set factors (``sim_data.adjustments.rna_deg_rates_adjustments``,
fit_sim_data_1.py:1043-1097); the factor is divided out before classifying, and those units
are listed under ``adjusted_units``. Each unit is weighted by its basal expression
(``transcription.rna_expression['basal']``) as a share of all mRNA expression.

The JSON mirrors the keys of Cellarium's ``data/parca/deg_rate_baseline.json`` (MIT,
``_reader_worker.deg_rate_provenance``) where the meaning is the same, so the two files can be
compared. ``cellarium_rule`` repeats the classification with Cellarium's value-only rule (a TU
half-life equal, within 1e-9 min, to the slowest or fastest mRNA TU half-life or to the
imputation constant) as a cross-check.

Two halves. ``classify`` and ``provenance`` are pure (numpy arrays in, dict out) and are tested
on synthetic arrays. ``load_inputs`` unpickles ``<cache>/kb/simData.cPickle`` and
``rawData.cPickle`` with this repo's classes, so it runs only under the wcEcoli simulation
environment (wcecoli-sim), and it has not been run against a real cache: check the first
output (counts near Cellarium's 854 of 3,133 units and 12% of basal mRNA expression, every TU
in exactly one class). ``cluster/w4c deg-rates`` (``cmd_deg_rates``, under wcecoli-api) runs
this module once per Parca cache the index names, as::

    W4C_SIM_PYTHON -m well4cell_build.deg_rates <out>/parca_cache_<hash> --out <json> --parca-cache <hash>

writes ``build/provenance/deg_rates_<hash>.json`` and checks its ``kb_sha256`` against the
index. The file is a derived summary of the Stanford-licensed fitted parameters, so it stays in
the build directory and is never published (ADR 0009): ``finalize`` reads it for ``aggregates``
(the unit count of each class and the not-a-fit share of basal mRNA expression), which are all
that reaches the card and ``manifest.json``.

This module imports only numpy and the standard library at the top, so the simulation
environment can run it; the build-side helpers import the rest lazily.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import numpy as np

CLASSES = ("floor", "ceiling", "imputed", "determined")
NOT_A_FIT = ("floor", "ceiling", "imputed")
# Relative tolerance of "equals the bound". Measured half-lives are given to 0.1 min, so the
# nearest distinct rate to a bound differs by >= ~1e-3; NNLS noise is ~1e-12.
RTOL = 1e-6
# Cellarium's value-only rule compares half-lives in minutes with this absolute tolerance.
CELLARIUM_ATOL_MIN = 1e-9
TOP = 8
FILE_PREFIX = "deg_rates_"
NOTE = ("A unit that is on a bound or imputed did not get a fitted half-life. sim_data stores all three classes "
        "as the same kind of float, so any claim resting on one of these transcripts rests on a constraint or a "
        "population mean, not on a measurement of that transcript.")
RULES = {
    "floor": "no measured TU half-life and the NNLS solution equals the lower bound, the slowest measured mRNA "
             "cistron rate (within rtol)",
    "ceiling": "the rate equals the fastest measured mRNA cistron rate (within rtol): faster rates are clipped to it",
    "imputed": "not floor or ceiling, no measured TU half-life, and none of the unit's mRNA cistrons has a measured "
               "half-life, so it rests on average_mRNA_cistron_half_life",
    "determined": "every other mRNA unit",
    "adjusted": "rates multiplied by sim_data.adjustments.rna_deg_rates_adjustments are divided by the factor before "
                "classifying",
}


def _share(mask: np.ndarray, expression: np.ndarray, total: float, n_mrna: int) -> dict:
    """Cellarium's per-class block: units, percent of mRNA units, percent of mRNA expression."""
    n = int(mask.sum())
    return {"n_units": n, "pct_units": round(100.0 * n / max(n_mrna, 1), 2),
            "pct_expression": round(100.0 * float(expression[mask].sum()) / total, 3)}


def classify(is_mrna: np.ndarray, deg_rate: np.ndarray, tu_measured: np.ndarray, cistron_tu,
             cistron_half_life_s: np.ndarray, cistron_is_mrna: np.ndarray,
             adjustment: np.ndarray | None = None, rtol: float = RTOL) -> dict:
    """Classify every TU. Arrays over TUs: ``is_mrna``, ``deg_rate`` (1/s, as stored in sim_data),
    ``tu_measured`` (the TU's own half-life was measured: ``rna_data['deg_rate_is_measured']``),
    ``adjustment`` (the factor the Parca multiplied the rate by, 1 when none). Over cistrons:
    ``cistron_half_life_s`` (measured half-life, NaN when unmeasured) and ``cistron_is_mrna``.
    ``cistron_tu`` is the [cistron, TU] membership matrix (numpy or scipy sparse).

    Returns ``classes`` (an array of class names, "" for non-mRNA TUs), the boolean ``masks``,
    ``floor_rate`` and ``ceiling_rate`` (1/s). Raises if a mRNA TU lands in no class or two."""
    is_mrna = np.asarray(is_mrna, dtype=bool)
    rate = np.asarray(deg_rate, dtype=float)
    if adjustment is not None:
        rate = rate / np.asarray(adjustment, dtype=float)
    measured_tu = np.asarray(tu_measured, dtype=bool)
    half_life = np.asarray(cistron_half_life_s, dtype=float)
    measured_mrna_cistron = np.isfinite(half_life) & np.asarray(cistron_is_mrna, dtype=bool)
    if not measured_mrna_cistron.any():
        raise ValueError("no measured mRNA cistron half-life: cannot locate the floor and ceiling")
    floor_rate = float(np.log(2) / half_life[measured_mrna_cistron].max())
    ceiling_rate = float(np.log(2) / half_life[measured_mrna_cistron].min())
    measured_per_tu = np.asarray(cistron_tu.T @ measured_mrna_cistron.astype(float)).ravel()

    ceiling = is_mrna & (rate >= ceiling_rate * (1 - rtol))
    floor = is_mrna & ~ceiling & ~measured_tu & (rate <= floor_rate * (1 + rtol))
    imputed = is_mrna & ~ceiling & ~floor & ~measured_tu & (measured_per_tu == 0)
    determined = is_mrna & ~ceiling & ~floor & ~imputed
    masks = {"floor": floor, "ceiling": ceiling, "imputed": imputed, "determined": determined}
    hits = sum(m.astype(int) for m in masks.values())
    if (hits[is_mrna] != 1).any() or (hits[~is_mrna] != 0).any():
        raise ValueError("classification is not a partition of the mRNA units")
    classes = np.full(is_mrna.shape[0], "", dtype=object)
    for name, mask in masks.items():
        classes[mask] = name
    return {"classes": classes, "masks": masks, "floor_rate": floor_rate, "ceiling_rate": ceiling_rate}


def cellarium_rule(is_mrna: np.ndarray, deg_rate: np.ndarray, imputation_half_life_s: float) -> dict:
    """Counts under Cellarium's value-only rule on the stored rates (no adjustment undone)."""
    is_mrna = np.asarray(is_mrna, dtype=bool)
    with np.errstate(divide="ignore", invalid="ignore"):
        minutes = np.log(2) / np.asarray(deg_rate, dtype=float) / 60.0
    slowest, fastest = float(np.nanmax(minutes[is_mrna])), float(np.nanmin(minutes[is_mrna]))
    floor = is_mrna & (np.abs(minutes - slowest) < CELLARIUM_ATOL_MIN)
    ceiling = is_mrna & (np.abs(minutes - fastest) < CELLARIUM_ATOL_MIN)
    imputed = is_mrna & (np.abs(minutes - imputation_half_life_s / 60.0) < CELLARIUM_ATOL_MIN) & ~floor & ~ceiling
    return {"floor": int(floor.sum()), "ceiling": int(ceiling.sum()), "imputed": int(imputed.sum()),
            "not_a_fit": int((floor | ceiling | imputed).sum()),
            "rule": "a TU half-life within {:g} min of the slowest or fastest mRNA TU half-life, or of the "
                    "imputation constant (Cellarium _reader_worker.deg_rate_provenance)".format(CELLARIUM_ATOL_MIN)}


def provenance(tu_ids, is_mrna: np.ndarray, deg_rate: np.ndarray, tu_measured: np.ndarray, cistron_tu,
               cistron_half_life_s: np.ndarray, cistron_is_mrna: np.ndarray, imputation_half_life_s: float,
               expression: np.ndarray, adjustment: np.ndarray | None = None,
               conditions: dict[str, np.ndarray] | None = None, rtol: float = RTOL) -> dict:
    """The provenance document (without ``kb_sha256`` / ``parca_cache``): Cellarium's keys plus
    ``determined``, ``adjusted_units``, ``cellarium_rule`` and ``rules``. ``expression`` is the
    basal expression over all TUs; ``conditions`` (name -> expression) adds Cellarium's
    ``not_a_fit_across_conditions``."""
    ids = [str(i) for i in tu_ids]
    is_mrna = np.asarray(is_mrna, dtype=bool)
    result = classify(is_mrna, deg_rate, tu_measured, cistron_tu, cistron_half_life_s, cistron_is_mrna,
                      adjustment, rtol)
    masks = result["masks"]
    expression = np.asarray(expression, dtype=float)
    total = float(expression[is_mrna].sum()) or 1.0
    n_mrna = int(is_mrna.sum())
    not_a_fit = masks["floor"] | masks["ceiling"] | masks["imputed"]

    def per_unit(mask: np.ndarray) -> dict:
        return {ids[i]: round(100.0 * float(expression[i]) / total, 6) for i in np.flatnonzero(mask)}

    top = sorted(np.flatnonzero(not_a_fit), key=lambda i: (-expression[i], ids[i]))[:TOP]
    measured = np.asarray(cistron_half_life_s, dtype=float)[
        np.isfinite(cistron_half_life_s) & np.asarray(cistron_is_mrna, dtype=bool)]
    document = {
        "generated_by": "well4cell_build.deg_rates",
        "n_mrna_units": n_mrna,
        "rate_floor_as_half_life_min": round(float(np.log(2) / result["floor_rate"]) / 60.0, 4),
        "rate_ceiling_as_half_life_min": round(float(np.log(2) / result["ceiling_rate"]) / 60.0, 4),
        "imputation_constant_min": round(imputation_half_life_s / 60.0, 6),
        "n_measured_mrna_cistrons": int(measured.size),
        "on_floor": _share(masks["floor"], expression, total, n_mrna),
        "on_ceiling": _share(masks["ceiling"], expression, total, n_mrna),
        "imputed_average": _share(masks["imputed"], expression, total, n_mrna),
        "not_a_fit": _share(not_a_fit, expression, total, n_mrna),
        "determined": _share(masks["determined"], expression, total, n_mrna),
        "most_expressed_not_a_fit": [{"id": ids[i], "class": result["classes"][i],
                                      "pct_of_mrna_expression": round(100.0 * float(expression[i]) / total, 4)}
                                     for i in top],
        "units_not_a_fit": {"floor": per_unit(masks["floor"]), "ceiling": per_unit(masks["ceiling"]),
                            "imputed": per_unit(masks["imputed"]),
                            "determined_is_the_complement": int(masks["determined"].sum())},
        "rtol": rtol,
        "rules": RULES,
        "cellarium_rule": cellarium_rule(is_mrna, deg_rate, imputation_half_life_s),
        "note": NOTE,
    }
    warnings = []
    if measured.size and not np.isclose(measured.mean(), imputation_half_life_s, rtol=1e-6):
        warnings.append("imputation constant {:.6f} min differs from the mean of the measured mRNA cistron "
                        "half-lives {:.6f} min".format(imputation_half_life_s / 60.0, measured.mean() / 60.0))
    if adjustment is not None:
        factors = np.asarray(adjustment, dtype=float)
        changed = np.flatnonzero(is_mrna & (factors != 1.0))
        document["adjusted_units"] = {ids[i]: {"factor": float(factors[i]), "class": result["classes"][i]}
                                      for i in changed}
    if conditions:
        spread = []
        for name, vector in conditions.items():
            vector = np.asarray(vector, dtype=float)
            denominator = float(vector[is_mrna].sum())
            if denominator > 0:
                spread.append((100.0 * float(vector[not_a_fit].sum()) / denominator, str(name)))
        spread.sort()
        if spread:
            document["not_a_fit_across_conditions"] = {
                "n_conditions": len(spread), "condition_used": "basal",
                "min_pct": round(spread[0][0], 3), "min_condition": spread[0][1],
                "max_pct": round(spread[-1][0], 3), "max_condition": spread[-1][1],
                "median_pct": round(spread[len(spread) // 2][0], 3)}
    if warnings:
        document["warnings"] = warnings
    return document


# -- loading (wcecoli-sim only; not testable without a cache) -----------------------------------
def kb_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_inputs(cache_dir: Path) -> dict:
    """The keyword arguments of ``provenance`` from ``<cache_dir>/kb``. Attribute names are this
    repo's transcription.py: ``rna_data['id' | 'is_mRNA' | 'deg_rate' | 'deg_rate_is_measured']``,
    ``cistron_data['id' | 'gene_id' | 'is_mRNA']``, ``cistron_tu_mapping_matrix``,
    ``average_mRNA_cistron_half_life``, ``rna_expression``; measured cistron half-lives are
    ``raw_data.rna_half_lives`` mapped gene id -> cistron exactly as transcription.py:331-336."""
    import pickle

    from wholecell.utils import units

    with (cache_dir / "kb" / "simData.cPickle").open("rb") as stream:
        sim_data = pickle.load(stream)
    with (cache_dir / "kb" / "rawData.cPickle").open("rb") as stream:
        raw_data = pickle.load(stream)
    transcription = sim_data.process.transcription
    rna = transcription.rna_data
    cistrons = transcription.cistron_data
    tu_ids = [str(x) for x in rna["id"]]
    cistron_ids = [str(x) for x in cistrons["id"]]
    position = {c: i for i, c in enumerate(cistron_ids)}
    gene_to_cistron = {str(g): c for c, g in zip(cistron_ids, cistrons["gene_id"])}
    half_life = np.full(len(cistron_ids), np.nan)
    for entry in raw_data.rna_half_lives:
        seconds = entry["half_life"].asNumber(units.s)
        if entry["id"] in gene_to_cistron and seconds > 0:
            half_life[position[gene_to_cistron[entry["id"]]]] = seconds

    # fit_sim_data_1.setRNADegRates: a cistron id adjusts every TU containing it, a TU id (without
    # its compartment) adjusts that TU; a TU adjusted twice takes the larger factor.
    tu_position = {t[:-3]: i for i, t in enumerate(tu_ids)}
    factors: dict[int, float] = {}
    for mol_id, factor in sim_data.adjustments.rna_deg_rates_adjustments.items():
        if mol_id in position:
            indexes = list(transcription.cistron_id_to_rna_indexes(mol_id))
        elif mol_id in tu_position:
            indexes = [tu_position[mol_id]]
        else:
            raise ValueError("rna_deg_rates_adjustments names {}, neither a cistron nor a TU".format(mol_id))
        for i in indexes:
            factors[int(i)] = max(factors.get(int(i), 0.0), float(factor))
    adjustment = np.ones(len(tu_ids))
    for i, factor in factors.items():
        adjustment[i] = factor

    return {
        "tu_ids": tu_ids,
        "is_mrna": np.asarray(rna["is_mRNA"], dtype=bool),
        "deg_rate": np.asarray(rna["deg_rate"].asNumber(1 / units.s), dtype=float),
        "tu_measured": np.asarray(rna["deg_rate_is_measured"], dtype=bool),
        "cistron_tu": transcription.cistron_tu_mapping_matrix,
        "cistron_half_life_s": half_life,
        "cistron_is_mrna": np.asarray(cistrons["is_mRNA"], dtype=bool),
        "imputation_half_life_s": float(transcription.average_mRNA_cistron_half_life.asNumber(units.s)),
        "expression": np.asarray(transcription.rna_expression["basal"], dtype=float),
        "adjustment": adjustment,
        "conditions": {str(k): np.asarray(v, dtype=float) for k, v in transcription.rna_expression.items()},
    }


def write_json(document: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main(argv: list[str] | None = None) -> None:
    """Simulation-environment entry: classify one cache and write the JSON."""
    parser = argparse.ArgumentParser(prog="python -m well4cell_build.deg_rates", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cache_dir", help="out/parca_cache_<hash>")
    parser.add_argument("--out", required=True, help="the JSON to write")
    parser.add_argument("--parca-cache", help="the cache name as the index has it (default: the directory name "
                                              "minus parca_cache_)")
    args = parser.parse_args(argv)
    cache_dir = Path(args.cache_dir)
    name = args.parca_cache or cache_dir.name.replace("parca_cache_", "", 1)
    document = {"parca_cache": name, "kb_sha256": kb_sha256(cache_dir / "kb" / "simData.cPickle"),
                **provenance(**load_inputs(cache_dir))}
    write_json(document, Path(args.out))
    print("{}: {} of {} mRNA units not a fit ({}% of basal mRNA expression); floor {}, ceiling {}, imputed {}".format(
        name, document["not_a_fit"]["n_units"], document["n_mrna_units"], document["not_a_fit"]["pct_expression"],
        document["on_floor"]["n_units"], document["on_ceiling"]["n_units"], document["imputed_average"]["n_units"]))


# -- build side (wcecoli-api, via cluster/w4c) -----------------------------------------------
def output_path(settings, parca_cache: str) -> Path:
    return settings.build_dir / "provenance" / "{}{}.json".format(FILE_PREFIX, parca_cache)


def run_child(settings, cache_dir: Path, out: Path, parca_cache: str) -> None:
    """Run ``main`` under the simulation environment (W4C_SIM_PYTHON), which can unpickle sim_data."""
    if not settings.sim_python:
        raise SystemExit("W4C_SIM_PYTHON is not set; source cluster/well4cell_env.sh")
    root = settings.repo_root
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(root / "cluster"), str(root)] +
                                        ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    argv = shlex.split(settings.sim_python) + ["-m", "well4cell_build.deg_rates", str(cache_dir),
                                               "--out", str(out), "--parca-cache", parca_cache]
    print("+ " + " ".join(shlex.quote(a) for a in argv), flush=True)
    completed = subprocess.run(argv, cwd=str(root), env=env)
    if completed.returncode != 0:
        raise SystemExit("deg-rates failed for {} (exit {})".format(cache_dir, completed.returncode))


def cmd_deg_rates(settings, args: argparse.Namespace) -> list[dict]:
    """One JSON per Parca cache the index names (or ``--cache``), checked against the index's kb_sha256."""
    import pyarrow.parquet as pq

    from .finalize import kb_sha256_by_cache
    from .ledger import append_jsonl, now

    expected: dict[str, str | None] = {}
    if settings.index_path.exists():
        expected = kb_sha256_by_cache(pq.read_table(settings.index_path, columns=["parca_cache", "kb_sha256"]))
    caches = [c.strip() for c in args.cache.split(",") if c.strip()] if args.cache else sorted(expected)
    if not caches:
        raise SystemExit("no Parca cache to classify: build the index first (`w4c index build`) or pass --cache")
    reports = []
    for cache in caches:
        cache_dir = settings.out_dir / ("parca_cache_" + cache)
        if not (cache_dir / "kb" / "simData.cPickle").exists():
            raise SystemExit("{} has no kb/simData.cPickle".format(cache_dir))
        out = output_path(settings, cache)
        run_child(settings, cache_dir, out, cache)
        document = json.loads(out.read_text())
        want = expected.get(cache)
        if want and document.get("kb_sha256") != want:
            out.rename(out.with_name(out.name + ".mismatch"))
            raise SystemExit("{}: simData.cPickle hashes to {} but the index records {}; the cache changed since "
                             "`index build`".format(cache, document.get("kb_sha256"), want))
        if not want:
            print("WARNING: the index does not name parca cache {}; finalize will not summarise {}".format(cache, out),
                  file=sys.stderr)
        report = {"parca_cache": cache, "path": str(out), **aggregates(document)}
        reports.append(report)
        print("wrote {}".format(out))
    append_jsonl(settings.ledger, {"at": now(), "stage": "deg-rates", "caches": reports})
    return reports


def aggregates(document: dict) -> dict:
    """The only figures of a classification that are published (card and manifest.json): the
    count of mRNA units in each class and in all, and the percent of basal mRNA expression the
    not-a-fit classes carry. No unit ids, no bounds, no imputation constant (ADR 0009). A figure
    the document lacks is None."""
    def count(key: str):
        return (document.get(key) or {}).get("n_units")
    return {"kb_sha256": document.get("kb_sha256"),
            "mrna_units": {"floor": count("on_floor"), "ceiling": count("on_ceiling"),
                           "imputed": count("imputed_average"), "determined": count("determined"),
                           "total": document.get("n_mrna_units")},
            "not_a_fit_pct_basal_mrna_expression": (document.get("not_a_fit") or {}).get("pct_expression")}


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("deg-rates", help="classify each Parca cache's mRNA degradation rates (floor, ceiling, "
                                              "imputed, determined) into build/provenance/deg_rates_<cache>.json "
                                              "(kept on the build side; only counts are published)")
    parser.add_argument("--cache", help="comma-separated parca cache hashes (default: every cache the index names)")
    parser.set_defaults(func=cmd_deg_rates)


if __name__ == "__main__":
    main()
