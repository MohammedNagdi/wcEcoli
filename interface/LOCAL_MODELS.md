# Running local models (Ollama) with the wcEcoli platform

The Assistant can use local models via Ollama (no API keys, no data leaving the machine). Local models
have **hardware requirements** that, if exceeded, crash the model server — and on Docker-for-Windows
that crash can cascade into killing the platform's containers. This doc captures the requirements, the
gotcha we hit, and the fixes, so you can run local models reliably and tell users what they need.

## TL;DR
- A 4-bit model needs **free RAM/VRAM ≈ its size**: `~3B ≈ 3 GB`, `8B ≈ 6 GB`, `12B ≈ 8 GB`,
  `14B ≈ 10–12 GB` (+ a context cache).
- On **Docker Desktop (WSL2 backend)** the Linux VM grabs **~50% of host RAM by default**, starving
  Ollama. Cap it with **`%UserProfile%\.wslconfig`** (see [`.wslconfig.example`](./.wslconfig.example)).
- The assistant now **bounds `num_ctx`** and the eval **unloads each model before the next**, so memory
  stays small and predictable.

## What broke (the case study)
On a **32 GB / RTX 4070 Laptop (8 GB VRAM)** machine, `qwen2.5-coder:14b` crashed repeatedly
(`llama-server.exe` OOM: `0xc0000005`, `0xe06d7363`), and the memory pressure **OOM-killed all three
Docker containers** (`Exited (137)` = SIGKILL).

Root causes:
1. **WSL2 ate 16 GB** (default 50% of 32 GB) — confirmed by the container seeing `MemTotal: 16 GB`.
   That left too little host RAM for Ollama.
2. **8 GB VRAM can't hold a 14B (~9 GB)** → Ollama spills layers + KV cache to system RAM, which then
   collided with the WSL2 hog → OOM. (8B models fit *entirely* in 8 GB VRAM → fast, no spill.)
3. **`keep_alive: 30m`** pinned each model in RAM, so benchmarking several models *stacked* them
   (8B + 8B + 14B ≈ 20 GB) → guaranteed OOM in the multi-model run.

It was **not** insufficient hardware — 32 GB + a 4070 is plenty. It was the WSL2 default + memory
management.

## The fix
### 1. Cap the WSL2 VM (frees host RAM for Ollama)
Create `%UserProfile%\.wslconfig` (e.g. `C:\Users\<you>\.wslconfig`) from
[`.wslconfig.example`](./.wslconfig.example):
```ini
[wsl2]
memory=12GB
swap=4GB
```
Apply it:
```powershell
# Quit Docker Desktop (tray -> Quit), then:
wsl --shutdown
# Reopen Docker Desktop, wait for it to start, then:
cd C:\dev\wcEcoli\interface
docker compose up -d
# Verify (should read ~12.5 GB, not 16):
docker exec interface-api-1 sh -c "grep MemTotal /proc/meminfo"   # -> MemTotal: ~12247116 kB
```
> On the WSL2 backend, Docker Desktop's **Settings → Resources → Memory slider is disabled** —
> `.wslconfig` is the *only* way to set container memory. (Ollama runs on the Windows host, so
> `wsl --shutdown` does not interrupt `ollama pull`/serving.)

**Result (verified):** after the cap, `qwen2.5-coder:14b` loads cleanly — `/api/ps` shows
`10.4 GB on GPU`, and the full eval runs with no OOM.

### 2. Code-level mitigations (already in the platform)
- **Bounded context** — every Ollama call sends `options.num_ctx` (default **8192**, configurable via
  `assistant_ollama_num_ctx`) instead of the model's 32K max, keeping the KV cache small.
- **Eval unloads between models** — `eval/run_eval.py` evicts each model (`keep_alive=0`) before the
  next loads, so a multi-model sweep never stacks models in RAM.
- **`keep_alive`** is configurable (`assistant_ollama_keep_alive`, default `30m`) — lower it if you
  switch models often on a tight machine.

## The memory trade-off (one knob, two consumers)
`.wslconfig memory` splits host RAM between Docker and Ollama:
- **Benchmarking / using local models:** keep Docker small (**12 GB**); Ollama gets the rest. Stop the
  worker (`docker stop interface-worker-1`) for heavy models as belt-and-suspenders.
- **Large simulation campaigns:** the Docker **worker is RAM-heavy** (ParCa + sims) — raise to
  **18–20 GB** and re-`wsl --shutdown`.

## What runs on what (rule of thumb)
| Free RAM / VRAM | Comfortable models |
|---|---|
| 8 GB VRAM | any **≤8B** fully on GPU (fast): qwen3:8b, llama3.1:8b, command-r7b, granite3.3:8b, hermes3:8b |
| ~10–12 GB free RAM (WSL2 capped) | **12–14B** partial-GPU (slower, fine): mistral-nemo:12b, qwen2.5-coder:14b |
| <6 GB free | **≤3B** only: llama3.2 |

## Benchmarking local models
Use the eval harness (it unloads between models):
```powershell
docker exec interface-api-1 python -m eval.run_eval --dataset eval/datasets/oneshot.v1.json \
  --models "ollama:command-r7b,ollama:granite3.3:8b,ollama:hermes3:8b" --out eval/results
# heavy models alone, worker stopped:
docker stop interface-worker-1
docker exec interface-api-1 python -m eval.run_eval --dataset eval/datasets/oneshot.v1.json \
  --models "ollama:qwen2.5-coder:14b" --out eval/results --limit 4   # --limit for a quick controlled run
docker start interface-worker-1
```
See `backend/eval/README.md` for the scorecard/transcript outputs and the Claude-as-judge workflow.

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| `llama-server.exe` crash dialog (`0xc...`) | model exceeds free memory (OOM) | cap WSL2 (`.wslconfig`), stop worker, use a smaller model |
| Containers `Exited (137)` | host OOM killed the Docker VM | restart: `docker compose up -d`; cap WSL2 to prevent recurrence |
| Assistant very slow on a big model | model doesn't fit VRAM → CPU offload | use a ≤8B model (fits 8 GB GPU), or accept the speed |
| `/api/ps` shows nothing after a call | model failed to load (OOM) | free RAM as above |
