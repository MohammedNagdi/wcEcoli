"""Calibrated-judge harness: blinding, reliability pairing, and aggregation."""

import json

from eval.judge_analyze import _pearson, build_report
from eval.judge_blind import build


def _results_dir(tmp_path):
    rows = []
    for model in ("ollama:m1", "ollama:m2"):
        for i in range(6):
            rows.append({"kind": "oneshot", "model": model, "id": f"c{i}", "category": "factual_lookup",
                         "sample": 0, "passed": True, "prompt": f"q{i}", "context": {},
                         "rubric": "", "gold": "", "tool_output": [{"x": i}],
                         "content": f"answer to c{i} " + "word " * i})
    d = tmp_path / "results"
    d.mkdir()
    (d / "results-20260101T000000Z.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return d


def test_blinding_and_reliability_pairing(tmp_path):
    out = tmp_path / "judge"
    summary = build(_results_dir(tmp_path), out, ["ollama:m1", "ollama:m2"], rel_fraction=0.5, seed=1)
    key = json.loads((out / "judge_key.json").read_text(encoding="utf-8"))
    worksheet = (out / "judge_worksheet.md").read_text(encoding="utf-8")

    assert summary["cases"] == 6 and summary["round1_answers"] == 12
    # worksheet must not label which model produced any answer (no provider:model strings)
    assert "ollama:" not in worksheet
    # the id->model mapping lives only in the separate key file
    assert "ollama:m1" in json.dumps(key)
    # every round-2 item points back to a real round-1 id for the same (model, case)
    r2 = [(rid, v) for rid, v in key.items() if v["round"] == 2]
    assert r2, "expected reliability items"
    for rid, v in r2:
        base = key[v["dup_of"]]
        assert base["round"] == 1 and base["model"] == v["model"] and base["case_id"] == v["case_id"]


def test_pearson_known_values():
    assert abs(_pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1.0) < 1e-9      # perfect positive
    assert abs(_pearson([1, 2, 3, 4], [4, 3, 2, 1]) + 1.0) < 1e-9      # perfect negative
    assert _pearson([1, 1, 1], [1, 2, 3]) is None                      # zero variance -> undefined


def test_aggregation_and_reliability(tmp_path):
    out = tmp_path / "judge"
    out.mkdir()
    # m1 strong (5/5), m2 weak (2/2) on two cases; one reliability dup of an m1 answer.
    key = {
        "r1": {"model": "ollama:m1", "case_id": "c0", "round": 1, "slot": 0, "n_words": 10, "dup_of": None},
        "r2": {"model": "ollama:m2", "case_id": "c0", "round": 1, "slot": 1, "n_words": 10, "dup_of": None},
        "r3": {"model": "ollama:m1", "case_id": "c1", "round": 1, "slot": 0, "n_words": 10, "dup_of": None},
        "r4": {"model": "ollama:m2", "case_id": "c1", "round": 1, "slot": 1, "n_words": 10, "dup_of": None},
        "r5": {"model": "ollama:m1", "case_id": "c0", "round": 2, "slot": 0, "n_words": 10, "dup_of": "r1"},
    }
    scores = {
        "r1": {"resp_id": "r1", "correctness": 5, "helpfulness": 5, "flags": []},
        "r2": {"resp_id": "r2", "correctness": 2, "helpfulness": 2, "flags": ["hallucination"]},
        "r3": {"resp_id": "r3", "correctness": 5, "helpfulness": 5, "flags": []},
        "r4": {"resp_id": "r4", "correctness": 2, "helpfulness": 2, "flags": ["hallucination"]},
        "r5": {"resp_id": "r5", "correctness": 5, "helpfulness": 5, "flags": []},  # identical re-judge
    }
    (out / "judge_key.json").write_text(json.dumps(key), encoding="utf-8")
    (out / "judge_scores.jsonl").write_text(
        "\n".join(json.dumps(s) for s in scores.values()), encoding="utf-8")

    report = build_report(out)
    # m1 sorts first (higher correctness) and shows 5.00; m2 shows 2.00
    m1_line = next(l for l in report.splitlines() if "ollama:m1 |" in l)
    assert "5.00" in m1_line
    assert "ollama:m2" in report and "2.00" in report
    # reliability: the one identical dup pair -> exact agreement 100%
    assert "100%" in report
    # flags attributed to m2 only
    assert "hallucination" in report and "m2×2" in report
