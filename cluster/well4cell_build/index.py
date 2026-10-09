"""Stage 2: index.parquet, one row per trajectory (cell generation), from the campaign
database, each run's metadata, and the scan.

``build``      writes repo/index.parquet, repo/provenance/sim_options/<hash>.json and
               build/index_report.json (non-fatal disagreements, excluded runs)
``check``      prints counts, uniqueness, nulls, outcomes and the build report
``reference``  writes repo/provenance/reference/{genes,conditions,timelines,media_recipes,
               tf_edges,tf_activity}.parquet from the database and the frozen sim_data tables

Where each column comes from (facts established from code and the DB on 2026-10-08)
---------------------------------------------------------------------------------
Rows. Every simulation_jobs row with status 'done' (31,101) joined to experiments
(4,009, names unique) contributes one row per generation present in scan/runs.jsonl
(authoritative for generations and n_steps), cross-checked against simulation_results
(117,174 rows, one per (job, generation)). A done job that the scan marked missing or
failed is excluded and listed in the report; a done job absent from runs.jsonl is fatal
(the scan is incomplete) unless ``--partial`` (tests).

Identity. experiments.name is "[T1] WT/basal", "[T2_CORE] argG_KO/basal", "[T3] ...",
"[T4] ...", "[T5] pfkA+pfkB/basal" (hf_export/matrix.py:16-21; T2_CORE is the only T2
flavour present). tier = "T1".."T5" (T2_CORE -> T2), family = settings.FAMILY_BY_TIER.
cell_id = "T2/argG_KO/basal" (perturbation.cell_id_for); T4 tf_activity names in the DB
name the wrong TF (see perturbation.py), so their cell_id uses the TF that actually ran.
The raw name is kept as ``experiment_name``. lineage_id = cell_id + "/s<seed>", sample_id
= lineage_id + "/g<gen>", parent_id = the previous generation's sample_id.

Design. variant_type, variant_index, condition, seed from simulation_jobs (identical to
experiments for every done job). ``condition`` is the DB value as designed; for tf_activity
and sinusoidal_media the simulation ignores it (the variant sets its own condition), so
read media_schedule instead. ``timeline`` is the schedule that actually ran, formatted
"0 minimal, 1200 minimal_acetate" (null for sinusoidal), not the DB column (empty for
static conditions).

Perturbation. perturbation.derive (mapping and file:line evidence in its docstring).
perturbation_text = <run>/<variant>_<index:06d>/metadata/description, stripped.

Consistency, fatal. metadata/metadata.json "seed" and "variant" must equal the job's seed
and variant_type, the variant directory's index must equal variant_index, the scan's seed
must equal the job's seed, the run's parca cache must be one sim_data_tables.json was
verified against, and every description must match its variant mapping.

Outcome. The DB ``simulation_results.divided`` is a heuristic that is false for many
cells that divided (35,113 rows divided=0 terminated=0), so divided := not terminated.
terminated is true only on the last present generation of a job with
simulation_jobs.lineage_terminated = 1, and termination_reason is then the job's reason
(e.g. "NegativeCountsError: ATP[c] in PolypeptideElongation (-886)"); termination_class
maps its leading exception name (perturbation.TERMINATION_CLASSES). division_time_sec =
n_steps - 1 when divided (equals simulation_results.division_time_sec where that is set).
final_mass_fg and growth_rate are simulation_results' per-generation values (growth_rate
there is the mean of the non-null growth_rate channel). lineage_generations = generations
present in the scan.

Provenance. job_id, attempt, started_at from simulation_jobs; run_dir = sim_dir; h5_group
"seed<S>/gen<G>" with S the scan's seed group (seed0..seed7, equal to the job's seed, which
is checked above); export reads trajectories through this column; git_hash from metadata.json; parca_cache = readlink(<run>/kb) ->
"../parca_cache_<hash>/kb" -> "<hash>"; sim_options_hash = sha256 of metadata.json minus
the per-run keys (description, time, seed, variant) and the keys carried as their own
columns (git_hash, timeline, multi_ko_indices), json-dumped with sorted keys; every
distinct option set is written to provenance/sim_options/<hash>.json.

Splits (numpy RandomState(W4C_SPLIT_SEED), 80/10/10). split_by_lineage: within each family,
cells in sorted order, each cell's lineages in a random order, concatenated; position k
gets slot k mod 10 of a random permutation of 8 train, 1 val, 1 test, so every cell's
lineages spread over the splits. split_by_gene: the sorted set of every knockout_genes
symbol is permuted and cut 80/10/10; a knockout row takes the most held-out split of its
genes (test > val > train) so no held-out gene appears in train; non-knockout rows train.
All generations of a lineage share its splits.

Locators <config>_file / _row_offset / _n_rows are present and null; finalize fills them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import perturbation as pert
from .ledger import append_jsonl, now, read_jsonl, rename_into_place, temp_path_for, write_atomic_json
from .settings import CONFIGS, FAMILIES, FAMILY_BY_TIER, Settings

OPTION_KEYS_EXCLUDED = ("description", "time", "seed", "variant", "git_hash", "timeline", "multi_ko_indices")
_VARIANT_DIR = re.compile(r"^(.+)_(\d{6})$")
_PARCA = re.compile(r"parca_cache_([0-9a-f]+)")


def connect(settings: Settings) -> sqlite3.Connection:
    connection = sqlite3.connect("file:{}?mode=ro".format(settings.database), uri=True)
    connection.row_factory = sqlite3.Row
    return connection


# -- schema -------------------------------------------------------------------------------

MEDIA_EVENT = pa.struct([("t_abs_sec", pa.int32()), ("medium", pa.string())])


def schema() -> pa.Schema:
    fields = [
        ("sample_id", pa.string()), ("lineage_id", pa.string()), ("cell_id", pa.string()),
        ("parent_id", pa.string()), ("experiment_name", pa.string()),
        ("family", pa.string()), ("tier", pa.string()), ("variant_type", pa.string()),
        ("variant_index", pa.int32()), ("variant", pa.string()), ("condition", pa.string()),
        ("timeline", pa.string()), ("seed", pa.int8()), ("generation", pa.int8()),
        ("knockout_genes", pa.list_(pa.string())), ("knockout_gene_ids", pa.list_(pa.string())),
        ("knockout_tu_ids", pa.list_(pa.string())), ("media_schedule", pa.list_(MEDIA_EVENT)),
        ("medium_at_birth", pa.string()), ("medium_at_division", pa.string()),
        ("media_a", pa.string()), ("media_b", pa.string()), ("period_sec", pa.int32()),
        ("tf_target", pa.string()), ("tf_target_id", pa.string()), ("tf_state", pa.string()),
        ("ppgpp_setpoint_um", pa.float32()), ("ppgpp_factor", pa.float32()), ("aa_shift", pa.string()),
        ("perturbation_text", pa.string()),
        ("n_steps", pa.int32()), ("divided", pa.bool_()), ("terminated", pa.bool_()),
        ("termination_class", pa.string()), ("termination_reason", pa.string()),
        ("division_time_sec", pa.float32()), ("final_mass_fg", pa.float32()), ("growth_rate", pa.float32()),
        ("lineage_terminated", pa.bool_()), ("lineage_generations", pa.int8()),
        ("split_by_lineage", pa.string()), ("split_by_gene", pa.string()),
        ("job_id", pa.int32()), ("attempt", pa.int8()), ("started_at", pa.string()), ("run_dir", pa.string()),
        ("h5_group", pa.string()), ("git_hash", pa.string()), ("parca_cache", pa.string()),
        ("sim_options_hash", pa.string()),
    ]
    for name in CONFIGS:
        fields += [(name + "_file", pa.string()), (name + "_row_offset", pa.int64()), (name + "_n_rows", pa.int32())]
    return pa.schema(fields)


# -- per-run files ------------------------------------------------------------------------

def read_run_files(out_dir: Path, run_dir: str) -> dict:
    """metadata.json, the variant directory and its description, and the kb link."""
    path = out_dir / run_dir
    record: dict = {"run_dir": run_dir}
    try:
        record["metadata"] = json.loads((path / "metadata" / "metadata.json").read_text())
        variant_dirs = []
        for name in os.listdir(path):
            match = _VARIANT_DIR.match(name)
            if match and (path / name / "metadata").is_dir():
                variant_dirs.append((match.group(1), int(match.group(2)), name))
        if len(variant_dirs) != 1:
            raise ValueError("expected one <variant>_<index> directory, found {}".format([v[2] for v in variant_dirs]))
        record["variant_name"], record["variant_dir_index"], vdir = variant_dirs[0]
        record["description"] = (path / vdir / "metadata" / "description").read_text().strip()
        link = os.readlink(path / "kb")
        match = _PARCA.search(link)
        if not match:
            raise ValueError("kb link {!r} does not name a parca cache".format(link))
        record["parca_cache"] = match.group(1)
    except Exception as error:  # noqa: BLE001 - reported as a fatal disagreement
        record["error"] = "{}: {}".format(type(error).__name__, error)
    return record


def sim_options(metadata: dict) -> tuple[str, dict]:
    options = {k: v for k, v in metadata.items() if k not in OPTION_KEYS_EXCLUDED}
    text = json.dumps(options, sort_keys=True, default=str)
    return hashlib.sha256(text.encode()).hexdigest(), options


# -- splits -------------------------------------------------------------------------------

SPLITS = ("train", "val", "test")


def lineage_splits(lineages: list[tuple[str, str, str]], seed: int) -> dict[str, str]:
    """``lineages`` = (family, cell_id, lineage_id); see the module docstring."""
    rng = np.random.RandomState(seed)
    pattern = np.array(["train"] * 8 + ["val", "test"])
    by_family: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for family, cell, lineage in lineages:
        by_family[family][cell].append(lineage)
    out: dict[str, str] = {}
    for family in sorted(by_family):
        slots = pattern[rng.permutation(len(pattern))]
        position = 0
        for cell in sorted(by_family[family]):
            members = sorted(by_family[family][cell])
            for index in rng.permutation(len(members)):
                out[members[index]] = str(slots[position % len(slots)])
                position += 1
    return out


def gene_splits(genes: set[str], seed: int) -> dict[str, str]:
    rng = np.random.RandomState(seed)
    ordered = sorted(genes)
    order = rng.permutation(len(ordered))
    n_train = int(round(0.8 * len(ordered)))
    n_val = int(round(0.1 * len(ordered)))
    out = {}
    for rank, index in enumerate(order):
        out[ordered[index]] = "train" if rank < n_train else ("val" if rank < n_train + n_val else "test")
    return out


def row_gene_split(knockout_genes: list[str] | None, by_gene: dict[str, str]) -> str:
    if not knockout_genes:
        return "train"
    return max((by_gene[g] for g in knockout_genes), key=SPLITS.index)


# -- build --------------------------------------------------------------------------------

def _load_db(settings: Settings) -> tuple[list[dict], dict[int, dict[int, dict]], list[tuple[str, str, int]]]:
    connection = connect(settings)
    jobs = [dict(r) for r in connection.execute(
        "select j.id as job_id, j.experiment_id, j.sim_dir, j.attempt, j.seed, j.variant_type, j.variant_index, "
        "j.condition, j.timeline as job_timeline, j.started_at, j.lineage_terminated, j.termination_reason, "
        "e.name as experiment_name, e.variant_type as e_variant_type, e.variant_index as e_variant_index, "
        "e.gene_symbol, e.sim_params, e.condition as e_condition "
        "from simulation_jobs j join experiments e on e.id = j.experiment_id where j.status = 'done' order by j.id")]
    results: dict[int, dict[int, dict]] = defaultdict(dict)
    for r in connection.execute("select job_id, generation, division_time_sec, final_mass_fg, growth_rate, "
                                "divided, terminated, termination_reason from simulation_results"):
        results[r["job_id"]][r["generation"]] = dict(r)
    genes = [(r["symbol"], r["ecoli_id"], r["ko_index"]) for r in connection.execute(
        "select symbol, ecoli_id, ko_index from genes")]
    connection.close()
    return jobs, results, genes


def cmd_build(settings: Settings, args: argparse.Namespace) -> dict:
    runs_path = Path(args.runs) if args.runs else settings.scan_dir / "runs.jsonl"
    scans = {r["run_dir"]: r for r in read_jsonl(runs_path)}
    if not scans:
        raise SystemExit("no scan records in {}; run `scan reduce` first".format(runs_path))
    jobs, results, genes = _load_db(settings)
    tables = pert.load_tables(genes)
    print("{} done jobs, {} scan records ({})".format(len(jobs), len(scans), runs_path), flush=True)

    fatal: list[str] = []
    excluded: list[dict] = []
    notes: dict[str, list] = defaultdict(list)
    selected = []
    for job in jobs:
        job["run_dir"] = Path(job["sim_dir"]).name
        if (job["variant_type"], job["variant_index"], job["condition"]) != (
                job["e_variant_type"], job["e_variant_index"], job["e_condition"]):
            fatal.append("job {}: job and experiment disagree on variant/condition".format(job["job_id"]))
        scan = scans.get(job["run_dir"])
        if scan is None:
            if not args.partial:
                fatal.append("job {}: {} not in runs.jsonl".format(job["job_id"], job["run_dir"]))
            continue
        if scan.get("status") != "ok":
            excluded.append({"job_id": job["job_id"], "run_dir": job["run_dir"], "scan_status": scan.get("status"),
                             "error": (scan.get("error") or "")[-300:]})
            continue
        selected.append((job, scan))

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        files = dict(zip([j["run_dir"] for j, _ in selected],
                         pool.map(lambda pair: read_run_files(settings.out_dir, pair[0]["run_dir"]), selected)))
    print("read metadata for {} runs".format(len(files)), flush=True)

    rows: list[dict] = []
    option_sets: dict[str, dict] = {}
    for job, scan in selected:
        run = files[job["run_dir"]]
        where = "job {} ({})".format(job["job_id"], job["run_dir"])
        if "error" in run:
            fatal.append("{}: {}".format(where, run["error"]))
            continue
        metadata = run["metadata"]
        if int(metadata.get("seed", -1)) != job["seed"]:
            fatal.append("{}: metadata seed {} != DB seed {}".format(where, metadata.get("seed"), job["seed"]))
        if metadata.get("variant") != job["variant_type"] or run["variant_name"] != job["variant_type"]:
            fatal.append("{}: metadata variant {} / dir {} != DB {}".format(
                where, metadata.get("variant"), run["variant_name"], job["variant_type"]))
        expected_dir_index = 0 if job["variant_type"] == "multi_gene_knockout" else job["variant_index"]
        if run["variant_dir_index"] != expected_dir_index:
            fatal.append("{}: variant dir index {} != DB {}".format(where, run["variant_dir_index"], job["variant_index"]))
        if int(scan["seed"]) != job["seed"]:
            fatal.append("{}: h5 seed {} != DB seed {}".format(where, scan["seed"], job["seed"]))
        if run["parca_cache"] not in tables.parca_caches:
            fatal.append("{}: parca cache {} not in sim_data_tables.json {}".format(where, run["parca_cache"], tables.parca_caches))
        try:
            p = pert.derive(job["variant_type"], job["variant_index"], job, metadata, run["description"], tables)
            cell_id = pert.cell_id_for(job["experiment_name"], p)
            tier = pert.tier_of(job["experiment_name"])
        except pert.PerturbationError as error:
            fatal.append("{}: {}".format(where, error))
            continue
        if tier not in FAMILY_BY_TIER:
            fatal.append("{}: tier {} has no family".format(where, tier))
            continue
        options_hash, options = sim_options(metadata)
        option_sets[options_hash] = options

        generations = sorted(scan["generations"], key=lambda g: g["generation"])
        db = results.get(job["job_id"], {})
        present = [g["generation"] for g in generations]
        if sorted(db) != present:
            notes["generations_scan_vs_db"].append({"job_id": job["job_id"], "scan": present, "db": sorted(db)})
        lineage_terminated = bool(job["lineage_terminated"])
        last = present[-1] if present else None
        if lineage_terminated and db.get(last, {}).get("terminated") != 1:
            notes["terminated_generation_vs_db"].append({"job_id": job["job_id"], "last_scanned": last,
                                                         "db_terminated": [g for g, r in db.items() if r["terminated"]]})
        lineage_id = "{}/s{}".format(cell_id, job["seed"])
        for g in generations:
            gen = g["generation"]
            terminated = lineage_terminated and gen == last
            divided = not terminated
            result = db.get(gen)
            if result is None:
                notes["generation_missing_in_db"].append({"job_id": job["job_id"], "generation": gen})
                result = {}
            elif result.get("division_time_sec") is not None and divided and \
                    abs(result["division_time_sec"] - (g["n_steps"] - 1)) > 0.5:
                notes["division_time_vs_n_steps"].append({"job_id": job["job_id"], "generation": gen,
                                                          "db": result["division_time_sec"], "n_steps": g["n_steps"]})
            reason = job["termination_reason"] if terminated else None
            rows.append({
                "sample_id": "{}/g{}".format(lineage_id, gen), "lineage_id": lineage_id, "cell_id": cell_id,
                "parent_id": "{}/g{}".format(lineage_id, gen - 1) if gen > 0 else None,
                "experiment_name": job["experiment_name"], "family": FAMILY_BY_TIER[tier], "tier": tier,
                "variant_type": job["variant_type"], "variant_index": job["variant_index"], "variant": p.variant,
                "condition": job["condition"], "timeline": p.timeline, "seed": job["seed"], "generation": gen,
                "knockout_genes": p.knockout_genes, "knockout_gene_ids": p.knockout_gene_ids,
                "knockout_tu_ids": p.knockout_tu_ids,
                "media_schedule": None if p.media_schedule is None else
                [{"t_abs_sec": t, "medium": m} for t, m in p.media_schedule],
                "medium_at_birth": pert.medium_at(p.media_schedule, g["t0"]),
                "medium_at_division": pert.medium_at(p.media_schedule, g["t_end"]),
                "media_a": p.media_a, "media_b": p.media_b, "period_sec": p.period_sec,
                "tf_target": p.tf_target, "tf_target_id": p.tf_target_id, "tf_state": p.tf_state,
                "ppgpp_setpoint_um": p.ppgpp_setpoint_um, "ppgpp_factor": p.ppgpp_factor, "aa_shift": p.aa_shift,
                "perturbation_text": run["description"],
                "n_steps": g["n_steps"], "divided": divided, "terminated": terminated,
                "termination_class": pert.termination_class(terminated, reason), "termination_reason": reason,
                "division_time_sec": float(g["n_steps"] - 1) if divided else None,
                "final_mass_fg": result.get("final_mass_fg"), "growth_rate": result.get("growth_rate"),
                "lineage_terminated": lineage_terminated, "lineage_generations": len(present),
                "job_id": job["job_id"], "attempt": job["attempt"], "started_at": job["started_at"],
                "run_dir": job["run_dir"], "h5_group": "seed{}/gen{}".format(int(scan["seed"]), gen),
                "git_hash": metadata.get("git_hash"), "parca_cache": run["parca_cache"],
                "sim_options_hash": options_hash,
            })

    seen = Counter(r["sample_id"] for r in rows)
    fatal += ["duplicate sample_id {} ({}x)".format(s, n) for s, n in seen.items() if n > 1]
    cells = defaultdict(set)
    for r in rows:
        cells[r["cell_id"]].add(r["experiment_name"])
    fatal += ["cell_id {} names {} experiments".format(c, sorted(e)) for c, e in cells.items() if len(e) > 1]

    report = {"at": now(), "runs_jsonl": str(runs_path), "done_jobs": len(jobs), "indexed_jobs": len({r["job_id"] for r in rows}),
              "rows": len(rows), "excluded": excluded, "fatal": fatal[:500], "n_fatal": len(fatal),
              "notes": {k: {"count": len(v), "examples": v[:20]} for k, v in notes.items()},
              "sim_option_sets": len(option_sets), "partial": bool(args.partial)}
    write_atomic_json(settings.build_dir / "index_report.json", report)
    if fatal:
        for line in fatal[:30]:
            print("FATAL " + line, file=sys.stderr)
        raise SystemExit("index build failed: {} fatal disagreements (see {})".format(
            len(fatal), settings.build_dir / "index_report.json"))

    seed = settings.split_seed
    by_lineage = lineage_splits(sorted({(r["family"], r["cell_id"], r["lineage_id"]) for r in rows}), seed)
    by_gene = gene_splits({g for r in rows for g in (r["knockout_genes"] or [])}, seed)
    for r in rows:
        r["split_by_lineage"] = by_lineage[r["lineage_id"]]
        r["split_by_gene"] = row_gene_split(r["knockout_genes"], by_gene)

    # Families in tier order (T1..T5, settings.FAMILIES), then cell, seed, generation.
    rows.sort(key=lambda r: (FAMILIES.index(r["family"]), r["cell_id"], r["seed"], r["generation"]))
    target = schema()
    columns = {f.name: [r.get(f.name) for r in rows] for f in target}
    table = pa.Table.from_arrays([pa.array(columns[f.name], type=f.type) for f in target], schema=target)
    table = table.replace_schema_metadata({"well4cell_version": settings.version, "split_seed": str(seed),
                                           "built_at": report["at"]})
    temporary = temp_path_for(settings.index_path)
    pq.write_table(table, temporary, compression=settings.compression)
    rename_into_place(temporary, settings.index_path)
    for options_hash, options in option_sets.items():
        write_atomic_json(settings.repo_dir / "provenance" / "sim_options" / (options_hash + ".json"), options)
    summary = {"rows": len(rows), "jobs": report["indexed_jobs"], "excluded": len(excluded),
               "sim_option_sets": len(option_sets), "notes": {k: len(v) for k, v in notes.items()}}
    append_jsonl(settings.ledger, {"at": now(), "stage": "index.build", **summary})
    print("wrote {}: {}".format(settings.index_path, summary))
    return summary


# -- check --------------------------------------------------------------------------------

def cmd_check(settings: Settings, args: argparse.Namespace) -> dict:
    table = pq.read_table(settings.index_path)
    rows = table.num_rows
    print("{}: {} rows, {} columns".format(settings.index_path, rows, table.num_columns))
    family = table.column("family").to_pylist()
    tier = table.column("tier").to_pylist()
    print("\nrows per family / tier:")
    for (f, t), n in sorted(Counter(zip(family, tier)).items(), key=lambda kv: (kv[0][1], kv[0][0])):
        print("  {:18s} {:3s} {:7d}".format(f, t, n))
    sample = table.column("sample_id").to_pylist()
    cells = table.column("cell_id").to_pylist()
    names = table.column("experiment_name").to_pylist()
    dup = [s for s, n in Counter(sample).items() if n > 1]
    per_cell = defaultdict(set)
    for c, e in zip(cells, names):
        per_cell[c].add(e)
    print("\nuniqueness: sample_id {} distinct / {} rows ({} duplicated); cell_id {} distinct, {} naming >1 experiment;"
          " experiments {} distinct".format(len(set(sample)), rows, len(dup), len(per_cell),
                                            sum(len(v) > 1 for v in per_cell.values()), len(set(names))))
    print("\nnull counts:")
    for name in table.column_names:
        nulls = table.column(name).null_count
        print("  {:28s} {:7d}{}".format(name, nulls, "  (all null)" if nulls == rows else ""))
    print("\nterminated / termination_class:")
    for (t, c), n in sorted(Counter(zip(table.column("terminated").to_pylist(),
                                        table.column("termination_class").to_pylist())).items()):
        print("  terminated={!s:5s} {:22s} {:7d}".format(t, c, n))
    print("\nsplits (lineage / gene):")
    for key in ("split_by_lineage", "split_by_gene"):
        print("  {:18s} {}".format(key, dict(sorted(Counter(table.column(key).to_pylist()).items()))))
    report_path = settings.build_dir / "index_report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text())
        print("\nbuild report ({}): done jobs {}, indexed {}, excluded {}, fatal {}, sim option sets {}{}".format(
            report["at"], report["done_jobs"], report["indexed_jobs"], len(report["excluded"]), report["n_fatal"],
            report["sim_option_sets"], ", PARTIAL" if report.get("partial") else ""))
        print("DB-vs-metadata disagreements (fatal at build): {}".format(report["n_fatal"] or "none"))
        for line in report["fatal"][:20]:
            print("  " + line)
        for key, value in sorted(report["notes"].items()):
            print("note {}: {} e.g. {}".format(key, value["count"], value["examples"][:3]))
        for item in report["excluded"][:10]:
            print("excluded: {}".format(item))
    return {"rows": rows, "duplicates": len(dup)}


# -- reference tables ---------------------------------------------------------------------

def cmd_reference(settings: Settings, args: argparse.Namespace) -> dict:
    connection = connect(settings)
    out = settings.reference_dir
    out.mkdir(parents=True, exist_ok=True)
    queries = {
        "genes": "select id, ecoli_id, symbol, synonyms, category, ko_index, is_mechanistic, monomer_id, monomer_name, "
                 "rna_ids, complex_ids, left_end_pos, right_end_pos, direction from genes order by id",
        "conditions": "select * from conditions order by id",
        "timelines": "select * from timelines order by id",
        "media_recipes": "select * from media_recipes order by id",
        "tf_edges": "select * from tf_edges order by id",
    }
    written = {}
    for name, sql in queries.items():
        cursor = connection.execute(sql)
        records = [dict(r) for r in cursor.fetchall()]
        table = pa.Table.from_pylist(records)
        _write(table, out / (name + ".parquet"))
        written[name] = table.num_rows
    connection.close()
    tables = pert.load_tables([])  # the TF table needs no genes
    tf_rows = [{"variant_index": 0, "tf_id": None, "tf_symbol": None, "tf_state": "control", "medium": None}]
    for k, tf in enumerate(tables.tf_ids, start=1):
        for state, index in (("active", 2 * k - 1), ("inactive", 2 * k)):
            tf_rows.append({"variant_index": index, "tf_id": tf, "tf_symbol": tables.tf_symbol_by_id[tf],
                            "tf_state": state, "medium": tables.tf_nutrients[tf][state]})
    _write(pa.Table.from_pylist(tf_rows), out / "tf_activity.parquet")
    written["tf_activity"] = len(tf_rows)
    print("wrote {}: {}".format(out, written))
    return written


def _write(table: pa.Table, path: Path) -> None:
    temporary = temp_path_for(path)
    pq.write_table(table, temporary, compression="zstd")
    rename_into_place(temporary, path)


def add_parser(sub: argparse._SubParsersAction) -> None:
    parser = sub.add_parser("index", help="index.parquet from the database, run metadata and the scan")
    stage = parser.add_subparsers(dest="action", required=True)
    build = stage.add_parser("build")
    build.add_argument("--runs", help="runs.jsonl to use (default build/scan/runs.jsonl)")
    build.add_argument("--partial", action="store_true",
                       help="index only the done jobs present in runs.jsonl (tests); default: absent jobs are fatal")
    build.add_argument("--threads", type=int, default=32, help="parallel metadata readers")
    build.set_defaults(func=cmd_build)
    stage.add_parser("check").set_defaults(func=cmd_check)
    stage.add_parser("reference").set_defaults(func=cmd_reference)
