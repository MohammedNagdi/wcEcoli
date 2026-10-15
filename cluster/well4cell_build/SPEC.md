# well4cell build: contracts between stages

Design decisions are final (see docs/well4cell/DESIGN.md; the owner of this
file is the build manager). This file is the interface contract the stage owners code to.

## Tree

```
$W4C_ROOT/ (default $WCECOLI_CAMPAIGN_ROOT/well4cell)
  build/   manifests/ <stage>_<ts>_<id>.jsonl + .sentinels/   logs/   scan/runs.jsonl   scan/active_union.npz   index_report.json   ledger.jsonl   dispatch_log.jsonl
           provenance/deg_rates_<parca_cache>.json
  repo/    README.md  manifest.json  index.parquet  stats/<family>.parquet  provenance/...  data/<config>/<family>/part-NNNNN.parquet
           data/summary/<family>/part-00000.parquet
```

## Families (by tier parsed from experiments.name prefix `[T1]`..`[T5]`; `[T2_CORE]` is T2)
T1 wildtype_media, T2 single_knockout, T3 dynamic_media, T4 regulation, T5 double_knockout.
This tier order (settings.FAMILIES) is THE family order everywhere: index rows, export plan
parts, card tables and front matter.

## Configs (settings.CONFIGS)
core (stride 1, scalars only), expression (10 s; mrna_counts_matrix + protein_counts_matrix),
metabolism (10 s; reaction_flux_matrix + exchange_flux_matrix), expression_1s, metabolism_1s.
Stride rule: keep rows with t % stride == 0 plus the last row. Matrix columns are pruned to
the active set from provenance/reference/<matrix>.parquet (`active`, `product_column`).
Every config repeats the 18 scalars plus sample_id, t, t_abs.

## scan/runs.jsonl (one line per run, written by scan reduce; schema from scan.py)
run_dir, job_id, job_status (done|failed), status (ok|failed|missing), seed, reference_hash,
reference_sizes{matrix: N}, generations[{generation, n_steps, t0, t_end, uniform_1s, channels[], matrices[], attrs{}}].

## Summary config (settings.SUMMARY_CONFIG = "summary"; summarize.py; docs/adr/0010)
Not in settings.CONFIGS: not exported, no export sentinels, no index locator columns.
`summarize` (after finalize has filled the core locators) streams repo/data/core/<family>/part-*.parquet
and writes repo/data/summary/<family>/part-00000.parquet, one row per trajectory in index order:
sample_id (string), n_steps (int32), then for each scalar in SCALAR_CHANNELS order
<channel>_mean, _min, _max, _first, _last over the 1 s core rows. float32 for float channels; for
INT_SCALARS min/max/first/last are int32 and mean float32. Nulls are skipped (growth_rate row 0, so
growth_rate_first is the value at t = 1); a statistic with no non-null value is null. Field metadata
`unit` from the core field; file metadata as below with config "summary", stride 1. Refuses (writes
nothing) unless, per family, the rows are exactly the index rows with a non-null core_file, each with
n_steps == core_n_rows and starting at core_row_offset of core_file. --core-dir, --index, --out-dir
override the repo/ paths (to run on downloaded core parts). finalize counts summary parts from the
files (rows = trajectories), skips them in the orphan-file check, warns when a family's rows differ
from its located core trajectories, never refuses for a missing summary, and drops a summary family
whose core family is held back. hub upload accepts `summary` as a part.
`summarize --pathways` (pathways.py) appends, after the statistics, one float32 column `pathway_<name>`
(unit `fraction`) per pathway of data/pathways.json (Cellarium's PATHWAY_PANEL, MIT, copied): per
expression row, sum of the pathway's protein_counts_matrix columns over the row sum (a row summing to 0 is
skipped), mean over the trajectory's 10 s rows. Symbols resolve via provenance/reference/genes.parquet
symbol -> monomer_id -> protein_counts.parquet id minus its `[c]` compartment suffix -> product_column;
unresolved symbols and pruned (active false) monomers are logged to stderr, a pathway with no column is
fatal. It refuses, writing nothing, if a family being summarized has no repo/data/expression/<family>
parts (--expression-dir, --reference-dir override the paths), and when the index has expression locators
the expression trajectories and row counts must equal them; a summary row without expression rows gets
nulls. Without --pathways there are no pathway columns. Run it once the expression export is complete.
finalize lists the pathway columns of the summary parts (config entry `pathways`, per family
`pathway_columns`) and the card describes them; finalize also counts `translation_collapse`
(ribosome_elongation_rate_mean < settings.COLLAPSE_RATE = 1 aa/s, and how many have termination_class
none) from the summary parts into the card's Outcomes and manifest.json `translation_collapse`.

## index.parquet (one row per trajectory, sorted by family in tier order T1..T5, then cell_id, seed, generation)
Column order and types: index.schema(). Column provenance: index.py and perturbation.py docstrings.
identity: sample_id (= lineage_id + "/g{gen}"), lineage_id (= cell_id + "/s{seed}"), cell_id
  (experiments.name slugified, tier prefix normalised: "[T2_CORE] argG_KO/basal" -> "T2/argG_KO/basal",
  "[T3] argG_KO/rich_to_minimal" -> "T3/argG_KO/rich_to_minimal"; must be unique per experiment; EXCEPT
  T4 tf_activity, whose DB names name the wrong TF: cell_id = "T4/<true TF symbol>/<state>"),
  parent_id (string, null at gen 0), experiment_name (raw experiments.name)
design: family, tier ("T1".."T5"), variant_type, variant_index (int32), variant (gene symbol / "wildtype" / variant_type), condition (DB, as designed), timeline (the schedule that actually ran, "0 minimal, 1200 minimal_acetate"; null for sinusoidal), seed (int8), generation (int8)
perturbation: knockout_genes list<string>, knockout_gene_ids list<string>, knockout_tu_ids list<string> (a knockout zeroes a whole TU), media_schedule list<struct<t_abs_sec:int32, medium:string>> (lineage-absolute seconds), medium_at_birth, medium_at_division, media_a, media_b, period_sec (int32, sinusoidal only), tf_target (true TF symbol), tf_target_id (TF EcoCyc id), tf_state, ppgpp_setpoint_um (float32), ppgpp_factor (float32), aa_shift (string), perturbation_text
outcome: n_steps int32, divided bool (= not terminated), terminated bool (lineage ended in THIS generation), termination_class string (none|time_limit|negative_counts|fba_infeasible|equilibrium_unstable|other), termination_reason, division_time_sec float32 (= n_steps-1 when divided else null), final_mass_fg float32, growth_rate float32 (mean of non-null growth_rate), lineage_terminated bool, lineage_generations int8 (generations present)
splits: split_by_lineage, split_by_gene (string train|val|test; fixed seed W4C_SPLIT_SEED; 80/10/10; lineage split stratified by cell within family; gene split holds out whole genes, non-knockout rows go to train)
provenance: job_id int32, attempt int8, started_at, run_dir, h5_group ("seed0/gen0": the scan's seed group, seed<S> with S = the job's seed), git_hash, parca_cache (the <hash> of out/parca_cache_<hash>), kb_sha256 (sha256 of out/parca_cache_<hash>/kb/simData.cPickle, hashed once per distinct cache at index build; an unreadable cache is fatal), sim_options_hash (sha256 of metadata.json minus description/time/seed/variant and minus the keys carried as columns: git_hash, timeline, multi_ko_indices)
locators (filled by finalize, null before): <config>_file, <config>_row_offset (int64), <config>_n_rows (int32) for each config name.

## export manifest line
{plan, part (array index), config, family, path ("data/<config>/<family>/part-00012.parquet"), samples:[{sample_id, run_dir, h5_group, n_steps}]}
run_dir, h5_group and n_steps are copied from index.parquet; export reads the trajectory at
<out>/<run_dir>/export/channels.h5 [h5_group] and never constructs a group name itself.
Parts are planned config by config, families in tier order, samples in index order.
## export sentinel (per part, <manifest stem>.sentinels/NNNNN.json):
{plan, part, status ok|failed, config, family, path, planned_path, bytes, rows, qc_failed, seconds, started_at, finished_at,
 samples:[{sample_id, row_offset, n_rows, seconds, qc:{ok:bool, reasons:[...]}}], stats_npz (path), error}
All-QC-failed part: status ok, path null, planned_path = the manifest path, bytes 0, rows 0, no
parquet written; its samples (row_offset/n_rows null) still go to export_qc. A failed part has
status failed, samples [] (finalize takes them from the manifest), stats_npz null.
QC gates per trajectory: t strictly increasing by 1 and n_steps == scan n_steps; growth_rate NaN allowed ONLY at row 0 (nulled in parquet); count channels/matrices >= 0 and integral; reaction flux >= -1e-6; reference hash equals the campaign's. Failing trajectories are skipped (not written) and reported.
Stats npz per part, at <manifest stem>.sentinels/NNNNN.stats.npz (stats.Moments.save): key
`names` (the channel names in insertion order) plus, for every name, five float64 arrays
`<name>.n`, `<name>.sum`, `<name>.sumsq`, `<name>.min`, `<name>.max` of shape [k]: k = 1 for a
scalar channel, k = active columns in product_column order for a matrix. NaN is not counted
(growth_rate row 0); a column with no finite value has n 0, min +inf, max -inf. finalize sums
n/sum/sumsq and reduces min/max over the parts of a family into stats/<family>.parquet.

## parquet (summary: see above; one row per trajectory, sample_id plain string)
compression zstd, row_group_size W4C_ROW_GROUP_ROWS (2048), sample_id dictionary-encoded, units in field metadata (b"unit"), file metadata: {"well4cell_version", "config", "family", "stride"}.
Column order: sample_id, t, t_abs, 18 scalars in settings.SCALAR_CHANNELS order, then matrices as fixed_size_list<int32|float32>.

## Ownership
scan.py / h5io.py / settings.py / ledger.py: manager (done). index.py + perturbation.py: agent "index".
export.py + stats.py: agent "export". summarize.py, deg_rates.py, finalize.py + card.py + hub.py: agent "publish". docs/: agent "docs".

## finalize completeness rule
finalize refuses while any part planned (in any export manifest) for the configs being
finalized (`--configs`, default all) has no sentinel or a failed one; incomplete parts of other
configs only warn. `--allow-incomplete` overrides.

## Parca caches are never published (docs/adr/0009)
They are wcEcoli's fitted parameters (Stanford licence), not simulation output. finalize does
not copy them; the repo identifies them by index `parca_cache` + `kb_sha256` and by
manifest.json `kb_sha256` ({parca_cache: sha256}). finalize refuses an index without
kb_sha256 or with a cache that has other than one hash, and warns about a stale
repo/provenance/parca_cache_* left by an older finalize. hub upload always excludes
`provenance/parca_cache_*/**`, `**/*.cPickle` and `**/deg_rates_*.json`.

## Degradation-rate provenance (deg_rates.py)
`deg-rates [--cache h1,h2]` runs, per Parca cache the index names (default) or given, `W4C_SIM_PYTHON -m
well4cell_build.deg_rates <out>/parca_cache_<h> --out build/provenance/deg_rates_<h>.json --parca-cache <h>`
(W4C_SIM_PYTHON: a command line for wcecoli-sim; PYTHONPATH = repo/cluster:repo, cwd repo root). The child
unpickles kb/simData.cPickle and kb/rawData.cPickle and classifies every mRNA TU (rna_data is_mRNA) as floor,
ceiling, imputed or determined (module docstring; rate divided by its rna_deg_rates_adjustments factor first;
relative tolerance RTOL), weighted by rna_expression['basal'] over mRNA. The pure part, `provenance(...)`
(numpy in, dict out), is what the tests cover; `load_inputs` is untested here. JSON keys (Cellarium's
deg_rate_baseline.json where the meaning is the same): parca_cache, kb_sha256 (of simData.cPickle),
generated_by, n_mrna_units, rate_floor_as_half_life_min, rate_ceiling_as_half_life_min,
imputation_constant_min, n_measured_mrna_cistrons, on_floor / on_ceiling / imputed_average / not_a_fit /
determined {n_units, pct_units, pct_expression}, most_expressed_not_a_fit [{id, class,
pct_of_mrna_expression}] (8), units_not_a_fit {floor|ceiling|imputed: {id: pct}, determined_is_the_complement},
adjusted_units {id: {factor, class}}, not_a_fit_across_conditions, cellarium_rule {floor, ceiling, imputed,
not_a_fit, rule}, rtol, rules, note, warnings (only when the imputation constant is not the mean of the
measured half-lives). The parent refuses (renaming the file to .mismatch) when kb_sha256 differs from the
index's. The file is a derived summary of the fitted parameters and is never published (ADR 0009, addendum
2026-10-15): it stays in build/provenance/. finalize reads every build/provenance/deg_rates_*.json whose cache
the index names (refuses a kb_sha256 mismatch, warns and skips an unnamed cache) and records `deg_rates`
{parca_cache: {kb_sha256, mrna_units {floor, ceiling, imputed, determined, total},
not_a_fit_pct_basal_mrna_expression}} (deg_rates.aggregates) in the summary and manifest.json; nothing else
from the file. It refuses, before writing anything, while repo/provenance/ holds a deg_rates_*.json (a copy
from an earlier finalize) and tells the user to delete it. The card's Provenance section gets a paragraph
with those counts only when `deg_rates` is non-empty.
