"""wcEcoli → Hugging Face dataset export.

See HF_DATASET_DESIGN.md (repo root) for the full design. `matrix` defines the fixed tiered campaign,
`converter` packages one sim's trajectories into HDF5 + a metadata record, `run_export` drives the
export over completed jobs.
"""
