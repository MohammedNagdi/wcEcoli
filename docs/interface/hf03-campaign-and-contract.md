# HF-03: demo campaign and serving release contract

Implemented 27 October 2026. This stage defines and validates data; it does not submit experiments, prepare a model, run simulations, migrate a working database or publish a dataset.

## Deliverables and current result

- [Campaign manifest](../../interface/backend/hf_export/campaigns/hf-demo-v1.json): twelve unique experiments, seed 0, up to four generations, with the three-member pilot selected from the same campaign.
- [Planner and campaign models](../../interface/backend/hf_export/demo_campaign.py): read-only catalog resolution and deterministic fingerprints.
- [Release models and validator](../../interface/backend/hf_export/explorer_contract.py): the separately versioned `explorer-release-v1` format. The existing v0 exporter and dataloader are unchanged.

A fresh temporary catalog built with the existing reference-ingestion code resolved all twelve entries successfully. The planner returned `catalog_valid: true`, `runtime_ready: false`, `planned_jobs: 12`, and `max_generation_trajectories: 48`. Its input database and surrounding directory hashes were unchanged. Temporary catalog preparation and planner execution were separate operations; the planner itself never initializes a database.

Manifest SHA-256: `512699e2907d8f51cedb4daeda7187be813c87f3b6f1618c6c34a8020ba3d0bf`.

## Campaign

| Stable key | Initial condition | Perturbation / lineage-time events | Comparison |
|---|---|---|---|
| `wt-basal` | basal | wild type, minimal medium | shared reference |
| `wt-with-aa` | with_aa | wild type, supplemented medium | basal reference |
| `wt-acetate` | acetate | wild type, acetate medium | basal reference |
| `wt-no-oxygen` | no_oxygen | wild type, oxygen-free medium | basal reference |
| `hisG-basal` | basal | hisG expression perturbation | matched basal wild type |
| `hisG-with-aa` | with_aa | hisG expression perturbation | matched supplemented wild type; hisG basal |
| `trpA-basal` | basal | trpA expression perturbation | matched basal wild type |
| `trpA-with-aa` | with_aa | trpA expression perturbation | matched supplemented wild type; trpA basal |
| `pgi-basal` | basal | pgi expression perturbation | matched basal wild type |
| `pgi-acetate` | acetate | pgi expression perturbation | matched acetate wild type; pgi basal |
| `wt-add-aa` | basal | minimal at 0 s, supplemented at 1200 s | initial and endpoint wild-type references |
| `wt-cut-aa` | with_aa | supplemented at 0 s, minimal at 1200 s | initial and endpoint wild-type references |

Pilot keys: `wt-basal`, `hisG-basal`, `wt-add-aa`. Completed pilot members are reused when the rest of this same campaign is executed later.

The manifest includes questions and suggested scalar/molecular measurements. Effects are hypotheses, not promised results. Knockouts are expression perturbations of the model's selected RNA/transcription-unit target; actual target IDs and co-targeted genes must be established from the prepared model in HF-04. Catalog indices alone are not proof of gene-specific targeting.

Generations are sequential within one lineage, not independent seed replicates. Do not generate replicate-based confidence intervals. The 1200-second events refer to elapsed lineage time; they do not restart after division. Plot-relative time is derived by subtracting the recorded generation's lineage start.

## Read-only planner

From `interface/backend/`, using the backend Python environment:

```bash
python -m hf_export.demo_campaign --database /absolute/path/to/reference.sqlite
```

From the root, an equivalent invocation is:

```bash
PYTHONPATH=interface/backend interface/backend/.venv/bin/python -m hf_export.demo_campaign --database /absolute/path/to/reference.sqlite
```

The manifest defaults to the checked-in campaign; `--manifest` selects an explicit input. `--out /path/to/new-report.json` optionally saves the resolved report. The output file must be new and cannot overwrite either input. Without `--out`, output goes only to stdout. There is no submission command. Exit code 0 means catalog-valid; exit code 2 means validation/input failure. Runtime readiness is always false at this stage, even when the command succeeds.

The input must be a closed, checkpointed catalog snapshot with current genes, conditions, media recipes, timelines and variants. The planner opens it with SQLite read-only/immutable flags plus query-only protection, explicitly closes the connection and refuses a nonempty WAL. It does not import the application, ORM, worker, model runtime or submission module. It never creates missing databases, schema markers, migrations, ledgers, experiments or jobs.

The older local file database currently lacks `media_recipes` and is intentionally rejected, without migration. HF-04 will prepare a dedicated demo catalog; do not modify the working database to make this planner pass.

Checks cover unique keys and normalized executions, controls and matching environments, mechanistic/KO-ready genes, conditions and media recipe existence, and exact correspondence to reference timelines. Quoted TSV timeline strings are accepted after decoding. Controls and presentation ordering do not change the manifest fingerprint; execution identities include the resolved index, initialization, events, seed and generations. The report records the input catalog hash and the `genes.ko_index` source without claiming it was verified against the current prepared model.

Pydantic models forbid unknown fields and expose JSON Schema through `CampaignSpec.model_json_schema()` and `ReleaseManifest.model_json_schema()`. Validation diagnostics omit rejected input values.

## Explorer release format

```text
manifest.json
catalog.sqlite
metadata.jsonl
qc.jsonl
README.md
trajectories/<experiment-key>.h5
```

Every experiment has an explicit outcome. A missing-output or execution-error entry has a reason and no claimed shard/trajectory. Normal, non-dividing and biologically terminated runs retain their actual trajectory prefix. Nothing pads a stopped lineage to four generations or renumbers its generations.

`manifest.json` embeds the campaign and its fingerprint, source/preparation/model fingerprints, runtime image digest, initial-condition binding, sample-preservation policy, public experiment/job ID mappings, outcomes, per-trajectory availability and payload inventory. Public stable experiment keys are independent of numeric database IDs.

Each payload inventory entry contains a relative path, byte size and SHA-256 checksum. The inventory must account for exactly the catalog, metadata, QC, dataset card and declared independent shards. Unlisted files and symlinks are rejected. The manifest does not hash itself, but its bytes count toward the total release size; the eventual dataset commit will pin the whole release.

The publication catalog must be created as a fresh allowlisted projection, not by deleting private tables from a copy of the live database. It is a sanitized schema, not the live app database. The column allowlists are defined in `CATALOG_COLUMNS` in the validator. Core mapping tables are:

- `demo_experiments(key, experiment_id, job_id)`
- `demo_controls(experiment_key, control_key, role)`
- `experiments`, `simulation_jobs`, `simulation_results`, plus reference tables.

User-data rows must correspond exactly to this campaign. The validator checks execution identities, controls, job/result relationships and outcome flags. Assistant/provider tables, private columns, views, triggers, unrelated experiments, host-specific paths and credential-like text are rejected. HF-04/HF-06 must read this schema through an adapter; do not point normal application migrations at a published snapshot.

`metadata.jsonl` indexes every actual trajectory with `key`, `seed`, `generation`; questions/configurations are in the embedded campaign. `qc.jsonl` has one `key`, `outcome`, `reason` entry per experiment. Outcomes distinguish `completed`, `no_division`, `terminated`, `missing_output`, and `execution_error`. Biological termination reasons are retained consistently in the manifest, HDF5 and catalog.

### HDF5

Each experiment shard stores:

```text
/reference/<matrix-channel>_ids
/seed=0/gen=<actual-generation>/<channel>/time
/seed=0/gen=<actual-generation>/<channel>/value
```

Trajectory-group attributes: `seed`, `generation`, `lineage_start_sec`, `lineage_end_sec`, `outcome`, `termination_reason`. Clocks must not restart or overlap across generations. Time datasets use seconds (`unit: s`) and record `source: Main.time` or `source: listener.time`; row-number fallback clocks are not accepted. Values record physical units. Scalars have shape `[T]`; matrices have shape `[T,N]`, with unique nonempty identifiers matching N.

Every trajectory explicitly declares availability for all 21 existing scalar channels and four matrix families: mRNA, protein, reaction flux and exchange flux. Available channels declare original `source_samples` and, for matrices, `source_columns`; these must match the saved shapes. Unavailable channels require a reason and must not contain data. Non-terminated trajectories require mass/growth data. Views requiring other molecule families must remain unavailable until a later contract adds their data.

Validation checks time ordering, finite values in bounded blocks, dimensions, IDs, source counts, units, group identity, checksums and indexed contents. It does not authenticate source claims or prove that a time vector labeled `Main.time` came from the simulator. HF-04 must compare against actual source trajectories and verify preparation, initialization, targets and sample/column counts before any production release is accepted.

### Size and fidelity

Target under 5,000,000,000 bytes; hard ceiling 10,000,000,000 bytes, including every file and the manifest. No minimum size. Compress and shard while preserving all saved samples, molecule columns and genuine time coordinates. Oversized releases fail validation and require an explicit revision; no automatic thinning is implemented or allowed by this contract.

### Validator command

```bash
python -m hf_export.explorer_contract /absolute/path/to/release
```

Returns JSON with `valid`, `errors`, and measured `total_bytes` (plus `above_target` when size validation proceeds). Exit code 0 means structurally valid; 2 means failure. A synthetic fixture is rejected unless `--allow-synthetic` is explicitly supplied. Tests create tiny, clearly labeled fixtures in temporary directories; no synthetic public dataset was generated.

## Verification and HF-04 handoff

The existing campaign/export suite is run alongside the new planner/release tests. The tests cover valid resolution, repeatability, duplicate/invalid inputs, zero-write planning, explicit output protection, rejected-credential diagnostics, invalid clocks/shapes/IDs/counts/checksums, size accounting, private/unrelated data, outcome consistency, and termination without fabricated generations. All **83 campaign/export tests passed**, including the new contract tests and the existing legacy tests. Ruff checks on all four new Python files passed. A preservation audit confirmed existing source files and the working database remained unchanged outside the intended documentation updates.

HF-04 prerequisites:

1. Prepare an isolated demo catalog, output directory, runner/socket and executor; do not enqueue into the existing working stack.
2. Verify catalog indices against the actual prepared `simData`, recording transcription-unit IDs, requested targets and other co-targeted genes. Stop on disagreement.
3. Bind and test the supported `--initial-condition` flag independently of media timeline events. The current worker does not forward it for these runs; HF-03 does not change worker execution behavior.
4. Verify absolute lineage clocks and source-array sample/column counts, then generate the three selected pilot experiments and compare one real result through export and serving.
5. Measure resources and output size before executing the other nine experiments.

Production export/sharding, a populated demo catalog, the serving adapter, simulations and source-value comparisons remain HF-04/HF-05 work. No user action, account setup or Docker operation is required for HF-03.
