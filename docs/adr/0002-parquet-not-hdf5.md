---
status: accepted
---

# Publish parquet, not HDF5 or The Well's layout

The campaign's pruned output is one HDF5 per run, and the dataset's name invites The Well's
HDF5 shape (fixed-size fields on a spatial grid). Neither fits: a cell simulation has no
spatial grid, and generations are ragged (2,500-10,801 one-second steps). We publish parquet
everywhere, one row per time step, zstd, row groups of at most 2,048 rows, files of ~2 GB.
Parquet is what `datasets.load_dataset`, the Hub viewer and DuckDB read natively, and Xet
deduplicates it by content-defined chunks.

## Considered options

- **The Well's HDF5 shape**: needs a grid and a fixed time axis; padding ragged generations
  to 10,801 steps wastes most of the file and needs a mask.
- **Ship the per-run HDF5 files**: no `load_dataset`, no viewer, no column pushdown; every
  consumer writes their own reader.
- **Zarr**: no viewer and no `load_dataset` support on the Hub.

## Consequences

Loading one trajectory needs its locator (file, row offset, row count) from the index, or a
filter on `sample_id`. Small row groups cost some compression, but the viewer serves files
as-is only when row groups are small. Matrices are fixed-size list columns, so a pruned
column set is a contract recorded in `provenance/reference/`.
