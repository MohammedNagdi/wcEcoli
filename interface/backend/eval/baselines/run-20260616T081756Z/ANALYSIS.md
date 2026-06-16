# Assistant eval — baseline run 20260616T081756Z (analysis & decisions)

First full assistant-quality benchmark. Preserved verbatim (scorecard + transcript + raw jsonl in this
folder) as the **baseline** all future runs are compared against. Nothing here is deprecated.

## Setup
- **Dataset:** `eval/datasets/oneshot.v1.json` — 30 one-shot prompts, 6 categories (factual_lookup,
  modeling_concept, action_draft, multi_step, adversarial, context_override).
- **Models (all local Ollama; no hosted keys configured, so this run is local-only by design):**
  `qwen3:8b`, `llama3.1:8b`, `qwen2.5-coder:14b`, `llama3.2:latest`.
- **Judge:** Claude (reading the transcript), per the JUDGE rubric — *not* a paid judge API.
- 120 cases total (30 × 4). Tool ground-truth captured alongside each answer.

## Deterministic scorecard (as-run, before the fairness fixes below)

| | qwen3:8b | llama3.1:8b | qwen2.5-coder:14b | llama3.2:latest |
|---|---|---|---|---|
| Overall pass | 70% | 67% | **77%** | 57% |
| Median latency | 132 s (slowest) | 81 s | 76 s | **47 s (fastest)** |
| multi_step | 80% | 40% | 40% | 0% |
| modeling_concept | 60% | 100% | 100% | 60% |
| action_draft | 100% | 40% | 100% | 60% |

Top failing checks: faithfulness (12), side_effect_expected (6), assert:contains (4),
tool_called:list_results/read_result_series (7).

## Judge findings (reading the actual answers vs. tool ground-truth)

**The deterministic scorecard understates quality — 3 false-failure modes:**
1. **Comma formatting:** `f_genes_total` "failed" only because the model wrote "4,749" vs the literal
   `4749`. Answer correct.
2. **Illustrative numbers:** modeling answers add `e.g. 10 mmol/gDCW/h`; the rubric allows this, the
   check flagged it.
3. **Computed aggregates / general biology:** averaging real growth rates; true textbook context
   ("CRP senses glucose via cAMP") not present in the tool output.

**No platform-data fabrication observed** from qwen3:8b or qwen2.5-coder:14b — they transcribe
grounded ids/numbers faithfully. (The earlier "Job 123-132" hallucination was the *weak* model + a
pre-grounded-cards build; the grounded cards make data trustworthy regardless of the model.)

**Two REAL behavioral patterns (not check artifacts), common to qwen3 and coder:**
- **Defer instead of complete:** "read the series for one of my results" → list all 16 and ask which,
  instead of picking one and reading it (`read_result_series` / `inspect_experiment` fails).
- **Narrate instead of call:** coder once said "I'll prepare the knockout…" *without* calling the tool
  → no card (`side_effect_expected` fail).

**llama3.2:latest** is genuinely too weak for agentic work (0/5 multi_step); fine only for trivial
no-tool replies.

## Per-model verdict (judged)

- **qwen2.5-coder:14b** — best all-rounder: highest pass, most literal/faithful (copies exact tool
  numbers, least embellishment), and ~2× faster than qwen3. Weakness: occasionally narrates an action
  without calling the tool; terser.
- **qwen3:8b** — strongest reasoning + instruction-following (overrode the aaaE/dnaA page context;
  correctly *refused* to fabricate zwf's growth rate and offered to simulate; reliably *invokes* the
  action tool). Weakness: **slowest** (the "laggy" feel) and embellishes with textbook biology.
- **llama3.1:8b** — solid middle; 100% modeling, weak action_draft/multi_step.
- **llama3.2:latest** — fastest but weakest; not for agentic.

## Decisions

1. **Model routing (keep ALL four; none deprecated):**
   - **Tier 1 — reads / data / QA (the bulk): `qwen2.5-coder:14b`** (faithful + fast).
   - **Tier 2 — side-effect actions + context-override + ambiguity: `qwen3:8b`** (reliable tool
     invocation, refuses fabrication).
   - `llama3.1:8b` — fallback. `llama3.2:latest` — Tier 0 only (trivial no-tool replies).
2. **Fixes implemented (additive; this baseline preserved unchanged):**
   - *(prompt)* When the user says "one of / a / any / pick one", choose and **complete** the task in
     the same turn (list→pick→inspect/read), don't list-and-ask. → fixes the *defer* pattern.
   - *(prompt)* "To prepare an action you MUST call the tool; describing it in prose does not create
     the card." → fixes the *narrate-without-card* pattern.
   - *(checker)* `assert:contains` tolerates comma-formatted numbers; faithfulness ignores
     illustrative (`e.g.`/`~`) values — while still catching bare fabricated ids. → removes the
     false failures without weakening real anti-fabrication.
3. **Keep everything:** this run is frozen here as the baseline; future runs land in `results/`
   (gitignored) and are compared against this. Re-run after the fixes to measure the delta (expect
   factual_lookup + faithfulness pass rates to rise on the same answers).

## Caveats
- The results-dependent cases ran against a **WT-only** dataset (16 jobs, 8 conditions); KO/dynamics
  diversity (via `submit_campaign --sample`) will exercise genotype-aware behavior more.
- One-shot only; the multi-turn drift suite is still to be authored.
