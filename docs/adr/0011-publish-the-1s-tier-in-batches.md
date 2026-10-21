---
status: accepted
---

# The 1 s tier is published in batches and pruned locally; finalize runs once

`expression_1s` and `metabolism_1s` are about 1.2 TB of parquet, more than the group's disk
holds next to everything else. They are exported one batch at a time (a config of a family,
or a slice of its parts), uploaded, checked on the Hub by path and exact size against the
export sentinels, and deleted locally, before the next batch. `finalize` runs once at the
end, with most 1 s parts no longer on disk, and writes the same index locators, stats,
`manifest.json` and card as it would with every part present.

Two files in `build/` carry what finalize needs once a part is gone. `build/published.jsonl`
is an append-only record per verified part (repo, revision, path, bytes, the Hub's LFS
sha256, the export attempt), written only by `hub verify`. `build/schemas/<config>.parquet`
is the arrow schema of a config's parts, stored from a local part by `hub verify` or `hub
prune` and checked against every part they read. finalize accepts an ok part missing on
disk only with a record that matches its sentinel; byte counts come from the sentinels
(already checked equal to the file sizes); the product schema comes from a local part, or
from `build/schemas/` when a config has none left.

## Considered options

- **Buy or borrow the space** (scrubbed scratch, another group's quota): scrubbed deletes
  after 21 days of inactivity, which the export-to-finalize span can exceed, and the rest is
  not ours.
- **Finalize per batch and upload the card each time**: the card and manifest would be
  rewritten by every batch from a partial picture, and any batch run without the others on
  disk would drop their counts.
- **Read sizes and schemas back from the Hub in finalize**: finalize would need the network
  and the token, and its output would depend on the Hub's state at that moment.

## Consequences

`hub verify` and `hub prune` are new; prune is a dry run unless `--yes` and deletes only
part files under `repo/data/<config>/<family>/` whose record, sentinel and local size agree.
Nothing deletes remotely. A re-exported part (a new sentinel) no longer matches its record
and must be uploaded and verified again. The local copies of the 1 s tier are gone after
publication: re-reading them means downloading from the Hub.
