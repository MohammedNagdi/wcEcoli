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

## 8. Push the campaign to Hugging Face

`cluster/transfer.py` mirrors the campaign root into a Hugging Face **bucket** with
`hf sync`, one SLURM array task per shard of ~100 experiment directories. It follows the
campaign's own ledger pattern -- manifest JSONL, atomic fsync'd per-unit sentinels, an
append-only ledger -- so a preempted, killed or re-run task never repeats finished work,
and nothing under the campaign root is ever deleted or modified. All knobs live in
`cluster/transfer_env.sh`; `cluster/hfx` runs the controller from anywhere.

### One-time setup

```bash
cluster/setup_hf_env.sh            # builds wcecoli-hf (Python 3.11 + huggingface_hub>=2.1)
```

A third environment: `hf sync` and `hf://buckets/...` URIs need `huggingface_hub>=2.1`,
which needs Python 3.10+, and its transfer engine (`hf-xet`) has no business in the pinned
API environment.

Create a **fine-grained** token at https://huggingface.co/settings/tokens with write
access to the organisation's buckets, and store it under `$HOME`, mode 600:

```bash
mkdir -p ~/.config/huggingface && chmod 700 ~/.config/huggingface
cat > ~/.config/huggingface/well4cell.token      # paste the token, one line
chmod 600 ~/.config/huggingface/well4cell.token
```

`HF_TOKEN_PATH` names the file (that is huggingface_hub's own variable, so `hf` reads it
natively). `dispatch` refuses a token file that is not mode 600, not under `$HOME`, or
anywhere under the repo or the campaign root -- `state/` is transferred, so a token there
would be published.

The bucket must already exist (`hf buckets create` is an org-level act and stays manual)
and must be **private**; `dispatch` refuses a public bucket unless `--allow-public`, because
every byte is world-readable the moment it lands and `state/` holds the campaign database.
Flip it afterwards with `hf buckets settings <ns>/<bucket> --public`.

### Pilot first

```bash
cluster/hfx pilot                  # plans ONE shard and submits it at concurrency 1
squeue -u "$USER" -n hfx-*         # wait for it
cluster/hfx reconcile && cluster/hfx report
```

The first shard is the two `parca_cache_*` directories plus the first experiment
directories, so the number it prints is representative. `report` gives bytes, files,
seconds and MB/s per shard, and an estimate for the remainder at the configured
concurrency. Measured on cpu-g2 while designing this: one process is overhead-bound on
10-file directories (~20-30 MB/s, ~2 s of start-up and remote listing per unit), and 8
processes on one node reached ~130 MB/s with no per-process loss. Concurrency across
array tasks is the throughput knob; klone's measured ceiling is ~348 MB/s.

### Fan out

```bash
export WCECOLI_TRANSFER_CONCURRENCY=16     # from the pilot number
cluster/hfx plan                           # snapshots every unit not yet done
cluster/hfx dispatch                       # one array, %16
cluster/hfx status
```

`plan` snapshots the directory list and each `kb` symlink target into
`transfer/manifests/<plan>.jsonl`, skipping units whose latest ledger entry is `ok`, so
re-planning after more campaign output arrives transfers only what is new. `--verify`
ignores the ledger and re-plans everything; `hf sync` then skips every file whose size and
mtime already match, so a verify pass costs listings, not uploads. Order is parca caches,
experiments by name, `logs/`, `state/`, then the `transfer/` metadata.

Both `plan` and `dispatch` **refuse while campaign jobs (`wce-*`) are in `squeue`**, and
`dispatch` refuses while another `hfx-*` array is queued; `--force` overrides either.

### Ledger

Everything lives under `$WCECOLI_TRANSFER_ROOT` (default `<campaign>/transfer/`, a sibling
of `out/`, never inside `state/`):

| File | Written by | Contents |
|---|---|---|
| `manifests/<plan>.jsonl` | `plan` | one shard per line: its unit records, each with source, destination, exclusions and symlink targets |
| `manifests/<plan>.sentinels/<shard>/<unit>.json` | the task | per-unit outcome: status, files, bytes, seconds, `hf` exit code, uploads/skips, error tail |
| `manifests/<plan>.sentinels/<shard>.json` | the task | per-shard summary, written last |
| `dispatch_log.jsonl` | `dispatch` | array id, manifest, shard indices, account, concurrency |
| `transfer_ledger.jsonl` | `reconcile` | append-only, fsync'd; one line per unit outcome. "Done" = latest line is `ok` |
| `logs/hfx-*_<A>_<a>.out` | SLURM | task stdout |
| `bucket_meta/` | `plan` | staging for `<bucket>/transfer/README.md` and `symlinks.jsonl` |

`cluster/transfer.sbatch` **always exits 0**; the sentinels carry the outcome. A re-run of a
shard (requeue, or `dispatch --manifest M --shards 3,7` after `reconcile` reports a shard
lost) skips every unit that already has an `ok` sentinel. Each unit gets
`WCECOLI_TRANSFER_RETRIES` attempts with back-off before it is recorded as `failed`; a failed
unit is simply pending again at the next `plan`.

### What is and is not transferred

- Run directories of jobs whose `simulation_jobs.status` is in `WCECOLI_TRANSFER_STATUSES`
  (default `done`, which includes lineage-terminated runs), read from the campaign database.
  A failed attempt leaves a ~255 MB run directory too, so the database decides what is
  finished, not the filesystem. `plan --status failed` adds them later; `--status all`
  disables the filter. The two parca caches, `logs/` and `state/` are always included, at
  the same relative paths as on disk.
- Excluded everywhere: `*.tmp`. Excluded from `state/`: `assistant_secret.key` (a secret),
  `wcecoli.db.bak-*`, `wcecoli.db.lock`, `wcecoli.db-journal`. The `state/` unit is synced
  via `hf sync --plan` / `--apply`, and the task refuses to apply a plan that contains an
  excluded path or any delete.
- **Symlinks.** Object storage has none, and `hf sync` silently drops directory symlinks
  (file symlinks are dereferenced). The per-run `kb -> ../parca_cache_<hash>/kb` link is the
  only record of which Parca cache a run used, so each one is uploaded as a tiny
  `out/<run>/kb.symlink` object holding the target, and `transfer/symlinks.jsonl` at bucket
  root indexes all of them. Nothing is duplicated.
- `--delete` is never passed to `hf sync`, and nothing in the source tree is ever removed.
  A run directory later purged locally (`wce requeue --purge-output`) stays in the bucket.

### Resuming and incremental runs

`hf sync` compares size and mtime per file (uploads carry the local mtime), so a task
killed mid-shard loses at most the files of the batch it was committing; the next run of
that shard re-lists and uploads only what is missing. After more campaign output lands,
`cluster/hfx plan && cluster/hfx dispatch` moves only the new directories plus a refreshed
`logs/`, `state/` and `transfer/`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Parca cache ... is incomplete` | `cluster/parca.sbatch` has not run, or `WCECOLI_PARCA_RUN_ID` is stale |
| `<repo>/out is a real directory` | Move it aside; it must be a symlink to the campaign root |
| Jobs stuck in `running_sim` | Run `reconcile`; check `logs/` for the array task's output |
| `unknown to SLURM` in reconcile | Task vanished with no sentinel and no `sacct` record — inspect `logs/` |
| `sbatch` `DenyOnLimit` | `WCECOLI_MAX_IN_FLIGHT` too close to `MaxSubmitJobsPU` (2000 on ckpt) |
| `database is locked` | Another writer holds the flock; it will clear (600s timeout) |
| `campaign jobs are in squeue` from `hfx` | The campaign is still running; wait, or `--force` if you know the output is quiescent |
| `bucket ... is PUBLIC` | `hf buckets settings <ns>/<bucket> --private`, or `--allow-public` deliberately |
| `HF token file ... must be 600` | `chmod 600` it; it must also live under `$HOME`, outside the repo and campaign root |
| `hfx reconcile` reports `lost` shards | The task died before writing its shard sentinel; `hfx dispatch --manifest <m> --shards <idx>` re-runs only its unfinished units |
