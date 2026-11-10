# HF-05 full campaign and verified raw cleanup

Completed 28 October 2026. All twelve outcomes, verified raw cleanup, full publication and real HTTP/browser acceptance pass. HF-06 is ready; it has not been started. No Hugging Face upload or deployment has occurred.

This task completes `hf-demo-v1` using the existing isolated project, prepared model, frozen scientific image and three pilot jobs. The main `interface` platform is outside its scope. No upload or Hugging Face deployment occurs here.

## Commands

From the repository root or `interface/`, use `./platform.sh demo prepare|run|status|preview|stop`. `run` launches a detached local controller and returns immediately; its log is `interface/.pilot/demo-controller.log`. `status` reports the controller and each experiment's execution, checkpoint and cleanup state. `stop` requests no further work and uses the existing bounded runner drain/cancellation behavior.

`./platform.sh demo cleanup --dry-run [--key KEY]` reports eligible raw output without deleting or changing cleanup state. Without `--dry-run`, cleanup requires a verified checkpoint and matching host copy. Preparing an existing completed pilot performs the initial verified checkpoint/backup/cleanup of its three raw experiment directories.

## Preservation and cleanup policy

The user's HF-05 instruction supersedes HF-04's requirement to retain every pilot raw output. After a successful scientific outcome, the controller exports the complete scalar channels and all four matrix families, compares every source array/time/identifier/count, validates the shard and compares production API adapter responses. All scalar samples and up to three real IDs per matrix family are compared through the API adapter; source comparisons cover all matrix columns.

Immutable checkpoints live in the release volume under `checkpoints/KEY`, with an independently checksum-verified copy under `interface/.pilot/checkpoints/KEY`. Receipts bind the campaign, readiness, experiment/job, raw inventory, artifact checksums and comparison evidence. The controller acknowledges the local copy before deletion. A journal in the dedicated state volume distinguishes `cleanup_pending` from `raw_removed`. An interrupted deletion resumes against that journal, without re-extraction or a duplicate simulation.

Only the exact ledger-owned experiment directory is deleted. Top-level links, traversal, unknown paths, active execution, failed outcomes, changed raw inventories and missing backup proof are rejected. Nested links are unlinked, not followed. The shared `hf-demo-v1-prepared` directory, KB, readiness, authoritative mappings, isolated ledger and compact logs/provenance persist. Failed simulations, failed exports and incomplete checkpoints stop work and retain raw output for diagnosis. No Docker image/volume pruning occurs.

Deleting original listeners prevents arbitrary future extraction of additional channels. Existing exported samples and matrix columns remain intact; extraction requiring discarded source must be explicitly reviewed and may require rerunning that experiment.

## Execution and monitoring

Remaining order: `wt-with-aa`, `wt-acetate`, `wt-no-oxygen`, `hisG-with-aa`, `trpA-basal`, `trpA-with-aa`, `pgi-basal`, `pgi-acetate`, `wt-cut-aa`. Each uses seed 0 and requests four sequential generations. Valid no-division or biological termination can shorten a lineage; infrastructure failures never count as biological outcomes.

The existing Parca preparation is verified and reused. Prepared-model condition membership is checked inside the frozen simulation interpreter without rerunning Parca. Scientific sources/inputs, runner identity, target/co-target mappings, explicit initialization and elapsed-lineage schedules stay bound to readiness. Updated tooling uses separately frozen serving images.

Limits: one simulation, two CPU slots, 4 GiB runner memory, four-hour wall deadline, 25 GiB free in host and Docker storage before each submission, 15 GiB stop thresholds. Local completion checks run every 15 seconds and resource observations every five minutes; these are ordinary local code and invoke no model. Agent fallback checks are at least 30 minutes apart, with notification only for meaningful changes, failure, completion or required action. The controller proceeds without chat involvement and keeps durable progress records.

## Full release

Internal checkpoints do not change the public `full`/`pilot` contract. The validated pilot stayed active during generation; the validated `scope: full` release is now active. It contains a fresh allowlisted catalog, all twelve experiment/control relationships, metadata/QC, provenance, checksums and dataset card. Final structural and API-adapter comparisons run without raw data. Publication activation is atomic, and the byte-identical host upload bundle is `interface/.pilot/demo-release`.

Target below 5,000,000,000 bytes; hard ceiling 10,000,000,000 bytes including every release file and manifest. Never thin timesteps or columns. Parca, raw output, execution state and private logs are not upload payloads. Independent live API and browser verification passed for this release.

## Acceptance record

**184 tests and 47 subtests pass**. Ruff and diff whitespace checks pass. TypeScript/Vite build passes with its existing bundle-size warning. Synthetic fixtures remain explicitly opt-in and were not used for real acceptance. Tests include cleanup interruption/recovery, path/symlink protection, missing backup/corrupt source rejection, full assembly without raw, serving-only resume, single-flight cache loading and partial preview restart with occupied-port protection.

All twelve experiments use seed 0. Eleven completed four generations; `hisG-basal` retains its three actual generations, with the final cell reaching 10,800 model seconds without division. There are **47 actual trajectories**, no invented fourth hisG generation and no unresolved infrastructure failures.

| Experiment | Generations | Outcome | Simulation wall seconds |
|---|---:|---|---:|
| wt-basal | 4 | completed | 1545.02 |
| wt-with-aa | 4 | completed | 1512.76 |
| wt-acetate | 4 | completed | 1851.13 |
| wt-no-oxygen | 4 | completed | 2276.69 |
| hisG-basal | 3 | no_division | 2221.34 |
| hisG-with-aa | 4 | completed | 1429.76 |
| trpA-basal | 4 | completed | 2069.50 |
| trpA-with-aa | 4 | completed | 1665.55 |
| pgi-basal | 4 | completed | 2434.82 |
| pgi-acetate | 4 | completed | 2665.35 |
| wt-add-aa | 4 | completed | 1677.86 |
| wt-cut-aa | 4 | completed | 2530.68 |

Remaining-nine simulation wall time: **18,436.24 seconds (5 h 7 min 16 s)**. All twelve: **23,880.46 seconds (6 h 38 min)**, excluding Parca, validation, export and serving recovery. Largest observed simulation process-group RSS: **1,030,586,368 bytes** (about 983 MiB). Parca ran once in HF-04 (499.56 seconds); it was reused throughout HF-05. Readiness remains `713cea9bc33f7e75f5eed57e0cf24b64726d2250ccef2ea6a364de4c88efd8ec`.

Exact source checks cover **1,128 channel/generation pairs**, all saved rows and matrix columns. Production adapter checks cover **1,504 series**. Independent live HTTP checks against the separate host HDF5 copy pass **48 experiment/family checks and 3,948 series comparisons**; scalar comparisons repeat across the four family checks. Both shifts have their first changed-medium observation at exactly **1,200 elapsed lineage seconds**, with continuity checked in every generation.

The final real Chromium run passes **two tests**: the full twelve-experiment/four-matrix-family test and the WT scientific-chart test. The earlier test requiring exactly three pilot results is deliberately skipped for a full release. No scientific route mocks or synthetic data were used. Screenshots were visually inspected. Controls are available, generation identities are retained, API writes return 405 and no assistant requests/page errors occur.

Publication: **1,277,795,259 bytes** (1.28 GB / 1.19 GiB), 17 files including the manifest, `scope: full`, strict validation with neither pilot nor synthetic opt-in. Immutable volume directory: `full-c85e170d95082914cfa8`. Host upload bundle: `interface/.pilot/demo-release/`. Manifest SHA-256: `948c756a6b61230823653ffa7bf3261e3fb38a30ce460a229d5d6a1b629fab84`. WT shard remains byte-identical to its original browser proof (`0c3cff40d8a6533e5228f3c088b1e46ea7383158ac1809d40e4d59d25b6b66f1`).

The cleanup journal and filesystem checks confirm **36,435,501,779 raw bytes / 13,502 files removed** across all twelve experiment directories. Timing evidence confirms no simulation overlap and cleanup before each following submission. Shared Parca, compact logs/state and independently verified checkpoint copies remain. Final observed free storage: **46.17 GiB host / 370.22 GiB Docker**. No image/volume pruning or VM-setting changes occurred.

An intermediate serving failure was resolved: concurrent publication-cache misses caused duplicate full-bundle validation and a preview OOM at 512 MiB. A single-flight lock, a longer readiness probe and safe restart of a stopped API fixed it. Serving-only refresh/resume kept the actual scientific/exporter provenance and exact existing publication; no simulation or Parca reran. Final preview peak cgroup memory after live API and browser checks: **390,311,936 bytes (372.2 MiB)**, below the unchanged 512 MiB cap. Final API root/release mount are read-only; runner remains 2 CPUs / 4 GiB and idle.

The original platform has the same four container/image identities, same volume mounts and original simulation image. Its experiment/job/result counts remain **8 / 7 / 7**, with the exact baseline data fingerprint unchanged. The isolated ledger has exactly twelve completed seed-0 submissions and no active/queued simulations.

Evidence under `interface/.pilot/proofs/hf05/` includes the consolidated `acceptance.json`, `tests-final.log`, `local-full-validation.json`, `campaign-measurements.json`, `live-http/summary.json`, `browser-final/`, `main-final.json`, `final-isolation-cleanup.json`, `final-serving-resources.json` and `sequential-cleanup-proof.json`. The controller's `demo-completion.json` records the completed unchanged release. The 30-minute follow-up was deleted after acceptance; no further experiment monitoring remains active.

Preview: http://localhost:5175. API: http://localhost:8001. HF-06 is ready for planning/implementation; the broader explorer restrictions/drafts and production Space image remain future tasks. Raw-listener re-extraction may require an explicit rerun. The current data is a single-seed model campaign, not independent replicated biological evidence.
