# well4cell: dataset design

The complete reference for the well4cell dataset: what is published, how it is shaped, how
it is built from the pruned wcEcoli campaign, and what is still open. The decisions here are
final; the reasoning behind the larger ones is recorded in `docs/adr/0002`-`0009`. The stage
contracts the code is written against are in `cluster/well4cell_build/SPEC.md`; the runbook
is section 9 of `cluster/RUN_SLURM.md`; the vocabulary is in `CONTEXT.md`.

## 1. Goal

Publish every finished whole-cell E. coli simulation of the campaign as one machine-learning
dataset that loads with `datasets.load_dataset`, browses in the Hub viewer, queries with
DuckDB, and carries enough provenance to trace any row back to the run directory, code
revision and Parca cache it came from (by name and hash: the caches themselves are not
distributed, ADR 0009).

- **One artifact**: the Hugging Face dataset repo `datasets/cSynBioSys/well4cell`, private
  until paper submission, then public. Release `v1.0` is a git tag on that repo, licensed
  CC-BY-4.0, with a Hub-minted DOI at release.
- **The bucket is retired.** The `hf://buckets` mirror built by `cluster/hfx` (100 pilot
  units) is not part of the release; the user deletes it later, by hand. See ADR 0007.
- **Nothing on klone is deleted or modified.** The builder reads `out/` and `state/` and
  writes only under `$W4C_ROOT` (default `<campaign>/well4cell`).

## 2. Data model

### Sample, cell, lineage

A **sample** (trajectory) is one cell generation: the rows from birth to division (or to
the end of the lineage) of one generation of one run. Samples are ragged: rows are exactly
1 s apart, a normal generation has 2,500-3,100 steps, and a generation that hit the time
limit has 10,801. See ADR 0003.

| Id | Form | Example |
|---|---|---|
| `cell_id` | campaign experiment name, slugified | `T3/argG_KO/rich_to_minimal` |
| `lineage_id` | `cell_id/s{seed}` | `T3/argG_KO/rich_to_minimal/s3` |
| `sample_id` | `lineage_id/g{gen}` | `T3/argG_KO/rich_to_minimal/s3/g2` |
| `parent_id` | `sample_id` of generation `gen-1`, null at `g0` | `T3/argG_KO/rich_to_minimal/s3/g1` |

`cell_id` comes from the experiment name, not from variant x condition, because that pair
collides: 2,390 combinations for 4,009 cells (ADR 0008). Each cell has 8 seeds; each lineage
has up to 4 generations. Only one daughter is followed at each division, so a lineage is a
chain, not a tree.

Row 0 of a sample is the birth state; `growth_rate` is null there (it is a difference and
has no previous step). `t` counts seconds since birth; `t_abs` counts seconds since the
start of the lineage, so generations continue each other in `t_abs` and media schedules are
expressed in it.

### Families

Families are the campaign's tiers, parsed from the `[T1]`..`[T5]` prefix of the experiment
name (`[T2_CORE]` is T2). They are the top-level grouping and the Hub split axis (ADR 0004).
The family order is always the tier order T1..T5 (index rows, export parts, card).

| Family | Tier | Design |
|---|---|---|
| `wildtype_media` | T1 | wild type in 21 static media |
| `single_knockout` | T2 | 573 single-gene knockouts x 5 media |
| `dynamic_media` | T3 | 100 knockouts + wild type under 6 time-varying timelines (`rich_to_minimal`, `minimal_to_acetate`, ...); wild-type amino-acid add/remove shifts at 600 s; sinusoidal media between `minimal` and one of three media (`minimal_acetate`, `minimal_plus_amino_acids`, glucose 2 mM <-> 20 mM) with periods 15/30/60/120 min |
| `regulation` | T4 | 22 transcription factors forced active/inactive; 20 ppGpp setpoints |
| `double_knockout` | T5 | 75 knockout pairs x 5 media |

Tiers, not variant types, because the variant type does not separate the designs: 4,800 T3
jobs share the `gene_knockout` variant type with T2.

Campaign totals: 31,101 `done` jobs are published; 971 `failed` jobs are listed in
provenance only (`provenance/failed_jobs.parquet`); 4,629 terminated lineages are included
and flagged.

### Outcome labels

The campaign database's `divided` column is a mass-ratio heuristic and is wrong: 28,464 rows
disagree with what the simulation actually did, and 38,899 division times are null. The
labels are rebuilt from how each generation ended (ADR 0005):

- `terminated`: the lineage ended in this generation.
- `divided = not terminated`.
- `division_time_sec = n_steps - 1` when divided, else null.
- `termination_class` in `none | time_limit | negative_counts | fba_infeasible |
  equilibrium_unstable | other`, with the raw `termination_reason` text alongside.

About 2,650 lineages end in `NegativeCountsError` (ATP in polypeptide elongation), 1,973 at
the time limit, and 9 on solver failures. Only `time_limit` is a clean "does not divide"
prediction of the model; the other classes are numerical failures of the simulation and
should be treated as such by any viability task.

## 3. Products (configs)

Every config but `summary` is one row per time step, with `sample_id`, `t`, `t_abs` and the
18 scalar channels; the matrix configs add matrix columns. `summary` is one row per
trajectory.

| Config | Stride | Columns beyond core | Notes |
|---|---|---|---|
| `summary` | one row per trajectory | `n_steps`; mean, min, max, first, last of each scalar; 13 pathway fractions once `expression` is complete | from `core` (pathways from `expression`); ADR 0010 |
| `core` | 1 s | none (18 scalars) | ~19 GB |
| `expression` | 10 s | mRNA counts (3,133 mRNA transcription units), protein counts (4,310 monomers) | default |
| `metabolism` | 10 s | reaction flux (9,612), exchange flux (87) | default |
| `expression_1s` | 1 s | as `expression` | uploaded last, after a storage grant |
| `metabolism_1s` | 1 s | as `metabolism` | uploaded last, after a storage grant |

The 18 scalars, in column order: `cell_mass`, `dry_mass`, `protein_mass`, `rna_mass`,
`dna_mass`, `small_molecule_mass`, `cell_volume`, `growth_rate`, `ppgpp_conc`,
`aa_supply_total`, `aa_synthesis_total`, `mrna_counts`, `n_oric`, `fba_objective`,
`exchange_flux_total`, `reaction_flux_total`, `ribosome_elongation_rate`,
`ribosome_actual_elongations`.

**Summary** (ADR 0010). `data/summary/<family>/part-00000.parquet` has one row per
trajectory, in index order, joining to `index.parquet` on `sample_id`: `sample_id`,
`n_steps` (int32), then for each of the 18 scalars in the order above `<channel>_mean`,
`_min`, `_max`, `_first`, `_last` over the trajectory's 1 s `core` rows. Statistics are
float32 for float channels; for the int channels (`mrna_counts`, `n_oric`) min, max, first
and last are int32 and the mean is float32. Nulls are skipped: `growth_rate` is null at row
0, so `growth_rate_first` is the value at t = 1 (and every `growth_rate` statistic of a
one-row trajectory is null). The `summarize` stage computes it from the core parts alone, so
it is independent of the 10 s matrix configs. It is not in `settings.CONFIGS` and has no
index locator: it is not exported from `channels.h5`. Field units and file metadata are as
for the other products (`config` = `summary`, `stride` = 1); `sample_id` is a plain string
(one row per trajectory, nothing to dictionary-encode).

**Pathway fractions in the summary.** `summarize --pathways` appends 13 float32 columns
`pathway_<name>` (unit `fraction`), one per pathway of the Cellarium pathway panel (gene
symbols copied into `cluster/well4cell_build/data/pathways.json` from Cellarium's
`pathway_panel.py`, MIT). The definition is Cellarium's, so the two datasets agree: at each
10 s `expression` row, the pathway's `protein_counts_matrix` counts over the row's total
(the pruned matrix sums to the total over all monomers), then the mean over the trajectory.
Symbols map through `genes.parquet` (`symbol` to `monomer_id`) to the `protein_counts`
reference (ids carry a `[c]`-style compartment suffix); all 13 pathways resolve fully on this
campaign. The columns live in the same summary parts and exist only for a family whose
`expression` parts exist, so they are added when the expression export is complete: the
stage refuses `--pathways` for a family without them rather than writing null columns, and
the published summary has no pathway columns until then.

**Translation collapse.** A generation can divide while its ribosomes have stopped. Cellarium
flags `translation_collapse` when the mean ribosome elongation rate is below 1 aa/s; here
that is `ribosome_elongation_rate_mean < 1` in `summary` (`settings.COLLAPSE_RATE`), counted
by finalize into the card's Outcomes and `manifest.json` (6,273 trajectories in 1.0.0-rc1,
4,188 of them with `termination_class` none). It is also the index column
`translation_collapse`: `index build` writes it null and finalize fills it from the summary
parts (null where a trajectory has no summary row; a null mean counts as false).

**Stride.** The 10 s products are point samples, not averages: keep rows with `t % 10 == 0`
plus the last row of the sample, so the division state is always present. A 10 s product is
an exact row subset of its 1 s counterpart.

**Pruned columns.** Matrix columns are pruned to the set that is non-zero somewhere in the
campaign (the globally ever-active set, computed by the scan). Sampled estimates: ~2,400 of
9,612 reaction fluxes, ~2,750 of 3,133 mRNA, ~4,170 of 4,310 protein, ~73 of 87 exchange
fluxes. `provenance/reference/<matrix>.parquet` keeps the full id list with an `active` mask
and `product_column` (position in the pruned matrix, null when pruned), so every column maps
back to its gene, monomer or reaction. See ADR 0006.

**Measured size** (one run, 4 generations, zstd): expression 17.5 MB at 1 s and 3.8 MB at
10 s; metabolism 34.6 MB at 1 s before pruning.

**Format** (ADR 0002): parquet, zstd, row groups of at most 2,048 rows (the viewer serves
files as-is only when row groups are small), files of ~2 GB ordered by `cell_id`, seed,
generation. `sample_id` is dictionary-encoded; `t` and `t_abs` are int32; counts are int32;
masses and fluxes are float32; matrices are `fixed_size_list<int32|float32>`. Each field
carries its unit in field metadata (`unit`); each file carries `well4cell_version`,
`config`, `family` and `stride` in file metadata.

### Splits

No `train/`, `val/`, `test/` directories are shipped. Each config's Hub splits are the
families:

```python
load_dataset("cSynBioSys/well4cell", "expression", split="single_knockout")
```

Learning splits are columns of the index, assigned with a fixed seed (`W4C_SPLIT_SEED`),
80/10/10:

- `split_by_lineage`: whole lineages, stratified by cell within each family.
- `split_by_gene`: whole knocked-out genes are held out; rows without a knockout go to
  `train`.

The consumer package exposes them as `split(by=...)`.

## 4. Repository layout

```
README.md                         dataset card; YAML front matter declares configs x splits
index.parquet                     one row per sample
stats/<family>.parquet            per channel and per active matrix column: n, mean, std, min, max
provenance/
  sim_options/<hash>.json         each distinct sim options set, keyed by sim_options_hash
  reference/
    mrna_counts.parquet           id list + active mask + product_column
    protein_counts.parquet
    reaction_flux.parquet
    exchange_flux.parquet
    genes.parquet  conditions.parquet  media_recipes.parquet  timelines.parquet  tf_edges.parquet
    tf_activity.parquet           tf_activity variant index -> true TF id, symbol, state, medium
  failed_jobs.parquet             the 971 failed jobs, provenance only
  export_qc.parquet               QC verdict of every trajectory in every config attempt, with reasons
  scan_runs.parquet               the scan record of every run
data/<config>/<family>/part-NNNNN.parquet
data/summary/<family>/part-00000.parquet   one row per trajectory (summarize, from core)
```

The two Parca caches the campaign used are not in the repo. They are wcEcoli's fitted
parameters, licensed with the model under the Stanford Academic Software License, not
simulation output (ADR 0009). Each sample names its cache in `parca_cache` and the sha256 of
that cache's `kb/simData.cPickle` in `kb_sha256`; `manifest.json` and the card list the pairs.

Nor is the degradation-rate classification of each cache. `cluster/w4c deg-rates` writes
`build/provenance/deg_rates_<parca_cache>.json`, which says, for each mRNA transcription unit
of that cache, whether its degradation rate is a fit. The Parca bounds the fitted rates below
by the slowest measured mRNA cistron (**floor**), clips them above at the fastest
(**ceiling**), and gives a unit none of whose cistrons was measured the mean measured
half-life (**imputed**); every other unit is **determined**. sim_data stores all four as the
same kind of float, so a claim about a floor, ceiling or imputed transcript rests on a bound
or a population mean. The file has the counts and the share of basal mRNA expression per
class, the floor, ceiling and imputation constant as half-lives, the units of the three
not-a-fit classes, and the eight most expressed of them, under the keys of Cellarium's
`data/parca/deg_rate_baseline.json` (854 of 3,133 units, 12.087% of basal mRNA expression on
Cellarium's fit) so the two compare. It is a derived summary of the fitted parameters, which
ADR 0009 rejects shipping, so it stays with the campaign on klone. The repo carries only
aggregates, in the card's Provenance section and `manifest.json` (`deg_rates`): per cache, its
`kb_sha256`, the number of mRNA units in each class and in all, and the percent of basal mRNA
expression the three not-a-fit classes carry. No unit ids, bounds or imputation constant.

### index.parquet

One row per sample, sorted by `family` in tier order (T1..T5), then `cell_id`, `seed`,
`generation`. Column order and types are `index.schema()` in
`cluster/well4cell_build/index.py`; where each value comes from is in the docstrings of
`index.py` and `perturbation.py`.

| Group | Column | Type | Meaning |
|---|---|---|---|
| identity | `sample_id` | string | `lineage_id/g{gen}` |
| | `lineage_id` | string | `cell_id/s{seed}` |
| | `cell_id` | string | slugified experiment name, tier prefix `T1`..`T5` (`[T2_CORE]` -> `T2`); T4 TF cells use the TF that actually ran (see Known defects) |
| | `parent_id` | string | previous generation's `sample_id`; null at g0 |
| | `experiment_name` | string | the campaign's experiment name, verbatim |
| design | `family` | string | tier family |
| | `tier` | string | `T1`..`T5` |
| | `variant_type` | string | wcEcoli variant type |
| | `variant_index` | int32 | wcEcoli variant index |
| | `variant` | string | gene symbol, `wildtype`, or the variant type |
| | `condition` | string | the campaign's condition as designed (ignored by the simulator for `tf_activity` and `sinusoidal_media`; read `media_schedule`) |
| | `timeline` | string | the schedule that actually ran, `"0 minimal, 1200 minimal_acetate"` (simulation seconds); null for sinusoidal media |
| | `seed` | int8 | 0-7 |
| | `generation` | int8 | 0-3 |
| perturbation | `knockout_genes` | list<string> | gene symbols |
| | `knockout_gene_ids` | list<string> | EcoCyc gene ids |
| | `knockout_tu_ids` | list<string> | transcription units set to zero expression: a knockout removes a whole TU |
| | `media_schedule` | list<struct<t_abs_sec:int32, medium:string>> | medium changes in lineage-absolute seconds |
| | `medium_at_birth` | string | medium at row 0 |
| | `medium_at_division` | string | medium at the last row |
| | `media_a`, `media_b` | string | sinusoidal endpoints |
| | `period_sec` | int32 | sinusoidal period |
| | `tf_target` | string | symbol of the TF that actually ran (T4) |
| | `tf_target_id` | string | EcoCyc id of that TF |
| | `tf_state` | string | active / inactive / control |
| | `ppgpp_setpoint_um` | float32 | ppGpp setpoint (T4) |
| | `ppgpp_factor` | float32 | multiple of the basal ppGpp concentration, 0.2-2.0 (T4) |
| | `aa_shift` | string | amino-acid shift label: `+ARG`, `-ARG`, `rich->6aa`, `control`, ... (T3) |
| | `perturbation_text` | string | the raw description from the campaign |
| outcome | `n_steps` | int32 | rows at 1 s |
| | `divided` | bool | `not terminated` |
| | `terminated` | bool | the lineage ended in this generation |
| | `termination_class` | string | `none`, `time_limit`, `negative_counts`, `fba_infeasible`, `equilibrium_unstable`, `other` |
| | `translation_collapse` | bool | `ribosome_elongation_rate_mean < 1` in `summary`; null until finalize fills it, and where there is no summary row |
| | `termination_reason` | string | raw reason text |
| | `division_time_sec` | float32 | `n_steps - 1` when divided, else null |
| | `final_mass_fg` | float32 | cell mass at the last row |
| | `growth_rate` | float32 | mean of non-null `growth_rate` |
| | `lineage_terminated` | bool | the lineage was ended by a termination (in its last present generation) |
| | `lineage_generations` | int8 | generations present in the lineage |
| splits | `split_by_lineage` | string | train / val / test |
| | `split_by_gene` | string | train / val / test |
| provenance | `job_id` | int32 | campaign job |
| | `attempt` | int8 | attempt that produced the run |
| | `started_at` | string | attempt start time |
| | `run_dir` | string | run directory under `out/` |
| | `h5_group` | string | group in the run's `export/channels.h5`, `seed<S>/gen<G>` with S the run's seed, e.g. `seed0/gen0`; export reads through it |
| | `git_hash` | string | code revision of the attempt |
| | `parca_cache` | string | Parca cache directory (`<hash>` of `out/parca_cache_<hash>`); the cache is not distributed |
| | `kb_sha256` | string | sha256 of that cache's `kb/simData.cPickle`, the fitted parameter set the run used; the set itself is not distributed |
| | `sim_options_hash` | string | sha256 of `metadata.json` minus the per-run keys and the keys carried as columns (`git_hash`, `timeline`, `multi_ko_indices`); key into `provenance/sim_options/` |
| locators | `<config>_file` | string | part file holding the sample in that config |
| | `<config>_row_offset` | int64 | first row in that file |
| | `<config>_n_rows` | int32 | rows in that file |

There is one locator triple per config; it is null until `finalize` fills it, and null for
a sample excluded by QC. The campaign ran under 5 distinct git hashes, and 2,288 retried jobs
ran newer code than their first attempt, which is why `git_hash` is per sample.

### Known defects in the campaign database

The index is built from the database, but two of its fields are wrong and are not used as
labels:

- **T4 transcription-factor names.** The `tf_activity` variant indexes the TFs by sorted
  TF *id* (`tfList = sorted(tf_to_active_inactive_conditions)`), while the campaign named
  the T4 experiments from the sorted TF *symbols*. So `experiments.name` and `condition`
  name the wrong TF for every T4 TF cell: `[T4] araC/active` (index 1) ran `CPLX-125`, which
  is trpR. The index takes the TF from the variant index and
  `reconstruction/ecoli/flat/condition/tf_condition.tsv`, checks it against the run's
  description, and uses it for `cell_id` (`T4/trpR/active`), `tf_target` and
  `tf_target_id`; `experiment_name` keeps the campaign's (wrong) name.
- **`simulation_results.divided`** is a mass-ratio heuristic, false for many cells that
  divided (and division times are often null). Outcomes are rebuilt from termination
  instead (Outcome labels above, ADR 0005).


## 5. Pipeline

All stages run through `cluster/w4c` with the knobs in `cluster/well4cell_env.sh`. The array
stages follow the campaign's ledger pattern: a frozen manifest per dispatch, one atomic
sentinel per task, an append-only ledger, and `cluster/well4cell.sbatch` always exits 0.

1. **scan** (SLURM array): read every run's `channels.h5` once. Records generations present,
   shapes and step counts, attributes, the reference-id hash, and the per-column active
   masks. `scan reduce` folds the shards into `build/scan/runs.jsonl`, the global active
   union and the reference tables.
2. **index**: `index build` writes `index.parquet` and `provenance/sim_options/` from the
   campaign database, each run's `metadata.json` and the scan, and hashes each Parca cache's
   `kb/simData.cPickle` once for `kb_sha256`; it fails if the sources disagree on seed or
   variant, or a cache cannot be read. `index reference` writes the database reference tables
   (genes, conditions, timelines, media recipes, TF edges, TF activity).
3. **export** (SLURM array): one task per output part (one config, one family, ~2 GB).
   Resumable: a re-run skips parts whose success sentinel exists. Each sentinel reports
   rows, bytes, per-sample offsets, QC results and a stats file.
4. **finalize**: fold the export sentinels into the index locators, write
   `export_qc.parquet`, merge the stats into `stats/<family>.parquet`, write
   `failed_jobs.parquet` and `scan_runs.parquet`, render the dataset card, and write
   `manifest.json` (with the `kb_sha256` of each Parca cache). It does not copy the Parca
   caches (ADR 0009) and refuses an index without `kb_sha256`. It refuses while any planned
   part of the configs being finalized lacks an `ok` sentinel (`--allow-incomplete`
   overrides) and only warns about other configs.
   **summarize** (after finalize): stream the core parts into `data/summary/<family>/`,
   one row per trajectory, refusing unless the rows match the index's core locators one for
   one (`n_steps == core_n_rows`); then finalize again so the card and `manifest.json` list
   the summary (ADR 0010). Once the `expression` export is complete, `summarize --pathways`
   adds the 13 pathway fractions to the same parts; then finalize and upload the summary again.
   **deg-rates** (any time after `index build`): for each Parca cache the index names, run
   `well4cell_build.deg_rates` under the simulation environment (`W4C_SIM_PYTHON`, which can
   unpickle `simData.cPickle` and `rawData.cPickle`), classify every mRNA transcription unit
   as floor, ceiling, imputed or determined, and write
   `build/provenance/deg_rates_<parca_cache>.json`, refusing one whose `kb_sha256` differs
   from the index. The next finalize reads the files from `build/provenance/` and puts only
   their aggregates (units per class, not-a-fit share of basal mRNA expression) in the card
   and `manifest.json` (`deg_rates`); it never copies them into the repo and refuses while a
   copy from an earlier finalize is still in `repo/provenance/`. Without the files nothing
   refuses and the card has no paragraph.
5. **hub**: `hub create` creates the repo private; `hub upload` pushes `repo/` with
   `hf upload`, resumable by re-running. huggingface_hub 2.1 has no `upload-large-folder`,
   the tool never deletes anything remotely, and every upload excludes
   `provenance/parca_cache_*`, `*.cPickle` and `deg_rates_*.json`.

Storage: confirm the organisation's plan, or email Hugging Face for an academic storage
grant, before uploading the 1 s matrix configs.

## 6. QC gates

Applied per trajectory during export. A trajectory that fails any gate is not written, and
is listed with its reasons in `provenance/export_qc.parquet` (which also records every pass).

- `t` is strictly increasing by exactly 1 and the step count matches the scan's `n_steps`.
- NaN appears only at `growth_rate[0]` (written as null).
- Count channels and count matrices are non-negative and integral.
- Reaction fluxes are `>= -1e-6` (smaller magnitudes are solver noise).
- The reference ids (gene, monomer, reaction, exchange lists) hash identically to the
  campaign's.

## 7. Known losses

- Only the 18 scalars and the 4 matrices survived pruning of the raw output; nothing else
  can be recovered.
- `aa_pool_size`, `ntp_pool_size` and `trna_charged_fraction` were never written: a
  column-name mismatch in `table_reader_bridge` dropped them, and the raw output they would
  have been recomputed from is deleted.
- 971 failed jobs have no trajectories; they appear only in `failed_jobs.parquet`.

## 8. Consumer package

`well4cell`, in its own repository, published on PyPI; torch is an optional extra. Each
release pins a dataset revision.

- `index()`: the index as a DataFrame.
- `load(config, family, where, columns)`: rows, read through the locators.
- `Trajectory` and `Lineage` objects.
- `windows()` and a torch `Dataset` over fixed-length windows.
- `split(by=...)`: the index split columns.
- `Normalizer` built from `stats/`.
- `genes()`: the reference tables.

The dataset card defines three tasks, with baselines shipped as package examples:
growth-rate regression, viability (does the generation divide), and forecasting (horizon in
seconds).

## 9. Open items

- **Storage grant**: confirm the org plan or obtain an academic grant before the
  `expression_1s` and `metabolism_1s` uploads.
- **Package**: the `well4cell` repository, PyPI release and baselines.
- **DOI**: mint at release, after the repo goes public with the `v1.0` tag.
- **Degradation-rate provenance, first run**: `deg_rates.py` is tested on synthetic arrays
  only; its loader has never read a real cache. Check the first output: counts near
  Cellarium's 854 of 3,133 units and 12% of basal mRNA expression, each unit in exactly one
  class, and `cellarium_rule` (Cellarium's value-only rule, computed alongside) close to the
  main counts.
- **Degradation-rate provenance, licence**: decided 2026-10-15, not distributed. The
  per-cache files (per-unit classes, expression shares, bounds, imputation constant) are a
  derived summary of the fitted parameters, which ADR 0009 rejects shipping; they stay on
  klone. The card and `manifest.json` carry aggregates only: units per class and the
  not-a-fit share of basal mRNA expression, per cache.
- **Card numbers**: the final counts, sizes and active-column totals are filled into the card
  from the finalize manifest; the figures in this document marked as sampled or measured on
  one run are estimates until then.
