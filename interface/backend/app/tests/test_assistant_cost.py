"""Cost-control behaviors in the agent loop: tool-result trimming + Anthropic history caching."""

from app.config import settings
from app.services.assistant_agent import NormalizedToolCall, _mark_history_cacheable, _tool_result


def test_tool_result_trims_large_payloads(monkeypatch):
    monkeypatch.setattr(settings, "assistant_max_tool_result_chars", 200)
    call = NormalizedToolCall(id="t1", name="gene_catalog", input={})
    big = _tool_result(call, {"genes": ["g"] * 5000})
    assert len(big["content"]) <= 200 + 80                     # capped + short marker
    assert "truncated" in big["content"]
    small = _tool_result(call, {"ok": True})
    assert "truncated" not in small["content"]                 # small payloads untouched


def test_history_cache_breakpoint_is_single_and_on_last_block():
    messages = [
        {"role": "user", "content": "hello"},                                  # string -> skipped
        {"role": "assistant", "content": [{"type": "text", "text": "hi"},
                                          {"type": "tool_use", "id": "t1", "name": "x", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "{}"}]},
    ]
    _mark_history_cacheable(messages)
    marked = [b for m in messages if isinstance(m["content"], list)
              for b in m["content"] if "cache_control" in b]
    assert len(marked) == 1                                    # exactly one breakpoint
    assert messages[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}  # on the last block

    # a second call must move the breakpoint, not accumulate a second one
    messages.append({"role": "assistant", "content": [{"type": "text", "text": "done"}]})
    _mark_history_cacheable(messages)
    marked = [b for m in messages if isinstance(m["content"], list)
              for b in m["content"] if "cache_control" in b]
    assert len(marked) == 1 and messages[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
