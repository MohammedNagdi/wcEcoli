"""Build and publish the well4cell dataset from a pruned wcEcoli campaign.

Stages, each a subcommand of ``python -m well4cell_build`` (run via ``cluster/w4c``)::

    scan plan|dispatch|run|reduce|status
              read every run's channels.h5 once: generations present, step counts,
              reference-id hash, ever-active matrix columns   (SLURM array)
    index build|check|reference
              index.parquet from the campaign database, metadata.json and the scan;
              the reference tables (genes, conditions, timelines, media, TFs)
    export plan|dispatch|run|status|reconcile
              one parquet file per array task, for one config and family   (SLURM array)
    finalize  fold export sentinels into index locators, export_qc, stats, provenance,
              the dataset card (README.md) and manifest.json
    hub create|upload|status
              the private Hub dataset repo; ``hf upload`` of repo/ (never deletes)

Vocabulary
----------
run         one job's run directory (out/<timestamp>_<variant>_job<N>_attempt<K>)
trajectory  one cell generation of one run: the dataset's sample
config      a data product (core, expression, metabolism, expression_1s, metabolism_1s)
family      the tier-based top-level grouping (wildtype_media, single_knockout, ...)
part        one output parquet file of one config and family
manifest    frozen JSONL of what one SLURM array will do, one line per array index
sentinel    atomically written per-task outcome; the only channel back to the controller
ledger      append-only record of reconciled outcomes

Everything under W4C_ROOT: build/ (manifests, sentinels, ledger, logs) and repo/ (the exact
tree that is uploaded). Nothing under the campaign's out/ or state/ is ever modified.
"""
