---
status: accepted
---

# The Parca caches are identified by hash, not distributed

The first build copied the two Parca caches the campaign used into the repo as
`provenance/parca_cache_<hash>/kb/*.cPickle` (five pickles, ~93 MB each). They are not
simulation output: they are the fitted parameter set of wcEcoli itself (`simData`, the raw
and validation data it is fitted from), the part of the model every simulation reads. The
model is licensed under the Stanford Academic Software License, which allows internal
academic use only and forbids distributing or transferring the Software to anyone without
Stanford's written permission (sections 5 and 8), treats anything built from it as a
derivative owned by Stanford (section 6), and keeps title to the Software and its
derivatives with Stanford (section 11). A CC BY 4.0 dataset cannot carry it. We publish the
simulation trajectories only, and identify the fitted parameters each run used by the
`parca_cache` name and `kb_sha256`, the sha256 of that cache's `kb/simData.cPickle`.

## Considered options

- **Keep the caches in `provenance/`**: one-step reproducibility, but it redistributes the
  licensed model under a licence that does not allow it.
- **Ship a derived summary of the parameters**: still a derivative of the Software
  (section 6), and no use for reproduction.
- **Name the cache only**: the cache name is a hash of the Parca inputs, not of its
  output, so it does not prove which fitted parameters ran; the content hash does.

## Consequences

`index build` hashes each distinct cache's `simData.cPickle` once into the `kb_sha256`
column; `finalize` no longer copies the caches, writes `{parca_cache: kb_sha256}` into
`manifest.json` and the card, and refuses an index without the column. `hub upload`
excludes `provenance/parca_cache_*` and `*.cPickle` even if present locally. Anyone who
obtains wcEcoli under its own licence and runs the Parca at the recorded `git_hash` can check
their `simData.cPickle` against `kb_sha256`. The caches already pushed to the Hub repo were
deleted and its history squashed so no revision still holds them. This amends the consequence
of ADR 0007 that moved the Parca caches into `provenance/`.
