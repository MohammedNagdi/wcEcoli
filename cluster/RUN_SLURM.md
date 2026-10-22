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

## 9. Build and publish the well4cell dataset

`cluster/w4c` builds the well4cell dataset from the pruned campaign and publishes it as one
Hugging Face **dataset repo**, `datasets/cSynBioSys/well4cell` (private until paper
submission). This replaces the bucket of section 8 as the published artifact: `cluster/hfx`
is no longer run, and the pilot bucket is deleted later by hand (ADR 0007). The design is in
`docs/well4cell/DESIGN.md`, the stage contracts in `cluster/well4cell_build/SPEC.md`.

The array stages follow the same ledger pattern as the campaign and the transfer: a frozen
manifest per dispatch, an atomic sentinel per task, an append-only ledger, and
`cluster/well4cell.sbatch` **always exits 0**. Nothing under `out/` or `state/` is read for
writing; everything is written under `$W4C_ROOT` (default `<campaign>/well4cell/`). All
knobs live in `cluster/well4cell_env.sh`; `cluster/w4c` sources it and runs the builder
under the `wcecoli-api` environment, using `wcecoli-hf` (section 8) for the `hf` CLI. The
token is the same `HF_TOKEN_PATH` file, with write access to the organisation's datasets.

### Scan

```bash
cluster/w4c scan plan              # one shard per W4C_SCAN_SHARD_SIZE runs (default 200)
cluster/w4c scan dispatch          # one array, %W4C_CONCURRENCY
cluster/w4c scan status
cluster/w4c scan reduce            # once every shard is ok
```

The scan reads every run's `channels.h5` exactly once: generations present, step counts,
attributes, the reference-id hash, and which matrix columns are ever non-zero. `reduce`
folds the shard sentinels into `build/scan/runs.jsonl`, the global active-column union
(`build/scan/active_union.npz`) and the four matrix tables
`provenance/reference/{mrna_counts,protein_counts,reaction_flux,exchange_flux}.parquet`.
A re-dispatched shard skips the runs whose per-run sentinel is `ok`; `scan plan` skips runs
already in `runs.jsonl` (`--force` re-scans). A failed job whose `channels.h5` is partial
(no `reference` group) is recorded as scan status `failed` and only reaches
`provenance/failed_jobs.parquet`.

### Index

```bash
cluster/w4c index build            # repo/index.parquet + provenance/sim_options/ from DB, metadata.json, scan
cluster/w4c index check            # counts per family, id uniqueness, nulls, outcomes, splits, build report
cluster/w4c index reference        # provenance/reference/{genes,conditions,timelines,media_recipes,tf_edges,tf_activity}.parquet
```

`index build` **fails** if the database, a run's `metadata.json` and the scan disagree on
seed or variant, if a done job is missing from `runs.jsonl` (the scan is incomplete), if
two experiments slugify to the same `cell_id`, or if a Parca cache's `kb/simData.cPickle`
cannot be read (it is hashed once per cache into `kb_sha256`); fix the cause, do not work around it.
Non-fatal disagreements and runs the scan marked missing/failed are in
`build/index_report.json`, which `index check` prints. T4 TF cells are named after the TF
that actually ran, not the database's name (DESIGN.md, Known defects). Outcome labels are
rebuilt from termination, not taken from the database's `divided` (ADR 0005). Locator columns stay null until `finalize`.

### Export

```bash
cluster/w4c export plan --configs core,expression,metabolism --families all
cluster/w4c export dispatch
cluster/w4c export status
cluster/w4c export reconcile       # sentinels -> ledger; reports failed, lost, running, not-dispatched parts
```

`--families` takes a comma-separated list of families or `all` (the default). `plan` packs
trajectories, families in tier order and within a family by cell, seed, generation, into parts of about
`W4C_FILE_TARGET_BYTES` (2 GB) per config and family, and writes one manifest line per part;
each array task writes one `data/<config>/<family>/part-NNNNN.parquet`. A part is written to
a temporary name and renamed, so a killed task leaves nothing half-written; re-running
`dispatch` skips parts whose sentinel is `ok`. Trajectories failing a QC gate are skipped
and reported in the sentinel (they land in `provenance/export_qc.parquet` at finalize).
`reconcile` appends each new sentinel outcome (ok or failed: rows, bytes, QC failures) to
`build/ledger.jsonl` exactly once, and lists failed parts, lost parts (an array was
submitted for the part per `build/dispatch_log.jsonl`, no sentinel, no longer live in
SLURM) with the `export dispatch --manifest ... --parts ...` command that re-runs them,
parts still running or pending in SLURM, and parts not dispatched yet (no array was ever
submitted for them, e.g. the later slices of a sliced dispatch; not lost, nothing to
re-run). `export status` counts the last separately too. `--parts` takes indices and
ranges, `0-161,170`. A later `plan` skips trajectories
already written by an ok sentinel and never reuses a part number.

A part task can be run in the foreground, e.g. to time one part:
`cluster/w4c export run --manifest <build/manifests/export_....jsonl> --index 0`.

Part sizes are estimated from `bytes_per_row` in `well4cell_build/settings.py` (`CONFIGS`),
measured on a 12-run reference only: after the first parts of each config are ok, compare
`bytes / rows` from `export status` or the sentinels and update `CONFIGS` before planning
the rest.

Plan `expression_1s` and `metabolism_1s` **last**, and only after the storage question below
is settled. They do not fit on disk (about 1.2 TB): export them one batch at a time, as in
[Configs that do not fit on disk](#configs-that-do-not-fit-on-disk), not with
`--families all`.

### Finalize

```bash
cluster/w4c finalize
```

Folds every ok export sentinel into the index locators, writes `export_qc.parquet`,
`failed_jobs.parquet` and `scan_runs.parquet`, merges per-part stats into
`stats/<family>.parquet`, renders `README.md` (the dataset card, with configs and family
splits in its front matter) and writes `manifest.json`. It does not copy the Parca caches:
they are wcEcoli's fitted parameters under the Stanford licence (`docs/adr/0009`), so the
dataset names each one by `parca_cache` and the sha256 of its `kb/simData.cPickle`
(`kb_sha256`, computed by `index build`). An index built before that column existed is
refused: re-run `cluster/w4c index build`, then finalize. A
`repo/provenance/parca_cache_*` left by an older finalize gets a warning; delete it (`hub
upload` excludes it and every `*.cPickle` regardless). A `repo/provenance/deg_rates_*.json`
left by an older finalize is refused: delete it (the original stays in `build/provenance/`)
and finalize again. It refuses
while any part planned for the configs being finalized lacks an `ok` sentinel, and only
warns about the other configs, so `cluster/w4c finalize --configs core` works while the
matrix configs are still exporting (`--allow-incomplete` overrides the refusal; those
trajectories then have null locators). It also refuses if a parquet under `data/` has no ok
sentinel, an ok part is missing on disk without a `hub verify` record (see [Configs that do
not fit on disk](#configs-that-do-not-fit-on-disk)), or one trajectory is in two files of one config. Re-run it after any further
export. `--hold-back core/single_knockout[,...]` leaves
exported `<config>/<family>` data out of the locators, stats, `manifest.json` and the card (which
then says that data follows), for a staged upload; re-run finalize without it once that data is
on the Hub, and upload `index`, `manifest`, `stats` and `readme` again.

### Summarize

```bash
cluster/w4c finalize               # fills the core locators summarize checks against
cluster/w4c summarize              # repo/data/summary/<family>/part-00000.parquet, every family with core parts
cluster/w4c finalize               # again: the card and manifest.json now list the summary config
cluster/w4c hub upload --include summary,manifest
cluster/w4c hub upload --include readme
```

`summarize` writes the `summary` config (`docs/adr/0010`): one row per trajectory with
`n_steps` and the mean, min, max, first and last of each of the 18 scalars, computed from the
core parts at 1 s (`growth_rate` skips its null row 0). It streams each core file in record
batches with pyarrow's read-ahead off (`pre_buffer=False`), so memory stays near 1 GB whatever
the part size (0.66 GB peak on a 1 GB synthetic part, 1.67 GB with the read-ahead). It is one
process, not an array, but it reads all of core (and with `--pathways` all of expression), so
submit it as a batch job rather than running it on the login node:
`sbatch --account=cpu-g2-amath --partition=cpu-g2 --mem=8G --time=04:00:00 --output=summarize-%j.out
--wrap "cluster/w4c summarize"` from the repo root. It refuses,
writing nothing, unless each family's rows are exactly the index's trajectories with a
`core_file`, each with `n_steps == core_n_rows` at its `core_row_offset`: run it after a
`finalize` that has seen every core part. `--families` limits it to some families (leave out
a family held back with `--hold-back core/<family>`). Re-run it, and finalize, after any new
core export; finalize warns when a summary's row count no longer matches the index. To
build the summary elsewhere from downloaded core parts and the published index, point it at
them: `summarize --core-dir <dir>/data/core --index <dir>/index.parquet --out-dir
<dir>/data/summary` (nothing is appended to the ledger then).

Pathway fractions are added once the `expression` export is complete for every family:

```bash
cluster/w4c summarize --pathways   # summary parts again, plus 13 pathway_<name> columns from data/expression
cluster/w4c finalize
cluster/w4c hub upload --include summary,manifest
cluster/w4c hub upload --include readme
```

`--pathways` appends one `pathway_<name>` column (proteome fraction, Cellarium's definition and
gene lists, `data/pathways.json`) per pathway, from the 10 s `protein_counts_matrix`. It
refuses, writing nothing, if a family has no expression parts (narrow `--families` to try it
on some), logs every gene symbol that does not resolve and every pruned monomer, and fails if
a pathway resolves to no column. A later `summarize` without `--pathways` drops the columns,
so keep the flag on every re-run once expression is complete.

### Degradation-rate provenance

```bash
cluster/w4c deg-rates              # build/provenance/deg_rates_<parca_cache>.json, every cache the index names
cluster/w4c deg-rates --cache <hash>
cluster/w4c finalize               # counts per class into the card and manifest.json; the files stay in build/
cluster/w4c hub upload --include manifest
cluster/w4c hub upload --include readme
```

For each Parca cache, `deg-rates` runs `well4cell_build/deg_rates.py` under the simulation
environment (`W4C_SIM_PYTHON`, default `micromamba run -n wcecoli-sim python`, since only it
can unpickle `kb/simData.cPickle` and `kb/rawData.cPickle`) and classifies every mRNA
transcription unit's degradation rate as floor (the NNLS lower bound, the slowest measured
mRNA cistron), ceiling (clipped at the fastest), imputed (no cistron measured, so the mean
measured half-life) or determined, weighted by basal expression. The JSON uses the keys of
Cellarium's `deg_rate_baseline.json` (854 of 3,133 units, 12.087% of basal mRNA expression on
their fit). It refuses a cache whose `simData.cPickle` no longer hashes to the index's
`kb_sha256`. Expect about a minute and a few GB per cache (two unpickles); run it on a compute
node (`srun --mem=8G ...` or `sbatch --wrap`) if the login node objects. The loader has not
yet run on a real cache: check the first output (counts near Cellarium's, every unit in
exactly one class, `cellarium_rule` close to the main counts) before the finalize that puts
its counts in the card.

The files are never published. They are a derived summary of the fitted parameters (per-unit
classes, expression shares, the bounds and the imputation constant), which `docs/adr/0009`
rules out shipping, so they stay in `build/provenance/` on klone. `finalize` reads them and
puts only aggregates in the card's Provenance section and `manifest.json` (`deg_rates`): per
cache, the number of mRNA units in each class and in all, and the percent of basal mRNA
expression the not-a-fit classes carry. `hub upload` excludes `**/deg_rates_*.json` in any
case.

### Upload

```bash
cluster/w4c hub create             # creates W4C_REPO_ID, private (exist_ok); refuses a public repo
cluster/w4c hub upload --include index,manifest,provenance,stats --dry-run   # print the hf command
cluster/w4c hub upload --include index,manifest,provenance,stats
cluster/w4c hub upload --include core
cluster/w4c hub upload --include expression,metabolism
cluster/w4c hub upload --include readme
cluster/w4c hub status             # remote files grouped by top-level dir (and data/<config>), sizes, private flag
cluster/w4c hub status --files     # every remote file
```

`--include` takes one comma-separated list of parts: `readme`, `index`, `manifest`,
`stats`, `provenance`, `data`, or a config name (`core`, `expression`, ..., `summary`); each part maps
to a glob of `repo/` (`data/<config>/**`, `provenance/**`, ...). `--families` narrows the
config parts to `data/<config>/<family>/**` (e.g. `--include core --families
wildtype_media,regulation`); the fixed parts are unaffected. Without `--include` every
fixed part plus every config present under `repo/data/` is uploaded. `hub upload` checks the
repo is private before pushing (`--allow-public` overrides) and runs `hf upload` on `repo/`; huggingface_hub 2.1 has no `upload-large-folder`,
so a large push is split with `--include` and **resumed by re-running the same command**
(files already on the Hub are skipped). The tool never deletes anything remotely; removing a
file from the repo is a manual Hub action. Upload the card last so the viewer never sees
configs whose files are missing.

**Storage.** Before uploading `data/expression_1s/**` and `data/metabolism_1s/**`, confirm
the organisation's plan covers them, or email Hugging Face for an academic storage grant.

### Configs that do not fit on disk

The 1 s tier is published in batches (ADR 0011): export a batch, upload it, verify it on
the Hub, delete it locally, repeat; finalize once at the end. A batch is one config of one
family (or several families, if they fit):

```bash
cluster/w4c export plan --configs expression_1s --families regulation
cluster/w4c export dispatch
cluster/w4c export status
cluster/w4c export reconcile       # until every part of the batch is ok
cluster/w4c hub upload --include expression_1s --families regulation
cluster/w4c hub verify --configs expression_1s --families regulation
cluster/w4c hub prune  --configs expression_1s --families regulation          # dry run
cluster/w4c hub prune  --configs expression_1s --families regulation --yes
```

`hub verify` lists `data/<config>/<family>/` on the Hub and compares every ok part of the
selection (path, exact size) with its sentinel; each match is appended to
`build/published.jsonl` (with the Hub revision and LFS sha256). It exits non-zero on a part
missing on the Hub, a size mismatch, or a remote file that is not a current ok part (remove
that by hand); re-run `hub upload` and verify again. `hub prune` deletes only the selection's
part files whose record, sentinel and local size agree, refuses the whole batch otherwise,
and is a dry run without `--yes`. Before a config's last local part goes it stores the
config's parquet schema in `build/schemas/<config>.parquet`, which finalize reads in its
place.

Without `--parts`, verify and prune take every ok part of the selection, strictly: an ok part
not yet uploaded fails verify and blocks prune. A family larger than the free space is
therefore dispatched in slices of the manifest's part indices, and each slice goes upload,
verify, prune with the same `--parts` before the next slice is dispatched (here 325 parts in
two slices; `export plan` prints the manifest, and `--manifest` defaults to the latest):

```bash
cluster/w4c export plan --configs metabolism_1s --families single_knockout
cluster/w4c export dispatch --parts 0-161
cluster/w4c export reconcile       # until 0-161 are ok; 162-324 show as "not dispatched yet"
cluster/w4c hub upload --include metabolism_1s --families single_knockout
cluster/w4c hub verify --configs metabolism_1s --families single_knockout --parts 0-161
cluster/w4c hub prune  --configs metabolism_1s --families single_knockout --parts 0-161 --yes
cluster/w4c export dispatch --parts 162-324
cluster/w4c export reconcile       # until 162-324 are ok
cluster/w4c hub upload --include metabolism_1s --families single_knockout
cluster/w4c hub verify --configs metabolism_1s --families single_knockout --parts 162-324
cluster/w4c hub prune  --configs metabolism_1s --families single_knockout --parts 162-324 --yes
cluster/w4c hub verify --configs metabolism_1s --families single_knockout   # whole family, strict
```

`--parts` has the syntax of `export dispatch --parts` and names part indices of one export
manifest (`--manifest`, default the latest), which are unique across that manifest's
configs and families, so several of either may be selected; indices of configs or families
outside `--configs`/`--families` are left out, and an index the manifest lacks is refused.
Parts outside `--parts` are ignored by both commands. Inside it nothing is skipped: a part
without an ok sentinel, missing on the Hub or of the wrong size fails verify and blocks
prune. verify still flags a remote file in the config/family folder that is not a current ok
part of any manifest, but not one of an ok part outside the range. The schema is stored
before the last local part of a config goes, whichever slice that is.

After the last batch of both configs:

```bash
cluster/w4c finalize               # reports how many parts are on disk and how many published-only
cluster/w4c hub upload --include index,manifest,provenance,stats
cluster/w4c hub upload --include readme
```

finalize accepts a part missing on disk only if `build/published.jsonl` has a record for that
export attempt with the sentinel's bytes, and refuses it as missing otherwise. Byte counts come
from the sentinels and the schema from `build/schemas/`, so the index, stats, manifest and card
are the ones it would write with every part on disk. Until then finalize refuses while 1 s
parts are planned but not ok; run `finalize --configs core,expression,metabolism` in between,
and upload the card only after the final finalize. A re-exported part has a new sentinel and
must be uploaded and verified again.

Release (paper submission): make the repo public, tag `v1.0`, mint the DOI on the Hub.

### Build tree

| Path under `$W4C_ROOT` | Written by | Contents |
|---|---|---|
| `build/manifests/<stage>_<ts>_<id>.jsonl` | `plan` | one shard (scan) or one part (export) per line |
| `build/manifests/<...>.sentinels/` | the task | per-task outcome: status, rows, bytes, seconds, per-sample offsets and QC, error tail |
| `build/dispatch_log.jsonl` | `dispatch` | array id, manifest, indices, account, concurrency |
| `build/ledger.jsonl` | `scan reduce`, `index build`, `export reconcile`, `finalize`, `summarize`, `deg-rates`, `hub create` / `upload` / `verify` / `prune` | append-only, fsync'd outcome record |
| `build/published.jsonl` | `hub verify` | append-only, one line per part verified on the Hub (path, bytes, revision, sha256, export attempt); finalize accepts a part missing on disk only with one |
| `build/schemas/<config>.parquet` | `hub verify`, `hub prune` | the config's parquet schema (no rows), read by finalize when no part of the config is on disk |
| `build/index_report.json` | `index build` | excluded runs, fatal and non-fatal disagreements |
| `build/provenance/deg_rates_<parca_cache>.json` | `deg-rates` | mRNA degradation-rate classes of that cache; never published, finalize puts only its counts in the card and `manifest.json` |
| `build/scan/` | `scan reduce` | `runs.jsonl`, `active_union.npz` |
| `build/logs/w4c-*_<A>_<a>.out` | SLURM | task stdout |
| `repo/` | `scan reduce`, `index`, `export`, `finalize`, `summarize` | exactly the tree that is uploaded |

### Knobs (`cluster/well4cell_env.sh`)

| Variable | Default | Meaning |
|---|---|---|
| `W4C_ROOT` | `<campaign>/well4cell` | build and repo root |
| `W4C_REPO_ID` | `cSynBioSys/well4cell` | Hub dataset repo |
| `W4C_VERSION` | `1.0.0-rc1` | version in the card, manifest and file metadata |
| `HF_TOKEN_PATH` | `~/.config/huggingface/well4cell.token` | token file, mode 600 |
| `W4C_ROW_GROUP_ROWS` | `2048` | parquet row-group cap; keep small for the viewer |
| `W4C_FILE_TARGET_BYTES` | `2000000000` | target part size |
| `W4C_COMPRESSION` | `zstd` | parquet codec |
| `W4C_SPLIT_SEED` | `20261008` | seed of `split_by_lineage` / `split_by_gene` |
| `W4C_PARTITION`, `W4C_ACCOUNTS` | `cpu-g2`, `cpu-g2-amath,cpu-g2-stf` | the group's nodes, no preemption |
| `W4C_CPUS`, `W4C_MEM`, `W4C_TIME` | `2`, `4G`, `04:00:00` | per array task |
| `W4C_CONCURRENCY` | `32` | array throttle (`%N`) |
| `W4C_SCAN_SHARD_SIZE` | `200` | runs per scan task |
| `W4C_JOB_PREFIX` | `w4c` | array job names; must not start with `wce` |
| `W4C_SIM_PYTHON` | `${MICROMAMBA_BIN} run -n ${WCECOLI_SIM_ENV} python` | command line of a python that can unpickle sim_data (`deg-rates` only) |

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
