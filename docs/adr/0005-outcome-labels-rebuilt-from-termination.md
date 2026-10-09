---
status: accepted
---

# Rebuild outcome labels from how each generation ended

The campaign database's `divided` column is a mass-ratio heuristic: 28,464 rows disagree
with what the simulation did, and 38,899 division times are null. Every generation either
divides or ends the lineage, and the termination is recorded. We derive the labels from
that: `divided = not terminated`, `division_time_sec = n_steps - 1` when divided, and a
`termination_class` of `none`, `time_limit`, `negative_counts`, `fba_infeasible`,
`equilibrium_unstable` or `other`, with the raw reason alongside. Terminated lineages (4,629)
are included and flagged.

## Considered options

- **Keep the database columns**: wrong labels on most of the dataset.
- **Drop terminated lineages**: hides the model's only non-division prediction
  (`time_limit`, 1,973 lineages) and the failure modes users must know about.

## Consequences

`termination_class` separates biology from numerics: only `time_limit` is a clean
"does not divide" prediction; about 2,650 `negative_counts` lineages (ATP in polypeptide
elongation) and 9 solver failures are simulation failures. A viability task has to choose
which classes it counts. The database is not the source of truth for outcomes in this
dataset.
