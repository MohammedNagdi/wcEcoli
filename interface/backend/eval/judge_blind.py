"""Calibrated LLM-as-judge — blinded worksheet generation + scoring key.

A Claude Code session is the judge. It scores the two subjective axes the deterministic checks can't
and that ``analyze.py`` deliberately omits — **correctness** and **helpfulness** — on a 1-5 scale.
To keep it airtight we control the known LLM-judge biases (Zheng et al. 2023, "LLM-as-a-judge"):

* **self-preference / identity bias** — model names are stripped; each answer gets a random id and the
  judge never sees which model produced it. The id->model key is written to a *separate* file that is
  not opened during scoring. (None of the judged models is Claude, so self-preference risk is already
  low; blinding removes brand/name effects regardless.)
* **position bias** — answers to the same prompt are shuffled within a panel; the presentation slot is
  recorded so the analysis can test for a slot effect.
* **verbosity bias** — answer length (chars/words) is recorded so the analysis can correlate score with
  length; the rubric tells the judge to ignore length and ground correctness in the tool output.
* **reliability** — a random subset of answers is re-presented in a second *isolated* round (fresh ids,
  no panel-mates, reshuffled) so test-retest agreement of the protocol can be measured.

Outputs (under ``--out``):
* ``judge_worksheet.md`` — what the judge reads (anonymized panels + reliability round).
* ``judge_key.json``     — id -> {model, case_id, round, slot, n_chars, n_words, dup_of}. NOT read while scoring.

    python -m eval.judge_blind --results eval/results --out eval/results/judge \
        --models "ollama:llama3.1:8b,ollama:qwen3:8b,ollama:qwen2.5-coder:14b,ollama:llama3.2:latest"
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

from .analyze import load_latest_per_model

RUBRIC = (
    "Score each blinded answer on two axes, 1-5 (5 best), INDEPENDENTLY of every other answer:\n"
    "  - correctness: factually right *given the TOOL OUTPUT (ground truth) and the question*. A "
    "fabricated id/number/name, or a claim the tool output contradicts, caps correctness at 2.\n"
    "  - helpfulness: directly answers what was asked, at the right level of detail, no filler.\n"
    "Rules to keep this unbiased:\n"
    "  - Judge correctness against the tool output, NOT your own world knowledge.\n"
    "  - IGNORE answer length and ignore the order answers appear in. A longer answer is not better.\n"
    "  - For action cases, a correct answer *prepares/drafts* and never claims it executed.\n"
    "Also record flags where they apply: hallucination, tool_misselection, context_stickiness "
    "(ignored an explicit override), format_leak (raw tool JSON shown).\n"
    'Emit one JSON object per answer to judge_scores.jsonl: '
    '{"resp_id":"r0001","correctness":n,"helpfulness":n,"flags":[],"why":"<=1 sentence"}'
)

# Anchored variant: same axes, but with explicit per-point anchors + worked examples to remove the
# judge-to-judge leniency gap (correctness is FACTUAL accuracy vs the tool output, not overall polish).
RUBRIC_ANCHORED = (
    "Score each blinded answer on two axes, 1-5 (5 best), INDEPENDENTLY of every other answer.\n"
    "Judge against the TOOL OUTPUT (ground truth), NOT your own world knowledge. Ignore length and order.\n\n"
    "correctness = FACTUAL accuracy only (not completeness or polish):\n"
    "  5 = every factual claim is supported by the tool output, OR it correctly reports 'not found' /"
    " 'no result yet' when the data is absent. A terse but fully-correct answer is a 5.\n"
    "  4 = correct with a minor slip that doesn't change the answer.\n"
    "  3 = partially correct or incomplete, but nothing fabricated and nothing contradicts the tool output.\n"
    "  2 = a fabricated or contradicted id/number/name/category, a raw tool-call JSON blob, or a bare"
    " error/non-answer.\n"
    "  1 = mostly fabricated, empty, or wholly unresponsive.\n"
    "helpfulness = does it directly answer what was asked, at the right level of detail?\n"
    "  5 = answers fully and cleanly; 3 = partial or needlessly defers; 1 = unhelpful.\n\n"
    "Worked examples:\n"
    "  - Tool says genes=4749, knockout_ready=4371; answer '4749 genes, 4371 knockout-ready' -> correctness 5"
    " (terse but fully grounded).\n"
    "  - Tool returned gene rodZ; answer summarizes a DIFFERENT gene (e.g. 'rplP') -> correctness 1, flag"
    " hallucination.\n"
    "  - Asked for a category of a gene the tool did not return; answer states a category anyway ->"
    " correctness 1, flag hallucination.\n"
    "  - Answer is a raw {\"name\": \"create_experiment\", ...} JSON blob -> correctness 2, flag format_leak.\n"
    "  - Gene truly absent; answer 'not found in the catalog, please check the symbol' -> correctness 5.\n"
    "  - Action case: 'draft prepared, awaiting your confirmation' -> correct; 'I have executed/called it'"
    " for a gated action -> correctness 2.\n\n"
    "Flags where they apply: hallucination, tool_misselection, context_stickiness, format_leak.\n"
    'Emit one JSON object per answer: '
    '{"resp_id":"r0001","correctness":n,"helpfulness":n,"flags":[],"why":"<=1 sentence"}'
)


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + f"… [+{len(s)-n} chars]"


def build(results_dir: Path, out_dir: Path, models: list[str], *, sample: int = 0,
          rel_fraction: float = 0.25, seed: int = 0) -> dict[str, Any]:
    rng = random.Random(seed)
    per_model = load_latest_per_model(results_dir, kind="oneshot")
    wanted = [m for m in models if m in per_model] or list(per_model)

    # Collect one representative row (the chosen `sample`) per (case, model).
    cases: dict[str, dict[str, Any]] = {}          # case_id -> shared fields
    answers: list[dict[str, Any]] = []             # one per (case, model)
    for model in wanted:
        for r in per_model[model]:
            if r.get("sample", 0) != sample:
                continue
            cid = r["id"]
            cases.setdefault(cid, {"prompt": r["prompt"], "context": r.get("context", {}),
                                   "rubric": r.get("rubric", ""), "gold": r.get("gold", ""),
                                   "tool_output": r.get("tool_output"), "category": r["category"]})
            ans = (r.get("content") or "").strip()
            answers.append({"case_id": cid, "model": model, "answer": ans,
                            "n_chars": len(ans), "n_words": len(ans.split())})

    key: dict[str, dict[str, Any]] = {}
    items: list[dict[str, Any]] = []   # structured per-answer judge inputs (for the batch judge)
    counter = [0]

    def new_id() -> str:
        counter[0] += 1
        return f"r{counter[0]:04d}"

    def record_item(rid: str, cid: str, answer: str) -> None:
        c = cases[cid]
        items.append({"resp_id": rid, "prompt": c["prompt"], "answer": answer,
                      "tool_output": c.get("tool_output"), "rubric": c.get("rubric", ""),
                      "gold": c.get("gold", "")})

    # --- Round 1: panels (all models' answers to one prompt, shuffled) ---
    panels: list[dict[str, Any]] = []
    by_case: dict[str, list[dict[str, Any]]] = {}
    for a in answers:
        by_case.setdefault(a["case_id"], []).append(a)
    for cid in sorted(by_case):
        group = by_case[cid][:]
        rng.shuffle(group)                          # position control
        entries = []
        for slot, a in enumerate(group):
            rid = new_id()
            key[rid] = {"model": a["model"], "case_id": cid, "round": 1, "slot": slot,
                        "n_chars": a["n_chars"], "n_words": a["n_words"], "dup_of": None}
            entries.append({"resp_id": rid, "answer": a["answer"]})
            record_item(rid, cid, a["answer"])
        panels.append({"case_id": cid, **cases[cid], "responses": entries})

    # --- Round 2: reliability — isolated re-presentation of a random subset ---
    n_rel = max(6, round(len(answers) * rel_fraction))
    rel_sample = rng.sample(answers, min(n_rel, len(answers)))
    rng.shuffle(rel_sample)
    rel_items = []
    for a in rel_sample:
        rid = new_id()
        # find the round-1 id for the same (case, model) so the analysis can pair them
        orig = next(k for k, v in key.items()
                    if v["round"] == 1 and v["model"] == a["model"] and v["case_id"] == a["case_id"])
        key[rid] = {"model": a["model"], "case_id": a["case_id"], "round": 2, "slot": 0,
                    "n_chars": a["n_chars"], "n_words": a["n_words"], "dup_of": orig}
        rel_items.append({"resp_id": rid, "case_id": a["case_id"], **cases[a["case_id"]],
                          "answer": a["answer"]})
        record_item(rid, a["case_id"], a["answer"])

    # Structured per-answer items so an automated (hosted) judge can rebuild the same prompt the
    # human/Claude judge reads in the worksheet. Identity stays only in judge_key.json.
    items: list[dict[str, Any]] = []
    for p in panels:
        for e in p["responses"]:
            items.append({"resp_id": e["resp_id"], "case_id": p["case_id"], "category": p["category"],
                          "prompt": p["prompt"], "rubric": p.get("rubric", ""), "gold": p.get("gold", ""),
                          "tool_output": p.get("tool_output"), "answer": e["answer"]})
    for e in rel_items:
        items.append({"resp_id": e["resp_id"], "case_id": e["case_id"], "category": e.get("category", ""),
                      "prompt": e["prompt"], "rubric": e.get("rubric", ""), "gold": e.get("gold", ""),
                      "tool_output": e.get("tool_output"), "answer": e["answer"]})

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "judge_key.json").write_text(json.dumps(key, indent=2), encoding="utf-8")
    (out_dir / "judge_items.jsonl").write_text(
        "\n".join(json.dumps(it, default=str) for it in items), encoding="utf-8")
    (out_dir / "judge_worksheet.md").write_text(
        _render(panels, rel_items, n_models=len(wanted)), encoding="utf-8")
    # Structured inputs for the batch judge (eval.judge_batch); the worksheet is for a human/Claude judge.
    (out_dir / "judge_items.jsonl").write_text(
        "\n".join(json.dumps(it, default=str) for it in items), encoding="utf-8")
    return {"models": wanted, "cases": len(panels), "round1_answers": sum(len(p["responses"]) for p in panels),
            "round2_reliability": len(rel_items), "total_to_judge": len(key)}


def _render(panels: list[dict[str, Any]], rel_items: list[dict[str, Any]], *, n_models: int) -> str:
    L = ["# Blinded judge worksheet", "",
         "Model identities are hidden; answer order is randomized. Score every `resp_id` and append a",
         "JSON line per answer to `judge_scores.jsonl` (see rubric).", "",
         "## Rubric", "", RUBRIC, "",
         f"## Round 1 — {len(panels)} panels (~{n_models} blinded answers each)", ""]
    for i, p in enumerate(panels, 1):
        L += [f"### Panel {i} — case `{p['case_id']}` ({p['category']})", "",
              f"**Question:** {p['prompt']}"]
        ctx = {k: v for k, v in (p.get("context") or {}).items() if k in ("selected_gene", "route", "assistant_surface")}
        if ctx:
            L.append(f"**Page context:** `{json.dumps(ctx)}`")
        if p.get("rubric"):
            L.append(f"**Case note:** {p['rubric']}")
        if p.get("gold"):
            L.append(f"**Reference answer:** {p['gold']}")
        to = p.get("tool_output")
        L += ["", "**TOOL OUTPUT (ground truth):**", "```json",
              _truncate(json.dumps(to, default=str, ensure_ascii=False), 1800), "```", ""]
        for e in p["responses"]:
            L += [f"#### `{e['resp_id']}`", "", _truncate(e["answer"] or "*(empty answer)*", 1600), ""]
        L.append("---")
    L += ["", f"## Round 2 — reliability ({len(rel_items)} isolated re-judgements)", "",
          "Same answers, fresh ids, no panel-mates. Score them the same way; agreement with Round 1",
          "measures protocol reliability (test-retest under a different presentation).", ""]
    for e in rel_items:
        L += [f"### `{e['resp_id']}` (case `{e['case_id']}`)", "",
              f"**Question:** {e['prompt']}", "", "**TOOL OUTPUT (ground truth):**", "```json",
              _truncate(json.dumps(e.get("tool_output"), default=str, ensure_ascii=False), 1500), "```", "",
              _truncate(e["answer"] or "*(empty answer)*", 1600), "", "---"]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="eval/results", type=Path)
    ap.add_argument("--out", default="eval/results/judge", type=Path)
    ap.add_argument("--models", default="", help="comma-separated provider:model labels to judge")
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--rel-fraction", type=float, default=0.25)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    summary = build(args.results, args.out, models, sample=args.sample,
                    rel_fraction=args.rel_fraction, seed=args.seed)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
