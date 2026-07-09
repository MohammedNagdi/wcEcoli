# wcEcoli → Hugging Face dataset export

Packages completed whole-cell simulations into the HF dataset layout ("The Well, for the cell"). See
`HF_DATASET_DESIGN.md` (repo root) for the full design, benchmark tasks, and tiered roadmap.

## Pieces
- `matrix.py` — the fixed tiered campaign plan: T1 covers WT static references, T2 covers
  single-gene KOs, T3 covers dynamic media, T4 covers regulatory variants, and T5 covers curated
  multi-gene KOs. `SEEDS`, `GENERATIONS`, condition sets, and target counts are tunable to your
  compute budget.
- `submit_campaign.py` — turns the matrix into experiments + queued jobs (the **generation** side). It
  only *enqueues*; the platform worker runs the sims.
- `converter.py` + `run_export.py` — `simOut → HDF5 + metadata.jsonl + manifest.json` (the **export**
  side). Ships ~21 scalar trajectory channels by default; `--full-tensors` adds the high-dimensional
  per-gene mRNA/protein and per-reaction flux matrices.

## End-to-end workflow (the commands we ran)

All run **inside the api container** (it has the sim-output volume + TableReader). Apply the mounts
once so `eval/` and `hf_export/` are live:
```
docker compose up -d api          # applies the ./backend/{eval,hf_export} bind mounts
```

**1 — Submit a campaign tier (generation).** Validate first with `--dry-run` (creates nothing):
```
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T1 --limit 8 --seeds 2 --generations 2
docker exec interface-api-1 python -m hf_export.submit_campaign           --tiers T1 --limit 8 --seeds 2 --generations 2
```
The real run creates experiments + queues jobs; **the worker then runs them** (watch the Experiments
page until `done`). Submittable now: `wildtype`, `gene_knockout`, timeline-based dynamics, T3
sinusoidal/amino-acid shifts, T4 regulatory variants, and T5 curated multi-gene KOs. `--limit N`
caps cells within the selected tiers. `--sample` picks a
stratified mix instead of the first-N — use it for a representative mini-pilot. Real submissions write
a `campaign_ledger.jsonl` next to the app DB; pass `--campaign-id <stable-id>` when resuming a known
campaign so already-created cells are reused instead of duplicated.

Fixed T2 knockout tiers can be inspected or submitted with `--tiers`:
```
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T2_CORE
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T2_EXTENDED
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T2_CORE,T2_EXTENDED
```
`T2_CORE` uses all KO-ready essentials plus category-balanced nonessential samples over the core
conditions. `T2_EXTENDED` uses a smaller balanced gene set over all 21 static conditions.

The single fixed T3 dynamic-media tier includes timelines, sinusoidal media, and amino-acid shifts:
```
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T3 --limit 12 --seeds 1 --generations 1
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T3
```
Timeline protocols run WT plus a selected KO subset. Sinusoidal and amino-acid shift protocols are
WT-only until combined variant effects are supported by the simulator.

The fixed T4 regulatory tier covers runtime-indexable TF activity states plus the ppGpp sweep:
```
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T4
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T4 --seeds 1 --generations 1
```
T4 reports TFs present in the regulatory network but not covered by `tf_condition.tsv` as uncovered
metadata instead of forcing unsupported `tf_activity` indices.

The fixed T5 multi-gene knockout tier covers 75 curated two-gene KO pairs over the T2 core
conditions, producing 375 cells before seed/generation multipliers:
```
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T5
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T5 --seeds 1 --generations 1
```
T5 uses the platform's `multi_gene_knockout` metadata path, so pairs are validated and canonicalized
before submission.

**2 — Export the completed jobs.** Run **after** the jobs finish:
```
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_v0
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_v0_full --full-tensors
```
Output (`trajectories.h5`, `metadata.jsonl`, `manifest.json`) lands at `/app/eval/...` in the
container = **`interface/backend/eval/...` on the host** (the eval bind mount). Export also writes
`export_qc.jsonl`, a durable row-per-export-attempt ledger for exported, no-division, malformed, and
missing-output trajectories.

> ⚠️ **Git Bash path mangling:** in MSYS/Git Bash a leading `/app/...` arg gets rewritten to
> `C:/Program Files/Git/app/...`. Prefix with `MSYS_NO_PATHCONV=1`. **PowerShell is unaffected** —
> the commands above work as-is in PowerShell.

## HDF5 layout
```
/reference/<matrix>_ids                 # column ids (gene/monomer/reaction), stored ONCE
/variant=<type>/idx=<i>/exp=<experiment_id>/job=<job_id>/seed=<s>/gen=<n>
    attrs: campaign_tier, variant_type, variant_index, experiment_id, sim_params_hash,
           ko_gene, condition, seed, generation, job_id, divided, summary metrics…
    <scalar_channel>/value [T] float32          <scalar_channel>/time [T] float32 (attrs.unit)
    <matrix_channel>/value [T, N] float32       # with --full-tensors; attrs.n_columns
```
`metadata.jsonl` is one flat row per cell trajectory — the index for splits + the benchmark tasks.
`manifest.json` includes variant/tier coverage and QC counts.

## Verified (real data)
- 8 WT experiments → 16 jobs → 32 trajectories exported; 18 scalar channels.
- `--full-tensors` on a WT/basal cell: mRNA `(2530, 3133)`, protein `(2530, 4310)`, reaction-flux
  `(2530, 9612)`, exchange-flux `(2530, 87)`; `/reference` id maps (e.g. `TU-8381[c]`); ~15 MB/traj.

## Tests
```
docker exec interface-api-1 python -m pytest hf_export/ -q
docker exec interface-api-1 python -m pytest app/tests/test_runtime_contracts.py -q
```
(or locally: `.venv/Scripts/python -m pytest hf_export/ -q`).

## Status / next
- ✅ M1 (matrix + converter), submitter, T1-T5 tiers, collision-safe export paths, QC sidecar,
  explicit seed submission, atomic job claiming, and full-tensor channels — done + unit-tested.
- ⏭ **T6 campaign:** genome-design and rRNA variants remain planned but not emitted.
- ⏭ **M2 (HF release packaging):** dataset card, croissant metadata, canonical held-out splits,
  PyTorch dataloader (reads `/reference` ids + `(T, N)` matrices), and baselines.
- Big `.h5` shards are git-ignored (`eval/.gitignore`) — they belong on Hugging Face, not in git.
