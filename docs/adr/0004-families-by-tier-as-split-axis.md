---
status: accepted
---

# Families by campaign tier are the Hub split axis; no shipped train/test directories

The campaign mixes five designs (static media, single knockouts, dynamic media, regulation,
double knockouts), and a consumer needs both a way to pick a design and a train/val/test
assignment. We group samples into families by the tier prefix of the experiment name (T1
`wildtype_media` .. T5 `double_knockout`) and make the family the split axis of every Hub
config: `load_dataset(repo, "expression", split="single_knockout")`. Learning splits are
index columns (`split_by_lineage`, `split_by_gene`, fixed seed), exposed by the package as
`split(by=...)`.

## Considered options

- **Group by variant type**: 4,800 T3 jobs share the `gene_knockout` variant type with T2,
  so dynamic-media knockouts would be mixed into single knockouts.
- **Ship `train/`, `val/`, `test/` directories**: freezes one split forever; a gene-held-out
  split and a lineage split would need two copies of the data.

## Consequences

Hub "splits" are not learning splits, which the card must say plainly. Changing a learning
split is an index edit, not a re-upload. Families are a contract on the file paths
(`data/<config>/<family>/`).
