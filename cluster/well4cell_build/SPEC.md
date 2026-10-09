# well4cell build: contracts between stages

Design decisions are final (see docs/well4cell/DESIGN.md; the owner of this
file is the build manager). This file is the interface contract the stage owners code to.

## Tree

```
$W4C_ROOT/ (default $WCECOLI_CAMPAIGN_ROOT/well4cell)
  build/   manifests/ <stage>_<ts>_<id>.jsonl + .sentinels/   logs/   scan/runs.jsonl   scan/active_union.npz   index_report.json   ledger.jsonl   dispatch_log.jsonl
  repo/    README.md  manifest.json  index.parquet  stats/<family>.parquet  provenance/...  data/<config>/<family>/part-NNNNN.parquet
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
provenance: job_id int32, attempt int8, started_at, run_dir, h5_group ("seed0/gen0": the scan's seed group, seed<S> with S = the job's seed), git_hash, parca_cache, sim_options_hash (sha256 of metadata.json minus description/time/seed/variant and minus the keys carried as columns: git_hash, timeline, multi_ko_indices)
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

## parquet
compression zstd, row_group_size W4C_ROW_GROUP_ROWS (2048), sample_id dictionary-encoded, units in field metadata (b"unit"), file metadata: {"well4cell_version", "config", "family", "stride"}.
Column order: sample_id, t, t_abs, 18 scalars in settings.SCALAR_CHANNELS order, then matrices as fixed_size_list<int32|float32>.

## Ownership
scan.py / h5io.py / settings.py / ledger.py: manager (done). index.py + perturbation.py: agent "index".
export.py + stats.py: agent "export". finalize.py + card.py + hub.py: agent "publish". docs/: agent "docs".

## finalize completeness rule
finalize refuses while any part planned (in any export manifest) for the configs being
finalized (`--configs`, default all) has no sentinel or a failed one; incomplete parts of other
configs only warn. `--allow-incomplete` overrides. Parca caches are copied byte-for-byte
(shutil.copyfile), never hard-linked.
