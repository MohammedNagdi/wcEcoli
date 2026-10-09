"""Typed perturbation columns from a run's variant, its design record and its description.

Everything here is a pure function of (job, experiment, metadata.json, the variant
description file, frozen sim_data tables, the DB genes table and tf_condition.tsv), so it
is unit-tested on literal examples (test_index.py). Anything that does not match what the
variant code says it did raises ``PerturbationError``: the index build fails loudly rather
than publish a wrong label.

Sources of truth and the mapping for each variant (file:line evidence)
-----------------------------------------------------------------------
Media schedules. A timeline string is "t1 media1, t2 media2" in simulation seconds
(wholecell/utils/make_media.py make_timeline); simulation time continues across
generations (wholecell/sim/simulation.py: daughters start at the parent's end time; the
scan's per-generation t0/t_end confirm it, e.g. gen1 t0 = 2530 after gen0 t_end = 2529),
so every ``t_abs_sec`` here is lineage-absolute. The environment uses the last event with
t <= now (wholecell/states/local_environment.py:118). ``medium_at_birth`` /
``medium_at_division`` evaluate the schedule at the generation's scan t0 / t_end.

* Variants that do not manage their environment (wildtype, gene_knockout,
  multi_gene_knockout): the worker passes ``--timeline`` (sim_worker.py:791-797): the job's
  timeline if set, else "0 <conditions.nutrients>" for the condition, or a shift from
  minimal where timelines_def.tsv has no static timeline for that medium
  (sim_worker.py:522-576: no_glucose -> "0 minimal, 1200 minimal_no_glucose",
  minus_phosphate -> "0 minimal, 2400 minimal_minus_phosphate", plus_arabinose ->
  "0 minimal, 1200 minimal_plus_arabinose"); basal passes nothing and the default is
  "0 minimal" (wholecell/sim/simulation.py:26). metadata.json["timeline"] records what ran,
  so it is the schedule for these variants.
* Environment-managing variants (sim_worker.py:583-604: the aa shifts, ppgpp_conc,
  sinusoidal_media, tf_activity index != 0) get no ``--timeline``; metadata.json says
  "0 minimal" and is ignored. They set ``external_state.current_timeline_id``, which wins
  over the passed timeline (local_environment.py:58-64). Schedules below.

wildtype (variants/wildtype.py:23-25): no change.

gene_knockout (variants/gene_knockout.py:24-41): index i >= 1 sets expression of
``transcription.rna_data['id'][i-1]`` to 0. In this operon model rna_data rows are
transcription units (3,276 TUs; the description reads "Complete knockout of TU0-5501[c].,
operons"), so a knockout removes a whole TU. ``genes.ko_index`` (init_db.py:440-497) picks
the smallest TU containing each gene, and experiments.variant_index == genes.ko_index for
every KO experiment. Columns: knockout_genes = [experiments.gene_symbol],
knockout_gene_ids = [genes.ecoli_id of that symbol with that ko_index],
knockout_tu_ids = [rna_ids[i-1]] (checked against the description).

multi_gene_knockout (variants/multi_gene_knockout.py:36-59): index 0 only; KO indices come
from ``--multi-ko-indices`` (sim_worker.py:778-790) = experiments.sim_params
{"multi_gene_knockout": {"gene_symbols": [...], "ko_indices": [...]}}, recorded in
metadata.json["multi_ko_indices"] (must match). Each k knocks out TU rna_ids[k-1].
Symbols are mapped to ko indices through the genes table and must cover ko_indices.

tf_activity (variants/tf_activity.py:26-58): tfList = ["basal (no TF)"] +
sorted(sim_data.tf_to_active_inactive_conditions) -- sorted TF *ids*; tf =
tfList[(i+1)//2]; odd i active, even i inactive; i = 0 control. The schedule is
[(0, tf_to_active_inactive_conditions[tf]["<state> nutrients"])]. The campaign named T4
experiments from sorted TF *symbols* (hf_export/matrix.py:238-252 with
routers/experiments.py:115-139), so experiments.name / condition are WRONG for T4
("[T4] araC/active" ran CPLX-125 = trpR). tf_target / tf_state come from the variant index
and the TF id <-> symbol table reconstruction/ecoli/flat/condition/tf_condition.tsv
(columns "TF", "active TF"), and the description "Simulation of phenotype
CPLX-125__active." must agree.

ppgpp_conc (variants/ppgpp_conc.py:24-73): condition = ['basal','with_aa'][i // 10],
factor = [0.2, 0.4, ..., 2.0][i % 10]; the condition variant (variants/condition.py:16-23)
sets the schedule to [(0, conditions[cond].nutrients)]. Setpoint (uM) is parsed from the
description "ppGpp conc adjusted by 0.2x to 9.833114188181234 uM in basal." (factor and
condition there must match the index). Indices 4 and 14 are the factor-1 controls.

sinusoidal_media (variants/sinusoidal_media.py:48-97): index = period in minutes,
period_sec = 60 * index; media A/B from the SINE_MEDIA_A/B environment, which the worker
sets from experiments.sim_params {"sinusoidal_media": {...}} (sim_worker.py:388-406, 798-801);
the description "Sinusoidal media: period 15min, minimal <-> minimal_acetate" must agree.
Fraction of B is (sin(2 pi t / T) + 1) / 2 (local_environment.py:97-113), a continuous
mixture, so media_schedule, timeline, medium_at_birth and medium_at_division are null.

Amino-acid shifts, SHIFT_TIME = 600 s (add_one_aa_shift.py:27, remove_one_aa_shift.py:26,
remove_aas_shift.py:32). aa = sim_data.molecule_groups.amino_acids[i][:-3], order
L-ALPHA-ALANINE ARG ASN L-ASPARTATE CYS GLT GLN GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP
TYR L-SELENOCYSTEINE VAL (index 19 = selenocysteine = control).
* add_one_aa_shift (add_one_aa_shift.py:30-70): [(0, minimal), (600, minimal_plus_<aa>)];
  aa_shift "+<aa>"; control (19): [(0, minimal)], aa_shift "control" (the variant
  "shifts" to an identical medium).
* remove_one_aa_shift (remove_one_aa_shift.py:29-75): [(0, minimal_plus_amino_acids),
  (600, minimal_plus_amino_acids_minus_<aa>)]; aa_shift "-<aa>"; control (19):
  [(0, minimal_plus_amino_acids)]. NOTE: the simulator itself names the removal medium
  "minimal_plus_amino_acids_plus_<aa>" (remove_one_aa_shift.py:45); we write "_minus_",
  which is what it contains.
* remove_aas_shift (remove_aas_shift.py:46-122), aa_ids = amino acids minus
  L-SELENOCYSTEINE and CYS: 0 rich throughout ("control_rich"); 1 rich ->
  minimal_plus_12_amino_acids ("rich->12aa"); 2 rich -> minimal_plus_6_amino_acids
  ("rich->6aa"); 3 minimal throughout ("control_minimal"; the variant leaves the default
  "0 minimal" timeline); 4..22 rich -> minimal_plus_<aa_ids[i-4]> ("rich->only_<aa>");
  23 rich -> minimal ("rich->minimal"). "rich" = minimal_plus_amino_acids.

The per-index tables (TU ids, the cistron genes of each TU, amino-acid order, sorted TF
ids and their media) are frozen from sim_data into data/sim_data_tables.json by
extract_sim_data.py, verified identical across both parca caches the campaign used.
"""

from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

SHIFT_TIME_SEC = 600
RICH = "minimal_plus_amino_acids"
MINIMAL = "minimal"
PPGPP_FACTORS = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]
PPGPP_CONDITIONS = ["basal", "with_aa"]
AA_SKIP_FOR_REMOVE_AAS = {"L-SELENOCYSTEINE", "CYS"}
AA_6 = ["MET", "HIS", "ARG", "PRO", "THR", "TRP"]
AA_12 = AA_6 + ["SER", "LEU", "TYR", "L-ALPHA-ALANINE", "ASN", "L-ASPARTATE"]
# Variants that set their own timeline (sim_worker.py:583-604; tf_activity only for index != 0).
ENVIRONMENT_MANAGED = {"add_one_aa", "remove_one_aa", "add_one_aa_shift", "remove_one_aa_shift",
                       "remove_aas_shift", "ppgpp_conc", "sinusoidal_media", "condition"}

DATA_DIR = Path(__file__).resolve().parent / "data"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TF_CONDITION_TSV = REPO_ROOT / "reconstruction" / "ecoli" / "flat" / "condition" / "tf_condition.tsv"


class PerturbationError(ValueError):
    """The run does not match what its variant says it did."""


# -- tables -------------------------------------------------------------------------------

@dataclass
class Tables:
    rna_ids: list[str]
    tu_gene_ids: list[list[str]]
    amino_acids: list[str]           # without the [c] suffix
    tf_ids: list[str]                # sorted, as tf_activity.py:33 sorts them
    tf_nutrients: dict[str, dict[str, str]]
    tf_symbol_by_id: dict[str, str]
    condition_nutrients: dict[str, str]
    parca_caches: list[str]
    # genes table: symbol -> list of (ecoli_id, ko_index)
    genes_by_symbol: dict[str, list[tuple[str, int]]] = field(default_factory=dict)

    def tu_id(self, ko_index: int) -> str:
        if not 1 <= ko_index <= len(self.rna_ids):
            raise PerturbationError("KO index {} outside 1..{}".format(ko_index, len(self.rna_ids)))
        return self.rna_ids[ko_index - 1]

    def gene_id(self, symbol: str, ko_index: int) -> str:
        candidates = self.genes_by_symbol.get(symbol, [])
        exact = [eid for eid, ko in candidates if ko == ko_index]
        if len(exact) == 1:
            return exact[0]
        raise PerturbationError("gene {!r} has no unique genes row with ko_index {} (rows: {})".format(
            symbol, ko_index, candidates))

    def ko_index_of(self, symbol: str) -> int:
        kos = sorted({ko for _, ko in self.genes_by_symbol.get(symbol, []) if ko > 0})
        if len(kos) != 1:
            raise PerturbationError("gene {!r} has ko indices {}".format(symbol, kos))
        return kos[0]


def read_tf_symbols(path: Path = TF_CONDITION_TSV) -> dict[str, str]:
    """TF id ("active TF" column) -> symbol ("TF" column) from tf_condition.tsv."""
    out: dict[str, str] = {}
    with path.open(encoding="utf-8") as stream:
        rows = [r for r in csv.reader(stream, delimiter="\t") if r and not r[0].startswith("#")]
    header = [h.strip('"') for h in rows[0]]
    symbol_col, id_col = header.index("TF"), header.index("active TF")
    for row in rows[1:]:
        out[row[id_col].strip('"')] = row[symbol_col].strip('"')
    return out


def load_tables(genes_rows: list[tuple[str, str, int]], path: Path | None = None,
                tf_condition: Path = TF_CONDITION_TSV) -> Tables:
    """``genes_rows`` = (symbol, ecoli_id, ko_index) from the DB genes table."""
    raw = json.loads((path or DATA_DIR / "sim_data_tables.json").read_text())
    tf_symbols = read_tf_symbols(tf_condition)
    missing = [tf for tf in raw["tf_list"] if tf not in tf_symbols]
    if missing:
        raise PerturbationError("TF ids without a symbol in tf_condition.tsv: {}".format(missing))
    genes: dict[str, list[tuple[str, int]]] = {}
    for symbol, ecoli_id, ko_index in genes_rows:
        genes.setdefault(symbol, []).append((ecoli_id, int(ko_index)))
    return Tables(
        rna_ids=raw["rna_ids"], tu_gene_ids=raw["tu_gene_ids"],
        amino_acids=[a[:-3] if a.endswith("]") else a for a in raw["amino_acids"]],
        tf_ids=sorted(raw["tf_list"]), tf_nutrients=raw["tf_nutrients"],
        tf_symbol_by_id={tf: tf_symbols[tf] for tf in raw["tf_list"]},
        condition_nutrients=raw["condition_nutrients"], parca_caches=raw["parca_caches"],
        genes_by_symbol=genes,
    )


# -- timelines ----------------------------------------------------------------------------

def parse_timeline(text: str) -> list[tuple[int, str]]:
    """'0 minimal, 1200 minimal_acetate' -> [(0, 'minimal'), (1200, 'minimal_acetate')]."""
    events = []
    for part in (text or "").strip().strip('"').strip("'").split(","):
        part = part.strip()
        if not part:
            continue
        fields = part.split(None, 1)
        if len(fields) != 2:
            raise PerturbationError("bad timeline event {!r} in {!r}".format(part, text))
        seconds = float(fields[0])
        if seconds != int(seconds):
            raise PerturbationError("non-integral timeline time {!r}".format(part))
        events.append((int(seconds), fields[1].strip()))
    if not events:
        raise PerturbationError("empty timeline {!r}".format(text))
    if events[0][0] != 0 or any(b[0] <= a[0] for a, b in zip(events, events[1:])):
        raise PerturbationError("timeline must start at 0 and increase: {!r}".format(text))
    return events


def format_timeline(schedule: list[tuple[int, str]] | None) -> str | None:
    if schedule is None:
        return None
    return ", ".join("{} {}".format(t, m) for t, m in schedule)


def medium_at(schedule: list[tuple[int, str]] | None, t_abs: float) -> str | None:
    """The medium in effect at lineage-absolute time ``t_abs`` (local_environment.py:118)."""
    if schedule is None:
        return None
    current = schedule[0][1]
    for t, medium in schedule:
        if t_abs >= t:
            current = medium
    return current


# -- per-run perturbation -----------------------------------------------------------------

@dataclass
class Perturbation:
    variant: str
    media_schedule: list[tuple[int, str]] | None
    knockout_genes: list[str] | None = None
    knockout_gene_ids: list[str] | None = None
    knockout_tu_ids: list[str] | None = None
    media_a: str | None = None
    media_b: str | None = None
    period_sec: int | None = None
    tf_target: str | None = None
    tf_target_id: str | None = None
    tf_state: str | None = None
    ppgpp_setpoint_um: float | None = None
    ppgpp_factor: float | None = None
    aa_shift: str | None = None

    @property
    def timeline(self) -> str | None:
        return format_timeline(self.media_schedule)


_KO_DESC = re.compile(r"^Complete knockout of (.+?)\.(?:, \w+)?$")
_MULTI_DESC = re.compile(r"^Complete knockout of (\d+) KO targets by KO index: ([\d, .]+?)\.(?:, \w+)?$")
_TF_DESC = re.compile(r"^Simulation of phenotype (.+)__(active|inactive)\.(?:, \w+)?$")
_PPGPP_DESC = re.compile(r"^ppGpp conc adjusted by ([\d.]+)x to ([\d.eE+-]+) uM in (\w+)\.(?:, \w+)?$")
_SINE_DESC = re.compile(r"^Sinusoidal media: period (\d+)min, (\S+) <-> (\S+?)(?:, \w+)?$")


def _desc(description: str) -> str:
    return (description or "").strip()


def derive(variant_type: str, variant_index: int, experiment: dict, metadata: dict,
           description: str, tables: Tables) -> Perturbation:
    """Typed perturbation for one run.

    ``experiment`` carries the experiments row (gene_symbol, sim_params, condition);
    ``metadata`` is the run's metadata/metadata.json; ``description`` the text of
    ``<variant>_<index>/metadata/description``.
    """
    text = _desc(description)
    i = int(variant_index)
    if variant_type == "wildtype":
        if not text.startswith("Wildtype simulation"):
            raise PerturbationError("wildtype description {!r}".format(text))
        return Perturbation("wildtype", parse_timeline(metadata["timeline"]))

    if variant_type == "gene_knockout":
        if i == 0:
            raise PerturbationError("gene_knockout index 0 is the control; not in the campaign")
        tu = tables.tu_id(i)
        match = _KO_DESC.match(text)
        if not match or match.group(1) != tu:
            raise PerturbationError("gene_knockout {} should knock out {}, description says {!r}".format(i, tu, text))
        symbol = experiment["gene_symbol"]
        return Perturbation(symbol, parse_timeline(metadata["timeline"]), knockout_genes=[symbol],
                            knockout_gene_ids=[tables.gene_id(symbol, i)], knockout_tu_ids=[tu])

    if variant_type == "multi_gene_knockout":
        if i != 0:
            raise PerturbationError("multi_gene_knockout supports index 0 only")
        params = json.loads(experiment.get("sim_params") or "{}").get("multi_gene_knockout") or {}
        ko_indices = [int(k) for k in params.get("ko_indices", [])]
        symbols = list(params.get("gene_symbols", []))
        if [int(k) for k in metadata.get("multi_ko_indices") or []] != ko_indices:
            raise PerturbationError("metadata multi_ko_indices {} != sim_params ko_indices {}".format(
                metadata.get("multi_ko_indices"), ko_indices))
        match = _MULTI_DESC.match(text)
        described = [int(k) for k in match.group(2).replace(".", "").split(",")] if match else None
        if described != ko_indices:
            raise PerturbationError("multi KO description {!r} != ko_indices {}".format(text, ko_indices))
        by_symbol = {s: tables.ko_index_of(s) for s in symbols}
        if sorted(by_symbol.values()) != sorted(ko_indices):
            raise PerturbationError("gene symbols {} map to ko indices {}, sim_params says {}".format(
                symbols, by_symbol, ko_indices))
        return Perturbation("+".join(symbols), parse_timeline(metadata["timeline"]), knockout_genes=symbols,
                            knockout_gene_ids=[tables.gene_id(s, by_symbol[s]) for s in symbols],
                            knockout_tu_ids=[tables.tu_id(by_symbol[s]) for s in symbols])

    if variant_type == "tf_activity":
        if i == 0:
            raise PerturbationError("tf_activity index 0 is the control; not in the campaign")
        tf_list = ["basal (no TF)"] + tables.tf_ids
        if (i + 1) // 2 >= len(tf_list):
            raise PerturbationError("tf_activity index {} beyond {} TFs".format(i, len(tables.tf_ids)))
        tf_id = tf_list[(i + 1) // 2]
        state = "active" if i % 2 == 1 else "inactive"
        match = _TF_DESC.match(text)
        if not match or (match.group(1), match.group(2)) != (tf_id, state):
            raise PerturbationError("tf_activity {} should be {}__{}, description says {!r}".format(i, tf_id, state, text))
        symbol = tables.tf_symbol_by_id[tf_id]
        medium = tables.tf_nutrients[tf_id][state]
        return Perturbation(symbol, [(0, medium)], tf_target=symbol, tf_target_id=tf_id, tf_state=state)

    if variant_type == "ppgpp_conc":
        condition = PPGPP_CONDITIONS[i // len(PPGPP_FACTORS)]
        factor = PPGPP_FACTORS[i % len(PPGPP_FACTORS)]
        match = _PPGPP_DESC.match(text)
        if not match or float(match.group(1)) != float(factor) or match.group(3) != condition:
            raise PerturbationError("ppgpp_conc {} should be {}x in {}, description says {!r}".format(i, factor, condition, text))
        return Perturbation("ppgpp_conc", [(0, tables.condition_nutrients[condition])],
                            ppgpp_setpoint_um=float(match.group(2)), ppgpp_factor=float(factor))

    if variant_type == "sinusoidal_media":
        params = json.loads(experiment.get("sim_params") or "{}").get("sinusoidal_media") or {}
        media_a = params.get("SINE_MEDIA_A") or "minimal"            # sinusoidal_media.py:44-45
        media_b = params.get("SINE_MEDIA_B") or "minimal_GLC_2mM"
        match = _SINE_DESC.match(text)
        if not match or (int(match.group(1)), match.group(2), match.group(3)) != (i, media_a, media_b):
            raise PerturbationError("sinusoidal {} {}<->{} but description says {!r}".format(i, media_a, media_b, text))
        return Perturbation("sinusoidal_media", None, media_a=media_a, media_b=media_b, period_sec=60 * i)

    if variant_type in ("add_one_aa_shift", "remove_one_aa_shift"):
        if not 0 <= i < len(tables.amino_acids):
            raise PerturbationError("{} index {} beyond {} amino acids".format(variant_type, i, len(tables.amino_acids)))
        aa = tables.amino_acids[i]
        adding = variant_type == "add_one_aa_shift"
        base = MINIMAL if adding else RICH
        if aa == "L-SELENOCYSTEINE":
            expected = "Minimal media control" if adding else "Minimal media with amino acids control"
            if not text.startswith(expected):
                raise PerturbationError("{} {} control, description says {!r}".format(variant_type, i, text))
            return Perturbation(variant_type, [(0, base)], aa_shift="control")
        expected = ("Add {} to minimal media.".format(aa) if adding else "Remove {} from rich media.".format(aa))
        if not text.startswith(expected):
            raise PerturbationError("{} {} should be {!r}, description says {!r}".format(variant_type, i, expected, text))
        target = "minimal_plus_{}".format(aa) if adding else "{}_minus_{}".format(RICH, aa)
        return Perturbation(variant_type, [(0, base), (SHIFT_TIME_SEC, target)],
                            aa_shift=("+" if adding else "-") + aa)

    if variant_type == "remove_aas_shift":
        aa_ids = [a for a in tables.amino_acids if a not in AA_SKIP_FOR_REMOVE_AAS]
        n_fixed = 4
        if i == 3:
            expected, schedule, label = "Minimal media with no amino acids", [(0, MINIMAL)], "control_minimal"
        elif i == 0:
            expected, schedule, label = "Minimal media with amino acids control", [(0, RICH)], "control_rich"
        elif i == n_fixed + len(aa_ids):
            expected, schedule, label = ("Remove all amino acids from rich media",
                                         [(0, RICH), (SHIFT_TIME_SEC, MINIMAL)], "rich->minimal")
        elif i == 1:
            expected, schedule, label = ("Remove 8 AAs from rich media.",
                                         [(0, RICH), (SHIFT_TIME_SEC, "minimal_plus_12_amino_acids")], "rich->12aa")
        elif i == 2:
            expected, schedule, label = ("Remove 14 AAs from rich media.",
                                         [(0, RICH), (SHIFT_TIME_SEC, "minimal_plus_6_amino_acids")], "rich->6aa")
        elif n_fixed <= i < n_fixed + len(aa_ids):
            aa = aa_ids[i - n_fixed]
            expected, schedule, label = ("Remove all but {} from rich media".format(aa),
                                         [(0, RICH), (SHIFT_TIME_SEC, "minimal_plus_{}".format(aa))],
                                         "rich->only_{}".format(aa))
        else:
            raise PerturbationError("remove_aas_shift index {} out of range".format(i))
        if not text.startswith(expected):
            raise PerturbationError("remove_aas_shift {} should be {!r}, description says {!r}".format(i, expected, text))
        return Perturbation(variant_type, schedule, aa_shift=label)

    raise PerturbationError("no mapping for variant type {!r}".format(variant_type))


# -- names and outcomes -------------------------------------------------------------------

_NAME = re.compile(r"^\[(T\d)(?:_[A-Z]+)?\]\s+(.+)$")


def tier_of(experiment_name: str) -> str:
    match = _NAME.match(experiment_name)
    if not match:
        raise PerturbationError("experiment name without a [Tn] prefix: {!r}".format(experiment_name))
    return match.group(1)


def cell_id_for(experiment_name: str, perturbation: Perturbation | None = None) -> str:
    """'[T2_CORE] argG_KO/basal' -> 'T2/argG_KO/basal'. T4 tf_activity names are rebuilt from
    the TF that actually ran ('[T4] araC/active' at index 1 -> 'T4/trpR/active')."""
    match = _NAME.match(experiment_name)
    if not match:
        raise PerturbationError("experiment name without a [Tn] prefix: {!r}".format(experiment_name))
    tier, rest = match.group(1), match.group(2).strip().replace(" ", "_")
    if perturbation is not None and perturbation.tf_target is not None:
        rest = "{}/{}".format(perturbation.tf_target, perturbation.tf_state)
    return "{}/{}".format(tier, rest)


TERMINATION_CLASSES = {
    "TimeLimitReached": "time_limit",
    "NegativeCountsError": "negative_counts",
    "FBASolveFailed": "fba_infeasible",
    "EquilibriumUnstable": "equilibrium_unstable",
}


def termination_class(terminated: bool, reason: str | None) -> str:
    if not terminated:
        return "none"
    head = (reason or "").split(":", 1)[0].strip()
    return TERMINATION_CLASSES.get(head, "other")
