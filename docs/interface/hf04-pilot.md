# HF-04 isolated pilot

Completed on 28 October 2026. All three real pilot outcomes are recorded, the release validates, and the read-only preview passes browser verification. The completion evidence below supersedes earlier progress observations in this guide.

Subsequent retention change: [HF-05](hf05-full-campaign.md) reverified and backed up all three pilot artifacts, then removed their raw experiment directories under the user's new cleanup policy. The raw-retention figures below describe the HF-04 completion checkpoint; shared Parca preparation remains available.

From either the root or `interface/`:

```bash
./platform.sh pilot prepare
./platform.sh pilot status
./platform.sh pilot run
./platform.sh pilot preview
./platform.sh pilot stop
```

`prepare` observes host/Docker storage and existing container memory, freezes checked-in and uncommitted nonignored source into ignored `interface/.pilot/snapshot`, builds unique images from inspected immutable local simulation/backend dependency images, then starts the pilot runner and tools. No live source mounts, worker, queue consumer or Docker socket is used. It runs Parca once under a durable 90-minute wrapper, extracts the actual RNA/TU membership in the simulation environment, creates a dedicated catalog with that authoritative mapping, and checkpoints a reference snapshot. The receipt binds source, image IDs, campaign, preparation checksums, verified targets, catalog and settings. The HF-03 planner remains catalog-valid with `runtime_ready: false`; only the separate readiness receipt authorizes this pilot.

The local dependency images `wcecoli-sim:latest` and `interface-api` must exist. They are inspected/tagged as immutable build bases and never overwritten. The pilot's project is `wcecoli-hf-demo-v1`; volumes are `wcecoli-hf-demo-v1_database`, `_output` and `_release`. Frozen image IDs and resource observations are retained under `interface/.pilot/`; task logs/metrics live in the pilot output volume. The runner's Unix socket lives only inside that output volume. Preview binds localhost 8001 and 5175, failing before startup if either port is occupied.

`run` creates WT first using a transactionally unique (campaign fingerprint, experiment key, seed) submission identity. An interrupted command reuses its existing task/outcome and cannot resubmit a completed seed. Loss of runner state after submission fails closed for investigation. The simulation wrapper enforces the four-hour deadline and Docker storage stop threshold even if the host command disconnects. Host storage is also polled by the host controller. The existing runner drains boundedly on stop; Compose retains volumes. Status/stop remain usable while the execution command holds the submission lock.

Every pilot job explicitly sets `initial_condition` and forwards `--initial-condition` separately from its complete frozen timeline. Jobs without the opt-in parameter keep their previous behavior. Preparation is reused through a symlink to the verified shared KB. Scientific outcome classification uses real daughter-state files and lineage-termination records, never a mass-ratio division guess. OOMs, OS deadlines, cancellations and nonzero process exits remain execution errors.

The explorer exporter is independent of legacy v0. It preserves actual seed/generation paths, source dtypes, clocks, all saved rows and matrix columns. A missing listener is unavailable. Malformed data or mismatched clocks fails, rather than dropping rows. `Main.time` fallback requires both equal counts and identical simulation-step vectors. Every exported channel is independently reread and compared for exact values, time, identifiers, counts and units. The publication SQLite file is a fresh allowlisted reference/result projection; assistant tables, credentials, private paths and unrelated experiments never enter it. Reaction fluxes retain their actual native mmol/L/s units (the old reader labels them differently); exchange flux retains mmol/gDCW/h.

A pilot bundle explicitly declares `scope: pilot`. Default full-release validation rejects it; `--allow-pilot` permits a nonempty subset of the three reserved keys. Synthetic opt-in is independent and is never enabled by the real exporter or preview. Unrun campaign designs are derived as unrun, with explicit unavailable control results. Size includes all files and manifest bytes: target <5 GB, hard ceiling 10 GB, no automatic thinning.

The preview imports no normal app startup, migrations, ingestion or assistant/provider initialization. All write methods are rejected at the API boundary. Its React entry reuses the existing result chart and styling, with explicit generation identities and elapsed lineage time. Missing channels/views cannot produce synthetic curves. The first WT source/export/validation/browser proof must pass before `hisG-basal` and then `wt-add-aa` may run. Browser evidence is recorded locally against the actual WT shard checksum; the public preview has no mutation endpoint for granting readiness.

Final code, runtime and browser verification results are recorded in the completion evidence below.

Preparation succeeded in 499.56 seconds with observed peak process-group RSS 2.73 GiB. A serving-only source refresh is supported with `./platform.sh pilot prepare --refresh-source` before any experiment submission. It verifies the existing receipt/images, checks every simulation/preparation source file is unchanged, archives the prior frozen revision, rebuilds unique images and reissues readiness with the actual preparation origin. A changed model input or any submitted job rejects this operation. It never edits an existing frozen snapshot or reruns Parca silently.

Real-format adjustments: ReplicationData omits a clock and step column. The explorer exporter permits Main alignment only for the pinned, reviewed Disk logger, whose common copyData operation appends all tables together, and exact matching row counts. The actual initial growth-rate sample is NaN; it remains byte-for-byte in HDF5 with an explicit undefined-sample count/reason, becomes null in JSON, and is omitted only during chart rendering. Other nonfinite values remain errors. Source file inventories/checksums bind the actual raw output in addition to exact array comparisons.

If the first real-output proof reveals a serving-only issue, `./platform.sh pilot prepare --refresh-serving` builds new immutable tools/web images after execution is idle and jobs are terminal. It verifies unchanged simulation/preparation sources and retains the original runner, readiness receipt and completed jobs. Exporter source/image provenance is recorded separately from actual simulation and Parca provenance. Further experiments remain blocked until the first WT export/browser proof passes.

Serving revisions record their own source/image fingerprint; the simulation fingerprint always refers to the unchanged execution image. The original preparation-start marker supplies the actual Parca source/image/options rather than inferring them from a later serving revision.

The real browser test is separate from the mocked development E2E suite:

```bash
cd interface/frontend
npx playwright test --config playwright.pilot.config.ts
```

It expects the real Docker preview at localhost 5175, uses no route mocks, and records screenshot/sample-count evidence under `/tmp/wcecoli-hf04-browser`. A test listing alone is not a browser proof.

## Completion evidence — 28 October 2026

Preview: http://localhost:5175. Read-only API: http://localhost:8001. No simulations remain active; the original `interface` stack is still running.

| Experiment | Actual generation IDs | Outcome | Wall time | Observed peak process-group RSS | Retained raw bytes |
|---|---|---|---|---|---|
| wt-basal | 0, 1, 2, 3 | Four generations completed | 1,545.02 s | 941,690,880 bytes | 2,853,855,519 |
| hisG-basal | 0, 1, 2 | Final cell did not divide within 10,800 model seconds | 2,221.34 s | 887,222,272 bytes | 4,739,817,398 |
| wt-add-aa | 0, 1, 2, 3 | Four generations completed | 1,677.86 s | 997,662,720 bytes | 2,542,435,800 |

The hisG result contains two divisions and a final non-dividing generation, with the actual `TimeLimitReached` explanation retained. It is not an OS timeout or execution failure. The shift's first saved supplemented-medium observation is exactly 1,200 elapsed lineage seconds; every subsequent generation's environment was checked against the same uninterrupted schedule.

Final release: **353,250,229 bytes** (about 337 MiB), including the manifest. Eleven actual trajectories, all saved samples and all columns in the four matrix families. All **264 available channel/generation comparisons** match their source values, dtype bytes, identifiers, clocks and sample counts. Unsupported scalar/molecular channels remain explicitly unavailable. Undefined initial growth samples remain NaN in HDF5 and null in the API with their reason/count.

The final real-data Chromium suite passes **two tests**, including all three result selections, real mass/growth and molecule charts, target/co-target display, unavailable controls, and the verified shift. Screenshots were visually inspected. Independent API/artifact checks pass for **231 scalar and selected-protein series** across the three experiments. The API rejects writes, its root filesystem and release mount are read-only, and default publication validation rejects this pilot bundle unless `--allow-pilot` is supplied. No synthetic opt-in was used.

Code verification: **160 tests and 47 subtests passed**, TypeScript/Vite build passed, Ruff and diff whitespace checks passed. The normal frontend retains the existing bundle-size warning. The localhost preview restart exposed TIME_WAIT address reuse; the launcher now permits that normal reuse while still rejecting an active listener. The live occupied-port check passed without changing services.

The main stack still has the original four container identities and original simulation image. Its read-only counts remain eight experiments, seven jobs and seven results. The pilot database contains exactly three experiments, three jobs and three unique submissions. Parca ran once; all three experiments reused its verified KB.

Retained raw experiment directories total **10,136,108,717 bytes / 3,161 files**, plus the separate preparation cache/logs. None were pruned. Final observed free space after preserving the local release copy: **43.18 GiB host / 362.41 GiB Docker**. Docker VM: 7.65 GiB RAM, 11 CPUs. All agreed runner/preparation limits were retained; no VM settings were changed.

Local artifacts and evidence (ignored generated files):

- `interface/.pilot/release/`: validated publication catalog, HDF5 shards, manifest, metadata/QC and dataset card, copied byte-for-byte from the active release.
- `interface/.pilot/proofs/final/`: release report, source comparisons, API comparisons for each experiment, real-browser screenshots, test/build logs, resource observations and status/port checks.
- `interface/.pilot/readiness.json`, `frozen.json`, `serving.json`, `snapshot/` and retained `revisions/`: reproducible execution/serving identities and preparation history.
- Docker volumes `wcecoli-hf-demo-v1_database`, `_output`, `_release`: dedicated database, original outputs/prepared model and immutable release versions.

Serving source: `80df7fff3f466d1bb902d1515989b5d29579540263819be1e92aa6e653d30fc1`. Tools image: `sha256:6e55f8f02be447e7ebb7af85209a4e53233f4fdef67145101f2b16cec7344cb0`. Web image: `sha256:39ba3972968da45a040c5674cf4bdeb07f39de0e5fc592deda3589a0d236a90d`. Scientific execution source/runner and original Parca identities remain in the readiness receipt and release provenance.

Limitations and handoff: this is a local, explicitly partial pilot with one seed and sequential generations. hisG perturbs an eight-gene TU; it is not an isolated physical gene deletion. Nine campaign designs remain unrun, with unavailable control results labeled. HF-05 is ready for planning/implementation using the verified preparation/export path; its remaining-nine execution command and a fresh disk budget are still required. Do not prune these raw outputs automatically. HF-06 completes explorer screens/drafts, HF-07 builds the production Space image, and no Hugging Face repository/upload/deployment has occurred.
