"""Deterministic, model-free checks — the cheap, exact backbone of the eval.

These run with no LLM and no cost, so they double as a CI regression gate. The subjective
dimensions (helpfulness, correctness) are left to the optional LLM judge (``judge.py``).
"""

from __future__ import annotations

import json
import re
from typing import Any

from .schema import Assertion

# Tokens that look "groundable" — integers (>=2 digits) and ID-ish strings — used by the
# faithfulness heuristic to catch fabricated job ids / counts / experiment names.
_NUM_RE = re.compile(r"\b\d{2,}\b")
_ID_RE = re.compile(r"\b[A-Za-z]{2,}[-_]?\d{2,}\b|\bEG\d{5}\b|\b[A-Z][A-Z0-9]{3,}\b")
# Common false positives to ignore (years, the gene total shown everywhere, etc.).
_FAITHFULNESS_WHITELIST = {"4749", "4371", "4425", "1125"}


def _norm(text: str) -> str:
    return (text or "").lower()


def _strip_num_commas(text: str) -> str:
    """Drop thousands separators inside numbers so '4,749' matches '4749'."""
    return re.sub(r"(?<=\d),(?=\d)", "", text or "")


# Markers that signal an illustrative value the rubric explicitly allows (not a grounded claim).
_ILLUSTRATIVE = ("e.g.", "eg.", "for example", "for instance", "such as", "example",
                 "approx", "roughly", "~", "around ", "about ", "say ")


def check_assertions(content: str, assertions: list[Assertion]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for a in assertions:
        hay = _norm(content) if a.flags_ignorecase else content
        needle = _norm(a.value) if a.flags_ignorecase else a.value
        if a.kind == "contains":
            # Tolerate comma-formatted numbers ('4,749' vs '4749').
            ok = needle in hay or _strip_num_commas(needle) in _strip_num_commas(hay)
        elif a.kind == "not_contains":
            ok = needle not in hay and _strip_num_commas(needle) not in _strip_num_commas(hay)
        elif a.kind == "regex":
            ok = re.search(a.value, content, re.I if a.flags_ignorecase else 0) is not None
        else:  # not_regex
            ok = re.search(a.value, content, re.I if a.flags_ignorecase else 0) is None
        results.append({"check": f"assert:{a.kind}", "passed": ok, "detail": a.value})
    return results


def check_tool_selection(tool_names: list[str], expect: list[str], forbid: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    called = set(tool_names)
    for tool in expect:
        out.append({"check": f"tool_called:{tool}", "passed": tool in called, "detail": sorted(called)})
    for tool in forbid:
        out.append({"check": f"tool_not_called:{tool}", "passed": tool not in called, "detail": sorted(called)})
    return out


def check_no_raw_json(content: str) -> dict[str, Any]:
    """The model must never leak a tool-call JSON object into the visible answer."""
    leaked = re.search(r"\{\s*[\"']?(name|tool|tool_name)[\"']?\s*:", content) is not None
    return {"check": "no_raw_tool_json", "passed": not leaked, "detail": "tool-call JSON in answer" if leaked else ""}


def check_side_effect(pending_tool_names: list[str], expect_side_effect: bool) -> dict[str, Any]:
    has = len(pending_tool_names) > 0
    return {
        "check": "side_effect_expected" if expect_side_effect else "no_unexpected_side_effect",
        "passed": has == expect_side_effect,
        "detail": sorted(set(pending_tool_names)),
    }


def _illustrative_occurrence(content_lc: str, token: str) -> bool:
    """True if every occurrence of ``token`` sits in an illustrative context (e.g. '~', 'e.g.').

    The rubric allows illustrative example values; this stops the heuristic flagging them as
    fabrication while still catching a bare invented id/number stated as fact.
    """
    tok = token.lower()
    start = 0
    found_any = False
    while True:
        i = content_lc.find(tok, start)
        if i == -1:
            break
        found_any = True
        window = content_lc[max(0, i - 60):i]
        if not any(m in window for m in _ILLUSTRATIVE):
            return False  # at least one occurrence is asserted as fact
        start = i + len(tok)
    return found_any


def check_faithfulness(content: str, executed_tools: list[dict[str, Any]]) -> dict[str, Any]:
    """Heuristic anti-fabrication: every groundable number/ID in the answer should appear in some
    tool result. Catches the 'Job ID 123-132' hallucination. Skipped when no tool ran (a purely
    conceptual answer has nothing to ground against). Tolerates comma-formatted numbers and values
    flagged as illustrative (e.g. '~', 'e.g.') per the rubric."""
    if not executed_tools:
        return {"check": "faithfulness", "passed": True, "detail": "skipped (no tool output)"}
    content_norm = _strip_num_commas(content)
    content_lc = content_norm.lower()
    haystack = _strip_num_commas(json.dumps([t.get("result") for t in executed_tools], default=str))
    candidates = set(_NUM_RE.findall(content_norm)) | set(_ID_RE.findall(content_norm))
    unsupported = [
        tok for tok in candidates
        if tok not in _FAITHFULNESS_WHITELIST
        and tok not in haystack
        and not _illustrative_occurrence(content_lc, tok)
    ]
    return {
        "check": "faithfulness",
        "passed": not unsupported,
        "detail": f"unsupported tokens (not in tool output): {unsupported[:8]}" if unsupported else "",
    }


def run_all(
    *,
    content: str,
    executed_tool_names: list[str],
    executed_tools: list[dict[str, Any]],
    pending_tool_names: list[str],
    expect_tools: list[str],
    forbid_tools: list[str],
    expect_side_effect: bool,
    assertions: list[Assertion],
) -> list[dict[str, Any]]:
    results = [
        check_no_raw_json(content),
        check_faithfulness(content, executed_tools),
        check_side_effect(pending_tool_names, expect_side_effect),
    ]
    results += check_tool_selection(executed_tool_names + pending_tool_names, expect_tools, forbid_tools)
    results += check_assertions(content, assertions)
    return results
