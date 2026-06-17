# Datasheet — `oneshot.v2.json`

- **Version (sha256):** `cdbd315cc1d2d8ab4e78f32f0a3e711d9141a0c2a8edd301cc52490d95c7c127`
- **One-shot cases:** 55  ·  **Multi-turn scenarios:** 0

## Motivation
Measure the wcEcoli Assistant's response quality for **model selection / routing** — specifically tool-grounded answering, action preparation, and resistance to context-stickiness and fabrication. Built in-house; not a general LLM benchmark.

## Composition
- **Categories (6):** action_draft=8, adversarial=10, context_override=7, factual_lookup=13, modeling_concept=9, multi_step=8
- **Cases with page context:** 7  ·  **with hard assertions:** 11  ·  **expecting a side-effect card:** 10
- **Tools exercised (expect_tools):** create_experiment×4, explain_modeling×9, gene_catalog×8, inspect_experiment×1, inspect_gene×2, inspect_tf_network×2, list_conditions×4, list_experiments×1, list_results×7, model_structure×3, read_result_series×1, run_simulation×1, save_condition×2, save_timeline×2
- **Negative controls (forbid_tools):** create_experiment×3, inspect_gene×2, list_conditions×1, run_simulation×1
- Each case carries a free-text **rubric** and optional **gold** answer for judge scoring.
- **Multi-turn:** none in this file.

## Collection process
Hand-authored against the live platform DB at authoring time, then **made data-agnostic** (no hard-coded job/experiment ids) so the suite grades behavior against any DB state. Tool outputs in results are captured from the real adapters (ground truth).

## Recommended uses
- Per-(provider,model) scoring with the deterministic checks + a calibrated judge (see README).
- Compare models with **Wilson CIs + paired McNemar (Holm-corrected)** — see `analyze.py`.

## Limitations & cautions (do not over-read)
- **Small (n=55)** — single-category margins are wide (~±20pp at n=5). Treat category rates as directional; rely on the overall + pairwise tests.
- **Single sample per item by default** — use `--repeats >=3` for stochastic CIs.
- **Deterministic `tool_called` checks are model-agnostic** but assume OpenAI-shaped tool calling; models with other native tool formats (e.g. Cohere Command via Ollama) score low for a *capability* reason, not a reasoning one — report tool-emission separately.
- **Faithfulness is a substring heuristic**, not a validated metric; conditional on tool-emission.
- **Possible train-set overlap** for generic facts (e.g. FBA); grounding via tools is the mitigation, and the analysis separates tool-grounded from memorized answers.

## Maintenance
Versioned by content hash (above). Extend by adding cases to the dataset JSON and regenerating this datasheet; bump the conceptual version in the filename for breaking changes.
