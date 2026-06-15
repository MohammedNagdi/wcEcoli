# Assistant evaluation harness

Quantifies assistant **response quality**, **tool-use correctness**, **faithfulness/grounding**, and
**context drift** across every configured `(provider, model)`. Built so the cheap, exact checks run
for free (and double as a CI gate), while the subjective LLM-judge scoring is an opt-in paid step.

> Status: scaffold + starter datasets. The methodology below is the agreed frame — fill in the
> dataset (target ~100 one-shot cases + several ≤50-turn scenarios) and wire a judge backend.

## What it measures

**One-shot suite** (single prompt → single answer):
- **Tool selection** — did it call the expected tool(s), and avoid the forbidden ones?
- **Faithfulness / no-fabrication** — every groundable number/ID in the answer appears in the tool
  output (catches the "Job ID 123-132" hallucination). *Free, deterministic.*
- **Format compliance** — no raw tool-call JSON leaked into the answer.
- **Side-effect correctness** — action prompts produce a confirmation card; read-only prompts don't.
- **Assertions** — per-case `contains`/`not_contains`/`regex` on the answer.
- **Latency** (and tokens/cost once the provider layer surfaces usage).
- **LLM-judge** (optional) — correctness, faithfulness, helpfulness, instruction-following (1–5).

**Multi-turn suite** (scripted ≤50-turn conversations):
- **Context drift** — `is_probe` turns recall earlier facts ("what gene count did you give me?").
- **Reference resolution & override** — "this gene" resolves; "a *different* gene" overrides the pin.
- Per-turn checks + an aggregate **probe pass rate** and average latency.

## Methodology (frontier-standard frame)

1. **Golden dataset**, categorized: `factual_lookup`, `modeling_concept`, `action_draft`,
   `multi_step`, `adversarial`, `context_override`. Each case carries the *expected tool call* +
   *machine-checkable assertions* (+ optional rubric/gold for the judge).
2. **Deterministic checks first** — free, exact, reproducible; the backbone and the CI gate.
3. **LLM-as-judge** only for subjective dims — strong judge model, **multi-sample + averaged**,
   verbosity/position-bias controls (see `judge.py`).
4. **Matrix run** over `(provider × model)`; results + a comparison scorecard per category.
5. **Reproducibility** — temperature 0 for factual one-shots, pinned prompt versions, full
   transcripts stored for diffing across runs/models.

This feeds the **model-routing** work: the per-category scorecard tells you which model is good
enough for which task tier, which becomes the routing policy (and the chat's "Auto" model mode).

## Files

| File | Role |
|---|---|
| `schema.py` | Dataset/case types (`OneShotCase`, `MultiTurnScenario`, `Assertion`, `ModelTarget`). |
| `checks.py` | Deterministic, model-free checks (tool selection, faithfulness, format, assertions). |
| `runner.py` | Runs cases against the real agent loop for a `(provider, model)`. |
| `judge.py` | Optional LLM-as-judge interface + default rubric (wire your own backend). |
| `report.py` | Builds the markdown scorecard. |
| `run_eval.py` | CLI entry point. |
| `datasets/*.example.json` | Starter datasets to copy and expand. |

## Running

Run where the backend imports and providers are configured (the API container has both):

```bash
# inside the running api container (providers already configured in its DB):
docker exec interface-api-1 python -m eval.run_eval \
  --dataset eval/datasets/oneshot.example.json \
  --models "ollama:qwen3:8b,ollama:llama3.1:8b" \
  --out /tmp/eval

# or locally from interface/backend with the backend env + a DB path:
python -m eval.run_eval --dataset eval/datasets/oneshot.example.json \
  --models "ollama:qwen3:8b" --db /path/to/wcecoli.db --out eval/results
```

Outputs `results-<ts>.jsonl` (every case + checks) and `scorecard-<ts>.md` (pass-rate matrix by
category, per-model overall + latency, most-common failing checks).

> ⚠️ Hosted models (`openai:…`, `anthropic:…`) cost money per run — the matrix multiplies cases ×
> models. Start with the local models and a small dataset slice.

## Claude-as-judge (free — no paid judge API)

Instead of paying a hosted judge, run the harness against your **local** models (free via Ollama),
then have a Claude Code session read the emitted `transcript-<ts>.md` and score it. The transcript
includes, per case: prompt, page context, rubric, **tool output (ground truth)**, the model's answer,
and the pre-computed deterministic checks — everything needed to grade without re-running.

Workflow:
1. `python -m eval.run_eval --dataset … --models "ollama:qwen3:8b,ollama:llama3.1:8b,ollama:qwen2.5-coder:14b,ollama:llama3.2:latest" --out eval/results`
2. Open the run's `transcript-<ts>.md` and ask Claude: *"Judge this eval transcript with the JUDGE rubric."*
3. Claude returns per-case scores + a model-comparison scorecard you save next to the run.

**JUDGE rubric** (1–5 each; 5 best):
- **correctness** — factually right given the tool output and the question.
- **faithfulness** — every claim supported by the tool output; no fabricated ids/numbers/names.
- **helpfulness** — answers what was asked, right level of detail, no filler.
- **instruction_following** — honors explicit constraints ("a *different* gene", "no equation",
  "no wildtype"), and for actions: *prepares* (never claims it executed).
Also flag, per case: any **hallucination**, **tool mis-selection**, **context-stickiness** (ignored
an override), or **format leak**. The deterministic checks are hints, not the verdict.

Report back: a category × model pass/score matrix, the worst failures with one-line diagnoses, and a
recommended model per task tier (this is the input to model routing).

## Extending

- **Add cases**: copy a starter dataset, add entries (aim for ~100 one-shot across the 6 categories,
  plus a handful of ≤50-turn scenarios with probes every ~10 turns).
- **Wire the judge**: implement a `JudgeBackend` (str prompt → str completion) against a strong model
  and call `judge.judge(...)` from a paid run; add its scores to the results.
- **CI gate**: run only the deterministic checks on a small slice with a local model (no `$`), fail
  the build on regressions in tool-selection / faithfulness / format.
- **Memory/compaction eval**: extend `run_multiturn` to persist a real conversation (so rolling
  summarization actually fires) when you want to score compaction fidelity directly.
