"""Analysis logic: split axes, grounding-conditionality, and paired significance."""

from eval.analyze import _axis_value, _model_summary, _pairwise


def _row(rid, passed, tools, checks):
    return {"kind": "oneshot", "model": "m", "id": rid, "category": "c",
            "passed": passed, "tool_names": tools, "checks": checks, "latency_ms": 1000}


def test_grounding_is_conditional_on_tool_emission():
    # faithfulness auto-passes when no tools fired -> must NOT count as a grounding pass.
    no_tools = _row("a", True, [], [{"check": "faithfulness", "passed": True}])
    assert _axis_value(no_tools, "grounding") is None
    # when tools fired, the faithfulness verdict is used.
    tooled = _row("b", True, ["gene_catalog"], [{"check": "faithfulness", "passed": False}])
    assert _axis_value(tooled, "grounding") is False


def test_summary_and_pairwise_significance():
    rows_a = [_row(str(i), i < 24, ["t"], [{"check": "tool_called:t", "passed": i < 24}]) for i in range(30)]
    s = _model_summary(rows_a)
    assert s["n"] == 30 and s["overall"].k == 24
    assert s["axes"]["tool_selection"] is not None and s["axes"]["tool_selection"].k == 24

    rows_b = [_row(str(i), i < 13, [], []) for i in range(30)]  # weaker, never calls tools
    pw = _pairwise({"A": rows_a, "B": rows_b})
    comp = next(x for x in pw if x["pair"] == "A vs B")
    assert comp["diff"] > 0 and comp["significant"]   # 80% vs 43% on paired items -> significant


def test_repeats_aggregate_to_item_level():
    # 10 items x 3 samples; items 0-5 pass on 2/3 samples, items 6-9 never -> item-mean 0.4.
    rows = []
    for i in range(10):
        for s in range(3):
            ok = i < 6 and s < 2
            rows.append(_row(str(i), ok, ["t"], [{"check": "tool_called:t", "passed": ok}]))
    s = _model_summary(rows)
    assert s["n"] == 10                      # items, not 30 rows (no pseudo-replication)
    assert abs(s["overall"].p - 0.4) < 1e-9  # mean of per-item pass-fractions
