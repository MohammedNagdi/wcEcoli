# Datasheet — `oneshot.v1.json`

- **Version (sha256):** `b42c5de3ef6117a4f8bff0e06f0ed47fbae0b88dbb8f8bf43c5f28733380864e`
- **One-shot cases:** 30  ·  **Multi-turn scenarios:** 0

## Motivation
Measure the wcEcoli Assistant's response quality for **model selection / routing** — specifically tool-grounded answering, action preparation, and resistance to context-stickiness and fabrication. Built in-house; not a general LLM benchmark.

## Composition
- **Categories (6):** action_draft=5, adversarial=5, context_override=5, factual_lookup=5, modeling_concept=5, multi_step=5
- **Cases with page context:** 5  ·  **with hard assertions:** 7  ·  **expecting a side-effect card:** 6
- **Tools exercised (expect_tools):** create_experiment×2, explain_modeling×5, gene_catalog×5, inspect_experiment×1, inspect_gene×1, inspect_tf_network×1, list_conditions×1, list_results×4, model_structure×2, read_result_series×1, run_simulation×1, save_condition×1, save_timeline×1
- **Negative controls (forbid_tools):** create_experiment×1, inspect_gene×2, list_conditions×1, run_simulation×1
- Each case carries a free-text **rubric** and optional **gold** answer for judge scoring.

## Collection process
Hand-authored against the live platform DB at authoring time, then **made data-agnostic** (no hard-coded job/experiment ids) so the suite grades behavior against any DB state. Tool outputs in results are captured from the real adapters (ground truth).

## Recommended uses
- Per-(provider,model) scoring with the deterministic checks + a calibrated judge (see README).
- Compare models with **Wilson CIs + paired McNemar (Holm-corrected)** — see `analyze.py`.

## Limitations & cautions (do not over-read)
- **Small (n=30)** — single-category margins are wide (~±20pp at n=5). Treat category rates as directional; rely on the overall + pairwise tests.
- **Single sample per item by default** — use `--repeats >=3` for stochastic CIs.
- **Deterministic `tool_called` checks are model-agnostic** but assume OpenAI-shaped tool calling; models with other native tool formats (e.g. Cohere Command via Ollama) score low for a *capability* reason, not a reasoning one — report tool-emission separately.
- **Faithfulness is a substring heuristic**, not a validated metric; conditional on tool-emission.
- **Possible train-set overlap** for generic facts (e.g. FBA); grounding via tools is the mitigation, and the analysis separates tool-grounded from memorized answers.

## Maintenance
Versioned by content hash (above). Extend by adding cases to the dataset JSON and regenerating this datasheet; bump the conceptual version in the filename for breaking changes.
