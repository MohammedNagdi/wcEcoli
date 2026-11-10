# Hugging Face deployment task catalog

Last updated: 30 October 2026.

This is the working record for deployment preparation, implementation, publication and verification. Update it at the end of each working session. The research note is background; this catalog records the current decisions and actual progress.

## Agreed outcome

- Preserve the full local simulation platform.
- Deploy a separate public explorer using the existing React frontend and a restricted FastAPI backend in one Docker Space.
- Visitors can explore published results and design experiments, but cannot execute experiments or change shared data.
- Personal drafts stay in the browser and support JSON download/import. The public explorer excludes the assistant and live ML training.
- Generate a new demonstration campaign locally: twelve distinct experiment designs, one seed each, up to four sequential generations. Do not describe generations as independent replicates.
- Package a small metadata database plus compressed trajectory artifacts in a separate Hugging Face Dataset repository. Target under 5 GB; enforce a 10 GB total release limit. There is no minimum size. Preserve all saved timesteps and molecule columns; stop packaging above the hard limit rather than automatically thinning data.
- Pin the application to a validated dataset revision. Verify the deployed application, restart behavior and data accuracy before declaring completion.

## How progress is recorded

Statuses: **Done**, **Ready**, **Planned**, **In progress**, **Blocked**. Ready means the next task is specified, not that its changes have been made.

Every implementation update must record: task IDs, changes, checks and results, remaining issues, next task, and any action the user must take. A task becomes Done only when its acceptance checks pass; distinguish existing baseline failures from regressions introduced by the task. Never count a proposed command as an executed check.

Record code/dataset revisions when they exist. Keep tokens, credentials and personal conversations out of this file. Track plan changes here before implementing a materially different approach.

## Roadmap and responsibilities

| ID | Task | Status | Owner | Depends on | Expected result / completion evidence |
|---|---|---|---|---|---|
| HF-00 | Research architecture and agree public scope | Done | Codex + user | — | Repository inspection, official platform research and recorded scope decisions |
| HF-01 | Clean up interface organization and deployment exclusions | Done | Codex | HF-00 | File disposition inventory; archived historical docs; working links; unchanged application behavior; verification record |
| HF-02 | Standardize Compose entry points | Done | Codex | HF-01 | Startup works from root and interface; existing project/volumes preserved; explorer command reserved until HF-07 |
| HF-03 | Define demo campaign and serving artifact contract | Done | Codex | HF-02 | Explicit twelve-design campaign; validation/dry run; metadata, channel, checksum and size contracts |
| HF-04 | Generate pilot and prove one real result can be served | Done | Codex; user keeps local Docker available | HF-03 | Pilot source-to-export-to-chart comparison; measured resources and size; no synthetic scientific fallback |
| HF-05 | Complete and validate demo release | Done | Codex | HF-04 | Twelve outcomes / 47 trajectories; 1.28 GB full release; real API/browser checks; 36.44 GB verified raw cleanup |
| HF-06 | Complete explorer restrictions and browser drafts | Done | Codex | HF-03, HF-04, HF-05 | Read-only public API; correct artifact reads; draft import/export; execution/shared writes unavailable; local mode preserved |
| HF-07 | Build production Docker image and Space upload bundle | Done | Codex | HF-05, HF-06 | One web container; production build; port 7860; clean upload inventory; reproducible local smoke checks; runnable explorer startup |
| HF-08 | Publish dataset and staging Space | Done | Codex; user supplies account access/choices | HF-07 | Local handoff ready; upload gated on rights/account/repository/access prerequisites; then URLs, pinned commit and remote startup |
| HF-09 | Verify hosted behavior and complete public release | Ready | Codex + user | HF-08 | Remote verification matrix, restart check, resource observations, revision record, user browser walkthrough and rollback instructions |

HF-04 can include the minimum explorer/artifact-reader work needed for a vertical slice. HF-06 completes the remaining screens and restrictions. No simulation or hosting operation is part of HF-01.

## HF-01: first-step plan and completion

Completed: [cleanup record](interface/hf01-cleanup.md), [file inventory](interface/hf01-file-inventory.tsv). All HF-01 subtasks are complete; the original plan below is retained for traceability.

### Purpose and boundary

Make the interface directory easier to maintain and make deployment contents explicit. This step changes organization and documentation, not the product design, database, simulation behavior, dependency versions or Compose topology. The existing application should look and behave as it did before cleanup.

### Subtasks

| ID | Work | Status | Expected output |
|---|---|---|---|
| HF-01.1 | Inspect tracked/untracked files, current changes and likely documentation/assets | Done | Initial audit recorded below; not a complete deletion/duplication audit |
| HF-01.2 | Record a verification baseline and classify candidates by actual references | Done | Build/test results and a path-by-path keep/archive/exclude/delete inventory |
| HF-01.3 | Consolidate historical documentation and repair references | Done | Moves recorded with original/destination paths; maintained docs remain discoverable |
| HF-01.4 | Tighten appropriate ignore rules and describe deployment exclusions | Done | Separate treatment of Git ignores and Docker build context; no accidental license/asset exclusion |
| HF-01.5 | Remove only demonstrated redundant tracked material, if any | Done | Evidence and reason for each deletion; no deletion required if nothing qualifies |
| HF-01.6 | Verify cleanup and update catalog | Done | Build/test/link checks, final diff review, disposition list and next task |

### File disposition rules

| Category / current examples | Planned treatment |
|---|---|
| `interface/README.md` | Keep as the interface entry point; consolidate stale/duplicated instructions and link to maintained supporting docs |
| Component READMEs, including dataset export and evaluation READMEs | Keep; different purposes do not make them duplicates |
| Root-level historical reports such as `assistant-refresh-report.md`, `batch-designer-report.md`, `environment-builder-report.md`, `experiment-designer-report.md`, `genome-design-report.md`, `result-detail-report.md`, `results-browser-report.md` | Archive under `docs/interface/archive/reports/`, preserving filenames and updating references; inspect all matching reports before moving |
| `interface/design-references/` | Archive as a tree under `docs/interface/design-references/` after checking consumers; preserve internal paths and repair external references |
| `interface/LOCAL_MODELS.md` | Retain local-platform instructions; relocate to `docs/interface/local-models.md` and link from the interface README |
| Active component documentation under `interface/frontend/docs/` | Keep near its component where it records current behavior; do not move solely because it is Markdown |
| `interface/frontend/public/previews/` and preview-generation tools | Keep referenced assets and source tools; responsive sizes and theme variants are intentional |
| License files and third-party notices, including `assistant-rendering-notices.txt` | Preserve; do not classify attribution as clutter |
| Tests, fixtures, package lockfile and runtime reference data | Keep unless an evidence-backed consumer audit proves a specific file redundant |
| Dependencies, caches, generated DBs, simulation output, QA screenshots and generated evaluation output | Exclude from deployment; ignore generated files appropriately; do not erase local scientific output or personal working files |
| Existing modified/untracked frontend and design work | Preserve; record before touching overlapping paths; untracked does not mean disposable |

Before each move/deletion, search code, scripts, Markdown, HTML and configuration for both path and basename references. Preserve directory structure where relative links matter. Git ignore rules do not remove tracked files; Docker exclusions do not change Git tracking. Keep these separate in the inventory.

The first step describes the deployment exclusion categories; HF-07 implements and validates the final Space upload allowlist once the image's runtime inputs are settled.

### Baseline and verification

1. Capture the existing changed/untracked path list and protect that work. Inspect overlapping diffs instead of resetting, stashing or overwriting them.
2. Run the frontend production build using the locked dependencies. Record pre-existing failures separately before any cleanup edits.
3. Run the existing fresh-clone/backend smoke check in an isolated temporary database/output environment, never against the user's working DB. Record unavailable dependencies explicitly.
4. Record a baseline for representative existing pages: home, explorer, designer and results. Use existing test infrastructure where available; do not regenerate checked-in snapshots as part of cleanup.
5. After cleanup, rerun the relevant checks, verify links and referenced assets, and review the diff for unintended source or data changes.

Acceptance: no new build/test failures, no broken maintained links or asset paths, no loss of working files or scientific data, no runtime feature changes, and a reviewed list of every archived/deleted path. If a baseline check is unavailable, record the limitation; do not claim that check passed.

### What the user needs to do for HF-01

No manual file cleanup, code editing, credential setup, Docker operation or dataset upload is required from the user. Codex handles the inventory, proposed moves, reference repair and verification when cleanup implementation begins.

If another editor/chat is changing the same files during implementation, coordinate those edits to avoid overlap. The current uncommitted work can remain in place. A brief user look at the unchanged website after cleanup is helpful but not a substitute for automated verification.

### What the user should expect after HF-01

- A less cluttered interface directory and a clear documentation entry point.
- Historical reports remain accessible in the documentation tree.
- Existing screens and local workflows remain unchanged.
- A concise completion report naming what moved, what was removed (if anything), which checks passed, and any known failures.
- This catalog updated with evidence and HF-02 identified as the next task.

## HF-02: consistent Compose entry points

Completed: [startup guide and verification record](interface/hf02-startup.md).

The default remains the full local platform. Preserve project `interface`, volumes `interface_api-db` and `interface_sim-output`, service names, ports and resource defaults. Runnable explorer startup belongs to HF-07; HF-02 only reserves the command with a clear error.

| ID | Work | Status | Evidence |
|---|---|---|---|
| HF-02.1 | Capture resolved current configuration | Done | Sanitized baseline fixture, with repository-relative placeholders and empty API credentials |
| HF-02.2 | Root include and canonical project identity | Done | Root, interface and launcher match the sanitized baseline |
| HF-02.3 | Shared path-aware launchers | Done | Path, quoting, exit-code and signal contracts pass |
| HF-02.4 | Canonical environment loading and example | Done | Optional file, shell and custom-project checks pass |
| HF-02.5 | Worker compatibility and reserved explorer command | Done | Capacity, validation, dry-run and no-launch checks pass |

Implementation and validation: Codex. User action: none for configuration/contract checks; Docker Desktop is needed only for daemon inspection or live runtime checks. No worker startup, simulation, volume deletion or data migration is part of verification.

## HF-03: demo campaign and serving-data contract

Completed: [campaign, contract and validation guide](interface/hf03-campaign-and-contract.md). No experiments were created, jobs enqueued, simulations run, working databases migrated or artifacts uploaded.

| ID | Work | Status | Evidence |
|---|---|---|---|
| HF-03.1 | Lock the versioned twelve-design campaign and pilot | Done | Checked-in `hf-demo-v1.json`; seed 0; up to four generations; shared controls; scientific questions and measurements |
| HF-03.2 | Add read-only planning and deterministic fingerprints | Done | Current temporary reference catalog resolves all 12 jobs / at most 48 trajectories; directory/input hashes unchanged; runtime readiness remains false |
| HF-03.3 | Define independently versioned serving artifacts | Done | Strict campaign/release models, sanitized catalog mapping, independent HDF5 shards, metadata/QC, source clocks/counts, units and checksum/size rules |
| HF-03.4 | Verify planner, contract and legacy compatibility | Done | All 83 campaign/export tests pass; new-code Ruff checks pass; working DB and existing source fingerprints preserved |
| HF-03.5 | Document limitations and pilot prerequisites | Done | HF-04 requires actual model-target/co-target verification, initial-condition binding and isolated demo execution before generation |

Fidelity decision: preserve all saved timesteps and molecule columns. Target below 5 GB; enforce a 10 GB complete-release ceiling including manifest bytes. Oversized bundles fail rather than being automatically thinned. This supersedes any earlier suggestion of automatic temporal subsampling.

The planner rejects stale schemas and uncheckpointed catalogs without upgrading them. The older local file DB lacks a required media-recipes table and was left untouched. Successful real-reference validation used a freshly ingested temporary catalog, not the working stack. Synthetic bundle fixtures are temporary, explicitly labeled and rejected by the release validator unless test opt-in is supplied.

A successful plan is **catalog-valid**, not **runtime-ready**. Actual transcription-unit targets/co-targets remain unknown until the prepared model is inspected. Production export, source-value comparisons and the read/serving adapter remain HF-04/HF-05 work. The publication catalog is a sanitized schema and must not enter normal application migrations.

User action: none for HF-03. HF-04 will need local Docker availability and an awake computer, after its own execution plan is established.

## User actions in later stages

| When | User responsibility | Codex responsibility |
|---|---|---|
| Before local pilot | Have Docker Desktop running; keep the computer awake with enough disk space while simulations run | Check capacity, prepare exact commands, run/monitor where tool access permits, measure pilot and avoid duplicate submissions |
| If host access is restricted | Run a specific command only when Codex cannot access the required local service | Explain the actual restriction and provide the smallest necessary command and expected output |
| Before publication | Choose HF account/organization and repository names, public visibility, and confirm the demo results may be published | Prepare tested artifacts, validate account/deployment requirements and publish through available authorized tooling |
| Authentication/billing if needed | Sign in through the normal account flow and handle account billing choices; never paste tokens into this catalog | Use configured access and keep credentials out of code, logs and browser bundles |
| Before release completion | Open the hosted URL in the user's own browser and try results, designer and draft export/import | Perform technical remote checks, investigate issues and record release/rollback details |

No account setup or payment is needed for HF-01. Verify current HF account requirements when publication approaches rather than treating earlier research as permanent policy.

## Evidence and working history

| Date | Task | What actually happened | Verification / limitations | Next |
|---|---|---|---|---|
| 2026-10-27 | HF-00 | Inspected architecture, export/read paths and official HF options; agreed explorer scope | Research note exists; no Docker build, simulations or deployment performed | HF-01 planning |
| 2026-10-27 | HF-01.1 | Rechecked working changes and inventoried 292 tracked interface files; found maintained docs, historical reports, referenced previews and attribution notices | Read-only inventory/reference searches; not proof that any candidate file is safe to delete | HF-01.2 |
| 2026-10-27 | Planning | Created this catalog and first-step plan; incorporated fresh experiments, single seed, retained local platform, browser drafts and no public assistant | Only planning documentation changed in this session; cleanup not implemented | HF-01.2 when implementation is requested |
| 2026-10-27 | HF-01.2–HF-01.6 | Archived 44 files including ten reports and the local-model guide; added documentation index, file inventory and generated-file exclusions; deleted nothing | Frontend build and 71 DB/API checks passed before/after; six Chromium checks passed before/after; 82 build outputs byte-identical; working DB/source fingerprints preserved; see [record](interface/hf01-cleanup.md) | HF-02 ready |

| 2026-10-27 | HF-02.1–HF-02.5 | Added root Compose include, shared launchers and commented env example; preserved worker helper and default project/volumes; reserved explorer startup for HF-07 | All 12 contract tests passed; live read-only checks found the same four running containers and both volumes; API healthy and frontend HTTP 200; no service or data changes | HF-03 ready |

| 2026-10-27 | HF-03.1–HF-03.5 | Added twelve-design campaign manifest, pure read-only planner and explorer release models/validator; no runtime/core exporter behavior changed | All 83 campaign/export tests pass; lint passes; real-reference temporary dry run yields 12 jobs / at most 48 trajectories with no errors; input and working DB hashes preserved | HF-04 ready with required preflight gates |

Earlier environment observation: Compose v2.40 was installed, but the agent's Docker daemon query was denied by the execution sandbox. This did not establish that Docker Desktop was stopped. Recheck authorized service access before runtime tasks; it does not block documentation cleanup planning.

## Release record

- Application revision: no new Git commit; frozen scientific/serving revisions remain recorded in HF-04–HF-06. Final HF-07 source fingerprint `3263273270e2fea67c9f11625347c4d664bd5a2bd82a265124956829e3d2aba5`; image identities and reproducible package inventory are in the HF-07 guide and local receipts.
- Dataset repository / pinned commit: not created.
- Dataset byte size / QC result: HF-05 data release **1,277,795,259 bytes**, preserved; HF-06 serving successor **1,280,813,520 bytes** with optional references. All 12 scientific shards and 47 trajectories are unchanged; strict validation and real API/browser checks pass.
- Space repository / URL: not created.
- Hosted verification / user walkthrough: not performed.
- Current next task: **HF-09 — hosted restart/cache/resource verification and release decisions**, ready but not started. HF-08 private staging is published and verified; public access remains disabled.
- HF-03 user action: none required.
- HF-03 verification: 83 campaign/export tests and new-code lint passed; successful real-reference dry run remains explicitly not runtime-ready.
- HF-04 prerequisites: completed and verified; model-target mappings, explicit initialization, isolation and genuine clocks/counts recorded in the readiness receipt and pilot guide.
- HF-02 user action: none required.
- HF-02 verification: 12 contract tests plus read-only inspection of the existing stack passed; no fresh image build or container restart was performed.
- HF-01 user action: none required; optional website walkthrough.
- HF-01 known limitations: existing startup/test-harness signal handling and Vite bundle-size warning documented in the cleanup record; no Docker image or remote deployment was tested.

Background: [deployment research](huggingface-spaces-deployment-research.md). Later decisions in this catalog supersede the initial research note's assumptions about reusing existing results.

## HF-04: isolated pilot (completed 28 October 2026)

| ID | Work | Status | Evidence |
|---|---|---|---|
| HF-04.1 | Frozen images, isolated orchestration and resource gates | Done | Existing interface stack inspected read-only: about 710 MiB combined; VM 7.65 GiB / 11 CPUs. Docker storage probe reports 374 GiB free; host gate is separate. |
| HF-04.2 | Parca, authoritative mapping, dedicated catalog and readiness receipt | Done | Reissued receipt after explicit backup checkpoint/close; original Parca reused; all model inputs verified unchanged |
| HF-04.3 | Opt-in initial-condition binding | Done | Worker forwards the opt-in flag; initial/daughter support and unchanged legacy defaults verified |
| HF-04.4 | Sequential WT-first execution and measurements | Done | Three unique seed-0 jobs executed sequentially; 4/3/4 actual generations and complete resource measurements recorded |
| HF-04.5 | Genuine-clock extractor and independent source comparison | Done | All 264 available channel/generation comparisons pass; actual clocks, samples, columns, NaNs and raw output retained; legacy v0 separate |
| HF-04.6 | Explicit pilot release scope | Done | Default full validation stays strict |
| HF-04.7 | Read-only preview and real browser proof | Done | Localhost 8001 / 5175; two real-browser tests, visual inspection and 231 API/artifact series comparisons pass |

Limits: runner 2 CPUs / 4 GiB, Parca 2 CPUs / 90 minutes, simulations sequential / 4 hours each. Start requires 25 GiB free in both storage domains; stop further submissions below 15 GiB. Preserve main project, images, queue, database, output and all pilot raw output. Infrastructure failures are unresolved work. User action: keep Docker Desktop and computer awake.

HF-04 implementation refinement: when only controller/export/preview code changes during model preparation, preserve the original frozen revision and preparation image identity. A new frozen revision may reuse the verified KB only after checking that every simulation/preparation source file is identical and that no experiment has been submitted. Issue a new receipt binding the updated images and the actual preparation origin; never edit an existing frozen snapshot or continue on a stale receipt. This avoids repeating Parca for serving-only fixes while preserving provenance.

HF-04 measured preparation: Parca completed successfully in 499.56 s, observed peak process-group RSS 2,929,733,632 bytes (2.73 GiB), no OOM. Start host free: 55.79 GiB; Docker free: 374.01 GiB. All preparation files checksummed; all twelve designs resolve against the authoritative fresh catalog. Verified targets: hisG index 1676, TU0-198747[c], genes hisA/hisB/hisC/hisD/hisF/hisG/hisH/hisI; trpA index 2940, TU3[c], genes trpA/trpB/trpC; pgi index 1984, TU0-45260[c], pgi only. These are actual model mappings for this frozen preparation, not portable hard-coded constants. Fitting warnings remain in the original log for review.

HF-04 checks so far: 111 campaign/export/launcher tests plus 30 launcher subtests pass; 42 existing runtime/lineage tests plus 17 subtests pass with repository reference paths configured. Frontend TypeScript/Vite build passes (existing bundle-size warning). No simulation experiment has yet been submitted.

HF-04 serving-refresh verification caught a nonempty WAL on the newly backed-up reference database. The read-only planner refused it; no experiment was submitted. Corrective change: explicitly checkpoint the backup, switch the publication reference to DELETE journaling and close its connection before planning. Recovery rechecks the retained KB against the original verified receipt and requires zero submissions, then builds a fresh immutable serving revision and repeats target/catalog verification. Parca is not rerun.

HF-04 active execution source: `69e915e6f7ac3f5cfd5720af9334591d15521bf1b4bb1e105d06f568e7e63bad`; readiness receipt: `713cea9bc33f7e75f5eed57e0cf24b64726d2250ccef2ea6a364de4c88efd8ec`. Runner image `sha256:c50180e5e7480933feb964ca4860888d61bd677ddd653d0ba37e11e80da2e96a`; tools `sha256:76b4d3d1ac05f7a3dfe93bb1b781898151ad1b2b63715759eee18572775b9811`; web `sha256:60b275d91be4905d5437b38e738b18dd8d39d5e0c8a43ca59d5aa4f42a57aafb`. Original Parca ran from source `97a13647dce262ebe11db703e6d7938e71657dade4bfac4869712ec332c458bd`, runner image `sha256:53ca6c9f2d3feb6832ba0afc10a1e92d360314072cfd9ebb26f3ed4650a8f1d4`. Retained frozen revision chain records serving-only verification/rebuilds; the original preparation-start marker is the authoritative record of the actual Parca invocation. The intermediate `preparation_origin` is transitive through revision f019fbfa823d9eba, not a second Parca run.

HF-04 isolation recheck: original interface container IDs remain eeaefbb82758 / 4b6a8685d2d0 / d6daac3f5a16 / 71114e513a6b, all running with the API/runner healthy. Original `wcecoli-sim:latest` remains `sha256:0984b03f01484f212996eda93f6c5764b4a75327f11717aa00b9e1fa4ca512f3`. Read-only working-stack counts: eight experiments, seven jobs, seven results. No pilot submission targets that database/socket.

HF-04 source inspection caught a real-format clock gap: ReplicationData has neither time nor simulationStep. The verified alignment now pins the exact frozen Disk logger source, whose copyData writes Main and every state/listener together at the same cadence, and additionally requires exact row-count equality. An altered logger, mismatched step vectors or mismatched counts fails. No row-number fallback is allowed. Serving/export-only image revisions may be built after completed pilot execution without changing the frozen runner, execution receipt or model: require an idle runner, terminal pilot jobs and identical simulation/preparation source; retain both source/image identities and record exporter provenance separately. No new simulation may bypass the WT export/browser gate.

HF-04 source-fidelity finding: the actual initial growth-rate sample is NaN at lineage time 0, before the first simulation step. Preserve that source value and timestamp. Extend channel availability with an undefined-sample count and explicit reason; allow only a single initial NaN for growth_rate, reject infinities and any other nonfinite sample. Independent comparison checks value bytes (including NaN encoding), not a replacement number. JSON represents the undefined value as null with its reason; charts omit only undefined values for rendering, while artifacts/API keep every source timestep. This replaces the validator's over-strict all-values-finite assumption without relaxing clock validation.

HF-04 WT proof passed: four actual generations (0–3), seed 0, saved clocks 0–2529 / 2530–5413 / 5414–8232 / 8233–10978 seconds; 2,530 / 2,884 / 2,819 / 2,746 saved rows. Wrapper wall time 1,545.02 s, observed peak process-group RSS 941,690,880 bytes; retained raw output 2,853,855,519 bytes / 1,149 files. Validated WT bundle 106,704,772 total bytes (~102 MiB), with 25-channel availability and all four molecular families, genuine clocks, source dtype/value byte comparisons, IDs, counts, checksums and sanitized catalog. All samples and molecule columns retained. Initial undefined growth-rate values remain in HDF5 with explicit metadata.

WT real Chromium proof passed (one test, no route mocks), including actual mass/growth charts, a selected protein series, generation identities, no assistant requests, no page errors and API write rejection. Screenshot visually inspected. Independent API/HDF5 comparison passed for all scalar samples and the selected protein across every generation. Preview: http://localhost:5175; API: http://localhost:8001. Scientific WT artifact SHA-256: `0c3cff40d8a6533e5228f3c088b1e46ea7383158ac1809d40e4d59d25b6b66f1`. Failed pre-publication drafts retained separately; they were never activated. Serving-only source `23a93e639007cbddbf30cdedda71b1074667bdb9f7f99a51499b4ac28fc3c4e8`; original frozen runner and execution receipt unchanged.

Next: run hisG-basal, then wt-add-aa sequentially under the same verified preparation, with source comparison and release validation after each outcome. HF-04 remains In progress; HF-05 remains Planned until all three outcomes and final measurements are recorded.

User requested wider monitoring intervals to conserve quota during the remaining two experiments. Assistant status inspections are spaced to approximately five minutes, with milestone/problem updates. Future host-controller task checks use five-minute intervals; the in-container wrapper still checks its deadline and Docker storage every second. The already running controller retains its original internal polling until it exits; those local checks do not invoke the assistant.

## HF-04 completion — 28 October 2026

Completed: [pilot guide, measured resource report and handoff](interface/hf04-pilot.md). All three reserved experiments were executed sequentially with the same verified model; no main-platform jobs or data were changed. The final report supersedes earlier in-progress notes above.

- `wt-basal`: generations 0–3 completed, 1,545.02 seconds wall time.
- `hisG-basal`: generations 0–2 saved; final generation reached 10,800 model seconds without division, 2,221.34 seconds wall time. Actual no-division reason retained; no invented fourth generation or infrastructure-to-biology relabeling.
- `wt-add-aa`: generations 0–3 completed, 1,677.86 seconds wall time. Actual event observed at exactly 1,200 lineage seconds; no schedule reset after division.
- Final release: 353,250,229 bytes (~337 MiB); default publication validation rejects pilot scope, explicit pilot validation passes with no synthetic opt-in. All source samples and matrix columns retained.
- Verification: 264 source channel/generation comparisons, 231 API/artifact series comparisons, two real-browser tests with visually inspected screenshots, 160 code tests plus 47 subtests, frontend build, lint and diff checks passed. API/root filesystem/release mount read-only; occupied-port guard verified. Unrun controls and unsupported views stay unavailable.
- Resources: preparation 499.56 seconds / observed peak RSS 2.73 GiB; simulations each below 1 GiB observed peak RSS and below their four-hour wall limit. Original raw directories retained (10,136,108,717 bytes, 3,161 files). Final free space 43.18 GiB host / 362.41 GiB Docker; no pruning or Docker Desktop changes.
- Isolation: original main container IDs/image unchanged; working DB read-only counts remain 8 experiments / 7 jobs / 7 results. Pilot has exactly 3 experiments / 3 jobs / 3 unique submissions. Separate volumes/socket and immutable images remain in place.
- Artifacts: local release `interface/.pilot/release/`; persistent proof/resource records `interface/.pilot/proofs/final/`; active preview http://localhost:5175 and API http://localhost:8001.

Changed areas: `interface/platform.sh`; new `interface/pilot/` orchestration/Compose/Dockerfiles; bounded runner and model-target extraction scripts; opt-in worker initialization; explorer exporter/contract/preview and tests; isolated React preview reusing existing result charts; dedicated real-browser config/tests and independent API verifier; generated-file exclusions; this catalog and HF-04 guide. Existing unrelated source/frontend work was preserved.

The usage-limit interruption occurred after simulations and artifact validation. Resumption restored only the preview, completed final verification and preserved the same scientific results. The localhost restart guard was corrected for TIME_WAIT reuse and tested against an active listener. No simulation rerun was needed.

**HF-04 Done. HF-05 Ready.** HF-05 must implement the remaining-nine execution path and refresh the disk budget before generating additional data. Preserve the existing preparation, source-to-artifact checks, one-seed design, actual generations and <5 GB target / 10 GB hard release limit. No Hugging Face account action is required yet; nothing has been uploaded or publicly deployed.

## HF-05: full campaign and verified raw cleanup (completed 28 October 2026)

Implementation guide: [full campaign and cleanup](interface/hf05-full-campaign.md).

| Subtask | Work | Status | Evidence / next gate |
|---|---|---|---|
| HF-05.1 | Durable full-campaign controller; infrequent agent checks | Done | Detached controller complete; shared project/runner preserved; 30-minute follow-up deleted after acceptance |
| HF-05.2 | Immutable per-experiment checkpoints and verified host copies | Done | Three real pilot checkpoints: 264 source-channel and 352 API-series comparisons, matching independent host copies |
| HF-05.3 | Journaled raw cleanup after verification | Done | 36,435,501,779 bytes / 13,502 files removed after verification and backup; preparation intact; timing/isolation evidence passes |
| HF-05.4 | Nine sequential seed-0 experiments with reused Parca | Done | All nine completed four generations; all twelve outcomes / 47 trajectories; no extra seeds, Parca reruns or overlapping simulations |
| HF-05.5 | Full release, real API/browser verification and resource report | Done | 1,277,795,259-byte strict full release; 48 live HTTP checks / 3,948 comparisons; full browser proof and measured resources |

User-authorized policy change: HF-05 supersedes HF-04 raw retention for successfully verified experiments. Remove their original listener/output directories after an exact source comparison, valid shard/API checks, verified second copy and durable cleanup journal. Retain shared Parca and compact provenance/state/logs. Failed simulation/export output stays until diagnosed. Additional extraction from removed raw may require an explicit rerun. No thinning, Docker pruning or changes to the original platform.

Monitoring is local code, not repeated model calls. Completion checks and resource guards stay active; agent fallback checks are at least 30 minutes apart. Notify only on meaningful change, failure, completion or user action. No new simulation has been submitted as of the initial implementation record.

Initial implementation record (superseded by completion below): 181 tests / 47 subtests and two real pilot-browser checks passed after initial raw cleanup; the detached controller and 30-minute follow-up were launched. Baseline main-platform data fingerprint/container identities were saved in `interface/.pilot/proofs/hf05/main-baseline.json`.

### HF-05 completion — 28 October 2026

Completed [full campaign, cleanup and resource report](interface/hf05-full-campaign.md). The original three outcomes plus nine new four-generation results account for all twelve unique seed-0 designs. `hisG-basal` retains its three-generation no-division outcome, giving 47 actual trajectories. Both medium shifts are observed at exactly 1,200 lineage seconds.

- Full release: **1,277,795,259 bytes**, 17 files, strict `scope: full`, no synthetic/pilot opt-in; upload bundle `interface/.pilot/demo-release/`. Manifest SHA-256 `948c756a6b61230823653ffa7bf3261e3fb38a30ce460a229d5d6a1b629fab84`.
- Source verification: **1,128 channel/generation pairs**, all saved samples/columns. Adapter proof: **1,504 series**. Independent live HTTP: **48 checks / 3,948 comparisons**. Two real Chromium tests pass, including all twelve results and all four molecular families; the three-result-only pilot test is intentionally skipped. Screenshots inspected.
- Code: **184 tests / 47 subtests pass**, Ruff/diff checks pass, production frontend build passes with its existing size warning.
- Raw cleanup: **36,435,501,779 bytes / 13,502 files removed**, both artifact copies and shared Parca retained. No simulation overlap; cleanup precedes each next submission. Parca ran once in HF-04 and never reran here.
- Runtime: remaining nine **5 h 7 min 16 s**; all twelve **6 h 38 min**, excluding Parca/export/verification. Largest observed simulation process-group RSS about **983 MiB**. Final free storage **46.17 GiB host / 370.22 GiB Docker**.
- Serving recovery: preview publication-cache misses originally triggered duplicate validation and OOM. Single-flight loading and restart/readiness fixes resolved it without changing scientific source, artifacts or the 512 MiB API cap. Final measured preview peak **372.2 MiB**. No unresolved infrastructure failure remains.
- Original platform: same container/image identities, mounts and simulation image; counts **8 / 7 / 7** and baseline data fingerprint unchanged. Isolated ledger: exactly twelve submissions; runner idle. Final evidence is in `interface/.pilot/proofs/hf05/`.

Preview: http://localhost:5175; API: http://localhost:8001. Controller state is complete; consolidated proof is `interface/.pilot/proofs/hf05/acceptance.json`. The 30-minute follow-up was deleted after acceptance, so no further scheduled experiment checks remain. **HF-05 Done; HF-06 Ready**, with no Hugging Face upload/deployment and no HF-06 implementation started.


## HF-06 completion — 28 October 2026

All subtasks **HF-06.1–HF-06.6 Done**. The existing website now has a capability-gated explorer profile and standalone read-only publication API; assistant/execution/shared persistence/training are unavailable. The single, batch and five-section environment builders save personal UUID drafts in IndexedDB, support explorer-only JSON transfer and preserve unrun/catalog-check semantics. The successor adds verified frozen reference metadata while preserving every HF-05 payload checksum.

Verification: **197 tests + 47 subtests**, **79 native browser checks**, **14 final explorer browser checks**, **3,948** exact real HTTP/HDF5 comparisons, **94** derived metric comparisons and eight-client concurrent reads pass. Peak API memory **413.5 MiB / 512 MiB**, no OOM/limit-pressure events; cold startup **51.36 s**. The main platform retains its original containers/images and database fingerprint/counts; 12 verified raw directories remain removed and shared preparation is unchanged. Original HF-05 serving images and publication remain available for rollback.

Successor manifest: `5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18`; serving source: `636f1f8fc82edaa6c2892adef7fcf22d55e07035f3e8cb4674d2f8d6a8c26307`. Full evidence and changed interfaces: [HF-06 record](interface/hf06-explorer.md), with consolidated local proof `interface/.pilot/proofs/hf06/acceptance.json`.

At HF-06 completion, the preview was [http://localhost:5175](http://localhost:5175) and HF-07 became ready. No user setup/payment, scientific execution or upload was required. Browser drafts remain origin-specific; export them before moving to another origin. The following HF-07 completion record supersedes its earlier launcher reservation.


## HF-07: production packaging completed

Local implementation authorized on 28 October 2026. HF-07.1–HF-07.5 cover frozen allowlisted packages, one production container, pinned private Dataset bootstrap, isolated explorer commands and acceptance. No uploads or account changes are authorized in this task. Publication remains gated on rights clarification, account eligibility, repository choices and configured access in HF-08. Attribution is preserved but does not replace permission under the repository license.

| ID | Work | Status | Evidence |
|---|---|---|---|
| HF-07.1 | Freeze allowlisted Space/Dataset packages and inventories | Done | 134 Space source files; 21 Dataset files; exact original scientific checksums and licenses; frozen host scripts |
| HF-07.2 | One production web container | Done | Standalone ARM64/AMD64 builds; pinned OCI bases and Python closure; UID 1000; port 7860; explicit asset MIME types; startup cancellation check |
| HF-07.3 | Pinned private Dataset bootstrap | Done locally | Actual pinned SDK with dummy private HTTP transport and all real release bytes; manifest-first/exact revision/offline reuse; real Hub credentials deferred |
| HF-07.4 | Isolated explorer launcher | Done | Both directories, unrelated cwd, paths with spaces, argument/exit contracts, occupied-port rejection and secret-safe configuration; native local-mode defaults preserved |
| HF-07.5 | Runtime/browser/data acceptance and handoff | Done | 226 backend tests / 46 subtests; 14 explorer + 62 local browser tests; 3,948 exact API/HDF5 and 94 metric comparisons; cold/restart/signal/AMD64/isolation evidence |

Current package: `interface/.explorer/bundles/3263273270e2fea67c9f/`.
Dataset upload package: **1,280,819,515 bytes**; Space source package: **2,568,167 bytes**.
The release itself remains **1,280,813,520 bytes**, manifest SHA-256
`5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18`.
All twelve HDF5 shards / 47 trajectories remain unchanged. See
[production guide](interface/hf07-production.md); local proof directory is
`interface/.explorer/proofs/`.


Completed HF-07 on 28 October 2026. Production preview:
[http://localhost:7860](http://localhost:7860); existing HF-06 preview remains
[http://localhost:5175](http://localhost:5175). Single non-root web container,
read-only local release and root filesystem, two CPUs / 512 MiB; all twelve
published designs and 47 trajectories preserved. Private Hub startup is pinned
and fails closed; local transport acceptance used the real SDK and real bytes
with a dummy token. No remote account or repository was contacted for access.

Final source fingerprint:
`3263273270e2fea67c9f11625347c4d664bd5a2bd82a265124956829e3d2aba5`.
Native image ID:
`sha256:0b99a60c3959cec52b278b0c54ae1a3aa21a861c5b5bc421329d4b077456c73e`.
AMD64 image ID:
`sha256:01c54ae70f3e6b30ce4910e9f8313e3f6e59d77aa3c4c3fdba2651075719dd70`.
Native restart 53.44 s; ready stop 0.51 s; startup cancellation 0.14 s; AMD64
emulated startup 59.35 s. Peak memory reached the 512 MiB ceiling with filesystem
cache reclamation and zero OOM events; final native probe 314,798,080 bytes.
Host free 48,342,568,960 bytes; Docker storage free 396,484,542,464 bytes.
Original main DB remains 8 experiments / 7 jobs / 7 results, fingerprint
`9654097951d51747332ab2781e7b6eda06613ad76fc859c4425eab2df552671c`;
containers, main simulation image, Parca readiness and publications unchanged.

Changed interfaces: `platform.sh explorer` is now runnable; dedicated
`interface/explorer/` package/orchestration templates and dependency lock;
`hf_export.production` and `release_bootstrap`; opt-in production strictness and
startup signal handling in the shared read adapter; isolated contract/runtime
checks, generated-file ignore and maintained startup guides. No full-platform
initialization or simulation behavior changed.

Acceptance evidence: `interface/.explorer/proofs/acceptance.json`, final runtime,
strict validation, local Hub transport, final browser and real HTTP/HDF5 reports;
full details and known limits in [HF-07 guide](interface/hf07-production.md).
Existing Vite large-chunk warning remains. Hosted performance and genuine Hub
private authentication await HF-08/HF-09. Attribution/license notices are
preserved; publication permission remains unresolved. No upload, account or
billing change was made. **HF-07 Done; HF-08 Ready for preparation with publication
gates pending.** No manual user action is required for the completed local task.


30 October 2026 — Removed three superseded HF-07 bundle directories at the user’s request. Only final bundle `3263273270e2fea67c9f` remains; Space/Dataset inventories unchanged. Retained small historical receipts, supporting dataset checkpoint and HF-05/HF-06 rollback artifacts; no Docker images/volumes or services changed. See the HF-07 guide and local cleanup receipt.


## HF-08 — local preparation implemented, publication blocked

30 October 2026. Confirmed choices: personal account `Safrot`; private Space
`Safrot/wcecoli-explorer`; private Dataset `Safrot/wcecoli-demo-v1`; explicit
release commands, CPU Basic and ephemeral storage. No GitHub workflow or public
visibility change. Read-only account checks report PRO with a read-only token;
both repository names return 404. No repositories, uploads or hosted settings
were created. User confirmation of upload/hosting permission remains pending.

| ID | Status | Evidence / remaining work |
|---|---|---|
| HF-08.1 | Done locally | `publish check/dataset/space/status` from both directories; atomic separate state, process lock, bound inventories and resumable explicit file commits; existing platform behavior preserved |
| HF-08.2 | Done | Owner confirmed current-version hosting permission; credentials configured by user; private publication succeeded with unchanged application/data and verified read access |
| HF-08.3 | Done | User executed publication; remote inventory and runtime-read download strictly verified at commit `a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6` |
| HF-08.4 | Done | Private Docker Space running on CPU Basic at commit `4b77e2869b7a4ebac6b4b3fe2e30f46abfc8af04`; uploaded inventory and pinned configuration verified |
| HF-08.5 | Done | Both repos private; CPU Basic healthy; pinned variables, anonymous denials, authenticated restrictions, 3,948 exact comparisons and real hosted browser smoke pass |

Local verification: **252 tests / 46 subtests pass**, including **26 publication
contracts** and existing campaign/export/worker/launcher regressions. Strict
check passes the unchanged real release (1,280,813,520 bytes, twelve experiments,
47 trajectories). The updated HTTP reader passes **48 experiment/family checks /
3,948 exact comparisons** against the local real API. The hosted browser suite
compiles and intentionally skips its single test while authorization is absent;
this is not a hosted pass. Ruff and diff checks pass.

Both write commands were actually invoked with pending prerequisites and exited
2 before remote mutation; errors identify missing permission/approval/access.
No confirmation or approval receipt was manufactured. Tests use temporary,
clearly synthetic permissions and fake SDK mutations only. An import collision
found by the combined regression suite was fixed by loading the package helper
under a unique module name; the entire combined suite now passes.

Evidence: `interface/.publication/check.json` and
`interface/.publication/proofs/`; instructions and gate records are documented in
[HF-08 staging guide](interface/hf08-private-staging.md). Frozen HF-07 bundle
`3263273270e2fea67c9f` remains the sole bundle and was not regenerated. Release
state/package caches are excluded from Git and root Docker contexts. No Docker
services/images/volumes, simulations, Parca, raw data or local publications were
changed. **HF-08 is not Done; HF-09 remains Planned.**


### HF-08 permission update — 30 October 2026

The owner directly confirmed that current hosting permission allows this version
of the website; additional features must be communicated first. Recorded in
ignored local `interface/.publication/permission.json`, bound to the agreed
private staging repositories and the current website baseline. This does not
authorize additional features, public visibility changes or broader distribution.

Only top-level README/publication notices changed in the successor package:
`interface/.explorer/bundles/2a339158cfce8ce52d4c/`. All application files and
all scientific payloads were compared with HF-07 and are byte-identical. The
HF-07 bundle remains as the verified rollback baseline. No new features were
added. Both ARM64 and AMD64 builds pass; a temporary native container passed
strict full-release startup, twelve-result API and image-MIME checks, then
stopped cleanly. It was removed without changing the running previews.

New package fingerprint:
`2a339158cfce8ce52d4cbb31fd41b2791a1c70b3d16be11ba17f6cef32cd9b79`.
Dataset upload package 1,280,819,447 bytes; Space source 2,568,239 bytes. Serving
release/manifest unchanged. Approval evidence:
`interface/.publication/proofs/permission-build-startup.json`; startup and
checks 45.25 seconds, graceful exit 0. Permission confirmation and local release
approval are now satisfied. Deployment/write and separate Dataset-read
credentials remain required. No remote mutation was performed; HF-08 remains
blocked on access and HF-09 remains planned.


HF-08 diagnostic follow-up — Replaced the uninformative generic failure with
credential-safe stage/exception-class/HTTP-status diagnostics and a local
`last-error.json`. The user’s screenshot did not expose the underlying cause;
a retry from their token-bearing terminal is required. No token values were
requested or read from that terminal, and no remote mutation was attempted.
Regression coverage verifies that HTTP 401 is actionable without serializing
request headers, response bodies or credential values.


HF-08 Dataset publication milestone — The user completed private Dataset publication. The matching local receipt records `Safrot/wcecoli-demo-v1`, commit `a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6`, verified upload inventory and strict pinned-download validation with the read credential. Space publication stopped before repository creation because the runtime token did not pass exclusive Dataset scope validation. No Space ownership/deployment receipt exists. Next action: restrict the fine-grained runtime token to this Dataset only, with no global permissions, and retry `publish space`; do not repeat the completed Dataset upload.


HF-08 repeated scope-error follow-up — Corrected the release validator’s full-path
display-name assumption by resolving and matching authoritative Dataset IDs.
Strict no-global-permissions, Dataset-type and exact-identity checks remain.
Added secret-free mismatch counts/booleans and regression cases for valid short
display names, wrong IDs, wrong resource types, broad scopes and ambiguous
names. Actual terminal-token metadata is unavailable to the agent; user retry
will determine the remaining blocker. No remote writes or artifact changes
were performed. This is release-tool compatibility work, not a website feature.


HF-08 scope follow-up — The UI screenshot shows the expected single Dataset/read
selection, while diagnostics report two scope entries, one matching. Adjusted
validation to ignore zero-permission entries while rejecting all additional
active grants; added per-entry permission counts. Tests cover empty extra
entries and rejection of extra read/write grants. Actual second-entry contents
remain unknown until the user retries from their credential-bearing terminal.
No remote mutations or website changes were performed.


HF-08 Space publication milestone — User reports success. Local receipts and
read-only HF checks confirm both repositories are private, Dataset commit
`a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6`, Space commit
`4b77e2869b7a4ebac6b4b3fe2e30f46abfc8af04`, runtime RUNNING on CPU Basic and
healthy full real release. Anonymous repository requests return 401 and app
health 404; authenticated writes return 405 and administrative/assistant routes
404. Remote variables pin the verified Dataset/manifest. Final hosted scientific
and browser acceptance is underway; HF-08 is not yet Done and HF-09 is not yet
Ready. Sanitized build/runtime log tails were captured once.


### HF-08 completion — private staging verified

The Dataset is at https://huggingface.co/datasets/Safrot/wcecoli-demo-v1 (private),
commit `a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6`. The Docker Space is at
https://huggingface.co/spaces/Safrot/wcecoli-explorer (private), commit
`4b77e2869b7a4ebac6b4b3fe2e30f46abfc8af04`. Both revisions were rechecked at
acceptance completion. Space is RUNNING on CPU Basic; health reports read-only,
full scope, no synthetic data. Dataset and application inventories match the
approved metadata-only package `2a339158cfce8ce52d4c`, with the original serving
manifest and all scientific payloads unchanged.

Acceptance: all **48 experiment/family HTTP checks / 3,948 exact comparisons**
pass against independent local HDF5. Private hosted browser smoke passes for
published results, real mass/growth charts, series in all four molecular families,
and personal draft save/reload/download with no application mutation requests.
The chart screenshot was visually inspected. Anonymous repository requests are
denied (401), anonymous application health returns 404; authenticated writes
return 405 and assistant/provider/debug/docs routes 404. Remote variables pin
the exact Dataset SHA and manifest fingerprint. Bounded sanitized build/runtime
log tails are saved; no tokens, request headers or auth traces are persisted.

The initial browser test used an overly exact label and a five-second local
wait; corrected to the existing counted tab label and a hosted-network timeout.
Only tests changed, not the deployed website or its permitted features.
Local read-only isolation verification confirms original DB counts 8/7/7 and
fingerprint `9654097951d51747332ab2781e7b6eda06613ad76fc859c4425eab2df552671c`,
original containers/images and retained Parca readiness unchanged; all twelve
verified raw directories remain removed. No simulations, preparation, hardware
upgrades or visibility changes occurred.

Evidence: `interface/.publication/proofs/hosted-acceptance.json`,
`hosted-access.json`, `hosted-restrictions.json`, `hosted-http/`, hosted browser
output/screenshot, sanitized log capture and `local-isolation/`. Space state is
now `verified`. **HF-08 Done; HF-09 Ready, not started.** The Space remains private;
restart/cache recovery, broader hosted browser/resource checks and any public
release decision remain HF-09. Current-version hosting permission does not
extend automatically to additional features; those require prior communication.


### Published-list scrolling bug — local correction, deployment pending

Reproduced on the deployed Space: `/results` and `/experiments` main panes had
`overflow-y:hidden`; wheel input left scrollTop at 0 despite content heights
1532/1601 px in a 720 px viewport. Individual `/results/1` pages scrolled normally
at widths 1440/768/390. The public lists inherited a native workspace rule that
expects an internal scrolling pane, but their explorer table uses page scrolling.

Local fix adds an explorer-only class to those two main panes and restores
vertical overflow without changing native layout or application capabilities.
Four desktop/mobile/light/dark wheel regressions (eight real-data route checks),
17 native result-detail browser tests and the explorer production build pass.
Proofs: `interface/.publication/proofs/scroll-fix/`, `scroll-fix-tests.txt`,
`scroll-fix-local-tests.txt`, and hosted scroll-diagnostic JSON files. Existing
Vite chunk-size warning remains. The hosted Space, frozen release bundles and
scientific files have not been changed; a frontend-only release update remains
necessary. This restores existing behavior and adds no feature.


Scrolling fix release preparation — User authorized fixing the deployed Space.
Prepared package `8c77169040e08a4ab519` with exactly the two reviewed frontend
source changes and identical Dataset inventory. Both production architecture
builds pass; compiled-image real-wheel tests pass (4 cases), and native
result-detail regressions pass (17). Local plan, approval and scoped permission
are bound to the new package; original receipts are retained under
`interface/.publication/history/4b77e2869b7a4ebac6b4b3fe2e30f46abfc8af04/`.

Added `publish update-space` with full baseline inventory, private visibility,
Dataset revision/configuration and parent-commit guards. It patches only the
approved source files, preserves secrets and supports no-duplicate resume.
The actual hosted commit remains unchanged: the agent has no deployment/write
credential, no app terminal is attached, and native Terminal access was denied
by the computer-use tool. Required user action: execute the prepared command in
the token-bearing terminal. No remote mutation was performed during preparation.

### Homepage correction — 2026-11-06; implementation verified, deployment pending

The scrolling fix is now confirmed deployed: private Space RUNNING revision
`c0a709462f3af20eadafb01303eea6c8d9302d42`, with complete source inventory matching
retained package `8c77169040e08a4ab519`. The earlier pending notes are historical.

Owner-approved homepage corrections preserve button text on hover, remove the
redundant campaign note below the actions, and clarify the guide/draft footer.
Prepared package `4f6c04fb2ec4511d2a6b` changes only ExplorerApp.tsx and explorer.css;
all Dataset files and scientific checksums are identical. Exact-file publication
plan, scoped permission and production approval are bound to the new source SHA.
Earlier receipts are archived under the deployed revision in
`interface/.publication/history/`.

Evidence: `interface/.publication/proofs/homepage-fix/review.json`, AMD64 image
startup and eight real-data browser checks under 512 MiB, visually reviewed
hover/focus/footer screenshots, 17 native homepage regressions and 46 publication
tests. Temporary verification services are stopped after checks. No new feature,
simulation, Parca run, Dataset upload or visibility change is included.

Deployment remains pending because the available secure credential is read-only.
User action: run `./platform.sh publish update-space` in the terminal holding
`HF_PUBLISH_TOKEN`; verify the hosted homepage after the rebuilt revision is
RUNNING. HF-08 remains Done; HF-09 remains Ready and has not started.

### Explorer guide completion — 2026-11-06; local acceptance complete, deployment pending

Owner approved expanding only the Hugging Face explorer guide. Added eight
bookmarkable sections, detailed coverage of all 29 visible experiment types,
publication-backed environment/target references and honest design/result
guidance. New guide component/content/CSS and routing layout stay within the
explorer profile. The local guide, shared shell/builders, routes, assistant and
global styles are unchanged; baseline hashes cover all 101 native source files.
Visual review identified the existing desktop sidebar squeezing the mobile
guide; the explorer-only mobile layout now uses the full width, with site
navigation and theme controls. No shared component was modified.

The earlier homepage correction is confirmed deployed as private RUNNING Space
revision `0d6ef2580c7c80be549db4ceed8808c4a5de037e`, matching package
`4f6c04fb2ec4511d2a6b`; earlier pending notes describe the previous handoff.
Guide successor package `4bfa5f25333c865dab7d` changes four explorer source paths,
including three new modules. Dataset inventory and all scientific checksums are
identical. Exact-file publication now supports reviewed additions without remote
deletions or relaxed inventory, parent-commit, configuration or Dataset guards.

Seventeen native regressions and 50 publication tests pass. The final frozen
AMD64 image builds and passes all 23 guide/homepage/scrolling tests, including
every section's accessibility checks in mobile/desktop and both themes. Cold
strict full-release startup takes 46.42 s under local AMD64 emulation at 512 MiB;
health reports full, non-synthetic, read-only data. Shutdown exits 0 without OOM.
All 101 native source hashes and the complete Dataset inventory remain unchanged.
Screenshots are visually reviewed. Evidence and scoped package-bound approval
are recorded in `interface/.publication/proofs/guide-fix/`; the exact four-file
update plan is ready against the verified deployed revision. Prior publication
receipts are retained under that revision's history directory. Two unapproved
intermediate guide bundles were removed, with small receipts retained.

No remote mutation or new simulation has occurred. Details:
[guide update record](interface/explorer-guide-update.md). Publication and hosted
guide acceptance remain pending: run `./platform.sh publish update-space` in the
owner's terminal containing `HF_PUBLISH_TOKEN`, then verify the hosted guide.
HF-09 remains Ready, not started.

Two focused authenticated hosted guide checks are also prepared and discovered
successfully; execution awaits publication. They use host-scoped credentials
with traces/video disabled and compare published references with the original
serving bundle. They do not replace the remaining broader HF-09 acceptance.

### Contextual guide links — 2026-11-06; local acceptance complete, deployment pending

Owner approved explorer-specific help destinations through minimal guarded
shared edits. Mechanistic, expression-only, knockout-index and state-ID help
open their matching explanations. Contextual page links open model coverage;
designer Documentation follows the current selected type. General Guide links
still open Overview. Local-mode destinations remain `/guide`.

Typed URLs, section normalization, asynchronous expansion/focus, guide-panel
scrolling, reduced-motion-aware highlighting and explicit invalid-target states
are implemented. Eighteen contextual tests pass, including actual tooltip
interactions with mouse/keyboard/touch, new tabs, history, advanced types,
unsaved protection, delayed loading and failure/retry. Fifty-two native
regressions and 50 publication tests pass. All 96 native files outside the five
approved shared integration files retain their hashes; local guide/routes and
global styles are unchanged. An exact shared diff is recorded.

Frozen AMD64 package `8d1073a8e767bc2a48a8` passes all 41 contextual/guide/homepage/
scrolling tests under 512 MiB. Cold strict full-release startup is 44.39 s on
local AMD64 emulation; health is full, read-only and non-synthetic. Shutdown exits
0 without OOM. The complete Dataset inventory/scientific checksums are identical.
Screenshots and receipts are retained under
`interface/.publication/proofs/context-help/`.

Private RUNNING Space `0d6ef258…` still matches the homepage package, so the new
successor combines the approved guide expansion and contextual links into one
exact ten-file update. The earlier guide bundle remains retained, with its
pending receipts archived under `history/prepared-4bfa5f25333c865dab7d/`.
Package-bound permission, approval and the update plan are ready. No remote
mutation has occurred; publication and focused authenticated hosted checks await
the owner's token-bearing terminal. Details:
[contextual guide links](interface/contextual-guide-links.md).
HF-09 remains Ready, not started.
