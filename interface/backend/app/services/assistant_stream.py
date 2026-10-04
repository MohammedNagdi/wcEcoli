"""Streaming (SSE) agent loop — token-by-token deltas with in-loop tool execution.

Mirrors ``generate_assistant_agent_reply`` but streams. Reuses all the wire-format and tool
plumbing from ``assistant_agent`` so there is one source of truth for tool schemas, the system
prompt, text-embedded-call recovery, and read-only/side-effect execution.

Event types yielded:
* ``meta``   — {provider_id, model}
* ``delta``  — {text} incremental assistant text
* ``status`` — {status:"running_tool", tool} when a tool executes mid-loop
* ``result`` — terminal {result: AssistantAgentResult dump} for persistence
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Generator, Iterator

from sqlmodel import Session

from app.services.assistant_output import iter_json_objects, lenient_json_loads, tool_envelope, remove_tool_envelopes
from app.config import settings
from app.services.assistant_runtime import (
    RUNTIME_PROVIDER_SPECS,
    _active_provider_config,
    _provider_base_url,
    _provider_model,
    _provider_secret,
    _resolved_provider_configured,
    _select_provider,
)
from app.services.assistant_harness import AssistantContext
from app.services.assistant_agent import (
    DEFAULT_MAX_TOKENS,
    AgentStep,
    AssistantAgentResult,
    NormalizedToolCall,
    PendingSideEffect,
    _agent_system_prompt,
    _anthropic_tools,
    _append_tool_results,
    _base_messages,
    _extract_text_tool_calls,
    _openai_tools,
    _parse_openai_tool_calls,
    _reconcile_claim,
    _run_tool_call,
    _synthetic_assistant_message,
    build_agent_tools,
    build_system,
    enrich_tools_for_session,
)


class _FenceFilter:
    """Hide recovered tool envelopes, preserving ordinary Markdown and code as it arrives.

    Only JSON/tool-code/unlabelled fences that could contain a tool envelope are held for
    classification. Ordinary code and non-JSON braces pass through immediately. Classification
    uses the same policy as final response recovery; this filter never executes a tool.
    """

    def __init__(self, tool_names: set[str] | None = None) -> None:
        self.tool_names = tool_names or set()
        self.buffer = ""
        self.line_prefix = ""
        self.mode = "text"
        self.marker = ""
        self.opening = ""

    def _consume(self, count: int) -> str:
        value, self.buffer = self.buffer[:count], self.buffer[count:]
        tail = (self.line_prefix + value).rsplit("\n", 1)[-1]
        self.line_prefix = tail if len(tail) <= 4 else "x"
        return value

    def _fence(self, closing: bool = False, final: bool = False):
        context = self.line_prefix + self.buffer
        marker = re.escape(self.marker[0]) + "{" + str(len(self.marker)) + ",}" if closing else "(`{3,}|~{3,})"
        pattern = r"(?m)^[ \t]{0,3}" + marker + (r"[ \t]*(?:\n|$)" if closing else r"([^\n]*)(?:\n|$)")
        match = re.search(pattern, context)
        if match and match.end() > len(self.line_prefix):
            start = max(0, match.start() - len(self.line_prefix))
            end = match.end() - len(self.line_prefix)
            complete = context[match.end() - 1:match.end()] == "\n" or final
            return start, end, match, complete
        return None

    def feed(self, text: str, *, final: bool = False) -> str:
        self.buffer += text
        out: list[str] = []
        while self.buffer:
            if self.mode != "text":
                closing = self._fence(closing=True, final=final)
                if self.mode == "candidate":
                    body = self.buffer[:closing[0]] if closing else self.buffer
                    stripped = body.lstrip()
                    objects = list(iter_json_objects(stripped))
                    # A non-JSON body, or a complete ordinary JSON object, can stream normally.
                    ordinary = bool(stripped) and not stripped.startswith("{")
                    if objects and objects[0][0] == 0:
                        ordinary = tool_envelope(lenient_json_loads(objects[0][2]), self.tool_names) is None
                    if ordinary and not closing:
                        out.append(self.opening)
                        self.opening = ""
                        self.mode = "code"
                        continue
                    if closing and closing[3]:
                        raw = self._consume(closing[1])
                        cleaned = remove_tool_envelopes(raw[:closing[0]], self.tool_names)
                        if cleaned.strip() or cleaned == raw[:closing[0]]:
                            out.append(self.opening + cleaned + raw[closing[0]:])
                        self.opening = ""
                        self.mode = "text"
                        continue
                    if final:
                        raw = self._consume(len(self.buffer))
                        cleaned = remove_tool_envelopes(raw, self.tool_names)
                        if cleaned.strip() or cleaned == raw:
                            out.append(self.opening + cleaned)
                        self.opening = ""
                    break
                if closing:
                    if closing[3]:
                        out.append(self._consume(closing[1]))
                        self.mode = "text"
                        continue
                    out.append(self._consume(closing[0]))
                    break
                # Hold only a possible closing marker at the beginning of the last line.
                last = self.buffer.rsplit("\n", 1)[-1]
                context_last = self.line_prefix + last if "\n" not in self.buffer else last
                hold = len(last) if re.fullmatch(r"[ \t]{0,3}[`~]*", context_last) and not final else 0
                out.append(self._consume(len(self.buffer) - hold))
                break

            fence = self._fence(final=final)
            brace = self.buffer.find("{")
            if fence and (brace < 0 or fence[0] <= brace):
                out.append(self._consume(fence[0]))
                # Recompute after consuming preceding prose (line prefix/offset changed).
                fence = self._fence(final=final)
                if not fence or not fence[3]:
                    break
                self.marker = fence[2].group(1)
                language = fence[2].group(2).strip().lower()
                self.opening = self._consume(fence[1])
                self.mode = "candidate" if language in {"", "json", "tool_code"} else "code"
                if self.mode == "code":
                    out.append(self.opening)
                    self.opening = ""
                continue
            if brace >= 0:
                out.append(self._consume(brace))
                rest = self.buffer[1:].lstrip()
                if not rest and not final:
                    break
                if not rest.startswith('"'):
                    out.append(self._consume(1))
                    continue
                objects = list(iter_json_objects(self.buffer))
                if objects and objects[0][0] == 0:
                    chunk = self._consume(objects[0][1])
                    if not tool_envelope(lenient_json_loads(chunk), self.tool_names):
                        out.append(chunk)
                    continue
                if final:
                    out.append(self._consume(len(self.buffer)))
                break
            last = self.buffer.rsplit("\n", 1)[-1]
            context_last = self.line_prefix + last if "\n" not in self.buffer else last
            hold = len(last) if re.fullmatch(r"[ \t]{0,3}[`~]{1,2}", context_last) and not final else 0
            out.append(self._consume(len(self.buffer) - hold))
            break
        return "".join(out)

    def flush(self) -> str:
        if not self.buffer and self.opening:
            opening, self.opening = self.opening, ""
            return opening
        return self.feed("", final=True)


def _default_stream_transport(
    url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int
) -> Iterator[str]:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    response = urllib.request.urlopen(request, timeout=timeout)
    for raw in response:
        yield raw.decode("utf-8", errors="replace").rstrip("\r\n")


def _stream_openai(lines: Iterator[str], *, prefix: str) -> Generator[dict[str, Any], None, AgentStep]:
    text_parts: list[str] = []
    tool_by_index: dict[int, dict[str, str]] = {}
    finish = ""
    for line in lines:
        if not line or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            continue
        choice = (chunk.get("choices") or [{}])[0]
        delta = choice.get("delta") or {}
        content = delta.get("content")
        if content:
            text_parts.append(content)
            yield {"type": "delta", "text": content}
        for tc in delta.get("tool_calls") or []:
            idx = tc.get("index", 0)
            slot = tool_by_index.setdefault(idx, {"id": "", "name": "", "args": ""})
            if tc.get("id"):
                slot["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["name"] = fn["name"]
            if fn.get("arguments"):
                slot["args"] += fn["arguments"]
        if choice.get("finish_reason"):
            finish = choice["finish_reason"]
    calls: list[NormalizedToolCall] = []
    for idx in sorted(tool_by_index):
        slot = tool_by_index[idx]
        if not slot["name"]:
            continue
        try:
            args = json.loads(slot["args"]) if slot["args"].strip() else {}
        except (json.JSONDecodeError, ValueError):
            args = {}
        calls.append(
            NormalizedToolCall(
                id=slot["id"] or f"{prefix}_{idx}",
                name=slot["name"],
                input=args if isinstance(args, dict) else {},
            )
        )
    text = "".join(text_parts).strip()
    raw_assistant: dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:
        raw_assistant["tool_calls"] = [
            {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.input)}}
            for c in calls
        ]
    return AgentStep(text, calls, finish or ("tool_use" if calls else "stop"), raw_assistant)


def _stream_ollama(lines: Iterator[str]) -> Generator[dict[str, Any], None, AgentStep]:
    text_parts: list[str] = []
    tool_calls_raw: list[Any] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            chunk = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        message = chunk.get("message") or {}
        content = message.get("content")
        if content:
            text_parts.append(content)
            yield {"type": "delta", "text": content}
        if message.get("tool_calls"):
            tool_calls_raw.extend(message["tool_calls"])
    calls = _parse_openai_tool_calls(tool_calls_raw, prefix="ollama")
    text = "".join(text_parts).strip()
    raw_assistant: dict[str, Any] = {"role": "assistant", "content": text}
    if tool_calls_raw:
        raw_assistant["tool_calls"] = tool_calls_raw
    return AgentStep(text, calls, "tool_use" if calls else "stop", raw_assistant)


def _stream_anthropic(lines: Iterator[str]) -> Generator[dict[str, Any], None, AgentStep]:
    text_parts: list[str] = []
    blocks: dict[int, dict[str, str]] = {}
    stop = ""
    for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data:
            continue
        try:
            event = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            continue
        etype = event.get("type")
        if etype == "content_block_start":
            idx = event.get("index", 0)
            block = event.get("content_block", {})
            blocks[idx] = {
                "type": block.get("type", ""),
                "id": block.get("id", ""),
                "name": block.get("name", ""),
                "json": "",
            }
        elif etype == "content_block_delta":
            idx = event.get("index", 0)
            delta = event.get("delta", {})
            if delta.get("type") == "text_delta":
                txt = delta.get("text", "")
                if txt:
                    text_parts.append(txt)
                    yield {"type": "delta", "text": txt}
            elif delta.get("type") == "input_json_delta":
                blocks.setdefault(idx, {"type": "tool_use", "id": "", "name": "", "json": ""})["json"] += delta.get("partial_json", "")
        elif etype == "message_delta":
            stop = event.get("delta", {}).get("stop_reason") or stop
    text = "".join(text_parts).strip()
    content_blocks: list[dict[str, Any]] = []
    if text:
        content_blocks.append({"type": "text", "text": text})
    calls: list[NormalizedToolCall] = []
    for idx in sorted(blocks):
        block = blocks[idx]
        if block["type"] != "tool_use":
            continue
        try:
            parsed = json.loads(block["json"]) if block["json"].strip() else {}
        except (json.JSONDecodeError, ValueError):
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        calls.append(NormalizedToolCall(id=block["id"], name=block["name"], input=parsed))
        content_blocks.append({"type": "tool_use", "id": block["id"], "name": block["name"], "input": parsed})
    raw_assistant = {"role": "assistant", "content": content_blocks}
    return AgentStep(text, calls, stop or ("tool_use" if calls else "end_turn"), raw_assistant)


def _stream_provider(
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
    stream_transport,
    tool_names: set[str],
) -> Generator[dict[str, Any], None, AgentStep]:
    if kind == "anthropic":
        url = f"{base_url}/messages"
        headers = {"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": "2023-06-01"}
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "system": system,
            "messages": native_messages,
            "stream": True,
        }
        if provider_tools:
            payload["tools"] = _anthropic_tools(provider_tools)
        step = yield from _stream_anthropic(stream_transport(url, headers, payload, timeout))
        return step

    messages = [{"role": "system", "content": system}, *native_messages]
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)

    if kind == "ollama":
        url = f"{base_url}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "keep_alive": settings.assistant_ollama_keep_alive or "30m",
            "options": {"num_ctx": int(settings.assistant_ollama_num_ctx or 8192)},
        }
        if provider_tools:
            payload["tools"] = _openai_tools(provider_tools)
        step = yield from _stream_ollama(stream_transport(url, headers, payload, timeout))
        if not step.tool_calls and tool_names:
            cleaned, recovered = _extract_text_tool_calls(step.text, tool_names, prefix="ollama")
            if recovered:
                return AgentStep(cleaned, recovered, "tool_use", _synthetic_assistant_message("ollama", cleaned, recovered))
        return step

    url = f"{base_url}/chat/completions"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {"model": model, "messages": messages, "temperature": 0.2, "stream": True}
    if provider_tools:
        payload["tools"] = _openai_tools(provider_tools)
        payload["tool_choice"] = "auto"
    step = yield from _stream_openai(stream_transport(url, headers, payload, timeout), prefix="call")
    if not step.tool_calls and tool_names:
        cleaned, recovered = _extract_text_tool_calls(step.text, tool_names, prefix="call")
        if recovered:
            return AgentStep(cleaned, recovered, "tool_use", _synthetic_assistant_message("openai_compatible", cleaned, recovered))
    return step


def stream_assistant_agent_events(
    user_content: str,
    context: dict[str, Any],
    *,
    session: Session,
    history: list[dict[str, Any]] | None = None,
    conversation_id: int | None = None,
    provider_id: str = "",
    model: str = "",
    stream_transport=None,
) -> Generator[dict[str, Any], None, None]:
    active_config = _active_provider_config(session)
    requested_provider = provider_id or (active_config.provider_id if active_config else (settings.assistant_provider or "").strip())

    def _emit(result: AssistantAgentResult) -> Generator[dict[str, Any], None, None]:
        yield {"type": "result", "result": result.model_dump()}

    if requested_provider and requested_provider not in RUNTIME_PROVIDER_SPECS:
        yield from _emit(AssistantAgentResult(
            status="provider_not_supported", provider_id=requested_provider,
            content=f"Assistant provider '{requested_provider}' has no runtime adapter. Choose OpenAI, Anthropic, or Ollama.",
        ))
        return

    provider = _select_provider(session, provider_id, model)
    if not provider:
        yield from _emit(AssistantAgentResult(
            status="no_provider_configured",
            content="Assistant chat is not connected to a provider yet. The message and context were stored; no model call was made.",
        ))
        return
    if not _resolved_provider_configured(provider):
        yield from _emit(AssistantAgentResult(
            status="selected_provider_not_configured", provider_id=provider.provider_id, model=_provider_model(provider),
            content=f"Assistant provider '{provider.provider_id}' is selected but not configured.",
        ))
        return

    spec = provider.spec
    kind = spec.kind
    model = _provider_model(provider)
    base_url = _provider_base_url(provider)
    api_key = _provider_secret(provider)
    timeout = max(1, int(settings.assistant_request_timeout_sec or 30))
    if kind == "ollama" or bool(spec.endpoint_setting):
        timeout = max(timeout, int(settings.assistant_local_timeout_sec or 300))
    max_turns = max(1, int(settings.assistant_max_agent_turns or 6))
    active_transport = stream_transport or _default_stream_transport

    system = build_system(kind, context)
    native_messages = _base_messages(history, user_content)
    tools = enrich_tools_for_session(session, build_agent_tools())
    tool_names = {t["name"] for t in tools}
    typed_context = AssistantContext.model_validate(
        {key: context.get(key) for key in AssistantContext.model_fields if context.get(key) is not None}
    )

    yield {"type": "meta", "provider_id": provider.provider_id, "model": model}

    pending: list[PendingSideEffect] = []
    executed: list[dict[str, Any]] = []
    issues: list[str] = []
    final_text = ""
    stop_reason = ""
    turns_used = 0

    try:
        for _ in range(max_turns):
            turns_used += 1
            fence = _FenceFilter(tool_names)
            provider_gen = _stream_provider(
                kind=kind, base_url=base_url, model=model, api_key=api_key,
                extra_headers=spec.extra_headers, system=system, native_messages=native_messages,
                provider_tools=tools, timeout=timeout, stream_transport=active_transport, tool_names=tool_names,
            )
            try:
                while True:
                    event = next(provider_gen)
                    if event.get("type") == "delta":
                        shown = fence.feed(event.get("text", ""))
                        if shown:
                            yield {"type": "delta", "text": shown}
                    else:
                        yield event
            except StopIteration as stop:
                step = stop.value
            tail = fence.flush()
            if tail:
                yield {"type": "delta", "text": tail}
            stop_reason = step.stop_reason
            if step.text:
                final_text = step.text
            if not step.tool_calls:
                break
            native_messages.append(step.raw_assistant_message)
            for call in step.tool_calls:
                yield {"type": "status", "status": "running_tool", "tool": call.name}
            results = [
                _run_tool_call(session, call=call, context=typed_context, conversation_id=conversation_id,
                               pending=pending, executed=executed, issues=issues)
                for call in step.tool_calls
            ]
            _append_tool_results(kind, native_messages, results)
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, IndexError, TypeError, ValueError) as exc:
        hint = "Assistant provider call failed. No side effects were executed."
        if kind == "ollama":
            hint = ("Ollama call failed. Check the endpoint is reachable, the model is pulled and supports tool calling, "
                    "and that it had time to respond. No side effects were executed.")
        yield from _emit(AssistantAgentResult(
            status="provider_call_failed", provider_id=provider.provider_id, model=model, content=hint,
            response={"error_type": type(exc).__name__}, error=str(exc),
            pending_side_effects=pending, executed_tools=executed,
        ))
        return

    if not final_text:
        if pending:
            final_text = "I've prepared the action(s) above for your review. Confirm to proceed; nothing has run yet."
        elif executed:
            final_text = "I inspected the requested platform data above."
        else:
            final_text = "The provider returned an empty response."
    final_text = _reconcile_claim(final_text, pending=pending, issues=issues)

    yield from _emit(AssistantAgentResult(
        status="completed", provider_id=provider.provider_id, model=model, content=final_text,
        request={"provider_id": provider.provider_id, "model": model, "content_length": len(user_content),
                 "turns": turns_used, "tool_names": [t["name"] for t in tools], "context": context, "streamed": True},
        response={"status": "completed", "stop_reason": stop_reason,
                  "executed_tool_count": len(executed), "pending_side_effect_count": len(pending)},
        pending_side_effects=pending, executed_tools=executed,
    ))
