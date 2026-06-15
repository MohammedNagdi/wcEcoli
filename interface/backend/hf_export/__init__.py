"""wcEcoli → Hugging Face dataset export (v0 pilot).

See HF_DATASET_DESIGN.md (repo root) for the full design. `matrix` defines the locked v0 campaign,
`converter` packages one sim's trajectories into HDF5 + a metadata record, `run_export` drives the
export over completed jobs.
"""
