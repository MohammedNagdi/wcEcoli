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
