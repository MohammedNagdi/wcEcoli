"""Stage 4: fold the export sentinels into the published tree.

``finalize`` is re-runnable and touches only repo/ (plus a ledger line):

1. index locators   <config>_file / _row_offset / _n_rows filled from ok export sentinels
2. export_qc        provenance/export_qc.parquet, one row per trajectory per config attempt
3. stats            stats/<family>.parquet reduced from the per-part stats npz files
4. failed jobs      provenance/failed_jobs.parquet (campaign DB, read-only) and
                    provenance/scan_runs.parquet (build/scan/runs.jsonl)
5. card             README.md from card.render
6. manifest         manifest.json: version, commit, row/byte totals, counts, and the
                    kb_sha256 of each Parca cache the index names
7. deg rates        build/provenance/deg_rates_<cache>.json (written by ``deg-rates``) read
                    for their aggregate figures (units per class, not-a-fit share of basal
                    mRNA expression) in the card and manifest; the files themselves are
                    never copied into repo/ (ADR 0009); absent files are not an error

The ``summary`` config (data/summary/<family>/part-00000.parquet, written by ``summarize``
from core, not by export) has no sentinels and no index locators. When present it is counted
in the card and manifest from the files themselves (one row per trajectory); when absent
nothing refuses. A summary family whose row count differs from the index's located core
trajectories gets a warning: re-run ``summarize`` and then finalize. From the summary parts
finalize also counts Cellarium's ``translation_collapse`` (``ribosome_elongation_rate_mean <
COLLAPSE_RATE``, and how many of those divided) for the card's Outcomes and manifest.json.

The Parca caches are not copied into repo/: they are wcEcoli's fitted parameters, under
the Stanford licence, and the repo identifies them only by ``parca_cache`` and
``kb_sha256`` (ADR 0009). finalize refuses an index without ``kb_sha256`` (built before
that column existed; re-run ``index build``).

Completeness. finalize refuses while any part planned for the configs being finalized
(``--configs``, default all) has no sentinel or a failed one, and only warns about
incomplete parts of other configs; ``--allow-incomplete`` overrides the refusal (the
trajectories of failed parts are then listed in export_qc and have null locators).

Stats npz layout read here (contract with stats.py, SPEC.md): ``names`` plus
``<name>.n|sum|sumsq|min|max`` (stats.Moments.save). For robustness any key of the form
``<channel><sep><stat>`` with sep one of ``/ . __ :`` is also accepted. Scalars are shape
() or (1,); matrices are [n_active] in product-column order.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import card
from . import deg_rates as deg_rate_provenance
from .ledger import append_jsonl, now, read_json, read_jsonl, rename_into_place, temp_path_for, write_atomic_json
from .pathways import PREFIX as PATHWAY_PREFIX
from .settings import COLLAPSE_RATE, CONFIGS, FAMILIES, MATRIX_CHANNELS, SCALAR_CHANNELS, SUMMARY_CONFIG, Settings

STATS = ("n", "sum", "sumsq", "min", "max")
_STAT_KEY = re.compile(r"^(?P<channel>.+?)(?:/|\.|__|:)(?P<stat>n|sum|sumsq|min|max)$")
# Units as written by interface/backend/hf_export/converter.py; overridden by the parquet
# field metadata of the published files whenever one exists.
UNITS = {
    "t": "s", "t_abs": "s",
    "cell_mass": "fg", "dry_mass": "fg", "protein_mass": "fg", "rna_mass": "fg", "dna_mass": "fg",
    "small_molecule_mass": "fg", "cell_volume": "fL", "growth_rate": "1/s", "ppgpp_conc": "uM",
    "aa_supply_total": "counts/s", "aa_synthesis_total": "counts/s", "mrna_counts": "molecules",
    "n_oric": "count", "fba_objective": "mmol/gDCW/h", "exchange_flux_total": "mmol/gDCW/h",
    "reaction_flux_total": "mmol/gDCW/h", "ribosome_elongation_rate": "aa/s",
    "ribosome_actual_elongations": "aa",
    "mrna_counts_matrix": "molecules", "protein_counts_matrix": "molecules",
    "reaction_flux_matrix": "mmol/gDCW/h", "exchange_flux_matrix": "mmol/gDCW/h",
}
# In the converter's channel allow-list but never present in any channels.h5.
NEVER_RECORDED = ("aa_pool_size", "ntp_pool_size", "trna_charged_fraction")


def reference_name(matrix: str) -> str:
    return matrix.replace("_matrix", "")


# -- sentinels ----------------------------------------------------------------------------
def export_sentinels(settings: Settings) -> list[tuple[Path, dict]]:
    """Every export sentinel (every attempt), oldest first."""
    found = []
    for sdir in sorted(settings.manifest_dir.glob("export_*.sentinels")):
        for path in sdir.rglob("*.json"):
            record = read_json(path)
            if "config" not in record or "path" not in record:
                continue  # a shard summary, not a part sentinel
            record.setdefault("plan", sdir.name[: -len(".sentinels")])
            if "part" not in record and path.stem.isdigit():
                record["part"] = int(path.stem)
            found.append((path, record))
    found.sort(key=lambda item: item[0].stat().st_mtime)
    return found


def _manifest_samples(settings: Settings) -> dict[tuple[str, int], list[dict]]:
    """(plan, part) -> planned samples, to report the trajectories of parts that failed outright."""
    planned = {}
    for manifest in settings.manifest_dir.glob("export_*.jsonl"):
        for line in read_jsonl(manifest):
            planned[(line.get("plan", manifest.stem), line.get("part"))] = line.get("samples", [])
    return planned


def current_parts(sentinels: list[tuple[Path, dict]]) -> dict[str, dict]:
    """path -> the newest ok sentinel for it; an older attempt at the same path is superseded.

    An ok part whose every trajectory failed QC writes no file (path null); it has no data,
    locators or stats, only export_qc rows.
    """
    parts: dict[str, dict] = {}
    for _, record in sentinels:
        if record.get("status") == "ok" and record.get("path"):
            parts[record["path"]] = record
    return parts


def locators(parts: dict[str, dict]) -> dict[str, dict[str, tuple[str, int, int]]]:
    """config -> sample_id -> (path, row_offset, n_rows) for every QC-passing trajectory.

    Refuses when one trajectory sits in two different files of the same config: the
    index could point at only one of them and the other would be a duplicate in the data.
    """
    out: dict[str, dict[str, tuple[str, int, int]]] = {}
    conflicts = []
    for path, record in sorted(parts.items()):
        table = out.setdefault(record["config"], {})
        for sample in record.get("samples", []):
            if not sample.get("qc", {}).get("ok", True) or not sample.get("n_rows"):
                continue
            entry = (path, int(sample["row_offset"]), int(sample["n_rows"]))
            previous = table.get(sample["sample_id"])
            if previous is not None and previous[0] != path:
                conflicts.append((record["config"], sample["sample_id"], previous[0], path))
                continue
            table[sample["sample_id"]] = entry
    if conflicts:
        lines = "\n".join("  {} {}: {} and {}".format(*c) for c in conflicts[:20])
        raise SystemExit("{} trajectories have ok exports in two files of the same config:\n{}".format(
            len(conflicts), lines))
    return out


def incomplete_parts(settings: Settings) -> list[dict]:
    """Planned parts (every export manifest) whose sentinel is missing or not ok."""
    out = []
    for manifest in sorted(settings.manifest_dir.glob("export_*.jsonl")):
        sdir = manifest.with_name(manifest.stem + ".sentinels")
        for line in read_jsonl(manifest):
            path = sdir / "{:05d}.json".format(line["part"])
            status = read_json(path).get("status") if path.exists() else None
            if status != "ok":
                out.append({"manifest": manifest.name, "part": line["part"], "config": line["config"],
                            "path": line["path"], "status": status or "no sentinel"})
    return out


def check_complete(settings: Settings, configs: list[str], allow_incomplete: bool) -> list[dict]:
    """Refuse for the configs being finalized; warn for the others."""
    incomplete = incomplete_parts(settings)
    mine = [p for p in incomplete if p["config"] in configs]
    others = [p for p in incomplete if p["config"] not in configs]
    if others:
        print("WARNING: {} planned part(s) of configs not being finalized are incomplete ({}); their "
              "locators are left as they are".format(len(others), sorted({p["config"] for p in others})),
              file=sys.stderr)
    if mine:
        lines = "\n".join("  {manifest}#{part} {path}: {status}".format(**p) for p in mine[:20])
        message = "{} planned part(s) of {} lack an ok sentinel:\n{}".format(len(mine), ",".join(configs), lines)
        if not allow_incomplete:
            raise SystemExit(message + "\nrun `export dispatch` / `export reconcile` until they are ok, "
                             "or pass --allow-incomplete")
        print("WARNING (--allow-incomplete): " + message, file=sys.stderr)
    return mine


# -- 1. index locators ---------------------------------------------------------------------
def _set_column(table: pa.Table, name: str, array: pa.Array) -> pa.Table:
    index = table.schema.get_field_index(name)
    if index < 0:
        return table.append_column(pa.field(name, array.type), array)
    field = table.schema.field(index).with_type(array.type)
    return table.set_column(index, field, array)


def fill_index(settings: Settings, located: dict, configs: list[str]) -> dict:
    table = pq.read_table(settings.index_path)
    sample_ids = table.column("sample_id").to_pylist()
    known = set(sample_ids)
    report = {}
    for config in configs:
        by_sample = located.get(config, {})
        files, offsets, counts = [], [], []
        for sample_id in sample_ids:
            entry = by_sample.get(sample_id)
            files.append(entry[0] if entry else None)
            offsets.append(entry[1] if entry else None)
            counts.append(entry[2] if entry else None)
        table = _set_column(table, config + "_file", pa.array(files, pa.string()))
        table = _set_column(table, config + "_row_offset", pa.array(offsets, pa.int64()))
        table = _set_column(table, config + "_n_rows", pa.array(counts, pa.int32()))
        unknown = sorted(set(by_sample) - known)
        if unknown:
            print("WARNING: {} {} trajectories exported but absent from the index, e.g. {}".format(
                len(unknown), config, unknown[:5]), file=sys.stderr)
        report[config] = {"located": len(by_sample) - len(unknown), "not_in_index": len(unknown)}
    temporary = temp_path_for(settings.index_path)
    pq.write_table(table, temporary, compression=settings.compression)
    rename_into_place(temporary, settings.index_path)
    return report


# -- 2. export QC ----------------------------------------------------------------------------
def write_export_qc(settings: Settings, sentinels: list[tuple[Path, dict]]) -> dict:
    planned = _manifest_samples(settings)
    rows = {"sample_id": [], "config": [], "family": [], "ok": [], "reasons": [], "part": []}

    def add(sample_id, record, ok, reasons):
        rows["sample_id"].append(sample_id)
        rows["config"].append(record.get("config"))
        rows["family"].append(record.get("family"))
        rows["ok"].append(bool(ok))
        rows["reasons"].append([str(r) for r in reasons])
        rows["part"].append(record.get("path") or record.get("planned_path"))

    for _, record in sentinels:
        if record.get("status") == "ok":
            for sample in record.get("samples") or []:
                qc = sample.get("qc", {})
                add(sample["sample_id"], record, qc.get("ok", True), qc.get("reasons", []))
        else:
            error = (record.get("error") or "part failed").strip().splitlines()
            reason = "part failed: " + (error[-1] if error else "")
            samples = record.get("samples") or planned.get((record.get("plan"), record.get("part")), [])
            for sample in samples:
                add(sample["sample_id"], record, False, [reason])
    table = pa.table({
        "sample_id": pa.array(rows["sample_id"], pa.string()),
        "config": pa.array(rows["config"], pa.string()),
        "family": pa.array(rows["family"], pa.string()),
        "ok": pa.array(rows["ok"], pa.bool_()),
        "reasons": pa.array(rows["reasons"], pa.list_(pa.string())),
        "part": pa.array(rows["part"], pa.string()),
    })
    _write_table(table, settings.repo_dir / "provenance" / "export_qc.parquet", settings)
    return {"attempts": table.num_rows, "failed": table.num_rows - int(sum(rows["ok"]))}


# -- 3. stats --------------------------------------------------------------------------------
def read_stats_npz(path: Path) -> dict[str, dict[str, np.ndarray]]:
    out: dict[str, dict[str, np.ndarray]] = {}
    with np.load(path) as handle:
        if "names" in handle.files:  # stats.Moments layout: names are exact, no key parsing
            for name in handle["names"].tolist():
                out[name] = {stat: np.atleast_1d(handle["{}.{}".format(name, stat)]).astype(np.float64)
                             for stat in STATS}
            return out
        for key in handle.files:
            match = _STAT_KEY.match(key)
            if match is None:
                continue
            out.setdefault(match["channel"], {})[match["stat"]] = np.atleast_1d(handle[key]).astype(np.float64)
    for channel, stats in out.items():
        missing = [s for s in STATS if s not in stats]
        if missing:
            raise ValueError("{}: channel {} lacks {}".format(path, channel, missing))
    return out


def combine(partials: list[dict[str, np.ndarray]]) -> dict[str, np.ndarray]:
    """Fold per-part partial sums: n, sum, sumsq add; min, max reduce."""
    total = {s: partials[0][s].copy() for s in STATS}
    for part in partials[1:]:
        if part["n"].shape != total["n"].shape:
            raise ValueError("stats shape mismatch: {} vs {}".format(part["n"].shape, total["n"].shape))
        for s in ("n", "sum", "sumsq"):
            total[s] += part[s]
        total["min"] = np.fmin(total["min"], part["min"])
        total["max"] = np.fmax(total["max"], part["max"])
    return total


def moments(total: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Mean and population std; NaN where n == 0."""
    n = total["n"]
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(n > 0, total["sum"] / n, np.nan)
        variance = np.where(n > 0, total["sumsq"] / n - mean * mean, np.nan)
    return mean, np.sqrt(np.clip(variance, 0.0, None))


def _resolve(settings: Settings, sentinel_path: Path | None, raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    for base in ([sentinel_path.parent] if sentinel_path else []) + [settings.build_dir, settings.root, settings.repo_dir]:
        if (base / path).exists():
            return base / path
    return settings.root / path


def reference_ids(settings: Settings) -> dict[str, dict[int, str]]:
    out = {}
    for matrix in MATRIX_CHANNELS:
        path = settings.reference_dir / (reference_name(matrix) + ".parquet")
        if not path.exists():
            continue
        table = pq.read_table(path, columns=["id", "product_column"]).to_pydict()
        out[matrix] = {int(c): i for i, c in zip(table["id"], table["product_column"]) if c is not None}
    return out


def write_stats(settings: Settings, parts: dict[str, dict], paths: dict[str, Path]) -> dict:
    """stats/<family>.parquet: one row per (product, channel, column)."""
    grouped: dict[tuple[str, str, str], list[dict[str, np.ndarray]]] = {}
    for path, record in sorted(parts.items()):
        if not record.get("stats_npz"):
            print("WARNING: part {} has no stats npz".format(path), file=sys.stderr)
            continue
        for channel, stats in read_stats_npz(_resolve(settings, paths.get(path), record["stats_npz"])).items():
            grouped.setdefault((record["family"], record["config"], channel), []).append(stats)
    ids = reference_ids(settings)
    by_family: dict[str, dict[str, list]] = {}
    channel_order = {c: i for i, c in enumerate(SCALAR_CHANNELS + MATRIX_CHANNELS)}
    for (family, config, channel), partials in sorted(
            grouped.items(), key=lambda kv: (kv[0][0], list(CONFIGS).index(kv[0][1]) if kv[0][1] in CONFIGS else 99,
                                             channel_order.get(kv[0][2], 999), kv[0][2])):
        total = combine(partials)
        mean, std = moments(total)
        empty = total["n"] == 0  # stats.py leaves min=+inf, max=-inf where nothing finite was seen
        total["min"] = np.where(empty, np.nan, total["min"])
        total["max"] = np.where(empty, np.nan, total["max"])
        columns = by_family.setdefault(family, {k: [] for k in
                                                ("product", "channel", "column", "column_id", "mean", "std", "min", "max", "n_rows")})
        is_matrix = channel in MATRIX_CHANNELS
        if is_matrix and channel in ids and len(ids[channel]) != total["n"].shape[0]:
            raise SystemExit("stats for {} {} have {} columns; reference has {} active".format(
                config, channel, total["n"].shape[0], len(ids[channel])))
        for column in range(total["n"].shape[0]):
            columns["product"].append(config)
            columns["channel"].append(channel)
            columns["column"].append(column if is_matrix else None)
            columns["column_id"].append(ids.get(channel, {}).get(column) if is_matrix else None)
            columns["mean"].append(float(mean[column]))
            columns["std"].append(float(std[column]))
            columns["min"].append(float(total["min"][column]))
            columns["max"].append(float(total["max"][column]))
            columns["n_rows"].append(int(total["n"][column]))
    written = {}
    for family, columns in by_family.items():
        table = pa.table({
            "product": pa.array(columns["product"], pa.string()),
            "channel": pa.array(columns["channel"], pa.string()),
            "column": pa.array(columns["column"], pa.int32()),
            "column_id": pa.array(columns["column_id"], pa.string()),
            "mean": pa.array(columns["mean"], pa.float64()),
            "std": pa.array(columns["std"], pa.float64()),
            "min": pa.array(columns["min"], pa.float64()),
            "max": pa.array(columns["max"], pa.float64()),
            "n_rows": pa.array(columns["n_rows"], pa.int64()),
        })
        _write_table(table, settings.repo_dir / "stats" / (family + ".parquet"), settings)
        written[family] = table.num_rows
    return written


# -- 4. failed jobs, scan runs ---------------------------------------------------------------
def write_failed_jobs(settings: Settings, runs: dict[str, dict]) -> dict:
    connection = sqlite3.connect("file:{}?mode=ro".format(settings.database), uri=True)
    connection.row_factory = sqlite3.Row
    rows = [dict(r) for r in connection.execute(
        "select j.id as job_id, e.name as experiment, j.variant_type, j.variant_index, j.condition, j.seed, "
        "j.attempt, j.error_message, j.sim_dir from simulation_jobs j join experiments e on e.id = j.experiment_id "
        "where j.status = 'failed' order by j.id").fetchall()]
    connection.close()
    for row in rows:
        run = runs.get(Path(row["sim_dir"]).name) if row["sim_dir"] else None
        row["run_dir"] = Path(row.pop("sim_dir")).name if row["sim_dir"] else None
        row["scan_status"] = run.get("status") if run else None
        row["generations_present"] = len(run.get("generations") or []) if run and run.get("status") == "ok" else None
    table = pa.table({
        "job_id": pa.array([r["job_id"] for r in rows], pa.int32()),
        "experiment": pa.array([r["experiment"] for r in rows], pa.string()),
        "variant_type": pa.array([r["variant_type"] for r in rows], pa.string()),
        "variant_index": pa.array([r["variant_index"] for r in rows], pa.int32()),
        "condition": pa.array([r["condition"] for r in rows], pa.string()),
        "seed": pa.array([r["seed"] for r in rows], pa.int32()),
        "attempt": pa.array([r["attempt"] for r in rows], pa.int32()),
        "error_message": pa.array([r["error_message"] for r in rows], pa.string()),
        "run_dir": pa.array([r["run_dir"] for r in rows], pa.string()),
        "scan_status": pa.array([r["scan_status"] for r in rows], pa.string()),
        "generations_present": pa.array([r["generations_present"] for r in rows], pa.int32()),
    })
    _write_table(table, settings.repo_dir / "provenance" / "failed_jobs.parquet", settings)
    return {"failed_jobs": table.num_rows,
            "with_generations": sum(1 for r in rows if r["generations_present"])}


def write_scan_runs(settings: Settings, runs: dict[str, dict]) -> int:
    records = sorted(runs.values(), key=lambda r: r["run_dir"])
    table = pa.table({
        "run_dir": pa.array([r["run_dir"] for r in records], pa.string()),
        "job_id": pa.array([r.get("job_id") for r in records], pa.int32()),
        "job_status": pa.array([r.get("job_status") for r in records], pa.string()),
        "status": pa.array([r.get("status") for r in records], pa.string()),
        "seed": pa.array([r.get("seed") for r in records], pa.int32()),
        "n_generations": pa.array([len(r.get("generations") or []) for r in records], pa.int32()),
        "n_steps": pa.array([sum(g.get("n_steps", 0) for g in r.get("generations") or []) for r in records], pa.int64()),
        "reference_hash": pa.array([r.get("reference_hash") for r in records], pa.string()),
        "error": pa.array([(r.get("error") or None) and r["error"].strip().splitlines()[-1] for r in records], pa.string()),
    })
    _write_table(table, settings.repo_dir / "provenance" / "scan_runs.parquet", settings)
    return table.num_rows


# -- fitted parameters (identified by hash, never copied) ------------------------------------
def kb_sha256_by_cache(index: pa.Table) -> dict[str, str]:
    """parca_cache -> kb_sha256 for every cache the index names (ADR 0009)."""
    if "parca_cache" not in index.column_names or "kb_sha256" not in index.column_names:
        return {}
    pairs = zip(index.column("parca_cache").to_pylist(), index.column("kb_sha256").to_pylist())
    return dict(sorted({(c, h) for c, h in pairs if c is not None}))


def check_kb_sha256(settings: Settings, index: pa.Table) -> None:
    """Refuse an index in which a named Parca cache lacks exactly one kb_sha256; warn about Parca
    caches an older finalize copied into repo/ (hub upload excludes them)."""
    if "kb_sha256" not in index.column_names:
        raise SystemExit("{} has no kb_sha256 column (built before it existed); re-run `w4c index build`, "
                         "then finalize".format(settings.index_path))
    hashes: dict[str, set] = {}
    for cache, digest in zip(index.column("parca_cache").to_pylist(), index.column("kb_sha256").to_pylist()):
        if cache is not None:
            hashes.setdefault(cache, set()).add(digest)
    bad = {c: sorted(h, key=str) for c, h in hashes.items() if len(h) != 1 or None in h}
    if bad:
        raise SystemExit("parca caches without exactly one kb_sha256 in {}: {}; re-run `w4c index build`".format(
            settings.index_path, bad))
    stale = sorted(p.name for p in (settings.repo_dir / "provenance").glob("parca_cache_*"))
    if stale:
        print("WARNING: {} under {} were copied by an older finalize and must not be published (ADR 0009); "
              "delete them. hub upload excludes them.".format(stale, settings.repo_dir / "provenance"), file=sys.stderr)


def check_no_deg_rate_copies(settings: Settings) -> None:
    """Refuse while repo/provenance/ holds a deg_rates_<cache>.json an older finalize copied there:
    the per-unit classification is derived from the fitted parameters and is not distributed
    (ADR 0009). The user deletes it; finalize does not."""
    provenance = settings.repo_dir / "provenance"
    copies = sorted(p.name for p in provenance.glob(deg_rate_provenance.FILE_PREFIX + "*.json"))
    if copies:
        raise SystemExit("{} under {} were copied by an older finalize; the degradation-rate classification is not "
                         "distributed (ADR 0009). Delete them (the originals stay in {}), then finalize again".format(
                             copies, provenance, settings.build_dir / "provenance"))


# -- 6. manifest and summary -----------------------------------------------------------------
def deg_rate_aggregates(settings: Settings, index: pa.Table) -> dict[str, dict]:
    """{parca_cache: aggregates} from each build/provenance/deg_rates_<cache>.json (``w4c
    deg-rates``): units per class and the not-a-fit share of basal mRNA expression, with the
    cache's kb_sha256 (deg_rates.aggregates). The files stay in build/. Refuses a file whose
    kb_sha256 is not the index's for that cache (the fit changed since it was classified); skips,
    with a warning, a cache the index does not name."""
    expected = kb_sha256_by_cache(index)
    prefix = deg_rate_provenance.FILE_PREFIX
    figures: dict[str, dict] = {}
    for path in sorted((settings.build_dir / "provenance").glob(prefix + "*.json")):
        document = read_json(path)
        cache = document.get("parca_cache") or path.stem[len(prefix):]
        if cache not in expected:
            print("WARNING: {} is for parca cache {}, which the index does not name; not summarised".format(
                path, cache), file=sys.stderr)
            continue
        if document.get("kb_sha256") != expected[cache]:
            raise SystemExit("{}: kb_sha256 {} but the index records {} for {}; re-run `w4c deg-rates`".format(
                path, document.get("kb_sha256"), expected[cache], cache))
        figures[cache] = deg_rate_provenance.aggregates(document)
    return figures


def git_commit(settings: Settings) -> tuple[str | None, bool]:
    def run(*argv):
        result = subprocess.run(["git", "-C", str(settings.repo_root)] + list(argv), capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None
    commit = run("rev-parse", "HEAD")
    dirty = bool(run("status", "--porcelain", "--untracked-files=no"))
    return commit, dirty


def data_files(settings: Settings) -> dict[str, dict[str, list[Path]]]:
    out: dict[str, dict[str, list[Path]]] = {}
    data = settings.repo_dir / "data"
    if not data.is_dir():
        return out
    for config_dir in sorted(p for p in data.iterdir() if p.is_dir()):
        for family_dir in sorted(p for p in config_dir.iterdir() if p.is_dir()):
            files = sorted(family_dir.glob("*.parquet"))
            if files:
                out.setdefault(config_dir.name, {})[family_dir.name] = files
    return out


def check_data_tree(settings: Settings, parts: dict[str, dict]) -> None:
    """Every published export parquet must be a current ok part, and every ok part must be on
    disk. The summary config is not exported (no sentinels) and is not checked here."""
    on_disk = {str(p.relative_to(settings.repo_dir)) for config, fams in data_files(settings).items()
               if config != SUMMARY_CONFIG for files in fams.values() for p in files}
    orphans = sorted(on_disk - set(parts))
    missing = sorted(set(parts) - on_disk)
    wrong_size = sorted(p for p in set(parts) & on_disk
                        if parts[p].get("bytes") is not None
                        and (settings.repo_dir / p).stat().st_size != int(parts[p]["bytes"]))
    problems = []
    if orphans:
        problems.append("{} parquet files under data/ without an ok sentinel (would be published as "
                        "duplicate or stale rows): {}".format(len(orphans), orphans[:10]))
    if missing:
        problems.append("{} ok sentinels whose file is missing: {}".format(len(missing), missing[:10]))
    if wrong_size:
        problems.append("{} files whose size differs from their sentinel: {}".format(len(wrong_size), wrong_size[:10]))
    if problems:
        raise SystemExit("data tree does not match the export sentinels:\n  " + "\n  ".join(problems))


def product_fields(files: dict[str, dict[str, list[Path]]]) -> tuple[dict[str, str], dict[str, str]]:
    """Units and types of every product column, from the first file of each config."""
    units, types = dict(UNITS), {}
    for config, families in files.items():
        if config == SUMMARY_CONFIG:
            continue
        for paths in families.values():
            for field in pq.read_schema(paths[0]):
                types[field.name] = str(field.type)
                if field.metadata and b"unit" in field.metadata:
                    units[field.name] = field.metadata[b"unit"].decode()
            break
    return units, types


def _counts(table: pa.Table, column: str) -> dict:
    if column not in table.column_names:
        return {}
    out: dict = {}
    for value in table.column(column).to_pylist():
        out[value] = out.get(value, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: str(kv[0])))


def _distinct(table: pa.Table, column: str) -> list:
    if column not in table.column_names:
        return []
    return sorted(v for v in table.column(column).unique().to_pylist() if v is not None)


def parse_hold_back(raw: str | None) -> set[tuple[str, str]]:
    """``core/single_knockout,expression/regulation`` -> {(config, family)}."""
    held = set()
    for item in (raw or "").split(","):
        item = item.strip()
        if not item:
            continue
        config, _, family = item.partition("/")
        if config not in CONFIGS or family not in FAMILIES:
            raise SystemExit("--hold-back takes <config>/<family>; got {!r}".format(item))
        held.add((config, family))
    return held


def withhold(parts: dict[str, dict], held: set[tuple[str, str]]) -> dict[str, dict]:
    return {p: r for p, r in parts.items() if (r.get("config"), r.get("family")) not in held}


def summarize(settings: Settings, index: pa.Table, parts: dict[str, dict], extra: dict,
              held: set[tuple[str, str]] = frozenset()) -> dict:
    files = data_files(settings)
    for config, family in held:
        files.get(config, {}).pop(family, None)
        if config == "core":  # the summary is computed from core: it follows core's hold-back
            files.get(SUMMARY_CONFIG, {}).pop(family, None)
    files = {c: f for c, f in files.items() if f}
    configs = {}
    for config, families in files.items():
        if config == SUMMARY_CONFIG:
            configs[config] = summary_config(index, families)
            continue
        per_family = {}
        for family, paths in families.items():
            recorded = [parts[str(p.relative_to(settings.repo_dir))] for p in paths
                        if str(p.relative_to(settings.repo_dir)) in parts]
            per_family[family] = {
                "files": len(paths),
                "bytes": sum(p.stat().st_size for p in paths),
                "rows": sum(int(r.get("rows") or 0) for r in recorded),
                "trajectories": sum(1 for r in recorded for s in r.get("samples", [])
                                    if s.get("qc", {}).get("ok", True) and s.get("n_rows")),
            }
        configs[config] = {
            "stride": CONFIGS[config].stride if config in CONFIGS else None,
            "matrices": list(CONFIGS[config].matrices) if config in CONFIGS else [],
            "files": sum(f["files"] for f in per_family.values()),
            "bytes": sum(f["bytes"] for f in per_family.values()),
            "rows": sum(f["rows"] for f in per_family.values()),
            "trajectories": sum(f["trajectories"] for f in per_family.values()),
            "families": per_family,
        }
    active = {}
    for matrix in MATRIX_CHANNELS:
        path = settings.reference_dir / (reference_name(matrix) + ".parquet")
        if path.exists():
            table = pq.read_table(path, columns=["active"])
            active[matrix] = {"columns": table.num_rows, "active": int(pc.sum(table.column("active")).as_py() or 0)}
    family_counts = {}
    for family in FAMILIES + sorted(set(_distinct(index, "family")) - set(FAMILIES)):
        mask = pc.equal(index.column("family"), family) if "family" in index.column_names else None
        if mask is None:
            continue
        subset = index.filter(mask)
        if subset.num_rows == 0:
            continue
        family_counts[family] = {
            "trajectories": subset.num_rows,
            "lineages": len(_distinct(subset, "lineage_id")),
            "cells": len(_distinct(subset, "cell_id")),
        }
    commit, dirty = git_commit(settings)
    units, types = product_fields(files)
    return {
        "version": settings.version,
        "repo_id": settings.repo_id,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "git_commit": commit,
        "git_dirty": dirty,
        "trajectories": index.num_rows,
        "lineages": len(_distinct(index, "lineage_id")),
        "cells": len(_distinct(index, "cell_id")),
        "families": family_counts,
        "configs": configs,
        "active_columns": active,
        "termination_class": _counts(index, "termination_class"),
        "split_by_lineage": _counts(index, "split_by_lineage"),
        "split_by_gene": _counts(index, "split_by_gene"),
        "max_generation": max(_distinct(index, "generation") or [None]) if "generation" in index.column_names else None,
        "sim_git_hashes": _distinct(index, "git_hash"),
        "sim_options_hashes": _distinct(index, "sim_options_hash"),
        "kb_sha256": kb_sha256_by_cache(index),
        "failed_jobs": extra.get("failed_jobs", {}),
        "qc": extra.get("qc", {}),
        "scan_runs": extra.get("scan_runs"),
        "units": units,
        "product_types": types,
        "index_schema": [(f.name, str(f.type)) for f in index.schema],
        "example_sample_id": index.column("sample_id")[0].as_py() if index.num_rows else None,
        "never_recorded": list(NEVER_RECORDED),
        "scalar_channels": list(SCALAR_CHANNELS),
        "held_back": sorted("{}/{}".format(c, f) for c, f in held),
        "translation_collapse": translation_collapse(index, files.get(SUMMARY_CONFIG, {})),
        "deg_rates": extra.get("deg_rates", {}),
    }


def summary_config(index: pa.Table, families: dict[str, list[Path]]) -> dict:
    """The summary config's card/manifest entry, from its files (one row per trajectory). Warns
    when a family's row count differs from the index's located core trajectories. When parts
    carry ``pathway_<name>`` columns (summarize --pathways), the entry lists them (``pathways``)
    and each such family has ``pathway_columns``."""
    per_family, pathways = {}, []
    for family, paths in families.items():
        rows = sum(pq.read_metadata(p).num_rows for p in paths)
        per_family[family] = {"files": len(paths), "bytes": sum(p.stat().st_size for p in paths),
                              "rows": rows, "trajectories": rows}
        names = [f.name for f in pq.read_schema(paths[0]) if f.name.startswith(PATHWAY_PREFIX)]
        if names:  # summarize --pathways (only for a family with expression parts)
            per_family[family]["pathway_columns"] = len(names)
            pathways += [n for n in names if n not in pathways]
        if "core_file" in index.column_names and "family" in index.column_names:
            located = int(pc.sum(pc.and_(pc.equal(index.column("family"), family),
                                         pc.is_valid(index.column("core_file")))).as_py() or 0)
            if located != rows:
                print("WARNING: data/{}/{} has {} rows but the index locates {} core trajectories; re-run "
                      "`w4c summarize`, then finalize".format(SUMMARY_CONFIG, family, rows, located), file=sys.stderr)
    entry = {"stride": 1, "matrices": [], "files": sum(f["files"] for f in per_family.values()),
             "bytes": sum(f["bytes"] for f in per_family.values()),
             "rows": sum(f["rows"] for f in per_family.values()),
             "trajectories": sum(f["trajectories"] for f in per_family.values()), "families": per_family}
    if pathways:
        entry["pathways"] = pathways
    return entry


def translation_collapse(index: pa.Table, families: dict[str, list[Path]]) -> dict:
    """Cellarium's ``translation_collapse`` on the summary parts: trajectories with
    ``ribosome_elongation_rate_mean < COLLAPSE_RATE`` (aa/s), and how many of them divided
    (index ``termination_class`` none). Empty when there are no summary parts (the card then
    shows TODO)."""
    if not families:
        return {}
    termination = dict(zip(index.column("sample_id").to_pylist(), index.column("termination_class").to_pylist())) \
        if "termination_class" in index.column_names else {}
    per_family = {}
    for family in [f for f in FAMILIES if f in families] + sorted(f for f in families if f not in FAMILIES):
        flagged = []
        for path in families[family]:
            table = pq.read_table(path, columns=["sample_id", "ribosome_elongation_rate_mean"])
            low = pc.fill_null(pc.less(table.column("ribosome_elongation_rate_mean"), COLLAPSE_RATE), False)
            flagged += table.column("sample_id").filter(low).to_pylist()
        per_family[family] = {"trajectories": len(flagged),
                              "divided": sum(1 for s in flagged if termination.get(s) == "none")}
    return {"threshold_aa_per_s": COLLAPSE_RATE,
            "trajectories": sum(f["trajectories"] for f in per_family.values()),
            "divided": sum(f["divided"] for f in per_family.values()), "families": per_family}


def manifest_payload(summary: dict) -> dict:
    return {
        "version": summary["version"],
        "built_at": summary["built_at"],
        "git_commit": summary["git_commit"],
        "git_dirty": summary["git_dirty"],
        "configs": {c: {k: v[k] for k in ("rows", "bytes", "files", "trajectories", "stride")}
                    | {"families": v["families"]} for c, v in summary["configs"].items()},
        "families": summary["families"],
        "trajectories": summary["trajectories"],
        "active_columns": summary["active_columns"],
        "termination_class": summary["termination_class"],
        "qc": summary["qc"],
        "failed_jobs": summary["failed_jobs"],
        "kb_sha256": summary["kb_sha256"],
        "held_back": summary.get("held_back", []),
        "translation_collapse": summary.get("translation_collapse", {}),
        "deg_rates": summary.get("deg_rates", {}),
    }


def _write_table(table: pa.Table, path: Path, settings: Settings) -> None:
    temporary = temp_path_for(path)
    pq.write_table(table, temporary, compression=settings.compression)
    rename_into_place(temporary, path)


def _write_text(path: Path, text: str) -> None:
    temporary = temp_path_for(path)
    temporary.write_text(text, encoding="utf-8")
    rename_into_place(temporary, path)


def cmd_finalize(settings: Settings, args: argparse.Namespace) -> dict:
    if not settings.index_path.exists():
        raise SystemExit("no {}; run `w4c index build` first".format(settings.index_path))
    configs = [c.strip() for c in args.configs.split(",")] if args.configs else list(CONFIGS)
    for config in configs:
        settings.config(config)
    check_kb_sha256(settings, pq.read_table(settings.index_path))
    check_no_deg_rate_copies(settings)
    incomplete = check_complete(settings, configs, args.allow_incomplete)
    sentinels = export_sentinels(settings)
    parts = current_parts(sentinels)
    sentinel_paths = {}
    for path, record in sentinels:
        if record.get("status") == "ok" and record.get("path"):
            sentinel_paths[record["path"]] = path
    check_data_tree(settings, parts)
    held = parse_hold_back(args.hold_back)
    if held:
        kept = withhold(parts, held)
        print("holding back {} part(s) of {}: no locators, stats, manifest or card entry".format(
            len(parts) - len(kept), ", ".join("{}/{}".format(*h) for h in sorted(held))))
        parts = kept
        sentinel_paths = {p: s for p, s in sentinel_paths.items() if p in parts}
    located = locators(parts)
    report = {"locators": fill_index(settings, located, configs), "incomplete_parts": len(incomplete)}
    report["qc"] = write_export_qc(settings, sentinels)
    report["stats"] = write_stats(settings, parts, sentinel_paths)
    runs = {r["run_dir"]: r for r in read_jsonl(settings.scan_dir / "runs.jsonl")}
    report["failed_jobs"] = write_failed_jobs(settings, runs)
    report["scan_runs"] = write_scan_runs(settings, runs)
    index = pq.read_table(settings.index_path)
    report["deg_rates"] = deg_rate_aggregates(settings, index)
    summary = summarize(settings, index, parts, report, held)
    _write_text(settings.repo_dir / "README.md", card.render(settings, summary))
    write_atomic_json(settings.repo_dir / "manifest.json", manifest_payload(summary))
    append_jsonl(settings.ledger, {"at": now(), "stage": "finalize", "configs": configs, **{
        k: report[k] for k in ("locators", "qc", "stats", "failed_jobs", "scan_runs", "deg_rates")}})
    for key, value in report.items():
        print("{}: {}".format(key, value))
    print("wrote {} and {}".format(settings.repo_dir / "README.md", settings.repo_dir / "manifest.json"))
    return report


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("finalize", help="index locators, export QC, stats, provenance, card, manifest")
    parser.add_argument("--configs", help="comma-separated configs whose index locators to refill (default: all)")
    parser.add_argument("--hold-back", help="comma-separated <config>/<family> exported locally but not published "
                                            "yet: left out of the locators, stats, manifest and card (re-run "
                                            "finalize without it once they are uploaded)")
    parser.add_argument("--allow-incomplete", action="store_true",
                        help="finalize even though planned parts of these configs lack an ok sentinel")
    parser.set_defaults(func=cmd_finalize)
