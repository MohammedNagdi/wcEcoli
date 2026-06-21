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
docker exec interface-api-1 python -u -m eval.run_eval \
  --dataset eval/datasets/oneshot.example.json \
  --models "ollama:qwen3:8b,ollama:llama3.1:8b" \
  --out /tmp/eval

# or locally from interface/backend with the backend env + a DB path:
python -u -m eval.run_eval --dataset eval/datasets/oneshot.example.json \
  --models "ollama:qwen3:8b" --db /path/to/wcecoli.db --out eval/results
```

Outputs `results-<ts>.jsonl` (every case + checks) and `scorecard-<ts>.md` (pass-rate matrix by
category, per-model overall + latency, most-common failing checks).

> ⚠️ Hosted models (`openai:…`, `anthropic:…`) cost money per run — the matrix multiplies cases ×
> models. Start with the local models and a small dataset slice.

### Multi-turn drift / recall

`datasets/multiturn.v1.json` (5 scenarios, 17 turns, 7 **probe** turns) scripts real conversations to
measure context drift: topic recall ("which gene did I ask about first?"), reference resolution ("the
fastest one — by job id"), override persistence (random-gene then back to the page selection), and
self-consistency (re-state a number/concept given earlier). Probe turns carry `is_probe: true` and a
deterministic assertion, so the drift signal is graded without a judge.

```bash
docker exec interface-api-1 python -u -m eval.run_eval \
  --dataset eval/datasets/multiturn.v1.json \
  --models "ollama:llama3.1:8b,ollama:qwen3:8b,ollama:llama3.2:latest" \
  --out eval/results --repeats 3
```

`analyze.py` reports a **Multi-turn** table — scenario pass, per-turn pass, and **probe recall** (the
isolated memory/reference metric) with Wilson CIs; `--repeats 3` aggregates to the item level.

## Claude-as-judge (free — no paid judge API)

Instead of paying a hosted judge, run the harness against your **local** models (free via Ollama),
then have a Claude Code session read the emitted `transcript-<ts>.md` and score it. The transcript
includes, per case: prompt, page context, rubric, **tool output (ground truth)**, the model's answer,
and the pre-computed deterministic checks — everything needed to grade without re-running.

Workflow:
1. `python -u -m eval.run_eval --dataset … --models "ollama:qwen3:8b,ollama:llama3.1:8b,ollama:qwen2.5-coder:14b,ollama:llama3.2:latest" --out eval/results`
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

## Statistical analysis & reproducibility (airtight, computed — not narrated)

Every number in the analysis comes from tested code over the stored results, with proper small-sample
methods — no hand-waving.

- **`python -m eval.analyze --results eval/results --out eval/results/analysis.md`** — per-model
  overall + per-category pass rates with **Wilson 95% CIs**, the **tool-emission** axis, **split skill
  axes** (tool-selection / grounding / format / assertion / side-effect, each over its applicable
  subset; grounding is conditional on tool-emission so it can't pass vacuously), and **pairwise
  significance** via **McNemar's exact test, Holm-corrected**, with paired-bootstrap Δ CIs. Each model
  uses only its newest complete run. Subjective axes (correctness/helpfulness) are deliberately left to
  a calibrated judge, not estimated.
- **`--repeats N`** on `run_eval` collects N samples/item; `analyze` then aggregates to the **item
  level** (bootstrap over items) so repeats don't pseudo-replicate the CIs.
- **`runconfig-<ts>.json`** is written per run: dataset sha256, model digests, options, harness commit.
- **`python -m eval.datasheet --dataset <file> --out <file>.DATASHEET.md`** — a Datasheets-for-Datasets
  record (provenance, composition, uses, limitations, content hash).
- Primitives + analysis are unit-tested: `pytest eval/test_stats.py eval/test_analyze.py`.

### Calibrated blinded judge (subjective axes)

`analyze.py` deliberately omits the subjective axes (correctness, helpfulness). The judge layer scores
them with bias controls so the result is trustworthy, not asserted:

1. **`python -m eval.judge_blind --results eval/results --out eval/results/judge --models "…"`** builds
   `judge_worksheet.md` — per-prompt **panels** of all models' answers with **identities hidden, order
   randomized**, plus a **reliability round** that re-presents a random subset isolated/reshuffled. The
   id→model map is written to a *separate* `judge_key.json` not opened while scoring.
2. The judge (a Claude Code session) scores every `resp_id` (correctness/helpfulness 1-5 + flags) into
   `judge_scores.jsonl`, grading correctness **against the captured tool output**, not world knowledge.
3. **`python -m eval.judge_analyze --judge eval/results/judge --out eval/results/judge/judge_report.md`**
   un-blinds and reports per-model means (bootstrap CIs) plus three diagnostics: **verbosity bias**
   (length↔score Pearson r), **position bias** (mean score by slot), and **test-retest reliability**
   (Round 1 vs Round 2). Self-preference bias is structurally low (no judged model is Claude) and
   identities are blinded regardless. Tested in `test_judge.py`.

For an **automated second judge** (inter-rater reliability vs the human/Claude pass), `judge_blind`
also emits a structured `judge_items.jsonl`, and **`python -m eval.judge_batch --judge eval/results/judge
[--submit --model claude-sonnet-4-6]`** scores every answer via a hosted model's **Batches API** (50%
off; each scoring is a single independent request — the ideal batch fit). It reads the key from the
encrypted provider config; without `--submit` it's a dry run (writes the batch + cost estimate, no
spend). Output is `judge_scores.jsonl` in the same shape `judge_analyze` consumes.

### Judge-methodology benchmark (three-way)

A single LLM judge's *absolute* 1–5 scores turned out to be unreliable (the Claude pass and a hosted
pass disagreed at weighted κ ≈ 0.3), so we benchmarked **three judge methodologies** on a fixed
**48-item anchor** (8 cases spanning all categories × 6 models), measuring **reliability** (do
independent judges agree?) and **ranking stability**:

| Method | Tooling | Independent-judge agreement | Verdict |
|---|---|---|---|
| **A. Multi-judge absolute** (base rubric) | `judge_batch --sync` + `judge_analyze --matrix` | sonnet↔gpt **κ = 0.74**; Claude↔hosted κ ≈ 0.30 | the two hosted judges share a scale; a single judge's absolute scale is idiosyncratic — **average ≥2 hosted judges** |
| **B. Anchored rubric** (worked examples) | `judge_batch --rubric anchored` | sonnet↔gpt **κ = 0.77**; Claude↔hosted κ ≈ 0.27 | anchoring barely moved κ — the gap is **grader disposition, not rubric ambiguity** |
| **C. Pairwise / Arena** (both orders) | `judge_pairwise` + `--analyze` | 64% per-pair verdict agreement; **position bias 1–3%** | **most judge-invariant ranking; no absolute scale to calibrate — recommended for the headline ranking** |

**All three methods, and all judges, agree on the ordinal result:** `llama3.1:8b` ranks #1 and
`llama3.2:latest` last; the top cluster (`llama3.1:8b`, `gpt-4.1-mini`, `qwen3:8b`, `claude-haiku`) and
bottom (`qwen2.5-coder:14b`, `llama3.2`) are method- and judge-invariant. **The ranking is robust; the
absolute 1–5 numbers are not.** Notably the 14B ranks near-last on judged *quality* despite a high
deterministic pass-rate — answer quality and tool-emission are different things.

**Why the Claude anchor (judge 1) grades ~+1.5 points more leniently than the hosted judges** — a
calibration difference, documented so it isn't mistaken for noise or bias:

- **Ceiling vs central-tendency scale use.** Claude awards a 5 to *any* grounded-correct answer; the
  hosted judges reserve 5 for excellent answers and compress "correct but unremarkable" toward 3.
- **Charitable reading of honest-but-incomplete answers.** Claude scored "admits the action card failed"
  or "gives no number, suggests running a simulation" at 3–4; the hosted judges penalised the
  incompleteness harder.
- **Holistic vs strict rubric application.** Claude integrated intent and task difficulty and rewarded
  good-faith correct attempts; the hosted judges applied the letter of the rubric.
- **Single-judge scale drift.** With no calibration anchor, one judge's internal scale drifts; two
  independent hosted models happen to share a stricter calibration.
- **Not self-preference.** No judged model is Claude, and identities were blinded — the leniency is
  scale-anchoring, not favouring its own outputs.

**Recommendation:** report the model ranking via **pairwise (Method C)** — judge-invariant,
position-bias ≈ 2%, no absolute-scale calibration needed; use **multi-judge-averaged absolute scores**
(Method A over ≥2 hosted judges) only as a secondary, directional readout; treat any *single* judge's
raw 1–5 as illustrative, and lean on the deterministic axes + flags for per-answer ground truth.

## Extending

- **Add cases**: copy a starter dataset, add entries (aim for ~100 one-shot across the 6 categories,
  plus a handful of ≤50-turn scenarios with probes every ~10 turns).
- **Wire the judge**: implement a `JudgeBackend` (str prompt → str completion) against a strong model
  and call `judge.judge(...)` from a paid run; add its scores to the results.
- **CI gate**: run only the deterministic checks on a small slice with a local model (no `$`), fail
  the build on regressions in tool-selection / faithfulness / format.
- **Memory/compaction eval**: extend `run_multiturn` to persist a real conversation (so rolling
  summarization actually fires) when you want to score compaction fidelity directly.
