# PLAN.md — Running wcEcoli Production Campaigns on Hyak/klone (SLURM)

Status: **agreed design, not yet implemented.**
Companion docs: `RUN.md` (Docker / external-server path, unchanged), `cluster/RUN_SLURM.md` (to be written).

---

## 0. Why this plan exists

`RUN.md` assumes a single server running the platform under Docker Compose:
`api` (FastAPI + SQLite) -> `worker` (leases `simulation_jobs` rows) -> `sim-runner`
(a persistent container that forks `runSim.py` behind a Unix-socket JSON protocol).

None of that executes on klone:

| Constraint | Finding |
|---|---|
| Docker | Not installed. `podman` has no `/etc/subuid` mapping; `apptainer` has no fakeroot mapping either, so a def-file build with `apt-get` fails |
| Long-lived services | Login nodes reap sustained processes; all three platform services are daemons |
| Scale | 40-core `compute` / 192-core `cpu-g2` nodes; `ckpt` exposes ~18k preemptible CPUs |
| Submission limits | `MaxArraySize=10001`, `MaxSubmitJobsPU` = 10000 (`normal`) / 2000 (`ckpt`) |
| Memory default | `DefMemPerCPU=1024` — 1 GB, far too low for a wcEcoli generation |
| Preemption | `ckpt` is `PreemptMode=REQUEUE`, `GraceTime=0` — instant kill, automatic re-run from the start |
| Backfill | `SchedulerParameters` includes `bf_max_job_user=100` — backfill considers only 100 of a user's jobs per cycle |
| Scheduling | `scrontab` is enabled (`ScronParameters = enable,explicit_scancel`) |
| Storage | `/gscratch/amath` is at **86% disk (2.1 TB free)** and **98% inodes (~300k free)**, shared group-wide |

Scale from `RUN.md`'s own figures: 56,136 jobs x 4 generations x 6.3 min ~= **23,600 core-hours**.

---

## 1. Decisions

| # | Decision | Choice |
|---|---|---|
| Q1 | Architecture | **(A)** SLURM backend behind the existing platform — keep `api`, SQLite, campaign tracking, exporter |
| Q2 | Runtime | **Native environment**, no container |
| Q3 | Partition | **ckpt-dominant hybrid** — code must be correct under preemption; `normal` QOS reserved for emergencies |
| Q4 | Scope | Everything eventually. **T1 first**, then T3/T4/T5, then T2 |
| Q5 | Root | `/gscratch/amath/alexeyy/wcecoli-campaign/` |
| Q6 | Control plane | Non-blocking dispatch/reap; no thread-per-job |
| Q7 | Unit of work | One simulation job (8 seeds x 4 generations per row) = **one array task**, 1 CPU |
| Q8 | Parca | Built **once** up front, frozen read-only, SLURM dependency gate |
| Q9 | Preemption | Task **wipes its own output dir on entry**; SLURM auto-requeues; rerun from scratch |
| Q10 | Storage | Measure on T1; prune-to-HDF5 hook wired in behind a flag from day one |
| Q11 | Loop invocation | **`scrontab`**; `tmux` loop as the dev fallback |
| Q12 | SQLite | Single-writer via `flock`, journal mode `TRUNCATE` (**not** WAL), tasks never touch the DB |
| Q13 | Resources | `--cpus-per-task=1 --mem=8G --time=02:00:00`, BLAS/OMP threads pinned to 1; retune after T1 |
| Q14 | Throttle | **1 for the smoke test**, then raise; cap 800 on `ckpt-stf` (hard limit 2000) |
| Q15 | Env | **micromamba**, root `~/storage/micromamba`, new env `wcecoli`, Python 3.10 |
| Q16 | Layout | Mirror the existing layout exactly; set `SIM_OUTPUT_DIR` only |
| Q17 | Env identity | Dedicated `wcecoli` env, not the existing `3.10.13` |
| Q18 | Test sequence | Five blocking gates (section 4) |
| Q19 | Quota | Escalate to PI / HYAK support **now**, in parallel |
| Q20 | Deliverable | Keep `RUN.md`; add `cluster/RUN_SLURM.md`; commit to `feature/wcecoli-platform` |
| Q21 | Ingestion | **In the task**, not the control loop — writes result JSON + Parquet; loop only inserts |
| Q22 | Retries | Delete previous attempt on retry; keep the last failure; GC sweep for orphans |
| Q23 | Parca check | Bypassed per task; validated once by the control loop |
| Q24 | Dispatch | **Job arrays + manifest file**, indexed by `$SLURM_ARRAY_TASK_ID` |
| Q25 | Scheduler | `scrontab` |
| Q26 | Staging | Task script + array dispatcher now; **pump deferred until T2** |
| Q27 | Reaping | **Completion sentinels**; scheduler queried only for jobs missing one |

### Rejected alternatives

- **One big allocation** (whole stack inside a single node's SLURM job via `apptainer instance`): near-zero code change, but caps the campaign at one node and kills everything when the allocation ends.
- **Bypassing the platform** (drive `runSim.py` from arrays with a filesystem ledger): `run_export.py:63` selects `SimulationJob.status == "done"` from SQLite and `run_export.py:81` resolves output as `settings.sim_output_dir / job.sim_dir` — the exporter needs **both** the DB and the filesystem, so bypassing it means rewriting the exporter.
- **Per-job `sbatch`**: `bf_max_job_user=100` would leave hundreds of pending jobs invisible to backfill, which is exactly how ckpt throughput is harvested.
- **Self-chaining `sbatch` for the control loop**: one failed link stops the campaign silently. `scrontab` is owned by `slurmctld` and has no such failure mode.
- **Containerising**: blocked by the missing subuid mappings, and buys reproducibility that only matters off-cluster. Building a SIF elsewhere and copying it in remains available later.

---

## 2. Architecture

```
submit_campaign  --writes-->  SQLite (flock, single writer)
                                   |
                     dispatch -----+ reads pending rows
                                   v
                          manifest file (one line per job)
                                   |
                    sbatch --array=0-N%K --> ckpt-stf
                                   |
                          +--------+--------+
                          |  array task     |  wipe dir -> runSim.py ->
                          |  (1 CPU, 8G)    |  _collect_results -> result.json
                          +--------+--------+  + Parquet + sentinel
                                   v
                        reconcile ---- reads sentinels, inserts results,
                                       queries squeue/sacct only for jobs
                                       that vanished without one
```

`dispatch` and `reconcile` are two functions. For T1 they are run by hand; for T2 `scrontab`
calls them on a schedule. The task script is identical either way.

### The core change

`poll_loop` (`interface/backend/app/services/sim_worker.py:1131`) runs a `ThreadPoolExecutor`
holding **one thread per in-flight job for that job's full ~25-minute duration** —
`execute_job` -> `_execute_owned_job` -> `_run_runner_task` blocks on the runner socket until
the task reaches a terminal state. That cannot hold 800 concurrent jobs. The fix is to split
that loop at the `_run_runner_task` seam into a non-blocking dispatch half and a reap half.

### Directory layout

Under `/gscratch/amath/alexeyy/wcecoli-campaign/`:

```
out/        SIM_OUTPUT_DIR — mirrors the platform layout exactly (unchanged code paths)
state/      wcecoli.db, the flock sidecar, manifests, sentinels
logs/       array task stdout/stderr
slurm/      generated sbatch scripts
```

---

## 3. Change list

### New files

| Path | Purpose |
|---|---|
| `interface/backend/app/services/slurm_backend.py` | Mirrors `RunnerClient`'s `submit` / `status` / `cancel` surface, so the socket runner stays usable for local dev |
| `cluster/task.sbatch` | Array task: activate env, `cd` to repo root, wipe run dir, `exec` the argv from its manifest line, ingest results, write sentinel |
| `cluster/setup_env.sh` | micromamba `wcecoli` env + `make compile` |
| `cluster/RUN_SLURM.md` | The klone runbook |

### Modified — `interface/backend/app/services/sim_worker.py`

| Function | Line | Change |
|---|---|---|
| `poll_loop` | 1131 | Split into `dispatch()` / `reconcile()`; `ThreadPoolExecutor` removed |
| `_execute_owned_job` | 601 | Split at the `_run_runner_task` seam |
| `_run_runner_task` | 296 | Replaced by array submission (dispatch) + sentinel read (reconcile) |
| `_collect_results` | 847 | Moved into the task process. It already *returns* `SimulationResult` objects rather than writing them (`_commit_results_and_complete` does the writing), so the seam exists |
| `_repair_stale_statuses` | 964 | Lease timeouts -> reconcile against `squeue` / `sacct` |
| `LeaseHeartbeat` | 81 | Removed — the SLURM job id is the ownership token |
| `_parca_lock`, `_parca_cached`, `_prepare_shared_parca_kb` | 561, 410, 448 | Removed from the per-job path. `_parca_lock` is a `threading.Lock`, meaningless across nodes; `_parca_cache_key` hashes the whole `reconstruction/` tree, which must not run 56k times over GPFS |
| `_build_sim_command` | 727 | Unchanged; its argv goes into the manifest |
| `runner_task_id` column | — | Stores the SLURM `jobid_arraytaskid`. **No schema change** |

### Unchanged

`submit_campaign.py`, `run_export.py`, `converter.py`, `_commit_results_and_complete`,
`_fail_owned_job`, `_requeue_lost_runner_task`, `claim_next_pending_job`, the DB schema,
`RUN.md`, and the existing `cluster/slurm_run.sh` / `slurm_template.sbatch`.
`cluster/build_sif.sh` is left in place but is inoperable here (it converts from a local
Docker daemon).

---

## 4. T1 execution sequence — each gate blocks the next

1. Build the `wcecoli` micromamba env (Python 3.10, matching the Dockerfile's `python:3.10.16`),
   `pip install -r requirements.txt`, `make compile`, then import-smoke the model on a login node.
2. Run Parca **once** under `salloc` (8 CPU, interactive). Verify `PARCA_EXPECTED_FILES`, then
   chmod the kb output read-only.
3. `submit_campaign --tiers T1 --campaign-id t1_klone_v1 --seeds 8 --generations 4`
   — creates DB rows only; nothing runs.
4. Dispatch **one** task (throttle = 1). Verify it completes, writes its sentinel, that
   `reconcile` transitions the row, and that `_collect_results` output lands correctly.
   **Record `MaxRSS`, wall time, bytes written, and file count.**
5. Raise the throttle and drain the remaining 167 jobs.

Then: T3, T4, T5 as throttled arrays. T2 last, and only once the pump and the storage
quota are both in place.

---

## 4a. Measured results (T1 gate 4, job 39439210_0)

Everything below is measured on klone, not estimated.

| Quantity | Measured | Plan assumption |
|---|---|---|
| Wall time, 4 generations | **1 h 16 m** (~14 min/gen) | 25 min (6.3 min/gen) |
| Peak memory (MaxRSS) | **2.03 GB** | 8 GB requested |
| Disk, one job | **2.8 GB** | unknown |
| **Files (inodes), one job** | **1,259** | unknown |
| Parca build | 13 m 24 s | 4.3 min |
| Environment build | 48 min (compute node) | — |

Resource defaults were retuned from this: `--mem` 8G -> **4G**, `--time` 02:00:00 -> **03:00:00**.

### What this means for scale

| | Jobs | Disk | Inodes |
|---|---:|---:|---:|
| T1 | 168 | 470 GB | **211,512** |
| Full matrix | 56,136 | ~157 TB | **~70,700,000** |

`/gscratch/amath` has **~2.1 TB and ~300,000 inodes free**, shared across the whole group.

- **T1 alone consumes ~70% of the group's remaining inode headroom.**
- The full matrix needs ~4.7x the entire 15,000,000-file allocation.
- Runtime is ~3x the `RUN.md` baseline, so the full matrix is ~71,000 core-hours, not ~23,600.

Storage, not CPU, decides whether this campaign is possible. Pruning is no longer optional
for anything beyond T1.

## 5. Open risks

- **Inodes are the binding constraint, not CPU or bytes.** ~300k free across all of `amath`,
  and 98% of current consumption belongs to other group members — frugality alone cannot
  create headroom. Step 4's file count decides whether T2 is physically possible.
  Estimated worst case for the full matrix: 56,136 x 4 x ~150 files ~= **33 million files**.
- **8 GB and 2 h are guesses.** Both get retuned from step 4's `sacct` data.
  Over-requesting memory directly costs ckpt backfill opportunities.
- **`bf_max_job_user=100`** is the first suspect if ckpt throughput disappoints at scale.
- **The `flock` serializes submission against reconciliation.** `submit_campaign` for a new
  tier will block behind an in-progress reconcile rather than racing it.
- **Per-generation output size is unmeasured.** No prior `out/` data exists in this checkout.

---

## 6. Out of scope

Containers (Apptainer/Docker), the `web` frontend, generation-level checkpointing inside
wcEcoli, tier T6 (genome-design variants), and the T2 submission pump — deferred until T2.
