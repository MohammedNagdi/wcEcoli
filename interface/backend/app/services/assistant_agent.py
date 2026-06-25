"""Unified provider-agnostic agent loop with native tool use.

This replaces the prose-scraping pseudo-agent in ``assistant_runtime`` with a real
observe -> act -> observe loop built on each provider's native tool-calling API:

* Anthropic Messages API  -> ``tools`` + ``tool_use`` / ``tool_result`` blocks
* OpenAI Chat Completions -> ``tools`` (function calling) + ``role:"tool"`` results
* Ollama ``/api/chat``    -> OpenAI-shaped ``tools`` + ``message.tool_calls``

Design rules:

* The model receives a real ``messages`` array (system + history + user), not a
  system-prompt blob, so multi-turn references resolve naturally.
* Read-only tools (``inspect_result``, ``inspect_gene``) execute *inside the loop*
  and their results are fed back as ``tool_result`` so the model can reason on them.
* Side-effecting tools (``create_experiment``, ``run_simulation``) are **never
  auto-executed**. They are surfaced as confirmation-gated proposal cards; the model
  is told the action is pending user approval and must not claim it ran.
* The HTTP ``Transport`` seam from ``assistant_runtime`` is reused so unit tests can
  inject a fake transport and exercise the full loop offline.
"""

from __future__ import annotations

import json
import re
import urllib.error
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlmodel import Session

from app.config import settings
from app.services.assistant_runtime import (
    Transport,
    _default_transport,
    _provider_base_url,
    _provider_model,
    _provider_secret,
    _resolved_provider_configured,
    _select_provider,
    _active_provider_config,
    RUNTIME_PROVIDER_SPECS,
)
from app.services.assistant_runtime import (
    _context_summary,
    _page_state_summary,
    _platform_facts_summary,
    _working_memory_summary,
)
from app.services.assistant_harness import (
    AssistantContext,
    AssistantToolExecutionRequest,
    AssistantToolPreviewRequest,
    execute_tool,
    get_tool_registry,
    get_tool_spec,
    preview_tool,
)


AgentStatus = Literal[
    "no_provider_configured",
    "selected_provider_not_configured",
    "provider_not_supported",
    "provider_call_failed",
    "completed",
]

# Applied to EVERY provider (was Anthropic-only at 1500, which truncated verbose hosted answers and
# under-scored them while OpenAI/Ollama ran uncapped). 4096 is generous for a chat turn yet bounded.
DEFAULT_MAX_TOKENS = 4096

_JSON_TYPE_MAP = {
    "string": "string",
    "integer": "integer",
    "number": "number",
    "boolean": "boolean",
    "object": "object",
    "array": "array",
}


@dataclass
class NormalizedToolCall:
    id: str
    name: str
    input: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentStep:
    text: str
    tool_calls: list[NormalizedToolCall]
    stop_reason: str
    raw_assistant_message: Any


class PendingSideEffect(BaseModel):
    tool_name: str
    normalized_arguments: dict[str, Any] = Field(default_factory=dict)
    preview: dict[str, Any] = Field(default_factory=dict)
    valid: bool = True
    errors: list[str] = Field(default_factory=list)


class AssistantAgentResult(BaseModel):
    status: AgentStatus
    provider_id: str = ""
    model: str = ""
    content: str = ""
    request: dict[str, Any] = Field(default_factory=dict)
    response: dict[str, Any] = Field(default_factory=dict)
    error: str = ""
    pending_side_effects: list[PendingSideEffect] = Field(default_factory=list)
    executed_tools: list[dict[str, Any]] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Tool schema conversion
# --------------------------------------------------------------------------- #


def _json_schema_for_spec(argument_schema: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    for key, type_name in argument_schema.items():
        json_type = _JSON_TYPE_MAP.get(str(type_name), "string")
        prop: dict[str, Any] = {"type": json_type}
        if json_type == "array":
            prop["items"] = {"type": "string"}
        properties[key] = prop
    return {"type": "object", "properties": properties}


def build_agent_tools() -> list[dict[str, Any]]:
    """Provider-neutral tool descriptors (name/description/input_schema)."""
    tools: list[dict[str, Any]] = []
    for spec in get_tool_registry():
        if spec.status == "registered_disabled":
            continue
        tools.append(
            {
                "name": spec.name,
                "description": spec.description,
                "input_schema": _json_schema_for_spec(spec.argument_schema),
                "side_effect": spec.side_effect,
            }
        )
    return tools


def enrich_tools_for_session(session: Session | None, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ground tool schemas in real DB values so the model stops guessing enums.

    Most importantly, pin ``create_experiment.variant_type`` to the actual ``Variant`` names — the
    model was inventing values like "mutation"/"knockout" because the schema only said "string".
    """
    if session is None:
        return tools
    try:
        from sqlmodel import select as _select

        from app.db.models import Condition as _Condition
        from app.db.models import MediaRecipe as _MediaRecipe
        from app.db.models import Variant as _Variant

        variant_names = [v.name for v in session.exec(_select(_Variant)).all() if v.name]
        condition_names = [c.name for c in session.exec(_select(_Condition)).all() if c.name]
        media_ids = [m.media_id for m in session.exec(_select(_MediaRecipe)).all() if m.media_id]
    except Exception:
        return tools
    for tool in tools:
        if tool["name"] == "create_experiment":
            props = tool["input_schema"].setdefault("properties", {})
            if variant_names and "variant_type" in props:
                props["variant_type"]["enum"] = variant_names
            hints = []
            if variant_names:
                hints.append(f"Valid variant_type values: {', '.join(variant_names)}.")
            if condition_names:
                hints.append(f"Valid condition values include: {', '.join(condition_names[:12])}.")
            if hints:
                tool["description"] = f"{tool['description']} " + " ".join(hints)
        elif tool["name"] == "save_condition":
            hints = []
            if media_ids:
                hints.append(f"Valid `nutrients` media-recipe ids include: {', '.join(media_ids[:12])}.")
            if condition_names:
                hints.append(f"Existing conditions to clone via base_condition: {', '.join(condition_names[:12])}.")
            if hints:
                tool["description"] = f"{tool['description']} " + " ".join(hints)
    return tools


def _anthropic_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]}
        for t in tools
    ]


def _openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in tools
    ]


# --------------------------------------------------------------------------- #
# System prompt
# --------------------------------------------------------------------------- #


# Fixed instructions — identical every turn so it can be prompt-cached (Anthropic cache_control /
# OpenAI automatic prefix caching). Keep all volatile per-turn context OUT of this string.
_STABLE_SYSTEM_PROMPT = (
    "You are the wcEcoli platform scientific assistant. Help the user understand model, experiment, "
    "and result context, and take safe next steps using the provided tools.\n\n"
    "Tool policy:\n"
    "- Read-only tools return real data to you so you can answer from facts, not guesses. Pick the right one:\n"
    "  * Aggregate/count questions ('how many genes', 'which knockout-ready genes', 'what categories') -> "
    "`gene_catalog`; never call `inspect_gene` with a made-up gene to count.\n"
    "  * A specific gene's metadata/model-state IDs -> `inspect_gene`; its regulators/targets -> `inspect_tf_network`.\n"
    "  * Growth conditions / media / timelines -> `list_conditions`. Experiments -> `list_experiments` then "
    "`inspect_experiment`. A completed result -> `inspect_result`; trajectory counts in the Molecule Explorer -> "
    "`inspect_molecule_trajectories` (scoped to one job only). Comparing metrics across several results ('compare "
    "WT vs the knockout', 'which grew fastest') -> `compare_results` with job_ids/experiment_ids. The actual "
    "numeric time-series behind a plot (growth rate / mass over time) -> `read_result_series` (call it with no "
    "`series` first to list the available channels). Never invent trajectory numbers — read them. "
    "`read_result_series`, `inspect_result`, and `inspect_molecule_trajectories` all need a specific job/result id. "
    "When the user asks to 'pick a result', 'break down the findings', list results, or compare results and none "
    "is selected, ALWAYS call `list_results` first to get the completed results (job_id, experiment, condition, "
    "metrics). If the user said 'one of', 'a', 'any', or 'pick one' (i.e. they don't care which), CHOOSE the most "
    "relevant one yourself and COMPLETE the task in the same turn — e.g. for 'read the growth-rate series for one "
    "of my results', call `list_results`, pick a job_id, then call `read_result_series` for it and describe the "
    "trend. Do NOT just list the results and ask the user which one — only ask when their criterion is genuinely "
    "ambiguous. The same applies to 'pick one of my experiments and ...' -> `list_experiments` then "
    "`inspect_experiment` on a chosen id. Never tell the user to go to the Results page themselves, and never claim "
    "there are no results without calling `list_results`. Never substitute `list_conditions` or call growth "
    "conditions 'output channels'; a condition is an input, not a result time-series.\n"
    "  * 'What does this/each page do', 'where do I do X', 'explain the pages' -> `platform_guide`. For 'each' or "
    "'all' pages call it with NO `page` argument to get every page; only pass `page` for a single named page. You "
    "cannot browse pages yourself, so never invent page descriptions — read them from `platform_guide`.\n"
    "  * 'What is being modelled', 'what is FBA', 'what are reaction fluxes / state variables / the output series', "
    "'what do the mechanistic equations describe', 'give an example of a term' -> `explain_modeling`. When you "
    "explain a mechanistic process or FBA, describe what each TERM represents and does (an illustrative example of "
    "the terms is fine), but NEVER write out or reproduce the actual governing equation.\n"
    "  * 'What reactions involve X', 'what does gene/enzyme Y catalyze', 'is reaction R reversible', 'how many "
    "reactions are there' -> `model_structure` (static metabolic structure). For values over time, propose a "
    "simulation and inspect the result — do not invent dynamic numbers.\n"
    "- The side-effecting tools are `create_experiment`, `run_simulation`, and the Conditions Builder writers "
    "`save_condition`, `save_timeline`, `save_recipe`, `save_tf_condition`. When you call any of them the platform "
    "shows the user a confirmation card and does NOT execute the action. Never claim you created, queued, ran, "
    "saved, or changed anything — say you have prepared it for review.\n"
    "  * To prepare an action you MUST actually call the tool — describing it in prose ('I'll prepare the "
    "knockout…', 'next I'll create…') does NOT create the card. If you intend to prepare something, emit the tool "
    "call in the same turn; don't promise to do it later.\n"
    "  * Conditions Builder edits all write a reviewable DRAFT (the user publishes from the Builder), and you "
    "should read current state with `list_conditions` first so referenced ids are real:\n"
    "    - a growth condition (nutrients, TFs, doubling time; clone an existing one with `base_condition`) -> "
    "`save_condition`;\n"
    "    - a time-varying media schedule (event string like '0 minimal, 1200 minimal_acetate') -> `save_timeline`;\n"
    "    - a media formulation (base/added medium + ingredients) -> `save_recipe`;\n"
    "    - a transcription-factor regulation rule (active/inactive nutrients + TF type) -> `save_tf_condition`.\n"
    "  To discuss or reason without changing anything, just answer; only call a save_* tool when the user actually "
    "wants to create or edit that artifact.\n"
    "- To build a knockout experiment: call `inspect_gene` for the target to get its knockout index, then call "
    "`create_experiment` with variant_type from the tool's allowed values (it is `gene_knockout` for knockouts) "
    "and variant_index = the gene's knockout index. Do NOT invent variant_type values like 'mutation' or "
    "'knockout'.\n"
    "- Page context (the selected gene/result/etc.) is the DEFAULT subject, not a constraint. If the user asks "
    "for a DIFFERENT, random, or 'another' gene/result, honor that over the selection — do not keep returning the "
    "selected one. For a random or different gene, call `gene_catalog` with `random: true` and pick from the "
    "result; for a different result, call `list_results`. Only reuse the selected/earlier gene when the user "
    "refers to it ('this gene', 'it', or by name).\n"
    "- Make tool calls via the tool interface only. NEVER paste a tool call as a JSON code block in your reply, "
    "and do not show raw arguments — the platform renders the confirmation card for you.\n"
    "- Tool results may include a `links` field — internal UI navigation targets. Never mention 'the links "
    "section' or any raw field name to the user. Instead phrase navigation naturally (e.g. 'open the Results "
    "page for this job' or 'see the Network view'); say nothing about links if they add nothing.\n"
    "- Prefer calling a tool over describing model IDs or counts from memory. If no tool fits, say so plainly "
    "instead of inventing arguments."
)


def _dynamic_context_block(context: dict[str, Any]) -> str:
    """The volatile, per-turn part of the system prompt (page context, facts, memory)."""
    parts = [
        f"Current page context (the default subject — the user may redirect to a different/random "
        f"subject, which takes precedence): {_context_summary(context)}."
    ]
    page_state = _page_state_summary(context)
    if page_state:
        parts.append(page_state)
    platform_facts = _platform_facts_summary(context)
    if platform_facts:
        parts.append(platform_facts)
    working_memory = _working_memory_summary(context)
    if working_memory:
        parts.append(working_memory)
    conversation = context.get("conversation_context")
    if isinstance(conversation, dict):
        earlier = conversation.get("earlier_context")
        if isinstance(earlier, dict) and earlier.get("note"):
            parts.append(f"Earlier conversation (compacted):\n{earlier['note']}")
    return "\n\n".join(parts)


# The base prompt's heavy ALWAYS/NEVER style is needed to push weak local models into calling tools and
# not fabricating. Instruction-following frontier models follow it too literally — they over-call tools
# and behave rigidly. This calibration note softens the framing for hosted models (and nudges them off
# their habit of adding accurate-but-ungrounded elaboration, which our grounding criterion penalises).
_FRONTIER_CALIBRATION = (
    "\n\nCalibration (capable models): you select tools and follow instructions reliably, so treat the "
    "rules above as defaults to apply with judgement, not rigid mandates. Don't over-call tools when the "
    "answer is already in context, don't pad responses, and keep every claim grounded in the tool output "
    "— do not add unverified detail from general knowledge. Prefer the single most relevant tool."
)


def _stable_system(frontier: bool) -> str:
    return _STABLE_SYSTEM_PROMPT + (_FRONTIER_CALIBRATION if frontier else "")


def _agent_system_prompt(context: dict[str, Any], frontier: bool = False) -> str:
    """Single-string system prompt (OpenAI/Ollama). Stable prefix first so prefix caching applies."""
    return f"{_stable_system(frontier)}\n\n{_dynamic_context_block(context)}"


def build_system(kind: str, context: dict[str, Any], frontier: bool = False):
    """Provider-shaped system. Anthropic gets a cached stable block + a fresh dynamic block. ``frontier``
    selects the softened prompt tier for hosted/instruction-following models (vs local 8Bs)."""
    if kind == "anthropic":
        return [
            {"type": "text", "text": _stable_system(frontier), "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": _dynamic_context_block(context)},
        ]
    return _agent_system_prompt(context, frontier)


# --------------------------------------------------------------------------- #
# Conversation history -> provider-native messages
# --------------------------------------------------------------------------- #


def _base_messages(history: list[dict[str, Any]] | None, user_content: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for message in history or []:
        role = message.get("role")
        content = message.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_content})
    return messages


# --------------------------------------------------------------------------- #
# Provider call + response normalization
# --------------------------------------------------------------------------- #


def _call_provider(
    *,
    kind: str,
    base_url: str,
    model: str,
    api_key: str,
    extra_headers: dict[str, str] | None,
    system: str,
    native_messages: list[dict[str, Any]],
    provider_tools: list[dict[str, Any]],
    timeout: int,
    transport: Transport,
) -> tuple[dict[str, Any], AgentStep]:
    if kind == "anthropic":
        url = f"{base_url}/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
        # Cache the conversation prefix too (system + tools are already cached via build_system): a
        # single moving breakpoint on the most recent block lets each later round/turn replay the
        # prior history at ~0.1x input price instead of full price.
        _mark_history_cacheable(native_messages)
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "system": system,
            "messages": native_messages,
        }
        if provider_tools:
            payload["tools"] = _anthropic_tools(provider_tools)
        response = transport(url, headers, payload, timeout)
        blocks = response.get("content", []) or []
        text = "\n".join(
            b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"
        ).strip()
        tool_calls = [
            NormalizedToolCall(id=str(b.get("id")), name=str(b.get("name")), input=b.get("input") or {})
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "tool_use"
        ]
        return response, AgentStep(text, tool_calls, str(response.get("stop_reason") or ""), {"role": "assistant", "content": blocks})

    # openai_compatible + ollama share OpenAI-shaped tools.
    messages = [{"role": "system", "content": system}, *native_messages]
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)

    tool_names = {t["name"] for t in provider_tools}

    if kind == "ollama":
        url = f"{base_url}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "keep_alive": settings.assistant_ollama_keep_alive or "30m",
            # Bound the context window so the KV cache footprint is small + predictable (avoids
            # runaway memory on big local models). Large enough for prompt + tool results.
            "options": {"num_ctx": int(settings.assistant_ollama_num_ctx or 8192),
                        "num_predict": DEFAULT_MAX_TOKENS},
        }
        if provider_tools:
            payload["tools"] = _openai_tools(provider_tools)
        response = transport(url, headers, payload, timeout)
        message = response.get("message", {}) if isinstance(response.get("message"), dict) else {}
        text = (message.get("content") or "").strip()
        tool_calls = _parse_openai_tool_calls(message.get("tool_calls"), prefix="ollama")
        raw_assistant = message
        if not tool_calls and tool_names:
            text, recovered = _extract_text_tool_calls(text, tool_names, prefix="ollama")
            if recovered:
                tool_calls = recovered
                raw_assistant = _synthetic_assistant_message("ollama", text, recovered)
        return response, AgentStep(text, tool_calls, "tool_use" if tool_calls else "stop", raw_assistant)

    # openai_compatible
    url = f"{base_url}/chat/completions"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": model, "messages": messages, "temperature": 0.2,
               "max_tokens": DEFAULT_MAX_TOKENS}
    if provider_tools:
        payload["tools"] = _openai_tools(provider_tools)
        payload["tool_choice"] = "auto"
    response = transport(url, headers, payload, timeout)
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message", {}) if isinstance(choice.get("message"), dict) else {}
    text = (message.get("content") or "").strip()
    tool_calls = _parse_openai_tool_calls(message.get("tool_calls"), prefix="call")
    raw_assistant = message
    if not tool_calls and tool_names:
        text, recovered = _extract_text_tool_calls(text, tool_names, prefix="call")
        if recovered:
            tool_calls = recovered
            raw_assistant = _synthetic_assistant_message("openai_compatible", text, recovered)
    return response, AgentStep(text, tool_calls, str(choice.get("finish_reason") or ""), raw_assistant)


def _lenient_json_loads(chunk: str) -> Any:
    """json.loads, but tolerate the Python-literal quirks weak models emit.

    Local models (e.g. llama3.1 via Ollama) frequently write tool calls with Python
    literals — `True`/`False`/`None` and single quotes — which are not valid JSON. Without
    this repair, recovery fails and the raw JSON leaks into the chat. Returns None on failure.
    """
    try:
        return json.loads(chunk)
    except (json.JSONDecodeError, ValueError):
        pass
    repaired = re.sub(r"\bTrue\b", "true", chunk)
    repaired = re.sub(r"\bFalse\b", "false", repaired)
    repaired = re.sub(r"\bNone\b", "null", repaired)
    try:
        return json.loads(repaired)
    except (json.JSONDecodeError, ValueError):
        return None


def _iter_json_objects(text: str):
    """Yield (start, end, substring) for each top-level balanced-brace object in text."""
    depth = 0
    start = None
    for index, char in enumerate(text):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                yield start, index + 1, text[start : index + 1]
                start = None


def _extract_text_tool_calls(
    text: str, tool_names: set[str], *, prefix: str
) -> tuple[str, list[NormalizedToolCall]]:
    """Recover tool calls that a weak model emitted as JSON in the message body.

    Some local models (e.g. via Ollama) write ```json {"name": "...", "arguments": {...}}```
    into `content` instead of returning structured `tool_calls`. Detect those, turn them into
    real calls, and strip them from the text shown to the user so raw JSON never leaks.
    """
    if not text or "{" not in text:
        return text, []
    calls: list[NormalizedToolCall] = []
    cut_spans: list[tuple[int, int]] = []
    for start, end, chunk in _iter_json_objects(text):
        obj = _lenient_json_loads(chunk)
        if not isinstance(obj, dict):
            continue
        name = obj.get("name") or obj.get("tool") or obj.get("tool_name")
        if not isinstance(name, str):
            continue
        raw_args = obj.get("arguments")
        if raw_args is None:
            raw_args = obj.get("parameters")
        if raw_args is None:
            raw_args = obj.get("input")
        # Only treat it as a (leaked) tool call if it has a params-like field or names a real tool —
        # avoids stripping unrelated JSON the user might legitimately be discussing.
        looks_like_call = raw_args is not None or name in tool_names
        if not looks_like_call:
            continue
        # Strip the JSON from the displayed text whether or not the tool exists, so a hallucinated
        # call like {"name": "list_jobs"} never leaks as raw text.
        cut_spans.append((start, end))
        if name not in tool_names:
            continue  # unknown/hallucinated tool: hide it, but don't execute anything
        args = _lenient_json_loads(raw_args) if isinstance(raw_args, str) else raw_args
        if not isinstance(args, dict):
            args = {}
        calls.append(NormalizedToolCall(id=f"{prefix}_text_{len(calls)}", name=name, input=args))
    if not cut_spans:
        return text, []
    cleaned = text
    for start, end in reversed(cut_spans):
        cleaned = cleaned[:start] + cleaned[end:]
    # Drop now-empty code fences and collapse whitespace.
    cleaned = re.sub(r"```(?:json|tool_code)?\s*```", "", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, calls


def _synthetic_assistant_message(kind: str, text: str, calls: list[NormalizedToolCall]) -> dict[str, Any]:
    """Build a provider-native assistant turn carrying recovered tool calls so results thread back."""
    if kind == "ollama":
        return {
            "role": "assistant",
            "content": text,
            "tool_calls": [{"function": {"name": c.name, "arguments": c.input}} for c in calls],
        }
    return {
        "role": "assistant",
        "content": text or None,
        "tool_calls": [
            {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.input)}}
            for c in calls
        ],
    }


def _parse_openai_tool_calls(raw: Any, *, prefix: str) -> list[NormalizedToolCall]:
    tool_calls: list[NormalizedToolCall] = []
    for index, tc in enumerate(raw or []):
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function", {}) if isinstance(tc.get("function"), dict) else {}
        arguments = fn.get("arguments")
        if isinstance(arguments, str):
            try:
                parsed = json.loads(arguments) if arguments.strip() else {}
            except json.JSONDecodeError:
                parsed = {}
        elif isinstance(arguments, dict):
            parsed = arguments
        else:
            parsed = {}
        tool_calls.append(
            NormalizedToolCall(
                id=str(tc.get("id") or f"{prefix}_{index}"),
                name=str(fn.get("name") or ""),
                input=parsed,
            )
        )
    return tool_calls


def _mark_history_cacheable(messages: list[dict[str, Any]]) -> None:
    """Keep exactly one Anthropic cache breakpoint on the most recent block-list message.

    Clears any stale ``cache_control`` first so a long agent loop can't accumulate breakpoints past
    the 4-per-request limit. String-content messages (the opening user turn) are skipped — a breakpoint
    must sit on a content *block*. Combined with the cached system block that is 2 breakpoints total.
    """
    last_block: dict[str, Any] | None = None
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    block.pop("cache_control", None)
                    last_block = block
    if last_block is not None:
        last_block["cache_control"] = {"type": "ephemeral"}


def _append_tool_results(
    kind: str,
    native_messages: list[dict[str, Any]],
    results: list[dict[str, Any]],
) -> None:
    if kind == "anthropic":
        native_messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": result["id"],
                        "content": result["content"],
                        "is_error": result.get("is_error", False),
                    }
                    for result in results
                ],
            }
        )
        return
    for result in results:
        message = {"role": "tool", "content": result["content"]}
        if kind == "ollama":
            message["tool_name"] = result["name"]
        else:
            message["tool_call_id"] = result["id"]
        native_messages.append(message)


# --------------------------------------------------------------------------- #
# Tool execution dispatch (read-only in-loop, side effects surfaced)
# --------------------------------------------------------------------------- #


_CLAIM_PHRASES = ("prepared", "i've created", "i have created", "i created", "queued", "i've designed",
                  "i have designed", "ready for review", "for your review", "for review")


def _reconcile_claim(final_text: str, *, pending: list[PendingSideEffect], issues: list[str]) -> str:
    """If the model claims it prepared an action but none was actually surfaced, say so plainly.

    Weak models sometimes narrate success even though the tool call was invalid (and was therefore not
    turned into a confirmation card). Append a correction so the user isn't misled.
    """
    if pending:
        return final_text
    lowered = final_text.lower()
    if not any(phrase in lowered for phrase in _CLAIM_PHRASES):
        return final_text
    if issues:
        detail = " ".join(f"({issue})" for issue in issues[:3])
        return (
            f"{final_text}\n\nNote: no action card was actually created — the request could not be prepared: "
            f"{detail} Please refine and try again."
        )
    return (
        f"{final_text}\n\nNote: no confirmation card was created, so nothing is pending. "
        "If you intended an action, ask me to prepare it explicitly."
    )


def _run_tool_call(
    session: Session,
    *,
    call: NormalizedToolCall,
    context: AssistantContext,
    conversation_id: int | None,
    pending: list[PendingSideEffect],
    executed: list[dict[str, Any]],
    issues: list[str] | None = None,
) -> dict[str, Any]:
    """Execute a read-only tool, or surface a side-effecting one. Returns a tool_result payload."""
    try:
        spec = get_tool_spec(call.name)
    except Exception:
        return _tool_result(call, {"status": "error", "error": f"Unknown tool '{call.name}'."}, is_error=True)

    if spec.side_effect:
        preview = preview_tool(
            session, call.name, AssistantToolPreviewRequest(arguments=call.input, context=context)
        )
        if not preview.valid:
            # Don't surface a broken card to the user; hand the errors back so the model fixes the call,
            # and record the issue so a falsely-claimed success can be contradicted afterwards.
            if issues is not None:
                issues.append(f"{call.name}: {'; '.join(preview.errors) or 'invalid arguments'}")
            return _tool_result(
                call,
                {
                    "status": "invalid_arguments",
                    "note": "This action was NOT prepared because the arguments are invalid. Fix them and call again.",
                    "errors": preview.errors,
                },
                is_error=True,
            )
        # De-duplicate identical proposals so the rail does not fill with repeats.
        signature = (call.name, json.dumps(preview.normalized_arguments, sort_keys=True, default=str))
        if signature not in {
            (p.tool_name, json.dumps(p.normalized_arguments, sort_keys=True, default=str)) for p in pending
        }:
            pending.append(
                PendingSideEffect(
                    tool_name=call.name,
                    normalized_arguments=preview.normalized_arguments,
                    preview=preview.preview,
                    valid=True,
                    errors=[],
                )
            )
        return _tool_result(
            call,
            {
                "status": "pending_user_confirmation",
                "note": (
                    "A confirmation card was shown to the user. This action has NOT been executed. "
                    "Do not claim it ran; tell the user it is prepared and awaiting their approval."
                ),
                "preview": preview.preview,
            },
        )

    # Read-only: execute now and feed real data back.
    outcome = execute_tool(
        session,
        call.name,
        AssistantToolExecutionRequest(
            arguments=call.input, context=context, conversation_id=conversation_id
        ),
    )
    if outcome.executed:
        executed.append({"tool_name": call.name, "result": outcome.result})
        return _tool_result(call, outcome.result)
    return _tool_result(
        call,
        {"status": "error", "errors": outcome.errors, "preview": outcome.result},
        is_error=True,
    )


def _tool_result(call: NormalizedToolCall, payload: dict[str, Any], *, is_error: bool = False) -> dict[str, Any]:
    content = json.dumps(payload, default=str)
    cap = int(settings.assistant_max_tool_result_chars or 0)
    if cap and len(content) > cap:
        # Trim what re-enters the model's context each round (the grounded card the user sees is full).
        content = content[:cap] + f'… [truncated {len(content) - cap} chars; full data shown in the card]"'
    return {
        "id": call.id,
        "name": call.name,
        "content": content,
        "is_error": is_error,
    }


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def _summary_model(provider) -> str:
    """Pick a cheap model for compaction per provider; the local model is reused as-is."""
    override = (settings.assistant_summary_model or "").strip()
    if override:
        return override
    provider_id = provider.provider_id
    if provider_id == "anthropic":
        return "claude-haiku-4-5"
    if provider_id == "openai":
        return "gpt-4.1-mini"
    if provider_id == "openrouter":
        return "openai/gpt-4.1-mini"
    # ollama / lm_studio / vllm: reuse the already-loaded local model (no second load).
    return _provider_model(provider)


def compact_conversation(
    session: Session | None,
    conversation_id: int,
    *,
    provider_id: str = "",
    model: str = "",
    transport: Transport | None = None,
) -> dict[str, Any]:
    """Fold older turns into a rolling, model-written summary once enough accumulate.

    Provider-agnostic: summarizes with the active provider using a cheap model (`_summary_model`).
    Infrequent — only fires when at least `assistant_compact_threshold` un-summarized older turns
    exist beyond the `assistant_keep_recent_turns` kept verbatim. Best-effort; never raises.
    """
    from sqlmodel import select as _select

    from app.db.models import AssistantMessage as _Message
    from app.services.assistant_harness import (
        from_json as _from_json,
        get_conversation_summary as _get_summary,
        upsert_conversation_summary as _upsert_summary,
    )

    if session is None:
        return {"compacted": False, "reason": "no_session"}
    provider = _select_provider(session, provider_id, model)
    if not provider or not _resolved_provider_configured(provider):
        return {"compacted": False, "reason": "no_provider"}

    records = session.exec(
        _select(_Message).where(_Message.conversation_id == conversation_id).order_by(_Message.id)
    ).all()
    summary_record = _get_summary(session, conversation_id)
    covered = int(_from_json(summary_record.context_json, {}).get("covered_up_to_message_id") or 0) if summary_record else 0
    turns = [r for r in records if r.role in {"user", "assistant"}]

    # Semantic boundary: the user switched focus gene or page between their last two turns. When that
    # happens we compact sooner and keep a tighter verbatim window, so the summary aligns to the task
    # boundary instead of straddling two topics.
    user_msgs = [r for r in records if r.role == "user"]
    boundary = False
    if len(user_msgs) >= 2:
        c_now = _from_json(user_msgs[-1].context_json, {}) or {}
        c_prev = _from_json(user_msgs[-2].context_json, {}) or {}
        gene_now, gene_prev = (c_now.get("selected_gene") or ""), (c_prev.get("selected_gene") or "")
        if gene_now and gene_prev and gene_now != gene_prev:
            boundary = True
        route_now = (c_now.get("route") or "").split("?")[0]
        route_prev = (c_prev.get("route") or "").split("?")[0]
        if route_now and route_prev and route_now != route_prev:
            boundary = True

    keep = max(2, int(settings.assistant_keep_recent_turns or 12))
    threshold = max(1, int(settings.assistant_compact_threshold or 6))
    if boundary:
        keep = max(2, keep // 2)
        threshold = 2

    older = [r for r in turns if (r.id or 0) > covered]
    to_summarize = older[:-keep] if len(older) > keep else []
    if len(to_summarize) < threshold:
        return {"compacted": False, "reason": "below_threshold", "pending_old": len(to_summarize), "boundary": boundary}

    existing = summary_record.content if summary_record else ""
    transcript = "\n".join(f"{r.role}: {r.content[:1200]}" for r in to_summarize)
    prompt = (
        "Compress the earlier part of this assistant conversation into durable notes for future turns. "
        "Capture decisions made, genes/conditions/experiments selected, user constraints and preferences, and "
        "open questions. Be faithful and concise (<= 180 words). Merge with the existing summary without losing "
        "prior facts.\n\n"
        f"Existing summary:\n{existing or '(none)'}\n\nNew messages to fold in:\n{transcript}"
    )
    spec = provider.spec
    model = _summary_model(provider)
    timeout = max(1, int(settings.assistant_request_timeout_sec or 30))
    if spec.kind == "ollama" or bool(spec.endpoint_setting):
        timeout = max(timeout, int(settings.assistant_local_timeout_sec or 300))
    try:
        _response, step = _call_provider(
            kind=spec.kind,
            base_url=_provider_base_url(provider),
            model=model,
            api_key=_provider_secret(provider),
            extra_headers=spec.extra_headers,
            system="You compress conversation history faithfully and concisely.",
            native_messages=[{"role": "user", "content": prompt}],
            provider_tools=[],
            timeout=timeout,
            transport=transport or _default_transport,
        )
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, IndexError, TypeError, ValueError) as exc:
        return {"compacted": False, "error": str(exc)}
    new_summary = (step.text or "").strip()
    if not new_summary:
        return {"compacted": False, "reason": "empty_summary"}
    covered_new = max((r.id or 0) for r in to_summarize)
    _upsert_summary(session, conversation_id, new_summary, covered_new)
    return {"compacted": True, "covered_up_to": covered_new, "summarized": len(to_summarize), "model": model, "boundary": boundary}


def warm_provider(session: Session | None) -> dict[str, Any]:
    """Pre-load a local model so the first real question doesn't pay the cold-start cost.

    No-op for hosted providers. For local runtimes (Ollama/LM Studio/vLLM) it fires a tiny
    keep-alive generation so the weights are resident before the user asks anything.
    """
    provider = _select_provider(session)
    if not provider or not _resolved_provider_configured(provider):
        return {"warmed": False, "reason": "no_configured_provider"}
    spec = provider.spec
    if not (spec.kind == "ollama" or spec.endpoint_setting):
        return {"warmed": False, "reason": "provider_not_local", "provider_id": provider.provider_id}
    model = _provider_model(provider)
    timeout = max(int(settings.assistant_local_timeout_sec or 300), 60)
    try:
        _call_provider(
            kind=spec.kind,
            base_url=_provider_base_url(provider),
            model=model,
            api_key=_provider_secret(provider),
            extra_headers=spec.extra_headers,
            system="ready",
            native_messages=[{"role": "user", "content": "ok"}],
            provider_tools=[],
            timeout=timeout,
            transport=_default_transport,
        )
        return {"warmed": True, "provider_id": provider.provider_id, "model": model}
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, IndexError, TypeError, ValueError) as exc:
        return {"warmed": False, "provider_id": provider.provider_id, "model": model, "error": str(exc)}


def generate_assistant_agent_reply(
    user_content: str,
    context: dict[str, Any],
    *,
    session: Session | None = None,
    history: list[dict[str, Any]] | None = None,
    conversation_id: int | None = None,
    provider_id: str = "",
    model: str = "",
    transport: Transport | None = None,
) -> AssistantAgentResult:
    active_config = _active_provider_config(session)
    requested_provider = provider_id or (active_config.provider_id if active_config else (settings.assistant_provider or "").strip())
    if requested_provider and requested_provider not in RUNTIME_PROVIDER_SPECS:
        return AssistantAgentResult(
            status="provider_not_supported",
            provider_id=requested_provider,
            content=(
                f"Assistant provider '{requested_provider}' is selected, but this build has no runtime adapter for it. "
                "Choose OpenAI, Anthropic, or Ollama for tool-using chat."
            ),
            request={"content_length": len(user_content)},
            response={"reason": "selected provider has no runtime adapter"},
        )

    provider = _select_provider(session, provider_id, model)
    if not provider:
        return AssistantAgentResult(
            status="no_provider_configured",
            content=(
                "Assistant chat is not connected to a provider yet. The message and context were stored, and no "
                "model call or tool execution was attempted."
            ),
            request={"content_length": len(user_content)},
            response={"reason": "no configured assistant provider"},
        )
    if not _resolved_provider_configured(provider):
        return AssistantAgentResult(
            status="selected_provider_not_configured",
            provider_id=provider.provider_id,
            model=_provider_model(provider),
            content=(
                f"Assistant provider '{provider.provider_id}' is selected but not configured. Set the provider key or "
                "local endpoint in Assistant provider setup before using tool-using chat."
            ),
            request={"content_length": len(user_content)},
            response={"reason": "selected provider is not configured"},
        )

    if session is None:
        return AssistantAgentResult(
            status="provider_call_failed",
            provider_id=provider.provider_id,
            model=_provider_model(provider),
            content="The assistant agent requires a database session to execute tools.",
            response={"reason": "no session for tool execution"},
        )

    spec = provider.spec
    kind = spec.kind
    model = _provider_model(provider)
    base_url = _provider_base_url(provider)
    api_key = _provider_secret(provider)
    timeout = max(1, int(settings.assistant_request_timeout_sec or 30))
    # Local runtimes load big weights on the first call and reason more with tools attached.
    is_local = kind == "ollama" or bool(spec.endpoint_setting)
    if is_local:
        timeout = max(timeout, int(settings.assistant_local_timeout_sec or 300))
    max_turns = max(1, int(settings.assistant_max_agent_turns or 6))
    active_transport = transport or _default_transport

    system = build_system(kind, context, frontier=not is_local)
    native_messages = _base_messages(history, user_content)
    tools = enrich_tools_for_session(session, build_agent_tools())
    typed_context = AssistantContext.model_validate(
        {key: context.get(key) for key in AssistantContext.model_fields if context.get(key) is not None}
    )

    pending: list[PendingSideEffect] = []
    executed: list[dict[str, Any]] = []
    issues: list[str] = []
    final_text = ""
    stop_reason = ""
    turns_used = 0
    last_response: dict[str, Any] = {}

    try:
        for _ in range(max_turns):
            turns_used += 1
            last_response, step = _call_provider(
                kind=kind,
                base_url=base_url,
                model=model,
                api_key=api_key,
                extra_headers=spec.extra_headers,
                system=system,
                native_messages=native_messages,
                provider_tools=tools,
                timeout=timeout,
                transport=active_transport,
            )
            stop_reason = step.stop_reason
            if step.text:
                final_text = step.text
            if not step.tool_calls:
                break
            # Record the assistant turn (with its tool_use/tool_calls) then the results.
            native_messages.append(step.raw_assistant_message)
            results = [
                _run_tool_call(
                    session,
                    call=call,
                    context=typed_context,
                    conversation_id=conversation_id,
                    pending=pending,
                    executed=executed,
                    issues=issues,
                )
                for call in step.tool_calls
            ]
            _append_tool_results(kind, native_messages, results)
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, IndexError, TypeError, ValueError) as exc:
        hint = "Assistant provider call failed. No side effects were executed."
        if kind == "ollama":
            hint = (
                "Ollama call failed. Check the endpoint is reachable, the model is pulled and supports tool calling, "
                "and that it had time to respond. No side effects were executed."
            )
        return AssistantAgentResult(
            status="provider_call_failed",
            provider_id=provider.provider_id,
            model=model,
            content=hint,
            request={"content_length": len(user_content), "turns": turns_used},
            response={"error_type": type(exc).__name__},
            error=str(exc),
            pending_side_effects=pending,
            executed_tools=executed,
        )

    if not final_text:
        if pending:
            final_text = "I've prepared the action(s) above for your review. Confirm to proceed; nothing has run yet."
        elif executed:
            final_text = "I inspected the requested platform data above."
        else:
            final_text = "The provider returned an empty response."
    final_text = _reconcile_claim(final_text, pending=pending, issues=issues)

    return AssistantAgentResult(
        status="completed",
        provider_id=provider.provider_id,
        model=model,
        content=final_text,
        request={
            "provider_id": provider.provider_id,
            "model": model,
            "content_length": len(user_content),
            "turns": turns_used,
            "tool_names": [t["name"] for t in tools],
            "context": context,
        },
        response={
            "status": "completed",
            "stop_reason": stop_reason,
            "executed_tool_count": len(executed),
            "pending_side_effect_count": len(pending),
        },
        pending_side_effects=pending,
        executed_tools=executed,
    )
