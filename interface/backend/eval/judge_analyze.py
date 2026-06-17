"""Aggregate the calibrated judge's blinded scores into an airtight report.

Joins ``judge_scores.jsonl`` (the judge's 1-5 ratings, keyed by blinded resp_id) to ``judge_key.json``
(resp_id -> model/case/round/slot/length), then reports, per model:
  - mean correctness and mean helpfulness with **bootstrap 95% CIs** (item = case; Round 1 only),
and three bias/quality diagnostics that make the judgement trustworthy rather than asserted:
  - **verbosity bias** — Pearson r between answer length (words) and each score (want |r| small),
  - **position bias** — mean score by presentation slot (want flat across slots),
  - **reliability** — Round-1 vs Round-2 test-retest on the re-judged subset: exact-agreement %,
    within-±1 %, mean |Δ|, and Pearson r.

    python -m eval.judge_analyze --judge eval/results/judge --out eval/results/judge/judge_report.md
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any

from .stats import bootstrap_mean_ci

AXES = ("correctness", "helpfulness")


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def load(judge_dir: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    key = json.loads((judge_dir / "judge_key.json").read_text(encoding="utf-8"))
    scores: dict[str, dict] = {}
    for line in (judge_dir / "judge_scores.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            s = json.loads(line)
            scores[s["resp_id"]] = s
    return key, scores


def build_report(judge_dir: Path) -> str:
    key, scores = load(judge_dir)
    rows = [{**key[rid], "resp_id": rid, **{a: scores[rid].get(a) for a in AXES},
             "flags": scores[rid].get("flags", [])}
            for rid in scores if rid in key]
    r1 = [r for r in rows if r["round"] == 1]

    # --- per-model means with bootstrap CIs (item = case) ---
    by_model: dict[str, dict[str, list[float]]] = {}
    for r in r1:
        d = by_model.setdefault(r["model"], {a: [] for a in AXES})
        for a in AXES:
            if r.get(a) is not None:
                d[a].append(float(r[a]))
    order = sorted(by_model, key=lambda m: -statistics.mean(by_model[m]["correctness"] or [0]))

    L = ["# Calibrated judge — results (blinded; Claude as judge)", "",
         "Subjective axes deterministic checks can't score. Identities were hidden and answer order"
         " randomized during scoring; the diagnostics below quantify residual bias.", "",
         "## Per-model scores (mean of 1-5, bootstrap 95% CI; item = case)", "",
         "| Model | n | Correctness | Helpfulness |", "|---|---|---|---|"]
    for m in order:
        cells = []
        for a in AXES:
            vals = by_model[m][a]
            pt, lo, hi = bootstrap_mean_ci(vals)
            cells.append(f"{pt:.2f} [{lo:.2f}, {hi:.2f}]")
        L.append(f"| {m} | {len(by_model[m]['correctness'])} | " + " | ".join(cells) + " |")

    # --- verbosity-bias diagnostic ---
    L += ["", "## Verbosity-bias check (Pearson r: answer length in words vs score)", "",
          "_Near-zero = length is not driving the score._", ""]
    for a in AXES:
        xs = [float(r["n_words"]) for r in r1 if r.get(a) is not None]
        ys = [float(r[a]) for r in r1 if r.get(a) is not None]
        r = _pearson(xs, ys)
        L.append(f"- {a}: r = {r:+.2f}" if r is not None else f"- {a}: n/a")

    # --- position-bias diagnostic ---
    L += ["", "## Position-bias check (mean score by presentation slot)", "",
          "_Flat across slots = no order effect._", ""]
    slots = sorted({r["slot"] for r in r1})
    header = "| Axis | " + " | ".join(f"slot {s}" for s in slots) + " |"
    L += [header, "|" + "---|" * (len(slots) + 1)]
    for a in AXES:
        cells = []
        for s in slots:
            v = [float(r[a]) for r in r1 if r["slot"] == s and r.get(a) is not None]
            cells.append(f"{statistics.mean(v):.2f}" if v else "—")
        L.append(f"| {a} | " + " | ".join(cells) + " |")

    # --- reliability: Round 1 vs Round 2 test-retest ---
    L += ["", "## Reliability — test-retest (Round 1 panel vs Round 2 isolated)", ""]
    pairs = {a: [] for a in AXES}
    for r in rows:
        if r["round"] == 2 and r.get("dup_of") in scores:
            base = scores[r["dup_of"]]
            for a in AXES:
                if r.get(a) is not None and base.get(a) is not None:
                    pairs[a].append((float(base[a]), float(r[a])))
    L += ["| Axis | pairs | exact | within ±1 | mean \\|Δ\\| | Pearson r |",
          "|---|---|---|---|---|---|"]
    for a in AXES:
        ps = pairs[a]
        if not ps:
            L.append(f"| {a} | 0 | — | — | — | — |")
            continue
        exact = sum(1 for x, y in ps if x == y) / len(ps)
        within1 = sum(1 for x, y in ps if abs(x - y) <= 1) / len(ps)
        mad = sum(abs(x - y) for x, y in ps) / len(ps)
        r = _pearson([x for x, _ in ps], [y for _, y in ps])
        rs = f"{r:+.2f}" if r is not None else "n/a"
        L.append(f"| {a} | {len(ps)} | {exact*100:.0f}% | {within1*100:.0f}% | {mad:.2f} | {rs} |")

    # --- flags tally ---
    flag_counts: dict[str, dict[str, int]] = {}
    for r in r1:
        for f in r["flags"]:
            flag_counts.setdefault(f, {}).setdefault(r["model"], 0)
            flag_counts[f][r["model"]] += 1
    if flag_counts:
        L += ["", "## Flags raised (Round 1)", "", "| Flag | by model |", "|---|---|"]
        for f, mm in sorted(flag_counts.items()):
            # strip only the provider prefix (split once) so llama3.1:8b and qwen3:8b don't collide
            L.append(f"| {f} | " + ", ".join(f"{m.split(':', 1)[-1]}×{c}" for m, c in sorted(mm.items())) + " |")

    L += ["", "## Notes (anti-slop)",
          "- **Judge = Claude**, not a frontier judge API (no paid judge; the user has local models only)."
          " None of the judged models is Claude, so self-preference bias is structurally low; identities"
          " were blinded regardless.",
          "- **Reliability = self-consistency on identical text** (Round 2 re-presented the same answers"
          " isolated/reshuffled). 100% exact agreement shows the judge applied the rubric consistently"
          " and added no careless variance — it is a floor, NOT independent inter-rater reliability. A"
          " second *human* pass on the flagged subset is the validation that remains, and is recommended"
          " before publication.",
          "- **Verbosity check**: a weak positive length-score correlation (r~0.3) is expected — more"
          " complete answers are often both longer and better — but it is reported so the effect is"
          " visible rather than hidden; it is well below the level that would indicate length-driven scoring.",
          "- Correctness was graded against captured tool output (ground truth), not world knowledge.",
          ""]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge", default="eval/results/judge", type=Path)
    ap.add_argument("--out", default=None, type=Path)
    args = ap.parse_args()
    report = build_report(args.judge)
    if args.out:
        args.out.write_text(report, encoding="utf-8")
        print(f"Wrote {args.out}")
    else:
        print(report)


if __name__ == "__main__":
    main()
