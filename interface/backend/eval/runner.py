"""Run dataset cases against the real assistant agent loop for a given (provider, model)."""

from __future__ import annotations

import time
from typing import Any

from sqlmodel import Session

from app.services.assistant_agent import generate_assistant_agent_reply

from . import checks
from .schema import ModelTarget, MultiTurnScenario, OneShotCase


def _summarize(result: Any) -> dict[str, Any]:
    executed = list(getattr(result, "executed_tools", []) or [])
    pending = list(getattr(result, "pending_side_effects", []) or [])
    return {
        "status": getattr(result, "status", ""),
        "content": getattr(result, "content", "") or "",
        "provider_id": getattr(result, "provider_id", ""),
        "model": getattr(result, "model", ""),
        "executed_tools": executed,
        "executed_tool_names": [t.get("tool_name") for t in executed if isinstance(t, dict)],
        "pending_tool_names": [getattr(p, "tool_name", "") for p in pending],
    }


def run_oneshot(session: Session, case: OneShotCase, target: ModelTarget) -> dict[str, Any]:
    started = time.perf_counter()
    result = generate_assistant_agent_reply(
        case.prompt,
        dict(case.context),
        session=session,
        provider_id=target.provider_id,
        model=target.model,
    )
    latency_ms = round((time.perf_counter() - started) * 1000)
    s = _summarize(result)
    check_results = checks.run_all(
        content=s["content"],
        executed_tool_names=s["executed_tool_names"],
        executed_tools=s["executed_tools"],
        pending_tool_names=s["pending_tool_names"],
        expect_tools=case.expect_tools,
        forbid_tools=case.forbid_tools,
        expect_side_effect=case.expect_side_effect,
        assertions=case.assertions,
    )
    return {
        "id": case.id, "kind": "oneshot", "category": case.category, "model": target.label,
        "latency_ms": latency_ms, "status": s["status"], "content": s["content"],
        "tool_names": s["executed_tool_names"] + s["pending_tool_names"],
        "checks": check_results,
        "passed": all(c["passed"] for c in check_results),
    }


def run_multiturn(session: Session, scenario: MultiTurnScenario, target: ModelTarget) -> dict[str, Any]:
    """Replay the scripted turns, threading history so drift/reference-resolution can be probed."""
    history: list[dict[str, str]] = []
    turn_results: list[dict[str, Any]] = []
    for index, turn in enumerate(scenario.turns):
        started = time.perf_counter()
        result = generate_assistant_agent_reply(
            turn.prompt,
            dict(scenario.context),
            session=session,
            history=list(history),
            provider_id=target.provider_id,
            model=target.model,
        )
        latency_ms = round((time.perf_counter() - started) * 1000)
        s = _summarize(result)
        check_results = checks.run_all(
            content=s["content"],
            executed_tool_names=s["executed_tool_names"],
            executed_tools=s["executed_tools"],
            pending_tool_names=s["pending_tool_names"],
            expect_tools=turn.expect_tools,
            forbid_tools=turn.forbid_tools,
            expect_side_effect=False,
            assertions=turn.assertions,
        )
        history.append({"role": "user", "content": turn.prompt})
        history.append({"role": "assistant", "content": s["content"]})
        turn_results.append({
            "turn": index, "is_probe": turn.is_probe, "prompt": turn.prompt,
            "latency_ms": latency_ms, "status": s["status"], "content": s["content"],
            "tool_names": s["executed_tool_names"] + s["pending_tool_names"],
            "checks": check_results, "passed": all(c["passed"] for c in check_results),
        })
    probes = [t for t in turn_results if t["is_probe"]]
    return {
        "id": scenario.id, "kind": "multiturn", "category": scenario.category, "model": target.label,
        "turns": turn_results,
        "passed": all(t["passed"] for t in turn_results),
        "probe_pass_rate": (sum(t["passed"] for t in probes) / len(probes)) if probes else None,
        "avg_latency_ms": round(sum(t["latency_ms"] for t in turn_results) / max(1, len(turn_results))),
    }
