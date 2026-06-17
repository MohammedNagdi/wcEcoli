"""Generate a 'Datasheet for Datasets' (Gebru et al. 2021) for an eval prompt set.

Documents provenance, composition, intended use, and limitations so the benchmark is reproducible and
its scope is explicit — the data-documentation half of the methodology audit.

    python -m eval.datasheet --dataset eval/datasets/oneshot.v1.json --out eval/datasets/oneshot.v1.DATASHEET.md
"""

from __future__ import annotations

import argparse
import hashlib
from collections import Counter
from pathlib import Path

from .schema import Dataset


def build_datasheet(dataset_path: Path) -> str:
    text = dataset_path.read_text(encoding="utf-8")
    ds = Dataset.model_validate_json(text)
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    n = len(ds.oneshot)
    cats = Counter(c.category for c in ds.oneshot)
    tools = Counter(t for c in ds.oneshot for t in (c.expect_tools or []))
    forbid = Counter(t for c in ds.oneshot for t in (c.forbid_tools or []))
    side = sum(1 for c in ds.oneshot if c.expect_side_effect)
    with_ctx = sum(1 for c in ds.oneshot if c.context)
    with_assert = sum(1 for c in ds.oneshot if c.assertions)

    L = [
        f"# Datasheet — `{dataset_path.name}`",
        "",
        f"- **Version (sha256):** `{sha}`",
        f"- **One-shot cases:** {n}  ·  **Multi-turn scenarios:** {len(ds.multiturn)}",
        "",
        "## Motivation",
        "Measure the wcEcoli Assistant's response quality for **model selection / routing** — specifically "
        "tool-grounded answering, action preparation, and resistance to context-stickiness and fabrication. "
        "Built in-house; not a general LLM benchmark.",
        "",
        "## Composition",
        f"- **Categories ({len(cats)}):** " + ", ".join(f"{c}={cats[c]}" for c in sorted(cats)),
        f"- **Cases with page context:** {with_ctx}  ·  **with hard assertions:** {with_assert}  "
        f"·  **expecting a side-effect card:** {side}",
        f"- **Tools exercised (expect_tools):** " + (", ".join(f"{t}×{tools[t]}" for t in sorted(tools)) or "none"),
        f"- **Negative controls (forbid_tools):** " + (", ".join(f"{t}×{forbid[t]}" for t in sorted(forbid)) or "none"),
        "- Each case carries a free-text **rubric** and optional **gold** answer for judge scoring.",
        "",
        "## Collection process",
        "Hand-authored against the live platform DB at authoring time, then **made data-agnostic** "
        "(no hard-coded job/experiment ids) so the suite grades behavior against any DB state. Tool outputs "
        "in results are captured from the real adapters (ground truth).",
        "",
        "## Recommended uses",
        "- Per-(provider,model) scoring with the deterministic checks + a calibrated judge (see README).",
        "- Compare models with **Wilson CIs + paired McNemar (Holm-corrected)** — see `analyze.py`.",
        "",
        "## Limitations & cautions (do not over-read)",
        f"- **Small (n={n})** — single-category margins are wide (~±20pp at n=5). Treat category rates as "
        "directional; rely on the overall + pairwise tests.",
        "- **Single sample per item by default** — use `--repeats >=3` for stochastic CIs.",
        "- **Deterministic `tool_called` checks are model-agnostic** but assume OpenAI-shaped tool calling; "
        "models with other native tool formats (e.g. Cohere Command via Ollama) score low for a *capability* "
        "reason, not a reasoning one — report tool-emission separately.",
        "- **Faithfulness is a substring heuristic**, not a validated metric; conditional on tool-emission.",
        "- **Possible train-set overlap** for generic facts (e.g. FBA); grounding via tools is the mitigation, "
        "and the analysis separates tool-grounded from memorized answers.",
        "",
        "## Maintenance",
        "Versioned by content hash (above). Extend by adding cases to the dataset JSON and regenerating this "
        "datasheet; bump the conceptual version in the filename for breaking changes.",
    ]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True, type=Path)
    ap.add_argument("--out", default=None, type=Path)
    args = ap.parse_args()
    sheet = build_datasheet(args.dataset)
    if args.out:
        args.out.write_text(sheet, encoding="utf-8")
        print(f"Wrote {args.out}")
    else:
        print(sheet)


if __name__ == "__main__":
    main()
