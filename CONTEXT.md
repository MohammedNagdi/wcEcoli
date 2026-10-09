# wcEcoli campaign platform

The control plane that runs whole-cell E. coli simulations in bulk (a campaign) on a
SLURM cluster, ingests their results, and pushes the output to Hugging Face. This file is
the glossary; the runbook is `cluster/RUN_SLURM.md`.

## Language

### Campaign

**Campaign**:
A set of simulation jobs submitted together under one id, tracked in the campaign database.
_Avoid_: batch, run (a run is one job's output)

**Job**:
One simulation lineage (variant, condition, seed, generations) the campaign has to simulate.
_Avoid_: task (that is the SLURM array element), experiment

**Attempt**:
One execution of a job. A re-run after failure or preemption is a new attempt with its own run directory.

**Run directory**:
The `out/<timestamp>_<variant>_job<N>_attempt<K>/` tree one attempt writes: its export, metadata and variant tree.
_Avoid_: sim dir, experiment dir

**Parca cache**:
The frozen, read-only knowledge base (`out/parca_cache_<hash>/kb`) every job of a campaign reads through a symlink.
_Avoid_: kb (that is the directory name), sim data

**Lineage terminated**:
A job whose cell stopped dividing before its last generation; a model prediction and a `done` outcome, not a failure.

**Pruning**:
Converting a run's raw simulation output to one compressed HDF5 and deleting the raw tree, after ingestion succeeded.

### Ledger pattern

**Manifest**:
A frozen JSONL snapshot of the work one SLURM array will do, one line per array index, written at dispatch and never edited.

**Sentinel**:
The small JSON file an array task writes atomically to report its outcome; the only channel from a task back to the controller.
_Avoid_: result file, marker (a marker is the symlink object in the bucket)

**Ledger**:
The append-only, fsync'd JSONL record of every outcome the controller has reconciled.
_Avoid_: log (SLURM stdout is a log)

**Dispatch**:
Claiming pending work, writing its manifest, and submitting one SLURM array for it.

**Reconcile**:
Reading sentinels into the ledger (or database) and asking the scheduler only about work that left no sentinel.

**Tick**:
One reconcile followed by one dispatch; the idempotent unit of unattended operation.

**Lost**:
A dispatched array task that is no longer queued or running and left no sentinel; it is retried, never recorded as a result.

### Transfer

**Transfer**:
Mirroring the campaign root into a Hugging Face bucket with `hf sync`, driven by the ledger pattern.
_Avoid_: upload, export (export is the dataset built by `hf_export`), sync (that is the `hf` primitive)

**Unit**:
What one `hf sync` call moves and what the transfer ledger marks done: one run directory, one parca cache, or all of `logs/` or `state/`.

**Shard**:
About a hundred units transferred sequentially by one array task.

**Marker**:
The tiny `<path>.symlink` object uploaded in place of a directory symlink, holding the link target.

**Done** (transfer):
A unit whose latest ledger line is `ok`. Nothing else, including a sentinel on disk, counts.

**Pilot**:
One shard dispatched at concurrency 1 to measure throughput before fanning out.

### well4cell dataset

**Trajectory**:
One cell generation of one run, birth to division or termination, at 1 s per row; the well4cell dataset's sample.
_Avoid_: run (a run is a whole lineage's output), episode, sequence

**Cell**:
One campaign experiment design (a variant, condition and timeline), identified by `cell_id`, the experiment name slugified; it has 8 seeds.
_Avoid_: variant, condition (variant x condition is not unique)

**Lineage**:
One seed of one cell: up to 4 generations, following one daughter at each division, identified by `cell_id/s{seed}`.
_Avoid_: job (a job may have several attempts), tree (only one daughter is followed)

**Family**:
The tier-based grouping of cells (T1 `wildtype_media` .. T5 `double_knockout`); the Hub split axis of every config.
_Avoid_: split (learning splits are index columns), variant type (T2 and T3 share one)

**Config** (product):
One data product of the dataset (`core`, `expression`, `metabolism`, `expression_1s`, `metabolism_1s`), declared as a Hub config of the repo.
_Avoid_: subset, view

**Part**:
One output parquet file of one config and family (`data/<config>/<family>/part-NNNNN.parquet`), written by one export array task.
_Avoid_: shard (a shard is a transfer unit group), chunk

**Active column**:
A matrix column that is non-zero somewhere in the campaign; only active columns are published, mapped back through `product_column` in `provenance/reference/`.
_Avoid_: non-zero column (zero in one trajectory does not make it inactive)

**Stride**:
The spacing in seconds between kept rows of a config: rows with `t % stride == 0` plus the last row, point samples of the 1 s data.
_Avoid_: resolution, downsampling factor (nothing is averaged)

**Locator**:
The (file, row offset, row count) triple in the index that says where one trajectory sits in one config.
_Avoid_: pointer, offset

**Termination class**:
How a generation ended: `none` (divided), `time_limit`, `negative_counts`, `fba_infeasible`, `equilibrium_unstable` or `other`; only `time_limit` is a clean non-division prediction.
_Avoid_: failure (a terminated lineage is a `done` job), divided flag from the database (a mass-ratio heuristic)
