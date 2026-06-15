"""Render eval results as a judge-ready markdown transcript.

This is the artifact for the "Claude-as-judge" workflow: run the harness against local models
(free), then paste this transcript into a Claude Code session and ask it to score each case with the
JUDGE rubric (see README). No paid judge API needed. Tool output is included (truncated) so the
judge can grade faithfulness against ground truth.
"""

from __future__ import annotations

import json
from typing import Any

_TOOL_TRUNC = 1500


def _fmt_tools(tool_output: list[dict[str, Any]]) -> str:
    if not tool_output:
        return "_(no tools called)_"
    blocks = []
    for t in tool_output:
        body = json.dumps(t.get("result"), default=str)
        if len(body) > _TOOL_TRUNC:
            body = body[:_TOOL_TRUNC] + " …(truncated)"
        blocks.append(f"- `{t.get('tool_name')}` → {body}")
    return "\n".join(blocks)


def _checks_line(checks: list[dict[str, Any]]) -> str:
    fails = [c["check"] for c in checks if not c["passed"]]
    return "✅ all deterministic checks pass" if not fails else f"❌ failing: {', '.join(fails)}"


def build_transcript(results: list[dict[str, Any]]) -> str:
    lines = [
        "# Eval transcript (judge worksheet)",
        "",
        "Score each case 1–5 on correctness, faithfulness, helpfulness, instruction_following "
        "(see eval/README → JUDGE rubric). Deterministic checks are pre-computed; use them as hints, "
        "not the final word.",
        "",
    ]
    for r in results:
        if r["kind"] == "oneshot":
            lines += [
                f"## {r['model']} · {r['id']} · _{r['category']}_",
                f"- **Prompt:** {r['prompt']}",
            ]
            if r.get("context"):
                lines.append(f"- **Page context:** `{json.dumps(r['context'])}`")
            if r.get("rubric"):
                lines.append(f"- **Rubric:** {r['rubric']}")
            if r.get("gold"):
                lines.append(f"- **Gold:** {r['gold']}")
            lines += [
                f"- **Tools called:** {r['tool_names'] or '—'}  ·  latency {r['latency_ms']}ms  ·  {_checks_line(r['checks'])}",
                "",
                "**Tool output (ground truth):**",
                _fmt_tools(r.get("tool_output", [])),
                "",
                "**Assistant answer:**",
                "",
                "> " + (r["content"] or "_(empty)_").replace("\n", "\n> "),
                "",
                "---",
                "",
            ]
        else:
            lines += [f"## {r['model']} · {r['id']} · _{r['category']}_ (multi-turn)", ""]
            for turn in r.get("turns", []):
                tag = " · PROBE" if turn.get("is_probe") else ""
                lines += [
                    f"### Turn {turn['turn']}{tag}",
                    f"- **User:** {turn['prompt']}",
                    f"- **Tools:** {turn['tool_names'] or '—'}  ·  {turn['latency_ms']}ms  ·  {_checks_line(turn['checks'])}",
                    "",
                    "**Tool output:** " + _fmt_tools(turn.get("tool_output", [])),
                    "",
                    "**Assistant:**",
                    "",
                    "> " + (turn["content"] or "_(empty)_").replace("\n", "\n> "),
                    "",
                ]
            lines += ["---", ""]
    return "\n".join(lines) + "\n"
