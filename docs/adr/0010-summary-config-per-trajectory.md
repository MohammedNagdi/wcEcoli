---
status: accepted
---

# A `summary` config: one row per trajectory, computed from core

Most questions asked of the dataset are about whole trajectories: how fast a perturbed cell
grew, how big it was at division, whether its mRNA or ppGpp moved. Answering them from the
products means scanning `core`, 316,751,845 rows and ~19 GB, to reduce each trajectory to a
handful of numbers. We publish that reduction once as the `summary` config,
`data/summary/<family>/part-00000.parquet`: one row per trajectory with `sample_id`,
`n_steps` and, for each of the 18 scalars, `<channel>_mean`, `_min`, `_max`, `_first` and
`_last`. It joins to `index.parquet` on `sample_id` and is about 30 MB for all five families. The
shape matches the per-lineage summary tables of the Cellarium corpus, so the two can be read
side by side. It is computed from `core`, at 1 s, so it does not depend on the 10 s matrix
configs or on which of them have been uploaded; `growth_rate` statistics skip its null row 0.

## Considered options

- **Leave it to the user**: every user rescans 19 GB for the same numbers, and computes
  them in slightly different ways (with or without the `growth_rate` null, at 10 s or 1 s).
- **Put the statistics in `index.parquet`**: 90 more columns in the table everyone loads
  first, mixing design and outcome with measurements; the index schema and its locator
  columns are a contract we do not want to widen.
- **Compute from the 10 s configs**: smaller input, but only `wildtype_media` has them yet,
  and a 10 s minimum or maximum misses the extremes between samples.

## Consequences

A new stage, `summarize`, reads the core parts after `finalize` has filled the core
locators, verifies that it has one row per located trajectory with `n_steps ==
core_n_rows`, and writes the summary parts; `finalize` then counts them in the card and
`manifest.json`. `summary` is not in `settings.CONFIGS`: it is not exported from
`channels.h5`, has no export sentinels and no `<config>_file` locator in the index. Its split
is the family, like every config. The summary is only as current as the core parts it was
computed from: after a new core export, run `summarize` again before the next `finalize`.
