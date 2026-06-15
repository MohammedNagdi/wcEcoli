# wcEcoli → Hugging Face dataset export (v0)

Packages completed whole-cell simulations into the HF dataset layout. See `HF_DATASET_DESIGN.md`
(repo root) for the full design, benchmark tasks, and tiered roadmap.

## Pieces
- `matrix.py` — the **locked v0 campaign** (what to simulate). Knockouts + static conditions +
  **dynamic media (timelines / sinusoidal) from day one** so the T3 forecasting benchmark exists in
  v0. Counts (`SEEDS`, `GENERATIONS`, condition sets, `KO_TARGET`) are tunable to your compute budget.
- `converter.py` — `simOut → HDF5 + metadata`. v0 ships the ~21 scalar trajectory channels the
  platform already extracts (masses, growth, volume, ppGpp, AA pools, mRNA total, FBA
  objective/fluxes, ribosome rates, replication). Per-gene/per-reaction matrices are v1/v2.
- `run_export.py` — drives the export over completed jobs.

## Run (inside the api container — it has the sim-output volume + readers)
```
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_v0 --limit 10
```
Outputs `trajectories.h5`, `metadata.jsonl`, `manifest.json`. (`--limit` makes the 10-sim pilot shard.)

## HDF5 layout
```
/cond=<c>/geno=<g>/seed=<s>/gen=<n>
    attrs: variant_type, ko_gene, condition, seed, generation, job_id, divided, summary metrics…
    <channel>/value [T] float32   <channel>/time [T] float32 (attrs.unit)
```
`metadata.jsonl` is one flat row per cell trajectory — the index for splits + the benchmark tasks.

## Status / next
- v0 converter + matrix are done and unit-tested (`python -m pytest hf_export/`).
- The 10-sim pilot shard needs real completed sims (run the v0 campaign via the platform's batch
  builder, then export). Remaining for the HF release: dataset card, croissant metadata, canonical
  splits, dataloader, baselines (M2).
