# Explorer personal draft transfer, version 1

The document schema marker is `explorer-drafts-v1`. This format is accepted only by the public explorer. It creates unrun browser drafts; it cannot submit work, create published results, or provide a runtime-readiness receipt. Native platform import is deferred.

A document contains a nonempty `drafts` array. Each record has:

| Field | Meaning |
|---|---|
| `id` | UUID, independent of integer published experiment/job IDs |
| `kind` | `experiment`, `batch`, `media`, `mediaRecipe`, `condition`, `tfCondition`, or `timeline` |
| `name` | Personal nonempty display name |
| `payload` | Existing builder configuration or complete batch recipe, including edits and removed rows |
| `binding` | SHA-256 campaign, reference, model and scientific-source fingerprints |
| `created_at`, `updated_at` | Browser draft timestamps; never fabricated scientific execution dates |
| `applied` | Local environment overlay state; import always resets this to false |
| `warnings` | Planning/review information; imports recompute reference/dependency warnings |

Bindings use `campaign_sha256`, `reference_sha256`, `model_sha256` and `source_sha256`. Environment references use `draft:UUID`, so personal names do not replace published identifiers. An export follows these dependency UUIDs recursively. Downloading the environment workspace includes its five current sections; a selected experiment export includes only its required saved dependencies. Batch exports preserve their recipe and counts rather than materializing every expanded design.

Import validates the entire document before an IndexedDB transaction. Unsupported versions, malformed records, invalid JSON, prototype-related properties, non-finite JSON numbers, duplicate document IDs and files larger than **5 MiB** are rejected without partial insertion. Valid records receive new UUIDs; dependency references are remapped together, and no existing record is overwritten. Unknown conditions, changed gene/index relationships, unknown variants, missing dependencies and changed fingerprints remain review warnings. Indices are never silently retargeted.

Saving incomplete designs is intentional. The single builder reports required fields, parameter metadata, units, identifiers and timeline checks separately from runtime readiness. Applying an environment section requires valid catalog dependencies. A stale imported overlay requires a new reviewed overlay using the current catalog before application. Preview expands at most **1,000 requested batch designs**; the recipe, complete seed list and total planned design/control counts remain downloadable.

Storage is IndexedDB under `wcecoli-explorer-drafts-v1`, scoped to the browser profile and origin. It does not sync between devices, private contexts, the local preview and a future Space URL. Clearing site storage removes drafts. Explicit save is required; unsaved navigation prompts before leaving. A failed transaction never reports success, and the current design can still be downloaded. Keep exported JSON for portability.
