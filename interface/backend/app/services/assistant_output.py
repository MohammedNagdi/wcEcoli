"""Shared presentation guidance and classification of recovered textual tool envelopes."""
from __future__ import annotations

import json
import re
from typing import Any

PRESENTATION_GUIDANCE = (
    "\n\nResponse presentation:\n"
    "- Write readable Markdown. Use headings for sections and numbered lists only for sequences. "
    "Indent nested bullets under their parent item and separate block elements with blank lines.\n"
    "- Give tables header rows and identify units. Preserve tool-provided values and identifiers. "
    "Use inline code for identifiers and fenced code with a language label for code; close every fence.\n"
    "- For permitted mathematical expressions use $$formula$$ inline, or $$ on separate lines for "
    "display equations. Do not use single-dollar delimiters. Do not reproduce governing equations "
    "when the scientific policy forbids them.\n"
    "- These presentation rules apply to answer prose; retain any required proposal protocol lines "
    "and use the tool interface for tool calls.\n\n"
)


def lenient_json_loads(chunk: str) -> Any:
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


def iter_json_objects(text: str):
    """Balanced objects, respecting quoted braces and escapes; offsets refer to original text."""
    depth = 0
    start = None
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"' and depth:
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                yield start, index + 1, text[start:index + 1]
                start = None


def tool_envelope(obj: Any, tool_names: set[str]) -> tuple[str, Any] | None:
    """The existing recovery policy: a name plus arguments, or the name of an actual tool."""
    if not isinstance(obj, dict):
        return None
    name = obj.get("name") or obj.get("tool") or obj.get("tool_name")
    if not isinstance(name, str):
        return None
    args = obj.get("arguments")
    if args is None:
        args = obj.get("parameters")
    if args is None:
        args = obj.get("input")
    return (name, args) if args is not None or name in tool_names else None


def remove_tool_envelopes(text: str, tool_names: set[str]) -> str:
    spans = [(start, end) for start, end, chunk in iter_json_objects(text)
             if tool_envelope(lenient_json_loads(chunk), tool_names)]
    for start, end in reversed(spans):
        text = text[:start] + text[end:]
    return text


def recoverable_json_objects(text: str):
    """Exclude ordinary labelled code from textual tool recovery, consistently with streaming."""
    excluded = []
    opening = None
    offset = 0
    for line in text.splitlines(keepends=True):
        match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)", line)
        if opening:
            start, marker, ordinary = opening
            if match and match[1][0] == marker[0] and len(match[1]) >= len(marker) and not match[2].strip():
                if ordinary:
                    excluded.append((start, offset + len(line)))
                opening = None
        elif match:
            opening = (offset, match[1], match[2].strip().lower() not in {"", "json", "tool_code"})
        offset += len(line)
    if opening and opening[2]:
        excluded.append((opening[0], len(text)))
    for start, end, chunk in iter_json_objects(text):
        if not any(low <= start < high for low, high in excluded):
            yield start, end, chunk
