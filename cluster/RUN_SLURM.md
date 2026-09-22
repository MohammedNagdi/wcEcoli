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
| Concurrency cap | `SIM_RUNNER_CONCURRENCY` | `WCECOLI_MAX_IN_FLIGHT` |

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
export WCECOLI_PARCA_RUN_ID=$(cluster/wce parca-id)
cluster/wce verify-parca
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
cluster/wce dispatch --limit 1
squeue -u "$USER"
# once it finishes:
cluster/wce reconcile
cluster/wce status
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

Both are **on by default**. Measured on job 39439210_0: 2.8 GB / 1,259 files becomes
129 MB / 26 files, for ~22 s of CPU, with the per-gene and per-reaction tensors retained.

`run_export` reads either form transparently via `hf_export/pruned_reader.py`, so nothing
downstream changes. A run pruned with `WCECOLI_PRUNE_KEEP_TENSORS=0` cannot satisfy
`--full-tensors`; that is reported as `tensors_pruned` in `export_qc.jsonl` rather than
silently producing a thinner dataset.

Pruning is irreversible: it runs only after results were extracted successfully, and never
deletes anything unless the HDF5 conversion demonstrably succeeded.

## 4. Scale up

```bash
export WCECOLI_MAX_IN_FLIGHT=150
cluster/wce dispatch --limit 150
```

**`WCECOLI_MAX_IN_FLIGHT` is the only concurrency knob.** It caps the tasks the controller
keeps submitted, and because arrays carry no `%N` cap by default, every submitted task is
runnable — so it is also how many run. Keep it well under klone's `MaxSubmitJobsPU` of 2000
on `ckpt` so `sbatch` never hits `DenyOnLimit`. `MaxArraySize` is 10001, so no single array
may exceed that.

`--limit` sizes one array and should equal `WCECOLI_MAX_IN_FLIGHT`: each dispatch claims
`min(limit, max_in_flight - in_flight)`, so a smaller limit only stretches the ramp over
`ceil(max_in_flight / limit)` ticks. `cluster/tick.sh` defaults `--limit` to
`WCECOLI_MAX_IN_FLIGHT` for exactly this reason; `WCECOLI_TICK_LIMIT` overrides it if you
want a gentler ramp.

`WCECOLI_SLURM_THROTTLE` adds a `%N` cap *inside* each array and defaults to `0` (none).
Do not reach for it as a second concurrency limit — the two caps are in different units and
multiply. `%40` on arrays of 200 under `MAX_IN_FLIGHT=800` holds 800 tasks but runs only
four arrays x 40 = **160**, and the number drifts upward as arrays drain and fragment.

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
while true; do python -m app.services.slurm_campaign tick --limit 800; sleep 60; done
```

## 5a. Checking on a running campaign

One command answers most of it -- progress, per-status counts, grouped failures, and when
the loop last ran:

```bash
cluster/wce status              # add --json for scripting
```

`cluster/wce` needs nothing sourced first. If you have sourced `campaign_env.sh`, the API
environment is on `PATH` and the longer form works too:

```bash
source cluster/campaign_env.sh
python -m app.services.slurm_campaign status
```

```
campaign: 10/168 jobs complete (6.0%)
  done=2, failed=8, running_sim=158
last tick: 2026-09-03T20:38:41+00:00
failures:
  8 job(s): Simulation failed with exit code 1
     ids: 105, 106, 107, 108, 109, 110 (+2 more)
```

`last tick` is the loop's heartbeat: if it stops advancing, the scrontab entry is not
firing. Check the loop itself with:

```bash
scrontab -l                                  # is the entry there?
sacct -n --name=wce-tick --starttime=today --format=JobID,State,Start,Elapsed
```

For the simulations and for one failure's real cause:

```bash
squeue -u "$USER" -o "%.12i %.9T %.10M %R"   # what SLURM is running now
sacct -X -n --starttime=today --format=JobID,JobName%18,State,Elapsed,MaxRSS
grep -iE "Traceback|Error" "$WCECOLI_CAMPAIGN_ROOT"/logs/*_<index>.out | tail
```

Note that `status` groups failures by message, because a whole condition failing the same
way is one problem rather than N -- and that distinction decides whether a retry is worth
attempting.

`status` also reports **lineage terminated** jobs. These are `done`, not `failed`: the cell
stopped growing before its last generation, either because it died (the simulator raised
`NegativeCountsError` -- a process allocated more of a molecule than existed) or because it
never divided within the generation's time limit (`TimeLimitReached`; the simulator used to
split the undivided cell into daughters at the limit). The generations it did run are ingested
as results, the dying one flagged `terminated` with the molecule that ran out, or the time
limit, as its reason. A starving cell in a depleted medium, or an auxotroph
shifted away from its amino acid, ends this way; it is a model prediction, not a crash. See
`issues.md`, Issues 1 and 5.

## 5b. Re-running failed jobs

`failed` is terminal. `reconcile` retries only tasks the *scheduler* lost (preemption, node
failure, exit-zero-without-sentinel); a simulation that ran and exited non-zero is never retried
on its own, because every such failure seen so far is deterministic. After a fix, re-run them
explicitly:

```bash
cluster/wce requeue --dry-run                    # what would be selected (default: every failed job)
cluster/wce requeue --purge-output               # back up the DB, return them to pending, delete old output
cluster/wce requeue --ids 273 274 --purge-output # just these
```

The next tick (or `cluster/wce dispatch`) picks them up as new attempts. `--purge-output`
removes each job's previous run directory: the new attempt writes a fresh one, so the old tree
is only ever dead weight (a pruned failed job is ~94 MiB, an unpruned one up to several GiB).

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
