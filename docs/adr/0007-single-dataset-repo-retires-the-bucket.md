---
status: accepted
---

# One dataset repo is the published artifact; the bucket mirror is retired

`cluster/hfx` mirrored run directories into an `hf://buckets` bucket (100 pilot units).
A bucket is a raw file mirror: no `load_dataset`, no viewer, no versions, no DOI. We publish
one dataset repo, `datasets/cSynBioSys/well4cell`, private until paper submission, released
as git tag `v1.0` under CC-BY-4.0 with a Hub DOI. The bucket is not part of the release; the
user deletes it by hand later. Nothing on klone is deleted.

## Considered options

- **Bucket plus dataset repo**: two copies to keep consistent, and the raw mirror carries
  the campaign database and logs, which are not a dataset.
- **Several repos (one per config or family)**: splits citation and versioning, and the
  index would have to point across repos.

## Consequences

Provenance that lived only in the bucket (Parca caches, sim options, failed jobs) moves into
`provenance/` in the repo. The upload is `hf upload`, resumable by re-running; the tool
never deletes remotely. `cluster/hfx` stays in the tree but is no longer run.
