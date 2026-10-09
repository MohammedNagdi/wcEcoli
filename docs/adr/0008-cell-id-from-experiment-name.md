---
status: accepted
---

# Identify a cell by its slugified experiment name

A sample needs a stable, readable id. The obvious key, variant x condition, collides:
2,390 combinations for 4,009 cells, because T3 timelines, T4 setpoints and T5 pairs reuse
variant and condition values. The campaign's experiment name is unique per cell design. We
set `cell_id` to the experiment name slugified (`[T3] argG_KO/rich_to_minimal` ->
`T3/argG_KO/rich_to_minimal`), `lineage_id = cell_id/s{seed}`, and
`sample_id = lineage_id/g{gen}`.

## Considered options

- **variant x condition**: not unique.
- **Job id or run directory**: unique but opaque, and changes with every retry attempt.
- **A hash of the design**: unique but unreadable, and hides the family in the id.

## Consequences

The index build fails if two experiments slugify to the same `cell_id`. Ids embed the tier,
so a family is readable from any id. Renaming an experiment in the campaign would change its
ids, so names are frozen once published.
