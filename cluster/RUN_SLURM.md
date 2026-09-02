# Run wcEcoli Campaigns on a SLURM Cluster (UW Hyak / klone)

`RUN.md` describes the Docker Compose path for a dedicated server. This document is the
equivalent for a SLURM cluster, where Docker is unavailable and long-lived services are not
allowed on login nodes. See `PLAN.md` for the design and the reasoning behind each choice.

## How this differs from the Docker path

| | Docker (`RUN.md`) | SLURM (this document) |
|---|---|---|
| Simulation execution | `sim-runner` container, one thread per job | One array task per job |
| Scheduling | `worker` daemon polling SQLite | `dispatch` / `reconcile`, run by hand or from `scrontab` |
| Result ingestion | On the worker | **In the array task** — parallelized across the cluster |
| Parca | Built lazily, cached, lock per process | Built **once** up front and frozen read-only |
| Runtime | Two Docker images | Two micromamba envs (same split, same reason) |
| Concurrency cap | `SIM_RUNNER_CONCURRENCY` | `--array=...%N` plus `WCECOLI_MAX_IN_FLIGHT` |

Unchanged: `submit_campaign`, `run_export`, the database schema, and the on-disk output
layout. `SIM_OUTPUT_DIR` is simply repointed.

## 1. One-time setup

### Environments

Two are required. They cannot be merged: `interface/backend/pyproject.toml` pins
`numpy==2.4.6` with `requires-python>=3.11`, while `requirements.txt` pins `numpy==1.26.3`.
That is the same split as the two Docker images.

```bash
cluster/setup_env.sh          # builds wcecoli-sim (3.10) and wcecoli-api (3.11)
```

`setup_env.sh` also installs `pyarrow` into the API env. This is deliberate and not in
`pyproject.toml`: without it, `SimOutReader.export_parquet()` silently falls back to
`_export_csv()`, which writes **CSV bytes into a file named `*.parquet`**
(`table_reader_bridge.py:628`).

### Campaign root

```bash
source cluster/campaign_env.sh
```

Creates `$WCECOLI_CAMPAIGN_ROOT/{out,state,logs}` and links `<repo>/out` at it.
That symlink is mandatory: `wholecell/utils/filepath.py` hardcodes `OUT_DIR = <repo>/out`
with no environment override, so it is the SLURM equivalent of the `sim-output` volume
Docker mounts at `/wcEcoli/out`.

Source this before every command below. It also sets `SQLITE_JOURNAL_MODE=TRUNCATE` —
SQLite's WAL mode relies on mmap semantics GPFS does not provide.

### Parca

Built once. Every job reads this one `kb/` through a symlink; letting each job
check-and-maybe-build it would put thousands of tasks in a race over the same directory.

```bash
sbatch --account=<acct> --partition=<part> cluster/parca.sbatch
# when it finishes, pin the name so nothing re-hashes reconstruction/ and models/:
export WCECOLI_PARCA_RUN_ID=$(python -m app.services.slurm_campaign parca-id)
python -m app.services.slurm_campaign verify-parca
```

The cache is `chmod -R a-w` on completion so a buggy task cannot corrupt the shared input.

## 2. Submit a campaign

Creates database rows only; nothing runs yet.

```bash
source cluster/campaign_env.sh
micromamba run -n wcecoli-api python -m hf_export.submit_campaign \
    --tiers T1 --campaign-id t1_klone_v1 --seeds 8 --generations 4
```

Reuse the same `--campaign-id` when resuming. `submit_campaign`, `dispatch` and `reconcile`
all write the same SQLite file and serialize through one `flock`, so a submission started
while a reconcile is running will wait rather than race.

## 3. Run one job first

Do not skip this. It sets the real `--mem` and `--time`, and its file count determines
whether the larger tiers are feasible at all.

```bash
export WCECOLI_SLURM_THROTTLE=1
python -m app.services.slurm_campaign dispatch --limit 1
squeue -u "$USER"
# once it finishes:
python -m app.services.slurm_campaign reconcile
python -m app.services.slurm_campaign status
```

Then measure:

```bash
sacct -j <arrayjobid> --format=JobID,State,Elapsed,MaxRSS,ReqMem
RUN=$(ls -t "$WCECOLI_CAMPAIGN_ROOT/out" | head -1)
du -sh  "$WCECOLI_CAMPAIGN_ROOT/out/$RUN"
find    "$WCECOLI_CAMPAIGN_ROOT/out/$RUN" | wc -l     # <-- the number that matters
```

**Inodes, not bytes, are the binding constraint.** `hyakstorage` showed `/gscratch/amath`
at 98% of its 15,000,000-file allocation, with ~300,000 free and shared across the whole
group. Multiply the file count above by the tier's job count before submitting it.

Measured on the first T1 job (39439210_0):

| Quantity | Measured |
|---|---|
| Wall time (4 generations) | 1 h 16 m (~14 min/generation) |
| Peak memory | 2.03 GB |
| Disk | 2.8 GB per job |
| Files | 1,259 per job |

So T1 (168 jobs) needs ~470 GB and **~211,500 inodes** -- about 70% of the group's
remaining headroom. The full 56,136-job matrix would need ~157 TB and ~70.7M files,
roughly 4.7x the entire allocation. Do not start a large tier without either a quota
increase or pruning enabled.

### Pruning

`WCECOLI_PRUNE_SIMOUT=1` makes each task convert its generations to a compressed
`export/channels.h5` and then delete the raw `simOut` trees, cutting a job from ~1,259
files to a handful. `WCECOLI_PRUNE_KEEP_TENSORS=1` additionally stores the per-gene and
per-reaction matrices (`RnaSynthProb`, `RibosomeData` and friends) that dominate the volume.

Pruning is **off by default**. It is irreversible, and `run_export` currently reads raw
`simOut` -- so with pruning on, export must be taught to prefer the per-job HDF5 first.
That change is the outstanding follow-up before any large tier runs.

## 4. Scale up

```bash
export WCECOLI_SLURM_THROTTLE=200
python -m app.services.slurm_campaign dispatch --limit 200
```

`--limit` sizes one array; `WCECOLI_MAX_IN_FLIGHT` (default 800) caps the total active
across arrays. Keep it well under klone's `MaxSubmitJobsPU` of 2000 on `ckpt` so `sbatch`
never hits `DenyOnLimit`. `MaxArraySize` is 10001, so no single array may exceed that.

Tiers below ~2000 jobs (T1 168, T4 512, T5 3000 in two chunks) need nothing more than a few
`dispatch` calls and a `reconcile` when convenient. Only T2's ~47k jobs need a scheduled loop.

## 5. Unattended operation

`dispatch` and `reconcile` are idempotent, so the loop is just `tick`:

```bash
scrontab -e
```

```
#SCRON --account=stf --partition=compute --time=00:15:00 --mem=4G
*/10 * * * * /gscratch/amath/USER/Git/wcEcoli/cluster/tick.sh
```

`scrontab` is owned by `slurmctld`, so unlike a self-chaining `sbatch` chain it cannot die
silently and strand the campaign. For interactive development, a `tmux` loop works too:

```bash
while true; do python -m app.services.slurm_campaign tick --limit 200; sleep 60; done
```

## 6. Preemption

`ckpt` is `PreemptMode=REQUEUE` with `GraceTime=0`: a preempted task is killed instantly,
with no cleanup window, and re-run from the start by SLURM. `cluster/task.sbatch` therefore
wipes its own output directory on entry, so every re-run is clean and preemption, node
failure and manual resubmission are all the same code path. A job is ~25 minutes, so a
preemption costs at most that much redone work.

`reconcile` treats a task that exited zero but wrote **no** sentinel as a retry, not a
success: that means the task died between the simulation and ingestion.

## 7. Export

```bash
micromamba run -n wcecoli-api python -m hf_export.run_export --out "$WCECOLI_CAMPAIGN_ROOT/export"
```

`run_export` reads both the database (`status == "done"`) and the filesystem, which is why
the platform's SQLite database remains the source of truth on this path.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Parca cache ... is incomplete` | `cluster/parca.sbatch` has not run, or `WCECOLI_PARCA_RUN_ID` is stale |
| `<repo>/out is a real directory` | Move it aside; it must be a symlink to the campaign root |
| Jobs stuck in `running_sim` | Run `reconcile`; check `logs/` for the array task's output |
| `unknown to SLURM` in reconcile | Task vanished with no sentinel and no `sacct` record — inspect `logs/` |
| `sbatch` `DenyOnLimit` | `WCECOLI_MAX_IN_FLIGHT` too close to `MaxSubmitJobsPU` (2000 on ckpt) |
| `database is locked` | Another writer holds the flock; it will clear (600s timeout) |
