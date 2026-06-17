# Datasheet — `multiturn.v2.json`

- **Version (sha256):** `eb5c0f0ddd08268617683913792e0c5f94d65cd85e9cd9878774fb516d5372bd`
- **One-shot cases:** 0  ·  **Multi-turn scenarios:** 10

## Motivation
Measure the wcEcoli Assistant's response quality for **model selection / routing** — specifically tool-grounded answering, action preparation, and resistance to context-stickiness and fabrication. Built in-house; not a general LLM benchmark.

## Composition
- **Categories (0):** 
- **Cases with page context:** 0  ·  **with hard assertions:** 0  ·  **expecting a side-effect card:** 0
- **Tools exercised (expect_tools):** none
- **Negative controls (forbid_tools):** none
- Each case carries a free-text **rubric** and optional **gold** answer for judge scoring.
- **Multi-turn:** 10 scenarios, 34 turns, 15 memory/reference **probe** turns (the drift signal). Categories: multi_turn=10. Scored per-turn + scenario + probe-recall with Wilson CIs (`analyze.py`).

## Collection process
Hand-authored against the live platform DB at authoring time, then **made data-agnostic** (no hard-coded job/experiment ids) so the suite grades behavior against any DB state. Tool outputs in results are captured from the real adapters (ground truth).

## Recommended uses
- Per-(provider,model) scoring with the deterministic checks + a calibrated judge (see README).
- Compare models with **Wilson CIs + paired McNemar (Holm-corrected)** — see `analyze.py`.

## Limitations & cautions (do not over-read)
- **Small (n=0)** — single-category margins are wide (~±20pp at n=5). Treat category rates as directional; rely on the overall + pairwise tests.
- **Single sample per item by default** — use `--repeats >=3` for stochastic CIs.
- **Deterministic `tool_called` checks are model-agnostic** but assume OpenAI-shaped tool calling; models with other native tool formats (e.g. Cohere Command via Ollama) score low for a *capability* reason, not a reasoning one — report tool-emission separately.
- **Faithfulness is a substring heuristic**, not a validated metric; conditional on tool-emission.
- **Possible train-set overlap** for generic facts (e.g. FBA); grounding via tools is the mitigation, and the analysis separates tool-grounded from memorized answers.

## Maintenance
Versioned by content hash (above). Extend by adding cases to the dataset JSON and regenerating this datasheet; bump the conceptual version in the filename for breaking changes.
