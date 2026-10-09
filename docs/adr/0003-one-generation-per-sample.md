---
status: accepted
---

# One cell generation per sample, ragged, one row per time step

A run is a lineage of 4 generations of one cell; the unit a model consumes could be the run,
the generation, or a fixed window. We make the sample one generation: birth (row 0) to
division or termination, exactly 1 s per row, 2,500-3,100 rows normally and 10,801 at the
time limit, stored ragged as one row per time step. `t` counts from birth and `t_abs` from
the start of the lineage, and `parent_id` links generations, so lineages are reassembled by
concatenation.

## Considered options

- **One lineage per sample**: outcome labels (divided, division time) are per generation,
  and a terminated lineage would be a single sample with mixed labels.
- **Fixed windows**: a modelling choice, not a data one; the package's `windows()` provides
  it on top of generations.
- **One row per sample with array columns**: rows of 10,801 x 7,000 values break the viewer
  and defeat row-group pushdown.

## Consequences

Samples have different lengths, so batching needs windows or padding in the consumer.
`growth_rate` is null at row 0. Only one daughter is followed per division, so a lineage is
a chain, never a tree.
