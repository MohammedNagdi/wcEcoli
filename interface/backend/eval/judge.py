"""Optional LLM-as-judge for the subjective dimensions deterministic checks can't score.

This is a thin, pluggable interface. Wire it to a STRONG judge model (a frontier hosted model is
recommended for low variance) and call it from a paid eval run. Kept separate from the free
deterministic checks so the default run costs nothing.

Best-practice notes baked into the default rubric:
- Score each dimension independently on 1-5.
- Judge faithfulness against the *tool output*, not world knowledge.
- Mitigate verbosity/position bias: the rubric asks for terse justification and ignores length.
- Average several samples per (case, model) and report variance — a single judge call is noisy.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

DEFAULT_RUBRIC = (
    "You are grading an AI lab-assistant answer for a whole-cell E. coli simulation platform.\n"
    "Score each dimension 1-5 (5 best):\n"
    "- correctness: factually right given the tool output and the question.\n"
    "- faithfulness: every claim is supported by the tool output; no fabricated ids/numbers.\n"
    "- helpfulness: directly answers what was asked, at the right level of detail.\n"
    "- instruction_following: honors explicit constraints (e.g. 'a different gene', 'no equation').\n"
    "Ignore answer length and position. Return STRICT JSON: "
    '{"correctness":n,"faithfulness":n,"helpfulness":n,"instruction_following":n,"why":"<=2 sentences"}'
)


@dataclass
class JudgeInput:
    prompt: str
    answer: str
    tool_output: Any
    rubric: str = ""
    gold: str = ""


# A judge backend takes a single text prompt and returns the model's raw string completion.
# Provide one that calls your chosen judge model (e.g. via the platform's provider layer or an SDK).
JudgeBackend = Callable[[str], str]


def build_judge_prompt(item: JudgeInput) -> str:
    parts = [item.rubric or DEFAULT_RUBRIC, "", f"QUESTION:\n{item.prompt}", "", f"ASSISTANT ANSWER:\n{item.answer}"]
    if item.tool_output is not None:
        parts += ["", f"TOOL OUTPUT (ground truth):\n{json.dumps(item.tool_output, default=str)[:4000]}"]
    if item.gold:
        parts += ["", f"REFERENCE ANSWER:\n{item.gold}"]
    return "\n".join(parts)


def judge(item: JudgeInput, backend: JudgeBackend, samples: int = 1) -> dict[str, Any]:
    """Run the judge `samples` times and average the numeric dimensions."""
    scores: list[dict[str, float]] = []
    whys: list[str] = []
    prompt = build_judge_prompt(item)
    for _ in range(max(1, samples)):
        raw = backend(prompt)
        try:
            start, end = raw.find("{"), raw.rfind("}")
            parsed = json.loads(raw[start : end + 1])
        except (ValueError, json.JSONDecodeError):
            continue
        scores.append({k: float(parsed[k]) for k in ("correctness", "faithfulness", "helpfulness", "instruction_following") if k in parsed})
        if parsed.get("why"):
            whys.append(str(parsed["why"]))
    if not scores:
        return {"ok": False, "detail": "judge returned no parseable JSON"}
    dims = ["correctness", "faithfulness", "helpfulness", "instruction_following"]
    avg = {d: round(sum(s.get(d, 0) for s in scores) / len(scores), 2) for d in dims}
    return {"ok": True, "samples": len(scores), "avg": avg, "why": whys[:samples]}
