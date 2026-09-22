# issues.md — Known simulation failures in the klone SLURM campaigns

Status: **fixes applied 2026-09-22; all 2,052 failed jobs re-dispatched.** Recorded 2026-09-22
from `state/wcecoli.db`, `state/campaign_ledger.jsonl`, `sacct`, and a walk of
`$WCECOLI_CAMPAIGN_ROOT/out`. Companion docs: `cluster/RUN_SLURM.md` (runbook), `PLAN.md`
(design).

**Fixes applied 2026-09-22** (see [Re-dispatch, 2026-09-22](#re-dispatch-2026-09-22) at the end
for the validation pilot and the resubmission):

| Issue | Change | Where |
|---|---|---|
| 1, 5 | **"No growth" is a result, not a crash.** `NegativeCountsError` now ends the *lineage*: the simulator finalizes the dying generation's tables, writes a marker, and the job is ingested as `done` with `lineage_terminated=1`, every generation that ran as a result, the dying one flagged `terminated` with the molecule that ran out. | `wholecell/sim/simulation.py`, `runscripts/manual/runSim.py`, `app/services/{table_reader_bridge,sim_worker,slurm_ingest,slurm_campaign}.py`, `app/db/{models,migrations}.py`, `hf_export/{run_export,converter}.py` |
| 2 | `plus_cytidine` row in `condition_defs.tsv`; guarded lookup in `chromosome_replication.py`; parca-time validation that every `tf_condition.tsv` medium has a doubling time. **Parca cache rebuilt** as `parca_cache_5558948af4ad806f21d7c80c`. | `reconstruction/ecoli/flat/condition/condition_defs.tsv`, `reconstruction/ecoli/simulation_data.py`, `models/ecoli/processes/chromosome_replication.py` |
| 4c | Homeostatic targets negative by less than `1e-6` are clamped to zero (with a warning) instead of raising. | `wholecell/utils/modular_fba.py` |
| 6 | The bare `assert` in `getKineticObjectiveValues` is a warning naming the reaction (the value only feeds a listener); the equilibrium solver now checks `sol.success` and falls through to the next method instead of crashing on `'list' object has no attribute 'T'`. | `wholecell/utils/modular_fba.py`, `reconstruction/ecoli/dataclasses/process/equilibrium.py` |
| 7 | `WCECOLI_SLURM_TIME` 03:00:00 -> **04:00:00**. | `cluster/campaign_env.sh` |
| — | `cluster/wce requeue` returns terminal jobs to `pending` (backs up the DB, deletes stale results, optionally purges old output). `status` reports lineage-terminated jobs grouped by reason. | `app/services/slurm_campaign.py` |

Not fixed: **4a** (tRNA charging divergence, 380 jobs) and the GLPK `GLP_ESING`/`GLP_EFAIL`
half of 4c, plus the ppGpp and negative-equilibrium classes in Issue 6. Those jobs were
re-dispatched anyway, because a cell that stalls before it hits one of those numerical paths
may now die through `NegativeCountsError` first and be recorded as a terminated lineage.

Four tiers have been dispatched and all four are terminal — **9,152 jobs, 7,100 done /
2,052 failed**, nothing pending, nothing in flight. Last tick 2026-09-19T14:20:23Z. T2_CORE,
T2_EXTENDED and T6 have never been submitted.

| Tier | Campaign | Job ids | Jobs | Done | Failed | Rate | Dominant cause |
|---|---|---|---:|---:|---:|---:|---|
| T1 | `t1_klone_v1` | 1–168 | 168 | 153 | 15 | 8.9% | Issue 1 |
| T4 | `t4_klone_v1` | 169–680 | 512 | 499 | 13 | 2.5% | Issue 2 (8), Issue 4 (5) |
| T5 | `t5_klone_v1` | 681–3680 | 3,000 | 2,944 | 56 | 1.9% | Issue 4 |
| T3 | `t3_klone_v1` | 3681–9152 | 5,472 | 3,504 | 1,968 | 36.0% | Issue 1 (1,534), Issue 5 (428) |

Every failure is accounted for below. By error class, across all four tiers:

| Failure | T1 | T3 | T4 | T5 | Total | Issue |
|---|---:|---:|---:|---:|---:|---|
| `NegativeCountsError` | 15 | 1,562 | — | 4 | **1,581** | 1, 5 |
| `ValueError: array must not contain infs or NaNs` | — | 343 | 1 | 36 | **380** | 4a |
| `GLP_ESING: Basis matrix is singular` | — | 27 | 2 | 10 | **39** | 4c |
| `GLP_EFAIL: Solver failure` | — | 18 | — | 5 | **23** | 4c |
| `KeyError: 'minimal_plus_cytidine'` | — | — | 8 | — | **8** | 2 |
| `Failed to meet molecule limits with ppGpp reactions` | — | 8 | — | — | **8** | 6 |
| SLURM-level kill, no traceback | — | 4 | — | 1 | **5** | 7 |
| `Have negative values at equilibrium steady state` | — | 3 | — | — | **3** | 6 |
| `AssertionError` (`modular_fba.py:1392`) | — | 2 | — | — | **2** | 6 |
| `AttributeError: 'list' object has no attribute 'T'` | — | 1 | — | — | **1** | 6 |
| `GLP_NOFEAS: no feasible` | — | — | 1 | — | **1** | 4c |
| `Homeostatic target must be non-negative` | — | — | 1 | — | **1** | 4c |
| **Total** | **15** | **1,968** | **13** | **56** | **2,052** | |

The issues below are grouped by *cause*, so their job counts overlap the table above, which
is grouped by *error signature*: a starved cell (Issue 1) or a blocked auxotroph (Issue 5)
often dies through an Issue-4 numerical path rather than through `NegativeCountsError`. The
table is the non-overlapping count; 2,052 is the total.

Two headline changes since the previous revision of this file:

* **Issue 1's preferred remedy is disproven.** Shifting into the depleted medium instead of
  starting in it does *not* rescue `no_glucose` / `minus_phosphate`. It was re-run on T1 and
  then tested at scale by T3: `phosphate_depletion` completed **0 of 808** jobs.
* **Issue 4b is fixed and validated**, and Issues 4a/4c are now proven **deterministic** —
  the open question in the previous revision. Re-runs reproduce them exactly.

**Note on retries.** `failed` is a terminal status. `reconcile` requeues only lost or
preempted array tasks (`COMPLETED`-without-sentinel, `PREEMPTED`, `NODE_FAIL`, `REQUEUED`,
`BOOT_FAIL`, `REVOKED` — `app/services/slurm_campaign.py:505-530`); a job that ran and exited
non-zero is never retried automatically. Re-running one is now an explicit command,
`cluster/wce requeue` (`--dry-run`, `--ids`, `--purge-output`), which backs up the database,
deletes the jobs' stale `simulation_results` rows, sets them and their experiments back to
`pending`/`queued`, and lets the next tick dispatch them as a new attempt. Before 2026-09-22
this was done by hand: T1's Issue-1 jobs were at `attempt=3` and T4's failures at `attempt=2`
from the 2026-09-07 re-dispatch; everything in T3 and T5 was at `attempt=1`.

---

## Issue 1 — Depleted media crash with `NegativeCountsError`, shift timeline or not

**Status: fixed as a result path (remedy 4 below, implemented 2026-09-22 via Issue 5's
remedy 2). The medium is still one the model cannot grow in; the crash is now recorded as a
terminated lineage instead of a failed job.** The analysis below is unchanged.

**Affects 1,549 jobs:**

* **T1, 15 jobs** — `no_glucose` (81–83, 85–88) and `minus_phosphate` (105–112).
  Job 84 (`no_glucose`, seed 3) is the single survivor of the 16.
* **T3, 1,534 jobs** — the `glucose_starvation` (5297–6104) and `phosphate_depletion`
  (6105–6912) protocols, 808 jobs each:

| T3 protocol | Timeline | Done | Failed | Rate |
|---|---|---:|---:|---:|
| `glucose_starvation` | `0 minimal, 1200 minimal_no_glucose` | 82 | 726 | 90% |
| `phosphate_depletion` | `0 minimal, 2400 minimal_minus_phosphate` | 0 | 808 | **100%** |

### Symptom

```
wholecell/sim/simulation.py:369   _evolveState -> state.merge(processes)
wholecell/states/bulk_molecules.py:196
NegativeCountsError: Negative value(s) in self._countsAllocatedFinal:
ATP[c] in PolypeptideElongation (-3900)
```

Preceded in the log by falling dry mass, a dry-mass fold change pinned near 1.0 while the
expected fold change climbs, and repeating `Warning: GLP_NOFEAS: no feasible error while
solving FBA - repeating FBA solve`. Of the 1,534 T3 starvation failures, **1,478 are this
exact error**; the remaining 56 are Issue-4 numerics reached on the way down (35 `infs or
NaNs`, 17 GLPK, 2 SLURM kills, 2 other).

### Cause

The initial state is parameterised for glucose-minimal growth at a 100 min doubling time. In a
medium that cannot sustain that, the cell cannot make ATP, drains the pool, and
`PolypeptideElongation` allocates more ATP than exists.

The original diagnosis was that the campaign started cells *in* the depleted medium at t=0
while the repo's own definitions shift into depletion only after the cell is established
(`reconstruction/ecoli/flat/condition/timelines_def.tsv:4,20`):

```
"000001_cut_glucose"        "0 minimal, 1200 minimal_no_glucose"
"000017_phosphate_absent"   "0 minimal, 2400 minimal_minus_phosphate"
```

That diagnosis was **incomplete**. Establishing the cell first delays the crash but does not
prevent it: the cell grows on minimal, the medium is cut, and it then dies the same way, a
generation or so later.

### Evidence that the shift timeline does not fix it

1. **T1 re-run.** All 16 jobs were re-dispatched on 2026-09-07 at `attempt=3` with the shift
   timeline. Verified from the dispatch manifest
   (`state/manifests/20260907_180016_732deb.jsonl`):

   ```
   job  81  attempt=3  --timeline '0 minimal, 1200 minimal_no_glucose'
   job 105  attempt=3  --timeline '0 minimal, 2400 minimal_minus_phosphate'
   ```

   **15 of the 16 failed again with the same `NegativeCountsError`.** Only job 84 completed.

2. **T3 at scale.** The two T3 protocols *are* the shift timelines, applied to WT and 100
   knockouts. `phosphate_depletion` produced no usable job at all; `glucose_starvation`
   produced 82 (10%).

3. **It is not a knockout artefact.** The WT cell of these two protocols fails 15 of its
   16 jobs — the same 15/16 as T1. The genotype is irrelevant; the medium is the fault.

4. **Starvation jobs die early and cheaply**: 27.7 min of SLURM elapsed for a failed
   starvation job against 70–73 min for everything else in T3, so the 1,534 failures cost
   708 core-hours — 13% of the tier's compute for 28% of its jobs.

### Remedies — reconsidered

1. ~~**Use the shift timelines.**~~ **Tried, disproven.** The code change is still in place
   (see below) and is harmless, but it does not recover these conditions.
2. **Drop the two conditions / two protocols from the matrix.** This is now the recommended
   action. It removes 2 of 21 T1 conditions, 2 of 6 T3 timeline protocols, and — see the
   scale-up warning — 3,008 jobs from T2_EXTENDED.
3. **Keep the crash as a result.** Defensible as a model prediction (no growth is possible in
   these media), but it yields no exportable trajectory past the failure point, and for
   `phosphate_depletion` no trajectory at all.
4. **Treat it as a model defect and fix the model.** The honest reading of 0/808 is that
   wcEcoli cannot currently simulate phosphate depletion, shift or no shift. That is a
   modelling project, not a campaign fix, but it is the only path that produces this data.

**Done (2026-09-22): the crash is a result.** `wholecell/sim/simulation.py` catches
`NegativeCountsError` (the `LINEAGE_TERMINATING_EXCEPTIONS` tuple, deliberately only that
class) inside `Simulation.run`, lets `finalize()` flush every listener so the dying
generation's tables are complete on disk, writes `simOut/lineage_termination.json`, and
raises `LineageTerminated`. `runscripts/manual/runSim.py` catches that, stops the seed's
generation loop (there is no daughter state to inherit), records the (variant, seed,
generation, exception, message, time, step) under `<run>/metadata/lineage_termination.json`,
and **exits 0**. Any other exception still fails the run exactly as before.

On the ingest side `_collect_results` reads that marker and accepts generations
`0..k` where `k` is the generation that died — anything short *without* a marker is still
the "Generation output mismatch" failure it always was. The job is committed `done` with
`simulation_jobs.lineage_terminated=1` and `termination_reason` (e.g.
`NegativeCountsError: ATP[c] in PolypeptideElongation (-3900)`); each generation is a
`simulation_results` row, the dying one with `terminated=1`. The pruned HDF5 carries the same
two attributes per generation, `run_export` labels that generation `terminated` in
`export_qc.jsonl` (it is exported; the label says why it is short), and `metadata.jsonl`
rows carry `terminated`/`termination_reason`. `cluster/wce status` groups terminated jobs by
reason the way it groups failures.

So a `phosphate_depletion` job now yields its minimal-medium generation(s) plus the
trajectory of the cell dying after the shift, which is the model's actual prediction for
that medium. Remedy 2 (dropping the conditions) is no longer needed for the re-run, and
the T2_EXTENDED warning below becomes a cost question rather than a data-loss one.

### Fix status — code change applied, effect disproven

`app/services/sim_worker.py:_resolve_condition_timeline` (with `_timeline_events` and
`_shift_timeline_for_media`, `sim_worker.py:522-570`) prefers a *static* timeline from
`timelines_def` and falls back to a **shift** timeline only when timelines_def defines no
static entry for that medium and does define a shift into it starting at plain `minimal`.
Enumerated over the 21 T1 conditions it changes three:

| Condition | Before | After |
|---|---|---|
| `no_glucose` | `0 minimal_no_glucose` | `0 minimal, 1200 minimal_no_glucose` |
| `minus_phosphate` | `0 minimal_minus_phosphate` | `0 minimal, 2400 minimal_minus_phosphate` |
| `plus_arabinose` | `0 minimal_plus_arabinose` | `0 minimal, 1200 minimal_plus_arabinose` |

The first two no longer matter, since neither form works. **`plus_arabinose` is settled**: it
was re-run at `attempt=3` under the shift timeline and completes 8/8 (jobs 113–120), so the
collateral semantic change is accepted and the T1 `plus_arabinose` results are the shift
form. The GLC conditions are untouched because their ramps start at `minimal_GLC_20mM` /
`minimal_GLC_2mM`, which the "starts at minimal" rule excludes.

### Scale-up warning — narrower than previously stated

The previous revision claimed both T2 tiers inherit this. That is wrong:

* **T2_CORE is unaffected.** `T2_CORE_CONDITIONS = KO_CORE_CONDITIONS = basal, glc_20mM,
  acetate, succinate, with_aa` (`hf_export/matrix.py:31-33`) — no depleted medium.
* **T2_EXTENDED is affected.** It sweeps all 21 `WT_CONDITIONS`, so `no_glucose` and
  `minus_phosphate` are 2/21 of 31,584 jobs = **3,008 jobs**, of which ~90–100% would fail
  on this evidence: roughly 1,400 core-hours burned for almost no data.

---

## Issue 2 — `tf_activity` variant 14 crashes with `KeyError` on an uncovered medium (T4)

**Status: fixed 2026-09-22 (remedies 1 and 3 below); parca cache rebuilt; the 8 jobs
re-dispatched.** 8 jobs — ids 273–280, `tf_activity` variant_index 14,
all 8 seeds, were at `attempt=2` and failing identically. This is the transcription factor
`cytR` / `CPLX0-7740` in its **inactive** state.

### Symptom

```
models/ecoli/processes/chromosome_replication.py:92
    self.criticalInitiationMass = self.get_dna_critical_mass(
        self.nutrientToDoublingTime[current_media_id])
KeyError: 'minimal_plus_cytidine'
```

The job dies in roughly 2 minutes rather than the usual ~3 h, because it fails at the first
chromosome-replication initiation check rather than deep inside the simulation.

### Cause

The `tf_activity` variant **overrides the timeline supplied on the command line**
(`models/ecoli/sim/variants/tf_activity.py:43-47`):

```python
sim_data.external_state.current_timeline_id = timeline_id
sim_data.external_state.saved_timelines[timeline_id] = []
sim_data.external_state.saved_timelines[timeline_id].append((
    0.0,
    sim_data.tf_to_active_inactive_conditions[tf][tfStatus + " nutrients"]
    ))
```

So `--timeline 0 minimal` is discarded and replaced by the TF's own nutrient condition. For
`cytR` inactive that is `minimal_plus_cytidine` (`condition/tf_condition.tsv:19`).

That medium is defined in `condition/media_recipes.tsv:15`, but **no row in
`condition/condition_defs.tsv` uses it**, and `sim_data.nutrient_to_doubling_time` is keyed off
`condition_defs`. The medium is loadable but has no doubling time, and
`chromosome_replication.py:92` indexes the mapping unguarded.

### Scope — contained

All 47 `tf_activity` variants were enumerated against the parca cache's 21 doubling-time
entries. **Exactly one is broken: index 14.** Reproduce with:

```bash
source cluster/campaign_env.sh
export KB="$WCECOLI_CAMPAIGN_ROOT/out/$WCECOLI_PARCA_RUN_ID/kb"
"${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_SIM_ENV}/bin/python" - <<'EOF'
import pickle, os
sd = pickle.load(open(os.path.join(os.environ['KB'], 'simData.cPickle'), 'rb'))
ntd = sd.nutrient_to_doubling_time
tfs = sorted(sd.tf_to_active_inactive_conditions)
tf_list = ["basal (no TF)"] + tfs
for idx in range(1, 2 * len(tfs) + 1):
    tf = tf_list[(idx + 1) // 2]
    status = "active" if idx % 2 == 1 else "inactive"
    media = sd.tf_to_active_inactive_conditions[tf][status + " nutrients"]
    if media not in ntd:
        print(f"BROKEN idx={idx} {tf} {status} {media}")
EOF
```

### Remedies — none actioned

1. **Close the data gap.** Add a `minimal_plus_cytidine` row to
   `reconstruction/ecoli/flat/condition/condition_defs.tsv` with a doubling time (other
   perturbation conditions use `100.0` min), then rebuild the parca cache. This invalidates
   the pinned `WCECOLI_PARCA_RUN_ID`, so it is a campaign-level decision. Now cheaper than it
   was: no tier is in flight, so a rebuild disrupts nothing.
2. **Defer and backfill.** 8 jobs out of 512; re-dispatch them as a small campaign once the
   data is fixed. Retry cost is ~2 min × 8.
3. **Harden regardless.** `chromosome_replication.py:92` should name the medium and point at
   `condition_defs.tsv` rather than raising a bare `KeyError`, and a
   `tf_condition.tsv` × `condition_defs.tsv` validation pass at parca time would catch the
   whole class before any job is dispatched. Still open and still worth doing.

### Fix — applied 2026-09-22

* **Data:** `condition_defs.tsv` gained
  `"plus_cytidine" "minimal_plus_cytidine" {} 44.0 [] ["CPLX0-7740"]`. The doubling time is
  **44.0 min, not the 100 min first proposed**, on purpose: `simulation_data.py` already
  assigned `cytR__inactive` a doubling time of `nutrient_to_doubling_time.get(medium,
  basal_dt)`, i.e. basal's 44 min, when the medium was missing. 44 min therefore keeps the
  parca fit of the cytR condition — and everything downstream of it (`delta_prob`,
  `pPromoterBound`) — byte-identical; 100 min would have refit it. It also matches every
  other `plus_*` supplement row in the file.
* **Guard:** `chromosome_replication.py` raises a `KeyError` that names the medium and the
  known media and points at `condition_defs.tsv`.
* **Validation at parca time:** `simulation_data.py` raises `ValueError` listing every
  `(tf, active|inactive, medium)` in `tf_condition.tsv` without a doubling time, before any
  fitting starts. Checked against the TSVs directly: cytR-inactive was the only gap in 23 TFs.
* **Parca rebuilt:** `cluster/parca.sbatch` on `ckpt`, 10 min 23 s, as
  `parca_cache_5558948af4ad806f21d7c80c` (the id is a hash of `reconstruction/ecoli` and
  `models/ecoli`, so the four edits above changed it). Pinned in `state/parca_run_id`; the
  old pin is kept as `state/parca_run_id.prev-fa6a9ebd`, and the old cache directory is
  untouched. **Diffed against the old cache** (`simData.cPickle`, every attribute walked
  recursively, arrays compared exactly): 11 keys added, all of them the new `plus_cytidine`
  condition (`conditions`, `condition_to_doubling_time`, `nutrient_to_doubling_time`,
  `pPromoterBound`, the per-condition transcription tables), one length change
  (`ordered_conditions` 21 -> 22), **zero changed values**. The 7,100 done jobs and the
  re-runs therefore share the same fitted model.

---

## Issue 3 — Storage exhaustion during T1 (resolved and validated in production)

**Status: resolved.** The original fault: attempt 1 of several T1 jobs on 2026-09-03 died with

```
OSError: [Errno 122] Disk quota exceeded:
  .../out/20260903_202815_wildtype_job88_attempt1/.../Daughter1_inherited_state.cPickle
```

### Cause

Pruning runs once at the end of a whole job (`app/services/slurm_ingest.py:236`), after
`_collect_results` succeeds — not per generation. Every running job holds its full raw
`simOut` tree for its entire lifetime and collapses to the pruned form only at the end, so
peak filesystem load is **concurrency × raw size**, not the final footprint:

| | per job |
|---|---|
| Raw, held for the whole run | ~2.8 GB, ~1,259 files |
| Pruned, after ingestion | ~116 MiB, ~10 files (measured over 9,152 jobs) |

Sizing a dispatch against the pruned figure understates the peak by more than 20×. At
`WCECOLI_MAX_IN_FLIGHT=150` the transient peak is ~420 GB.

### Prune-on-failure — applied and validated

`app/services/slurm_ingest.py:ingest` runs `convert_and_prune` on the failure path too, under
the same `WCECOLI_PRUNE_SIMOUT` gate, wrapped so any error leaves the tree untouched and never
masks the simulation's own failure. Generations that *did* complete are converted to HDF5
before the raw tree is deleted.

**Validated across T3's 1,968 real failures** (sample of 40): a failed job now occupies
**6 files / 94 MiB**, against 10 files / 116 MiB for a successful one. Before the fix, failed
jobs kept their raw tree — 1.2–4.6 GiB each for a job that died deep into a generation. Had
T3 run without it, its failures alone would have stranded well over 2 TB.

### Still outstanding

**T4's 19.7 GiB of stranded trees was never swept** — until the 2026-09-22 re-dispatch: the
change only affects jobs ingested after it landed, and T4 ran before, so its 13 failed jobs
held ~19.7 GiB / ~7.7k files, a third of the tier's 59.9 GiB. `cluster/wce requeue
--purge-output` removed them (and every other failed job's old tree) when the failures were
requeued.

### Current headroom

`/gscratch/amath` is at **8,235 / 15,360 GB (54%)** and **9,345,778 / 15,000,000 files
(62%)**, of which this campaign is 1,110 GB and ~726k files. That is far more room than the
~2.1 TB / ~300k inodes recorded in `PLAN.md` and `cluster/RUN_SLURM.md` — **those figures are
stale**; other group members freed space. Disk still binds before inodes because of the
transient raw tree.

---

## Issue 4 — Numerical and solver faults (all tiers)

**Status: open. 4b fixed and validated; the homeostatic-target half of 4c fixed 2026-09-22;
4a and the GLPK half of 4c unfixed but proven deterministic.**

**Affects 444 jobs** across every tier — the background failure rate of the model itself:

| Sub-mode | T3 | T4 | T5 | Total |
|---|---:|---:|---:|---:|
| 4a `infs or NaNs` (tRNA charging ODE) | 343 | 1 | 36 | **380** |
| 4c `GLP_ESING` / `GLP_EFAIL` / `GLP_NOFEAS` / homeostatic target | 45 | 4 | 15 | **64** |
| 4b `VariableEntrySizeError` | 0 | 0 | 0 | **0** (fixed) |

The rate is strongly condition-dependent: **1.9% in T5** (static media) against **11.3% of
T3's non-starvation jobs** (media shifts). A shift roughly sextuples it.

### 4a — tRNA charging ODE diverges

```
models/ecoli/processes/polypeptide_elongation.py:1081  solve_ivp(dcdt, ..., method='BDF')
scipy/integrate/_ivp/bdf.py:364                        LU = self.lu(self.I - c * J)
ValueError: array must not contain infs or NaNs
```

Preceded by divide-by-zero warnings in the charging model (`polypeptide_elongation.py:856`,
`:1076`, `:1098`) and `invalid value encountered in subtract` from the BDF integrator. The
charging state goes non-finite and the next Jacobian factorisation rejects it. Growth stalls
first — dry-mass fold change pinned near 1.0.

This is now the **second-largest failure class in the campaign**, and the largest that is not
a media artefact. Unfixed.

### 4b — `aaCountInSequence` written at the wrong width — FIXED AND VALIDATED

```
models/ecoli/listeners/ribosome_data.py:157  tableWriter.append(aaCountInSequence=...)
VariableEntrySizeError: Entry size in bytes, elements (128, 16) is inconsistent with (168, 21)
```

`polypeptide_elongation.py:201` built the array with `np.bincount(...)` and no `minlength`, so
when translation falls far enough that the top amino-acid indices appear in no ribosome
sequence, the array comes back short (16 or 12 entries instead of 21). The listener allocates
a fixed 21 (`ribosome_data.py:43`) and the column is not in `set_variable_length_columns`
(`ribosome_data.py:148-152`), so the writer refuses the row.

**Fixed** — `polypeptide_elongation.py:208` now passes `minlength=len(self.aaNames)`.

**Validated:** zero `VariableEntrySizeError` across all 9,152 jobs, including 8,472 run after
the fix. Job 246, one of the two original victims, completed on `attempt=2`. Job 242 still
fails, but now with `GLP_NOFEAS` — its trajectory was sick independently of the writer fault.

`aaCounts` was audited alongside and needs no change: it derives from `self.aas.counts()` and
is always full width.

### 4c — FBA solve degenerates

```
models/ecoli/processes/metabolism.py:195   fba.solve(n_retries)
wholecell/utils/modular_fba.py:1539        self.solve(iterations - 1)   (x3, exhausted)
wholecell/utils/_netflow/nf_glpk.py:482
RuntimeError: GLP_ESING: Basis matrix is singular
```

and, one step earlier in the same process (job 461):

```
models/ecoli/processes/metabolism.py:496   self.fba.update_homeostatic_targets(objective)
wholecell/utils/modular_fba.py:1204
ValueError: Homeostatic target must be non-negative. It is -4.4661743080447463e-07 for BIOTIN[c].
```

The BIOTIN target is negative by 4e-07 — a rounding artefact, not a biologically negative
demand. `modular_fba.py:1204` rejects it with a strict `< 0` test rather than clamping small
negatives to zero. `GLP_ESING` / `GLP_EFAIL` are the same family: the LP drifts into a
degenerate basis and the retry ladder in `modular_fba.py:1539` runs out.

### Determinism — answered: these are deterministic

The previous revision left this open. The 2026-09-07 re-dispatch of T4 settles it. All four
surviving Issue-4 jobs reproduced their **exact** failure on `attempt=2`:

| Job | Variant | Seed | attempt=1 | attempt=2 |
|---|---|---|---|---|
| 203 | 5 `CPLX0-226` active | 2 | `infs or NaNs` | `infs or NaNs` |
| 341 | 22 `FNR-4FE-4S-CPLX` inactive | 4 | `GLP_ESING` | `GLP_ESING` |
| 370 | 26 `MONOMER0-160` inactive | 1 | `GLP_ESING` | `GLP_ESING` |
| 461 | 37 `PHOSPHO-ARCA` active | 4 | homeostatic target `-4.466e-07` | identical value |

So a plain re-dispatch recovers nothing, and BLAS/node variation is not the cause. These are
specific (genotype, condition, seed) cells that fail every time.

### Remedies

1. ~~**Fix 4b.**~~ **Done and validated.**
2. ~~**Clamp the homeostatic target.**~~ **Done 2026-09-22.** `modular_fba.py` clamps a
   target more negative than zero but not below `HOMEOSTATIC_TARGET_TOLERANCE = 1e-6` to
   zero with a warning; anything below the tolerance still raises. Job 461's `-4.466e-07`
   is inside it. Recovers that sub-class only; `GLP_ESING`/`GLP_EFAIL`/`GLP_NOFEAS` are
   untouched.
3. ~~**Re-dispatch and establish determinism.**~~ **Done** — they are deterministic.
4. **Accept the loss.** 1.9% in static media is defensible. In shifting media it is 11.3%,
   and that is the number to carry into any tier built on timelines.
5. **Investigate 4a properly.** At 380 jobs it is the largest tractable class left. The
   divide-by-zero warnings in the charging model precede every instance and are the obvious
   place to start.

---

## Issue 5 — Amino-acid auxotroph knockouts cannot grow under a media shift (T3)

**Status: remedy 2 below implemented 2026-09-22 (see Issue 1, "Done"); the biology reading is
unchanged.** An auxotroph that stops growing after a shift is now a `done` job with a
terminated lineage, and its trajectory up to the death is data.

**Affects 428 jobs.** Of T3's 434 failures outside the two starvation protocols, 428 come from
just **21 of the 101 genotypes**. Six more contribute one seed apiece; the remaining 73
knockouts and the WT contribute none.

| Genotype | Failed / 48 (all 6 protocols) | Failed / 32 (non-starvation) | Category |
|---|---:|---:|---|
| `adk` | 48 | **32** | nucleotide_metabolism |
| `cysE` | 48 | **32** | amino_acid_biosynthesis |
| `hflD` | 48 | **32** | other |
| `alaS` | 41 | 25 | regulation |
| `aroA` | 40 | 24 | amino_acid_biosynthesis |
| `aroC`, `glyA`, `ilvC`, `metA` | 39 | 23 | amino_acid_biosynthesis |
| `pheA` | 38 | 22 | amino_acid_biosynthesis |
| `argE` | 37 | 21 | amino_acid_biosynthesis |
| `argG` | 36 | 20 | amino_acid_biosynthesis |
| `leuA`, `leuB`, `leuC`, `leuD` | 34 | 18 | amino_acid_biosynthesis |
| `lysA` | 29 | 13 | amino_acid_biosynthesis |
| `hisC`, `hisD`, `hisG` | 27 | 11 | amino_acid_biosynthesis |
| `argA` | 24 | 10 | amino_acid_biosynthesis |
| `aaeR`, `appB`, `appC`, `bioP`, `insA2`, `lpp` | 15–16 | 1 each | — |
| 73 other knockouts | 13–16 | **0** | — |
| **WT** | 15 | **0** | — |

Every genotype above still fails 13–16 of its 16 starvation jobs, which is Issue 1 and is
counted there; the "non-starvation" column is the part that belongs to this issue. Knockouts
appear only in the six timeline protocols — the sinusoidal and AA-shift cells are WT-only —
so 48 is the maximum a gene can fail.

By error signature the 434 are: **308 Issue-4a `infs or NaNs`**, 84 `NegativeCountsError`,
28 GLPK failures, 7 ppGpp, and 7 assorted (Issue 6). These cells mostly die through the
tRNA-charging divergence rather than through the allocation crash — the same endpoint as
Issue 1, reached by a different route.

### Reading

Seventeen of the 21 are amino-acid biosynthesis genes, and `adk`, `cysE` and `hflD` fail
**in every one of the six protocols, all 48 jobs** — depleted or not, shifted or not.
The interpretation is straightforward: knock out an auxotroph's only route to an amino acid
and then shift it into a medium that does not supply that amino acid, and it stops growing.
The simulator expresses "stops growing" as an allocation crash rather than as a flat growth
curve, which is exactly the complaint in Issue 1.

So this is most likely **real biology reported through a bad error path**, not an
infrastructure fault. Two consequences:

* The 3,504 completed T3 jobs are the scientifically meaningful part, and the tier's usable
  content is intact for the 74 clean genotypes and all 4 non-starvation protocols.
* `adk`, `cysE` and `hflD` produce nothing at all and should be dropped from future timeline
  tiers — 48 wasted jobs each per T3-shaped tier.

### Remedies

1. **Filter the gene set per protocol.** A knockout should not be paired with a medium its
   product is required for. `T3_ESSENTIAL_TARGET`/`T3_NONESSENTIAL_TARGET`
   (`hf_export/matrix.py:42-43`) select genes with no reference to the protocol's media.
2. ~~**Make "no growth" a result rather than a crash.**~~ **Done 2026-09-22** — see Issue 1.
   Caveat on the count: only `NegativeCountsError` is a lineage termination. Of these 428
   jobs, 84 died that way and 308 through Issue 4a's tRNA-charging divergence; whether a
   given 4a cell now reaches the allocation failure first is what the re-run will show.
3. **Accept and document.** Report the affected genotype × protocol pairs as "no growth".

---

## Issue 6 — Rare single-job faults in T3 (14 jobs)

Small classes, each seen only in T3, listed so that `status`'s grouped failure counts can be
read without re-deriving them.

| Failure | Jobs | Location | Notes |
|---|---:|---|---|
| `ValueError: Failed to meet molecule limits with ppGpp reactions` | 8 | `polypeptide_elongation.py` | `leuA/B/C/D_KO/rich_to_minimal` (3991, 3999, 4007, 4015), `ilvC_KO/glucose_starvation` (5587), `alaS_KO/cut_oxygen` (7564), `alaS_KO/add_amino_acids` (8369, 8375) — all in the Issue-5 gene set |
| `ValueError: Have negative values at equilibrium steady state` | 3 | `reconstruction/ecoli/dataclasses/process/equilibrium.py` | `glyA_KO` (4702, 4703, 6320) |
| `AssertionError` | 2 | `wholecell/utils/modular_fba.py:1392` in `getKi...` | `metA_KO/cut_oxygen` (7258, 7262); bare assert, no message |
| `AttributeError: 'list' object has no attribute 'T'` | 1 | `reconstruction/ecoli/dataclasses/process/equilibrium.py` | `alaS_KO/cut_oxygen` (7566) — a plain type bug on a rarely taken branch |

The last two are genuine code defects rather than numerical drift and were fixed on
2026-09-22:

* The `AssertionError` guarded `relaxUp <= 0 or relaxDown <= 0` in
  `getKineticObjectiveValues`, whose only caller writes the value to the `FBAResults`
  listener. A degenerate basis that relaxes a kinetic target both ways is worth reporting,
  not worth killing the cell: it is now a warning naming the reaction and both values.
* The `'list' object has no attribute 'T'` was not a type bug in the model but SciPy's
  `solve_ivp` returning `status=-1` with `y` still an empty list when the solver gives up
  before the first `t_eval` point (`scipy/integrate/_ivp/ivp.py`, the `elif ts:` branch).
  `equilibrium.py` only caught `ValueError`, so a silent LSODA failure fell through to
  `sol.y.T`. It now checks `sol.success` and tries BDF, as it already did for a raised
  `ValueError`, and raises the existing "Could not solve ODEs" error if both fail.

The ppGpp and negative-equilibrium classes are unchanged.

---

## Issue 7 — Five jobs killed by SLURM before ingestion (no traceback)

`log_tail` is empty for exactly 5 of the 2,052 failures, because the task never reached the
ingest path:

| Job | Tier | `error_message` |
|---|---|---|
| 1483 | T5 | `SLURM reported TIMEOUT` |
| 5317 | T3 | `SLURM reported FAILED` |
| 6117 | T3 | `SLURM reported FAILED` |
| 7217 | T3 | `SLURM reported TIMEOUT` |
| 7248 | T3 | `SLURM reported TIMEOUT` |

Three hit the 3 h `WCECOLI_SLURM_TIME` wall — and only three, out of 9,360 array tasks. The
limit was sized from a 76-minute calibration job and the measured mean is 72–85 min, so the
margin is a healthy 2.1–2.5× and these are genuine outliers rather than a systematic
under-request. **`WCECOLI_SLURM_TIME` is `04:00:00` as of 2026-09-22** (`cluster/campaign_env.sh`);
it costs nothing on `ckpt` (the partition is preemptible; a longer limit does not reserve
more) and removes the class. All five jobs were re-dispatched.

The two `FAILED` cases have no local record at all; their SLURM `.out` file is the only
evidence.

---

## Cross-cutting: `log_tail` on the failure path — FIXED AND VALIDATED

`simulation_jobs.log_tail` was once populated for done jobs and **empty for every failed one**
— precisely backwards — because `slurm_ingest.py` hardcoded `payload["log_tail"] = ""` on the
simulation-failure path. Every cause in the earlier revisions of this file had to be recovered
by grepping SLURM `.out` files.

Fixed in two parts:

* `cluster/task.sbatch:107` tees the simulation to `$WCE_SIM_LOG` (`<run_dir>/sim.log`) with
  stderr folded in, taking the exit code from `${PIPESTATUS[0]}` rather than `$?` — under
  `set -o pipefail` the latter is whichever stage of the pipe failed last, which would have
  reported `tee`'s status.
* `slurm_ingest._consume_sim_log` (`:183`, called at `:256` and `:268`) reads that file's tail
  into the log buffer on **both** the success and failure paths, then deletes it. Deleting
  matters: at ~1 MB per run, keeping it would add ~63 GB across the full matrix. On the
  failure path the tail is taken *after* pruning, so the traceback evicts the pruning chatter
  rather than the reverse.

**Validated in production: 2,047 of 2,052 failed jobs now carry a traceback**, and the 5
exceptions are Issue 7's SLURM-level kills, which never reach ingest by construction. Every
diagnosis in this revision came from `log_tail` rather than from grepping logs.

---

## Cross-cutting: campaign matrix totals

`cluster/RUN_SLURM.md` still describes a "56,136-job matrix". The `submit_campaign --dry-run`
totals, and what has actually run:

| Tier | Cells | Jobs (8 seeds) | Status |
|---|---:|---:|---|
| T1 | 21 | 168 | done 2026-09-04 |
| T2_CORE | 2,865 | 22,920 | not submitted |
| T2_EXTENDED | 3,948 | 31,584 | not submitted |
| T3 | 684 | 5,472 | done 2026-09-19 |
| T4 | 64 | 512 | done 2026-09-05 |
| T5 | 375 | 3,000 | done 2026-09-09 |
| **Total** | **7,957** | **63,656** | **9,152 run (14%)** |

### What T3 implies for T2

Projecting the measured rates onto the two unsubmitted tiers:

* **T2_CORE** (single KOs × 5 static conditions) is the safer one: no depleted media, so
  Issue 1 does not apply, and static media put it near T5's 1.9% — perhaps ~435 failures of
  22,920. At T5's measured 76 min/job that is ~29,000 core-hours; at the 87–135 average
  concurrency these tiers actually achieved on `ckpt`, 9–14 days of wall clock.
* **T2_EXTENDED** sweeps all 21 conditions over ~188 genes. 3,008 jobs land in
  `no_glucose` / `minus_phosphate` and would mostly fail (Issue 1); its amino-acid
  biosynthesis knockouts would fail across most media (Issue 5). Do not submit it before
  those two decisions are made.

---

## Appendix: measured campaign figures

Recorded 2026-09-22. Supersedes the 2026-09-07 figures in earlier revisions.

### Runtime

**Take runtime from `sacct`, not from the database.** `simulation_jobs.started_at` is stamped
at *dispatch* (`slurm_campaign.py:286`), not when the task starts on a node, so a database
`finished_at - started_at` includes queue wait and reconcile lag and overstates compute by
40–120%. Everything below is `sacct` elapsed, joined to tiers through
`state/dispatch_log.jsonl` → `state/manifests/` → array index.

| Tier | Wall span | Tasks | Core-hours | Mean completed | Mean failed | Avg concurrency |
|---|---|---:|---:|---:|---:|---:|
| T1 | 3 waves; productive re-run 2.9 h (2026-09-04 20:03 → 22:58) | 358 | 369 | 85 min | 43 min | — |
| T4 | 5.4 h (2026-09-04 23:34 → 09-05 05:00) | 527 | 727 | 85 min | 38 min | 135 |
| T5 | 44.1 h (2026-09-07 18:37 → 09-09 14:43) | 3,002 | 3,827 | 76 min | 100 min | 87 |
| T3 | 40.7 h (2026-09-17 21:50 → 09-19 14:20) | 5,473 | 5,442 | 72 min | 37 min | 134 |
| **Total** | | **9,360** | **10,365** | | | |

Task counts exceed job counts because preemption and re-dispatch produce several tasks per
job — T1's 358 tasks for 168 jobs is the Issue-3 wave plus the Issue-1 re-runs.

Non-completed tasks consumed 1,467 of the 10,365 core-hours (14%). The split by tier is the
story: 2% in T4 and T5, but 38% in T1 and 22% in T3, because those two are where Issue 1 is.

**Average concurrency never reached 150**, even though `WCECOLI_MAX_IN_FLIGHT=150` and arrays
carry no `%N` cap. 150 is the cap on *submitted* tasks, and on `ckpt` a submitted task can sit
PENDING behind preemption, so the achieved figure was 134–135 on T3/T4 and only 87 on T5.
Divide core-hours by the achieved concurrency, not by 150, when predicting a wall span. Note
this also corrects an earlier reading of T4 as "~300 concurrent" — that was an artefact of the
database timestamps, and T4 in fact behaved like T3.

The mean completed job is **72–85 min against the 76 min calibration**, so `PLAN.md`'s runtime
assumption was sound; it was the *wall-clock* projection that drifted, through concurrency,
not through per-job cost.

### Storage

**1,017 GiB (1,092 GB) under `out/`**, plus 8.9 GB of `logs/` (9,365 files) and 1.4 GB of
`state/`:

| | Size | Dirs | Files |
|---|---:|---:|---:|
| T1 `*_wildtype_job1..168_*` | 19.40 GiB | 168 | 1,621 |
| T3 `*_job3681..9152_*` | 584.55 GiB | 5,472 | 52,554 |
| T4 `*_tf_activity_*` + `*_ppgpp_conc_*` | 59.92 GiB | 512 | 7,332 |
| T5 `*_multi_gene_knockout_*` | 353.32 GiB | 3,000 | 30,917 |
| parca cache | 0.09 GiB | 1 | 6 |

A pruned successful job is ~116 MiB / 10 files; a pruned failed job ~94 MiB / 6 files. Both
run *under* the 129 MB / 26 files that `PLAN.md` projected, so the plan's storage estimate is
conservative — and, per the runtime note above, its per-job time estimate was accurate too.
The projections that need revising are the wall-clock ones, which assumed the full 150-wide
concurrency the scheduler did not always grant.

### Where the output lives

* **Per-job trees:** `$WCECOLI_CAMPAIGN_ROOT/out/<YYYYmmdd_HHMMSS>_<variant_type>_job<N>_attempt<M>/`,
  also reachable as `wcEcoli/out` (symlink).
* **Analysis payload:** `<run_dir>/export/` — `timeseries_seed<S>_gen<0..3>.parquet`,
  `channels.h5`, `pruned.json`.
* **Metrics:** `state/wcecoli.db`, table `simulation_results` — 612 rows for T1, 14,016 for
  T3, 1,996 for T4, 11,776 for T5. That is exactly 4 generations × every done job: no
  completed job is short a generation.
* **SLURM stdout:** `logs/wce-<dispatch_id>-<array_job_id>_<index>.out`. To find a job's log:
  `grep -l "job_id=<N> attempt" $WCECOLI_CAMPAIGN_ROOT/logs/*.out`.
* **Provenance:** `state/campaign_ledger.jsonl` (cell → job_ids, and the only place `tier` is
  recorded), `state/dispatch_log.jsonl` (array job ids), `state/manifests/` (the exact argv of
  every dispatched task — this is how Issue 1's disproof was verified).

### Re-deriving these numbers

`cluster/wce status` gives campaign-wide counts. Tier lives in the ledger, not the database,
so a per-tier breakdown needs a join:

```bash
source cluster/campaign_env.sh >/dev/null && python - <<'EOF'
import json, sqlite3, collections, os
root = os.environ["WCECOLI_CAMPAIGN_ROOT"]
tier = {j: (r["tier"], r["campaign_id"])
        for line in open(f"{root}/state/campaign_ledger.jsonl")
        for r in [json.loads(line)] for j in r["job_ids"]}
db = sqlite3.connect(f"file:{os.environ['DATABASE_PATH']}?mode=ro", uri=True)
by = collections.defaultdict(collections.Counter)
for i, s in db.execute("select id, status from simulation_jobs"):
    by[tier.get(i, ("?", "?"))][s] += 1
cols = ["pending", "queued", "running_sim", "done", "terminated", "failed", "cancelled"]
print(f"{'tier':6s} {'campaign':14s} " + " ".join(f"{c:>11s}" for c in cols) + f" {'total':>7s}")
for k in sorted(by):
    c = by[k]
    print(f"{k[0]:6s} {k[1]:14s} " + " ".join(f"{c.get(x,0):11,d}" for x in cols) + f" {sum(c.values()):7,d}")
EOF
```

(`terminated` counts `done` jobs with `lineage_terminated=1`; replace the status query with
`select id, status, lineage_terminated from simulation_jobs` and bucket accordingly, as the
per-tier table in the re-dispatch section below does.) It opens the database read-only and
takes no `flock`, so it is safe against a live campaign.

---

## Re-dispatch, 2026-09-22

### Pilot — array `40443086`, six jobs, one per fix

Requeued with `cluster/wce requeue --ids 105 273 461 7258 7566 1483 --purge-output` at
14:27 PDT, dispatched by the live tick loop at 14:30 against
`parca_cache_5558948af4ad806f21d7c80c` with `TimeLimit=04:00:00`.

| Job | Was | Now |
|---|---|---|
| 105 (T1 `minus_phosphate`, Issue 1) | `NegativeCountsError`, failed at `attempt=3` | **`done`, `lineage_terminated=1`** at `attempt=4`. Generation 0 grew on minimal and divided (2,530 s, 2,324 fg); generation 1 died at 2,750 s — 350 s after the 2,400 s phosphate shift — with `ATP[c] in PolypeptideElongation (-10793)`. `runSim` exited 0; the sentinel carried both generations; `export/channels.h5` holds `seed0/gen0` (`terminated=False`, `divided=True`) and `seed0/gen1` (`terminated=True`, reason attached, 220 timesteps); `simulation_results` has both rows; `cluster/wce status` lists it under "lineage terminated". 83 MiB on disk. Elapsed 16 min 56 s. |
| 273 (T4 `tf_activity` 14, Issue 2) | `KeyError: 'minimal_plus_cytidine'` ~2 min in | Past the initiation check and still simulating normally (600 s of cell time at 7 min wall, no warnings); running at the time of writing. |
| 7258 (T3 `metA_KO/cut_oxygen`, Issue 6) | bare `AssertionError` in `getKineticObjectiveValues` | The assert is now the warning `Kinetic target for RXN0-4301 relaxed both up (2.44) and down (1.44)`, and the cell went on — then **failed again 17 min in with `GLP_ESING` in `fba.solve`**, i.e. the unfixed GLPK half of Issue 4c, which its log had been warning about (`GLP_EFAIL ... repeating FBA solve`) before the assert ever fired. Expected: a degenerate basis was the underlying state. |
| 461 (T4, Issue 4c homeostatic) | `Homeostatic target ... -4.466e-07` | running at the time of writing |
| 7566 (T3 `alaS_KO/cut_oxygen`, Issue 6) | `'list' object has no attribute 'T'` | running at the time of writing |
| 1483 (T5, Issue 7) | `SLURM reported TIMEOUT` at 3 h | running at the time of writing, under the 4 h limit |

### Full resubmission

Every remaining `failed` job (**2,047**: the 2,046 untouched by the pilot plus 7258's second
failure) was returned to `pending` with `cluster/wce requeue --purge-output` at 14:49 PDT.
The database was backed up first (`state/wcecoli.db.bak-20260922_*`, plus a
`-premigrate` copy from before the column migration); each job's stale
`simulation_results` rows were deleted; the 13 T4 trees from Issue 3 and every other failed
job's pruned tree were removed; the affected experiments went back to `queued`. The live
scrontab loop (`*/10 * * * * cluster/tick.sh`, `WCECOLI_MAX_IN_FLIGHT=150`) dispatches them
from the next tick in arrays of up to 150. At the measured 72–85 min per job and the
134–135 achieved concurrency of T3/T4, the whole set is roughly **19–21 h of wall clock**;
the Issue-1 jobs are cheaper than that, since a starving cell now stops at its death (~17
min for job 105) rather than being re-run to it.

### Observation: the writer `flock` does not hold across nodes

`cluster/wce requeue` on the login node held `state/wcecoli.db.lock` from 14:49:28 to
14:53:47 (the commit, then 2,047 `rmtree`s inside the same `db_lock()`), yet the scrontab
tick — a job on the `compute` partition — dispatched array `40443644` at 14:50:20, in the
middle of that window. So `fcntl.flock` on this GPFS mount does not exclude a holder on
another node, and the "single writer" discipline in `slurm_campaign.py` is only real when
every writer runs on the same node. Nothing was lost here: the requeue's transaction had
already committed, and SQLite's own file locking (`SQLITE_BUSY_TIMEOUT_MS=60000`) still
serializes individual transactions. But run controller commands from the same node the tick
runs on, or pause the loop first, when doing anything that must be atomic with respect to it.

### What to expect, and how to read the result

* **Issue 1 (1,549 jobs) and the `NegativeCountsError` share of Issue 5 (84):** `done` with
  `lineage_terminated=1`. `phosphate_depletion` should go from 0/808 to 808/808 done, of
  which ~all terminated in generation 1.
* **Issue 2 (8):** plain `done`, ~3 h each.
* **Issue 4a (380) and the GLPK half of 4c (63):** unchanged code, so expect the same failure
  unless the cell now reaches an allocation failure first. Job 7258 is the first data point:
  it did not.
* **Issue 4c homeostatic (1), Issue 6 equilibrium (1), Issue 7 (5):** expected `done`.
* The per-tier table at the top of this file is superseded once these land; re-derive it
  with the appendix script, splitting `done` by `lineage_terminated`.
