# HF-06 public explorer and personal drafts

Status: completed, 28 October 2026. No new simulations, Parca, uploads or deployments are authorized by this task. The HF-05 dataset and original local platform remain preserved.

## Page and capability inventory

| Page / action | Explorer behavior | Source |
|---|---|---|
| Home / Guide | Existing visual system, explorer-specific wording and real campaign captures | Published release and current website |
| Workspace / Genes / Genome / Network / Pathways | Bounded read-only reference browsing | Publication SQLite and verified references |
| Published experiments / Results | Twelve experiments, 47 actual trajectories, artifact-backed charts | HF-05 HDF5 / manifest |
| Comparison | Selected actual generation; final saved values and recorded division duration; no replica CI | HDF5 and lineage metadata |
| Genome Design | Catalog context and TU/co-target evidence; unmeasured remains unclassified | Catalog / campaign |
| Single / batch experiment designer | Personal unrun draft, structural/catalog checks, export | Browser IndexedDB |
| Environment builder | Save locally, review, apply only to personal draft overlays | References + browser drafts |
| Draft transfer | Explorer JSON export/import, dependency closure, import as copies | Browser only |
| Execute / retry / cancel / delete published data / publish reference changes | Unavailable; API writes return 405 | Server capability boundary |
| Assistant / provider / training / administrative debug | Excluded; direct routes explicitly unavailable | No corresponding server routes/providers |

The explorer has a dedicated frontend profile and checks `/api/capabilities` before rendering. Default local startup remains unchanged. No normal backend startup/migrations/ingestion/recovery/worker/provider lifecycle is used. All public server endpoints are read-only.

## Reference and data contract

Add an optional `explorer-references-v1` descriptor/file to the existing release contract. The successor bundle reuses byte-identical scientific HDF5 shards and preserves the HF-05 bundle. Bind references to source, model and catalog fingerprints; include media stocks, TF conditions, variant hints, actual RNA/TU targets and reaction relationships from the verified frozen source/mappings. No runtime Parca/reconstruction access. Include every added file in size/checksum validation.

## Browser drafts

Use `explorer-drafts-v1`, IndexedDB and UUIDs distinct from database IDs. Manual save, reopen/rename/duplicate/delete and dependency-complete export/import. Import as copies atomically, limit input to 5 MiB, retain source fingerprints and unresolved/stale-reference warnings. Storage failure cannot claim success; current designs remain downloadable. Batch previews materialize at most 1,000 rows while retaining their recipe and planned count. Native local import is deferred.

## Design reference lock

Use the existing product and its approved [frontend reference lock](../../interface/frontend/docs/frontend-refresh.md), plus the archived [Refero decisions](design-references/refero-references.json). Preserve Inter, semantic biological/status colors, neutral technical surfaces, violet actions, panel geometry, light/dark/system themes and responsive navigation. Change execution language and personal-draft feedback to reflect actual capabilities. Public captures show only this campaign and personal draft screens; local captures remain unchanged and excluded from the explorer build. No new visual direction or generated scientific imagery.

## Subtasks and acceptance

- HF-06.1 capability boundary and API/page inventory: done; API and page smoke tests pass.
- HF-06.2 reference successor: done; 1,280,813,520 bytes, 12 unchanged HDF5 shards.
- HF-06.3 immutable read adapters and honest scientific summaries: done; 3,948 independent HTTP/HDF5 comparisons and 94 derived-metric comparisons pass.
- HF-06.4 personal draft repository and transfer: done; persistence, context isolation, all five environment sections, dependency transfer, import/storage errors and draft CRUD pass.
- HF-06.5 full website integration and real captures: done; real charts, four matrix families, controls, timed shifts, navigation and explorer-only light/dark captures pass.
- HF-06.6 API/data/draft/browser/local-mode/resource verification and rollback record: done. 197 backend/contract tests plus 47 subtests, 79 native browser checks and 14 final explorer browser checks pass.

Completion requires real artifact/API/browser checks, matching HDF5 hashes, no unexpected backend writes or provider requests, draft isolation/storage/import error tests, local-mode regressions, unchanged original platform data and cold/warm/concurrent preview checks under the existing 512 MiB API limit. All acceptance checks pass; HF-07 is ready and has not started.

## Implemented interfaces and operation

- Standalone API: `hf_export.preview`, with publication adapters in `hf_export.explorer_routes`. Only the approved read routes are registered; normal application startup and scientific execution dependencies are not imported. Public schemas, provider/admin/debug routes and writes are unavailable. SQLite connections use `mode=ro&immutable=1` and `query_only`.
- Profile: `VITE_DEPLOYMENT_MODE=explorer`; capabilities must match before the workspace renders. Missing or incompatible metadata fails closed. Native mode remains the default. The assistant provider/dock, assistant shortcuts and live job polling are excluded in the explorer.
- Drafts: [transfer contract](explorer-drafts-v1.md), UUID IndexedDB repository, browser-local environment overlays and explicit manual save. Single/batch/environment tools remain available for plans beyond the published examples. No draft receives a job or scientific result.
- Offline references: `python -m hf_export.reference_export` inside the frozen serving tools. Media stocks, TF rules, variant hints, exact RNA/TU/co-target mappings and reaction stoichiometry are packaged from verified frozen inputs. Runtime serving reads JSON/SQLite/HDF5 only.
- `./platform.sh demo prepare` recognizes a completed campaign and prepares its serving successor without scientific execution. `demo run` recognizes completion and cannot enqueue completed seeds or reassemble over the explorer. `demo preview` serves the active validated publication. The root `explorer` command stays reserved for HF-07.
- Rollback: retain `interface/.pilot/proofs/hf06/rollback.json`, the original `demo-release`, original HF-05 serving image tags/IDs and `/release/full-c85e170d95082914cfa8`. Restore its recorded serving configuration and the publication symlink to return to the original preview. No images or volumes are pruned by HF-06.

Public charts default to elapsed lineage time. Comparison selects actual generation 0 by default, with an explicit generation-relative axis option. Missing generations/channels, undefined initial growth and zero control denominators stay unavailable. Final saved mass/growth and recorded division duration are distinguished from means. Shift controls retain their initial/endpoint roles. Gene/pathway views do not infer genome-wide essentiality; unmeasured genes remain unclassified.

Scientific bundle identity: original manifest `948c756a6b61230823653ffa7bf3261e3fb38a30ce460a229d5d6a1b629fab84`; successor manifest `5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18`; references `10fa3950edc64b5b84c346c08595a51ae010ffa50ee9c1f72f917f9a3b62a0f5`. All 16 original payload hashes, including 12 HDF5 shards, are unchanged. The successor has 18 files totaling **1,280,813,520 bytes**, below the 5 GB target. It includes 12 experiments and 47 trajectories.


## Final acceptance and handoff

The working full explorer is [http://localhost:5175](http://localhost:5175), with its read-only API on port 8001. Final screenshots were visually inspected, including real lineage charts and the mobile dark results page. All 14 final browser tests ran against the packaged images, with no mocked scientific data. They cover 17 public routes, four molecular families, both shift controls, missing generations, design-from-result, IndexedDB persistence/isolation, five environment sections, dependency-remapped imports, rejected malformed/oversized/stale files, storage failures, large batch limits, rename/duplicate/selected export/delete, capability mismatch, themes, mobile layouts, keyboard focus and accessibility.

Evidence under `interface/.pilot/proofs/hf06/`:

- `acceptance.json`, `tests.json`, `successor-validation.json` and `bundle-parity.json` consolidate completion and scientific parity.
- `live-http-final/summary.json`: 48 experiment/family checks and **3,948** exact scalar/molecular timestamp/value/unit comparisons.
- `api-acceptance.json`: **94** derived final-value comparisons, reference routes, absent-generation handling, **18 requests from eight concurrent clients**, unchanged publication files and no SQLite journals.
- `browser-final/`: 14 passing production browser checks and desktop/mobile/light/dark screenshots. `captures/` records source routes and fingerprints for the four public homepage captures. The web image contains only these four preview assets.
- `isolation-resources.json`: original four container identities/images/mounts and simulation image unchanged; main database still **8 experiments / 7 jobs / 7 results**, data fingerprint `9654097951d51747332ab2781e7b6eda06613ad76fc859c4425eab2df552671c`; all 12 verified raw directories remain removed; preparation/readiness remains intact.
- `cold-start.json`: healthy cold startup **51.36 seconds**. `final-serving.json` records source/image identities; `rollback.json` preserves the original HF-05 serving configuration.

The API now holds a maximum of two response builders through transmission, in addition to single-flight bundle validation and bounded molecular columns. Final measured peak is **433,594,368 bytes (413.5 MiB)** under **512 MiB**, with no limit-pressure or OOM events during combined browser and HTTP verification. The earlier unrestricted preview reached its memory ceiling under concurrent requests; the verified limiter resolves that pressure. Production startup/readiness in HF-07 must accommodate the measured cold validation time. The existing Vite large-bundle warning remains; the public build is successful.

Final frozen serving source: `636f1f8fc82edaa6c2892adef7fcf22d55e07035f3e8cb4674d2f8d6a8c26307`.
Tools image: `sha256:ab47e2caa4d0f714093cae782a0a21dba64a6b6b532c5abec715f84edf36c031`.
Web image: `sha256:835a0cae28782d0c12fb656821d9b2f155916547ef2f701a79aefccbbdd87313`.
Scientific readiness: `713cea9bc33f7e75f5eed57e0cf24b64726d2250ccef2ea6a364de4c88efd8ec`.

No manual user work is required. Keep Docker Desktop available to view the isolated preview. Drafts are specific to their browser/origin, may be cleared by the browser, and do not sync to a future Space; export/import provides portability. Existing raw-listener re-extraction limitations remain unchanged. No new simulation, Parca run, upload or public deployment occurred. **HF-06 Done; HF-07 — production Docker image and Space upload bundle — Ready.**
