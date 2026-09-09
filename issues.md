# issues.md — Known simulation failures in the klone SLURM campaigns

Status: **open.** Failures observed while running T1 (`t1_klone_v1`) and T4 (`t4_klone_v1`)
on klone. Companion docs: `cluster/RUN_SLURM.md` (runbook), `PLAN.md` (design).

Both tiers are now terminal: 680/680 jobs, **650 done / 30 failed**, nothing in flight. No
other tier has been dispatched. Every failure is accounted for below.

**Fixes applied 2026-09-07** (now committed on `feature/wcecoli-platform`): Issue 1 (timeline
resolution), Issue 3 remedy 4 (prune-on-failure), Issue 4b (`bincount` width), and the
empty-`log_tail` defect noted in the appendix. Issue 2 and Issues 4a/4c are **not** fixed.

**Requeue, 2026-09-07 18:00 UTC.** 38 jobs were returned to `pending`, their output purged
(20.2 GiB reclaimed) and their stale `simulation_results` rows deleted (32 rows):

* all **30 failed** jobs, and
* the **8 `plus_arabinose`** jobs (113–120), which were `done` but whose `--timeline` changes
  under the Issue-1 fix. They were enumerated by running the fixed resolver over every job:
  exactly 24 jobs change command line (81–88, 105–112, 113–120), of which 16 had already
  failed. **No T4 job is affected** — `tf_activity` with `variant_index != 0` satisfies
  `_variant_manages_environment`, so it never receives `--timeline` at all.

The Issue-4b `bincount` fix does not invalidate any completed job: it changes the width of a
logged array, not the simulation state, so trajectories are unaffected.

The 9 parent experiments were set back to `queued` so the reconciler re-derives their real
status. Database backed up first to `state/wcecoli.db.bak-20260907_105700`.

**The scrontab loop then dispatched them automatically** — `*/10 * * * * cluster/tick.sh` at
`throttle=40` — as SLURM array `39723014` at 18:00:18 UTC, about a minute after the requeue.
This was not a manual dispatch. Verified from the dispatch manifest that the fix is live:

```
job  81  attempt=3  --timeline '0 minimal, 1200 minimal_no_glucose'
job 105  attempt=3  --timeline '0 minimal, 2400 minimal_minus_phosphate'
job 113  attempt=3  --timeline '0 minimal, 1200 minimal_plus_arabinose'
job 203  attempt=2  --timeline ''            (tf_activity manages its own environment)
```

Expected outcomes: the 16 Issue-1 jobs should now complete, and 242/246 (Issue 4b) should get
past the table-writer fault. **Jobs 273–280 will fail identically** — Issue 2 is a data gap in
`condition_defs.tsv` and was not fixed. Jobs 203, 341, 370 and 461 (Issues 4a/4c) are
unfixed, and this re-run doubles as the determinism experiment their section asks for.

| Tier | Jobs | done | failed | Issue |
|---|---|---|---|---|
| T1 `t1_klone_v1` (ids 1–168) | 168 | 152 | 16 | Issue 1 |
| T4 `t4_klone_v1` (ids 169–680) | 512 | 498 | 14 | Issue 2 (8), Issue 4 (6) |

Issues 1 and 2 are **deterministic model/data faults, not infrastructure faults**: a re-run
reproduces the failure bit-for-bit, so retrying does not help. Issue 4 is different — those
six are numerical/solver faults that hit a *single seed* of an otherwise healthy variant, and
have not been shown to reproduce. Issue 3 is infrastructure and is resolved. They are recorded
here so the campaign controller's `failed` counts can be read without re-deriving the cause.

**Note on retries.** `failed` is a terminal status. `reconcile` requeues only lost or
preempted array tasks (`COMPLETED`-without-sentinel, `PREEMPTED`, `NODE_FAIL`, `REQUEUED`,
`BOOT_FAIL`, `REVOKED` — `app/services/slurm_campaign.py:505-530`); a job that ran and exited
non-zero is never retried automatically. Re-running one means re-dispatching it explicitly.

---

## Issue 1 — Starvation conditions crash with `NegativeCountsError` (T1)

**Affects:** 16 jobs — `no_glucose` (ids 81–88) and `minus_phosphate` (ids 105–112), all 8 seeds
of each. Every other T1 condition completed 8/8.

### Symptom

```
wholecell/sim/simulation.py:369   _evolveState -> state.merge(processes)
wholecell/states/bulk_molecules.py:196
NegativeCountsError: Negative value(s) in self._countsAllocatedFinal:
ATP[c] in PolypeptideElongation (-3900)
```

Preceded in the log by falling dry mass (238.78 → 238.41 fg), a dry-mass fold change pinned
near 0.99 while the expected fold change climbs past 1.13, and repeating
`Warning: GLP_NOFEAS: no feasible error while solving FBA - repeating FBA solve`.

The two conditions fail at different points:

| Condition | Fails at | Firetask |
|---|---|---|
| `no_glucose` | generation 1–3, after 1–3 divisions | `simulationDaughter.py` |
| `minus_phosphate` | generation 0 | `simulation.py` |

### Cause

The campaign starts these cells in the depleted medium at t=0. The launcher derives the
timeline from the condition's media, producing:

```
runSim.py ... --timeline "0 minimal_no_glucose"
```

But the repo's own timeline definitions shift *into* depletion only after the cell is
established (`reconstruction/ecoli/flat/condition/timelines_def.tsv:4,20`):

```
"000001_cut_glucose"        "0 minimal, 1200 minimal_no_glucose"
"000017_phosphate_absent"   "0 minimal, 2400 minimal_minus_phosphate"
```

`condition_defs.tsv:18-19` maps `no_glucose` / `minus_phosphate` straight to the depleted
media, so the initial state — parameterised for glucose-minimal growth at a 100 min doubling
time — is dropped into a medium that cannot sustain it. The cell cannot make ATP, drains the
pool, and `PolypeptideElongation` allocates more ATP than exists.

`minus_calcium` and `minus_magnesium` survive because those are not limiting on this
timescale; carbon and phosphate are.

### Confirmation that it is deterministic

Attempts 1 and 2 produced **bit-identical** ATP deficits (job 105: `-8744` both times;
job 82: `-4833` both times). Both attempts are now spent on all 16 jobs.

Note: attempt 1 of jobs 81 and 88 failed differently, with
`OSError: [Errno 122] Disk quota exceeded`, on 2026-09-03. That was a separate, since-resolved
storage exhaustion and is unrelated to the cause above. See Issue 3.

### Suggested remedies

1. **Preferred — use the shift timelines.** Point these two conditions at
   `0 minimal, 1200 minimal_no_glucose` and `0 minimal, 2400 minimal_minus_phosphate`.
   This is what the model is built to represent and captures the intended biology
   (a nutrient downshift), rather than an unphysical instantaneous start in starvation.
2. **Drop the two conditions** from the campaign matrix and report T1 as 152/152.
3. **Keep the crash as a result.** It is arguably a genuine model prediction (no growth is
   possible), but produces no usable per-generation data past the failure point, so the
   trajectories are not exportable.

### Scale-up warning

`T2_CORE` and `T2_EXTENDED` both include `no_glucose` and `minus_phosphate` in their condition
sets. At 22,920 and 31,584 jobs respectively they would inherit this failure at scale —
roughly 1/21 of each tier. **Fix the timelines before submitting either T2 tier.**

### Fix status — applied (remedy 1)

`app/services/sim_worker.py:_resolve_condition_timeline` no longer maps every condition to
`"0 <nutrients>"` unconditionally. It now prefers a *static* timeline from `timelines_def`
(the existing behaviour) and falls back to a **shift** timeline only when timelines_def
defines no static entry for that medium and does define a shift into it that starts at plain
`minimal`. Helpers `_timeline_events` and `_shift_timeline_for_media` were added alongside it.

The rule is deliberately narrow so that conditions which already work keep their exact
semantics. Enumerated over all 21 T1 conditions against the live database, it changes three:

| Condition | Before | After |
|---|---|---|
| `no_glucose` | `0 minimal_no_glucose` | `0 minimal, 1200 minimal_no_glucose` |
| `minus_phosphate` | `0 minimal_minus_phosphate` | `0 minimal, 2400 minimal_minus_phosphate` |
| `plus_arabinose` | `0 minimal_plus_arabinose` | `0 minimal, 1200 minimal_plus_arabinose` |

The first two are the fix. **`plus_arabinose` is collateral and needs a decision** — it
currently completes 8/8, so this changes a working condition. It qualifies under the rule for
the same reason the other two do: timelines_def has no static entry for
`minimal_plus_arabinose`, only `000019_add_arabinose`. Arguably the shift is the more faithful
reading of what the repo intends by that experiment, but it is a semantic change to completed
results and is not comparable with the existing T1 run. Either accept it, or add a static
`"0 minimal_plus_arabinose"` row to `timelines_def.tsv` to pin the old behaviour explicitly.

The GLC conditions are untouched because the ramps start at `minimal_GLC_20mM` /
`minimal_GLC_2mM` rather than `minimal`, which is exactly what the "starts at minimal"
condition in the rule is there to exclude.

**Not yet validated by a run.** The resolver was exercised directly against the campaign
database, but no simulation has been dispatched with the new timelines, so it is not yet
established that `no_glucose` and `minus_phosphate` actually complete 8/8 under the shift.

---

## Issue 2 — `tf_activity` variant 14 crashes with `KeyError` on an uncovered medium (T4)

**Affects:** 8 jobs — ids 273–280, `tf_activity` variant_index 14, all 8 seeds. This is the
transcription factor `cytR` / `CPLX0-7740` in its **inactive** state.

### Symptom

```
models/ecoli/processes/chromosome_replication.py:92
    self.criticalInitiationMass = self.get_dna_critical_mass(
        self.nutrientToDoublingTime[current_media_id])
KeyError: 'minimal_plus_cytidine'
```

The job dies in roughly 2 minutes rather than the usual ~1.4 h, because it fails at the first
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
`condition_defs`. The medium is therefore loadable but has no doubling time, and
`chromosome_replication.py:92` indexes the mapping unguarded.

In short: `tf_condition.tsv` references a medium that `condition_defs.tsv` does not cover.

### Scope — contained

All 47 `tf_activity` variants were enumerated against the parca cache's 21 doubling-time
entries. **Exactly one is broken: index 14.** All 8 of its jobs have already failed; the
remaining 44 variants in the campaign are unaffected *by this fault* — five of them
(5, 10, 22, 26, 37) nevertheless lost single seeds to the unrelated numerical faults in
Issue 4.

Reproduce the check with:

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

### Suggested remedies

1. **Preferred — close the data gap.** Add a row to
   `reconstruction/ecoli/flat/condition/condition_defs.tsv` covering `minimal_plus_cytidine`
   with a doubling time (the other perturbation conditions use `100.0` min), then rebuild the
   parca cache. Note this invalidates the pinned `WCECOLI_PARCA_RUN_ID`, so it is disruptive
   mid-campaign.
2. **Defer.** Let variant 14 fail, complete the other 44 `tf_activity` variants now, then fix
   the data and backfill index 14 as a separate small campaign. Recommended while T4 is in
   flight — it is 8 jobs out of 512.
3. **Harden the process regardless.** `chromosome_replication.py:92` should fail with a
   message naming the medium and pointing at `condition_defs.tsv`, rather than a bare
   `KeyError` raised thousands of timesteps into a run. A validation pass over
   `tf_condition.tsv` × `condition_defs.tsv` at parca time would catch the whole class of
   fault before any job is dispatched.

### Fix status — not applied

None of the three remedies has been actioned. Remedy 1 invalidates the pinned
`WCECOLI_PARCA_RUN_ID` and so is a campaign-level decision, not a code fix; remedy 3
(a clearer error, plus a `tf_condition.tsv` × `condition_defs.tsv` validation pass at parca
time) is worth doing regardless and is still open.

### Retry cost

~2 minutes × 8 jobs — negligible, and it will not grow: these jobs are still at `attempt=1`
and will stay there. An earlier draft of this file claimed `reconcile` would retry them once;
that is wrong. `failed` is terminal (see **Note on retries** at the top), so nothing re-runs
them until the `condition_defs.tsv` gap is closed and they are re-dispatched by hand.

T1's 16 Issue-1 jobs show `attempt=2` for an unrelated reason: the whole tier was re-dispatched
after the Issue-3 quota exhaustion, which advanced every T1 job's attempt counter.

---

## Issue 3 — Storage exhaustion during T1 (resolved, but the sizing lesson stands)

**Affects:** attempt 1 of several T1 jobs on 2026-09-03, e.g.

```
OSError: [Errno 122] Disk quota exceeded:
  .../out/20260903_202815_wildtype_job88_attempt1/.../Daughter1_inherited_state.cPickle
```

### Cause

Pruning runs **once at the end of a whole job** (`app/services/slurm_ingest.py:236`), only
after `_collect_results` succeeds — not per generation. So every running job holds its full
raw `simOut` tree for its entire ~1.4 h lifetime and collapses to the pruned form only at the
very end.

Peak filesystem load is therefore **concurrency × raw size**, not the final pruned footprint:

| | per job |
|---|---|
| Raw, held for the whole run | ~2.8 GB, ~1,259 files |
| Pruned, after ingestion | ~122 MB, ~10 files (measured over 152 completed T1 jobs) |

Sizing a dispatch against the pruned figure understates the peak by more than 20×.

### Suggested remedies

1. **Size concurrency against free disk, not against SLURM limits.** *(Superseded in part:
   the per-array `%N` throttle is no longer the knob. It now defaults to `0` — no cap — and
   `WCECOLI_MAX_IN_FLIGHT` alone governs concurrency, because a per-array cap and a submit
   cap are in different units and multiply. Read `throttle` below as "concurrent tasks", and
   set it via `WCECOLI_MAX_IN_FLIGHT`.)*
2. **Budget roughly a quarter of free space.** `/gscratch/amath` is group-shared and already
   87% full. For T4, `throttle=150` gives a peak of ~482 GB (25% of the 1,928 GB free) and
   ~194k files (6.8% of free inodes), across 4 waves.
3. **Note that the binding constraint has flipped.** `cluster/RUN_SLURM.md` states that inodes
   bind. Pruning fixed the inode problem, but the 2.8 GB transient raw tree means **disk now
   binds first**. That section of the runbook is stale.
4. **Reclaim output from terminally-failed jobs.** Pruning only runs on success, so failed
   jobs leave their full raw tree behind. The 16 Issue-1 jobs held 10.9 GB / 9,470 files until
   removed on 2026-09-04. **This cleanup was never applied to T4:** its 14 failed jobs still
   hold **19.7 GiB / ~7.7k files**, which is a quarter of the tier's 78.5 GiB footprint. The
   six Issue-4 jobs are the bulk of it (1.2–4.6 GiB each, since they died deep into
   generation 1–3); the eight Issue-2 jobs are only ~73 MiB each because they die in 2 minutes.
   Worth automating: prune-on-failure, or a sweep in `reconcile`.

### Fix status — remedy 4 applied

`app/services/slurm_ingest.py:ingest` now runs `convert_and_prune` on the failure path too,
under the same `WCECOLI_PRUNE_SIMOUT` gate, wrapped so that any error leaves the tree
untouched and never masks the simulation's own failure. The generations that *did* complete
are converted to HDF5 before the raw tree is deleted, so this reclaims space without
discarding results.

Verified against a copy of the stranded job-341 tree (the original was not touched): 409 MB /
574 files → 83 MB / 6 files, with both generations preserved in `channels.h5` — `gen0`
(`divided=True`, 2649 fg) and the generation that actually crashed, `gen1` (`divided=False`,
1825 fg). The partial simOut of a crashed generation converts cleanly rather than producing
garbage, which was the main risk in pruning a failed run.

The 19.7 GiB already stranded in T4 is **not** reclaimed by this — the change only affects
jobs ingested from now on. Clearing the existing trees is still a manual sweep.

---

## Issue 4 — Six single-seed numerical failures in `tf_activity` (T4)

**Affects:** 6 jobs across 5 variants — one or two seeds each, out of 8. Every other seed of
the same variant completed 4 generations, so no variant is lost; the affected variants are
7/8 or 6/8 rather than 8/8.

| Job | Variant | TF / state | Variant media | Seed | Died in | Failure |
|---|---|---|---|---|---|---|
| 203 | 5 | `CPLX0-226` active | `minimal_acetate` | 2 | gen 2 | `ValueError: array must not contain infs or NaNs` |
| 242 | 10 | `CPLX0-7669` inactive | `minimal_plus_amino_acids` | 1 | gen 3 | `VariableEntrySizeError` |
| 246 | 10 | `CPLX0-7669` inactive | `minimal_plus_amino_acids` | 5 | gen 1 | `VariableEntrySizeError` |
| 341 | 22 | `FNR-4FE-4S-CPLX` inactive | `minimal` | 4 | gen 0 | `RuntimeError: GLP_ESING: Basis matrix is singular` |
| 370 | 26 | `MONOMER0-160` inactive | `minimal` | 1 | gen 1 | `RuntimeError: GLP_ESING: Basis matrix is singular` |
| 461 | 37 | `PHOSPHO-ARCA` active | `minimal_minus_oxygen` | 4 | gen 2 | `ValueError: Homeostatic target must be non-negative … BIOTIN[c]` |

These are **not** the Issue-2 fault. They run the normal ~1–2 h before dying, not 2 minutes,
and they are seed-specific. Note the media column is the *variant's* media, not the `condition`
recorded in the database — `tf_activity` overrides the timeline, as Issue 2 explains. Job 461
is filed under `condition='plus_nitrate'` but actually ran anaerobically.

Three distinct sub-modes:

### 4a — tRNA charging ODE diverges (job 203)

```
models/ecoli/processes/polypeptide_elongation.py:1081  solve_ivp(dcdt, ..., method='BDF')
scipy/integrate/_ivp/bdf.py:364                        LU = self.lu(self.I - c * J)
ValueError: array must not contain infs or NaNs
```

Preceded by a run of divide-by-zero warnings in the charging model —
`polypeptide_elongation.py:856`, `:1076`, `:1098` — and `invalid value encountered in
subtract` from the BDF integrator itself. The charging state goes non-finite, and the next
Jacobian factorisation rejects it. Growth had stalled first: dry-mass fold change was pinned
around 1.01 while the expected fold change stayed near 1.004, on `minimal_acetate`.

### 4b — `aaCountInSequence` written at the wrong width (jobs 242, 246)

```
models/ecoli/listeners/ribosome_data.py:157  tableWriter.append(aaCountInSequence=...)
wholecell/io/tablewriter.py:340
VariableEntrySizeError: Entry size in bytes, elements (128, 16) is inconsistent with (168, 21)
  for ... RibosomeData/aaCountInSequence which is not set up for variable lengths.
```

**This one is a plain bug, not a numerical accident.** `polypeptide_elongation.py:201` builds
the array with

```python
aaCountInSequence = np.bincount(sequences[(sequences != polymerize.PAD_VALUE)])
```

with no `minlength`. `np.bincount` returns an array only as long as the highest index
*present*, so when translation activity falls far enough that the top amino-acid indices do not
appear in any ribosome sequence that timestep, the array comes back with 16 (job 242) or 12
(job 246) entries instead of 21. The listener allocates a fixed 21 (`ribosome_data.py:43`) and
`aaCountInSequence` is **not** among the columns passed to
`set_variable_length_columns` (`ribosome_data.py:148-152`), so the table writer refuses the
short row and the run dies.

**Fixed 2026-09-07.** `polypeptide_elongation.py:201` now passes
`minlength=len(self.aaNames)`, which is the same 21 the listener allocates.

`aaCounts` was audited alongside it and needs no change: it is written from
`aa_counts_for_translation`, which derives from `self.aas.counts()` and is therefore always
full width. `aaCountInSequence` was the only `bincount`-derived column of the pair.

This was a latent fault in the model, not in the campaign; it would have recurred in any tier
with enough jobs, and both T2 tiers are ~20-60x larger than T4.

**Not yet validated by a run.** The change is a one-line width guarantee and the failing
condition is understood, but no simulation has been re-run to confirm jobs 242/246 now
complete.

### 4c — FBA solve degenerates (jobs 341, 370, 461)

```
models/ecoli/processes/metabolism.py:195   fba.solve(n_retries)
wholecell/utils/modular_fba.py:1539        self.solve(iterations - 1)   (x3, exhausted)
wholecell/utils/_netflow/nf_glpk.py:482
RuntimeError: GLP_ESING: Basis matrix is singular
```

and, for job 461, one step earlier in the same process:

```
models/ecoli/processes/metabolism.py:496   self.fba.update_homeostatic_targets(objective)
wholecell/utils/modular_fba.py:1204
ValueError: Homeostatic target must be non-negative. It is -4.4661743080447463e-07 for BIOTIN[c].
```

The BIOTIN target is negative by 4e-07 — a rounding artefact, not a biologically negative
demand. `modular_fba.py:1204` rejects it with a strict `< 0` test rather than clamping small
negatives to zero. `GLP_ESING` in 341/370 is the same family: the LP has drifted into a
degenerate basis and the retry ladder in `modular_fba.py:1539` runs out.

### Determinism — unknown, and worth establishing

Unlike Issues 1 and 2, these have **not** been shown to reproduce. All six are `attempt=1`;
the tier was never re-dispatched, so no second attempt exists to compare against. The model is
seeded, so a re-run on the same seed *should* be bit-identical — but that is an assumption, not
a measurement here.

Cost to check: 6 jobs × ~1.5 h. That is cheap and it is the right next step, because the two
readings lead to opposite conclusions:

* **Deterministic** → these are five specific (variant, seed) cells that will fail every time,
  and 4b in particular will scale linearly into T2.
* **Non-deterministic** (e.g. sensitive to BLAS thread count or node CPU model — note the
  campaign deliberately links a separate LP64 OpenBLAS for aesara, `cluster/campaign_env.sh`)
  → a plain re-dispatch recovers all six, and the fault is in the tolerance of the numerics.

### Suggested remedies

1. ~~**Fix 4b now.**~~ **Done** — see the Fix status note under 4b.
2. **Clamp the homeostatic target.** Treat `-4e-07` as zero at `modular_fba.py:1204`, keeping
   the hard error for targets that are negative beyond a tolerance. **Not done** — this is a
   change to the model's numerical tolerance, not a plain defect, and picking the tolerance is
   a modelling decision.
3. **Re-dispatch the six and see.** Establishes determinism for the cost of ~9 CPU-hours, and
   settles how much of a 22,920-job T2 tier this class is likely to cost.
4. **Accept the loss.** At 6/512 (1.2%) with every affected variant still at 6/8 or 7/8 seeds,
   T4's scientific content is intact. This is defensible for T4 alone, but 1.2% of T2_CORE is
   ~275 jobs and of T2_EXTENDED ~380.

---

## Cross-cutting: `log_tail` was empty for exactly the jobs that needed it (fixed)

`simulation_jobs.log_tail` was populated for all 650 done jobs (~415 characters each) and
**empty for all 30 failed ones** — precisely backwards. `slurm_ingest.py` hardcoded
`payload["log_tail"] = ""` on the simulation-failure path and returned before the buffer was
ever filled, so the only record of any traceback was the SLURM `.out` file, findable only by
grep. Every cause in this document had to be recovered that way.

**Fixed 2026-09-07**, in two parts:

* `cluster/task.sbatch` tees the simulation to `$WCE_SIM_LOG` (`<run_dir>/sim.log`) with
  stderr folded in, taking the exit code from `${PIPESTATUS[0]}` rather than `$?` — under
  `set -o pipefail` the latter is whichever stage of the pipe failed last, which would have
  reported `tee`'s status.
* `slurm_ingest._consume_sim_log` reads that file's tail into the log buffer on **both** the
  success and failure paths, then deletes it. Deleting matters: at ~1 MB per run, keeping it
  would add ~63 GB across the full matrix. The `.out` file remains the archive; `sim.log` is
  only the handoff. On the failure path the tail is taken *after* pruning, so that on a full
  200-line buffer the traceback evicts the pruning chatter rather than the reverse.

Folding stderr into stdout also fixes a diagnosis hazard: Python leaves stderr unbuffered
while block-buffering stdout, so in the existing `.out` files tracebacks appear thousands of
lines *above* the output they actually followed. Job 203's traceback sits at line 22 of a
24,000-line log despite the run continuing for ~1.9 h afterwards.

Verified directly: a 5,000-line log correctly truncates to the last 200 lines with the
traceback retained, the file is removed, `ingest()` returns a populated `log_tail` on the
failure path, and a missing `$WCE_SIM_LOG` (an older task script) is a no-op rather than an
error.

**Not yet validated by a real dispatch.** `task.sbatch` passes `bash -n` and the ingest side
was exercised directly, but no array task has run end to end with the tee in place.

---

## Cross-cutting note: the runbook's job counts are stale

`cluster/RUN_SLURM.md` describes a "56,136-job matrix". The current
`submit_campaign --dry-run` totals are:

| Tier | Cells | Jobs (8 seeds) |
|---|---|---|
| T1 | 21 | 168 |
| T2_CORE | 2,865 | 22,920 |
| T2_EXTENDED | 3,948 | 31,584 |
| T3 | 684 | 5,472 |
| T4 | 64 | 512 |
| T5 | 375 | 3,000 |
| **Total** | **7,957** | **63,656** |

---

## Appendix: measured campaign figures

Recorded 2026-09-07 from `state/wcecoli.db`, `state/campaign_ledger.jsonl` and `du` over
`$WCECOLI_CAMPAIGN_ROOT/out`. Issue 3's sizing argument rests on these.

**These describe the campaign as it stood before the requeue** described at the top of this
file — 650 done / 30 failed, 97 GB. After the requeue and purge it is 642 done / 38 running,
77 GB across 643 run directories. The runtime and per-job storage figures below are unchanged
by that; the tier totals and dir counts are not.

### Runtime

| Tier | Wall span | CPU-hours | Mean per job |
|---|---|---|---|
| T1 | 71.1 h nominal (2026-09-01 23:51 → 09-04 22:58), but that is three waves: a 1-job calibration on 09-01, a 09-03 wave lost to Issue 3, and the productive re-run on 09-04 20:03 → 22:58 = **2.9 h** at `throttle=166` | 488 | 174 min |
| T4 | **5.4 h** (2026-09-04 23:34 → 09-05 05:00) at `throttle=150` | 1,612 | 193 min (done) |

The 30 failed jobs consumed 61 CPU-hours of the 2,100 total.

### Storage

97 GB under `$WCECOLI_CAMPAIGN_ROOT`, of which:

| | Size | Dirs | Files |
|---|---|---|---|
| T1 `*_wildtype_job*` | 18.1 GiB | 152 | 1,521 |
| T4 `*_tf_activity_job*` | 60.4 GiB | 352 | 11,130 |
| T4 `*_ppgpp_conc_job*` | 18.1 GiB | 160 | 1,600 |
| parca cache | 89 MiB | 1 | — |
| `logs/` | 808 MB | — | 852 |
| `state/` | 87 MB | — | — |

T1 shows 152 dirs, not 168, because the Issue-1 failures were reclaimed. T4 shows all 512:
19.7 GiB of the tf_activity figure is the 14 unpruned failed trees (see Issue 3, remedy 4).
A pruned, successful job is ~122 MiB / 10 files, matching the Issue-3 measurement.

### Where the output lives

* **Per-job trees:** `$WCECOLI_CAMPAIGN_ROOT/out/<YYYYmmdd_HHMMSS>_<variant_type>_job<N>_attempt<M>/`,
  also reachable as `wcEcoli/out` (symlink). T1 is `*_wildtype_job1..168_*`; T4 is
  `*_tf_activity_job169..520_*` and `*_ppgpp_conc_job521..680_*`.
* **Analysis payload:** `<run_dir>/export/` — `timeseries_seed<S>_gen<0..3>.parquet`,
  `channels.h5`, `pruned.json`.
* **Metrics:** `state/wcecoli.db`, table `simulation_results` — 608 rows for T1, 1,992 for T4
  (4 generations × every done job; no done job is short a generation).
* **SLURM stdout:** `logs/wce-<dispatch_id>-<array_job_id>_<index>.out`. To find a job's log:
  `grep -l "job_id=<N> attempt" $WCECOLI_CAMPAIGN_ROOT/logs/*.out`.
* **Provenance:** `state/campaign_ledger.jsonl` (cell → job_ids), `state/dispatch_log.jsonl`
  (array job ids, throttles), `state/manifests/`.
