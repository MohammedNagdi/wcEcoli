---
status: accepted
---

# Matrix products at two strides, with columns pruned to the ever-active set

The four matrices (mRNA 3,133, protein 4,310, reaction flux 9,612, exchange flux 87) at 1 s
dominate the size: on one run, expression is 17.5 MB and metabolism 34.6 MB per 4
generations. Most models do not need 1 s resolution, and many columns are zero everywhere.
We publish `expression` and `metabolism` at a 10 s stride (rows with `t % 10 == 0` plus the
last row, point samples, an exact subset of 1 s), `expression_1s` and `metabolism_1s` at
1 s, and `core` (18 scalars, 1 s) on its own. Matrix columns are pruned to the set active
anywhere in the campaign (sampled: ~2,400/9,612 fluxes, ~2,750/3,133 mRNA, ~4,170/4,310
protein, ~73/87 exchange), with the full id list, an `active` mask and `product_column` in
`provenance/reference/`.

## Considered options

- **1 s only**: forces every user to download the large products.
- **10 s averages**: not a subset of 1 s, and it blurs the division state.
- **No pruning**: about three quarters of the flux columns would be all-zero.
- **Per-family pruning**: columns would mean different things in different files.

## Consequences

The 1 s matrix configs are uploaded last, after a storage grant. Column positions are a
contract: mapping a column to its gene or reaction requires the reference table.
