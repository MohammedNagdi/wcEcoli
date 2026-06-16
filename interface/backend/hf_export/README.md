# wcEcoli → Hugging Face dataset export

Packages completed whole-cell simulations into the HF dataset layout ("The Well, for the cell"). See
`HF_DATASET_DESIGN.md` (repo root) for the full design, benchmark tasks, and tiered roadmap.

## Pieces
- `matrix.py` — the **locked v0 campaign** (what to simulate): knockouts + static conditions +
  **dynamic media (timelines / sinusoidal) from day one** so the T3 forecasting benchmark exists in
  v0. `SEEDS`, `GENERATIONS`, condition sets, `KO_TARGET` are tunable to your compute budget.
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

**1 — Submit the v0 campaign (generation).** Validate first with `--dry-run` (creates nothing):
```
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --limit 8 --seeds 2 --generations 2
docker exec interface-api-1 python -m hf_export.submit_campaign           --limit 8 --seeds 2 --generations 2
```
The real run creates experiments + queues jobs; **the worker then runs them** (watch the Experiments
page until `done`). Submittable now: `wildtype`, `gene_knockout`, timeline-based dynamics; exotic
variants (`sinusoidal_media`, ppGpp, aa_*) are skipped with a reason. `--limit N` caps cells (the
matrix orders all WT conditions first, then KOs, then dynamics). `--sample` picks a stratified mix
(WT + KO + a dynamic run) instead of the first-N — use it for a representative mini-pilot.

**2 — Export the completed jobs.** Run **after** the jobs finish:
```
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_v0
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_v0_full --full-tensors
```
Output (`trajectories.h5`, `metadata.jsonl`, `manifest.json`) lands at `/app/eval/...` in the
container = **`interface/backend/eval/...` on the host** (the eval bind mount).

> ⚠️ **Git Bash path mangling:** in MSYS/Git Bash a leading `/app/...` arg gets rewritten to
> `C:/Program Files/Git/app/...`. Prefix with `MSYS_NO_PATHCONV=1`. **PowerShell is unaffected** —
> the commands above work as-is in PowerShell.

## HDF5 layout
```
/reference/<matrix>_ids                 # column ids (gene/monomer/reaction), stored ONCE
/cond=<c>/geno=<g>/seed=<s>/gen=<n>
    attrs: variant_type, ko_gene, condition, seed, generation, job_id, divided, summary metrics…
    <scalar_channel>/value [T] float32          <scalar_channel>/time [T] float32 (attrs.unit)
    <matrix_channel>/value [T, N] float32       # with --full-tensors; attrs.n_columns
```
`metadata.jsonl` is one flat row per cell trajectory — the index for splits + the benchmark tasks.

## Verified (real data)
- 8 WT experiments → 16 jobs → 32 trajectories exported; 18 scalar channels.
- `--full-tensors` on a WT/basal cell: mRNA `(2530, 3133)`, protein `(2530, 4310)`, reaction-flux
  `(2530, 9612)`, exchange-flux `(2530, 87)`; `/reference` id maps (e.g. `TU-8381[c]`); ~15 MB/traj.

## Tests
```
docker exec interface-api-1 python -m pytest hf_export/ -q
```
(or locally: `.venv/Scripts/python -m pytest hf_export/ -q`).

## Status / next
- ✅ M1 (matrix + converter), submitter, and full-tensor channels — done + unit-tested.
- ⏭ **M2 (HF release packaging):** dataset card, croissant metadata, canonical held-out splits,
  PyTorch dataloader (reads `/reference` ids + `(T, N)` matrices), and baselines.
- Big `.h5` shards are git-ignored (`eval/.gitignore`) — they belong on Hugging Face, not in git.
