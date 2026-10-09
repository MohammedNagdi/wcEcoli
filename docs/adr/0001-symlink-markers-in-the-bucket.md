---
status: accepted
---

# Represent directory symlinks in the bucket as `<path>.symlink` marker objects

Every run directory holds `kb -> ../parca_cache_<hash>/kb`, the only record of which
Parca cache that run was simulated against (`metadata/metadata.json` does not name it).
Object storage has no symlinks, and `hf sync` (huggingface_hub 2.1) silently drops
directory symlinks while dereferencing file symlinks. We upload one `out/<run>/kb.symlink`
object per link, containing the target exactly as `readlink` prints it, plus a
`transfer/symlinks.jsonl` index at bucket root, and never dereference the link. This keeps
the 2 × 90 MB caches from being copied 32,000 times (2.9 TB), keeps every run directory
self-describing when downloaded alone, and leaves the source tree untouched.

## Considered options

- **Dereference** (copy the cache into every run): 2.9 TB of duplicates and the provenance
  becomes implicit.
- **Index only** (one JSONL at bucket root): a single run downloaded on its own carries no
  provenance.
- **Write the target into `metadata.json`**: modifies the source tree, which the transfer
  must never do.

## Consequences

Consumers reconstructing a local tree must turn `*.symlink` objects back into links, or
read the index. The marker name is now a contract: 32,000 objects are expensive to rename.
