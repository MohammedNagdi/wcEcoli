"""Unit tests for assistant_agent helpers (tool-result compaction)."""

import json

from app.services.assistant_agent import _compact_payload


def test_compact_payload_trims_largest_list_to_valid_json():
    payload = {"totals": {"jobs": 16},
               "results": [{"job_id": i, "metrics": {"g": i * 0.01, "m": i * 100}} for i in range(16)]}
    out = _compact_payload(payload, 400)
    s = json.dumps(out)
    assert len(s) <= 400                       # fits the budget
    assert isinstance(json.loads(s), dict)     # still valid JSON (not a mid-structure char-cut)
    assert len(out["results"]) < 16            # the big list was trimmed
    assert out["totals"] == {"jobs": 16}       # small fields untouched
    assert "of 16" in out["results__truncated"]  # note reports the ORIGINAL count, not an intermediate


def test_compact_payload_leaves_small_payload_untouched():
    payload = {"a": 1, "items": [1, 2, 3]}
    assert _compact_payload(payload, 4096) == payload   # under budget -> identical object
    assert _compact_payload(payload, 0) == payload      # disabled (budget 0) -> no-op


def test_compact_payload_handles_no_lists():
    # No trimmable list -> returns shaped payload unchanged (caller applies the hard char fallback).
    payload = {"a": "x" * 1000}
    out = _compact_payload(payload, 100)
    assert out == payload
