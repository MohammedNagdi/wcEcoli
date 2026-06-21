"""Method C — pairwise / Arena-style judging (relative preference, not absolute Likert).

For each case, every pair of blinded answers is judged "which is more correct vs the TOOL OUTPUT?"
in BOTH orders (A,B) and (B,A) — the position-bias control. Aggregation gives:
  * per-model **win-rate** ranking (the ordinal signal, produced directly),
  * a **position-bias rate** (how often the judge picks the same SLOT regardless of content),
  * **inter-judge agreement** (do two judges pick the same winner per pair?) — to compare against the
    absolute-Likert κ (Methods A/B).

    # run (one verdict file per judge)
    python -m eval.judge_pairwise --judge eval/results/judge_v2 --items <anchor.jsonl> \
        --provider anthropic --model claude-sonnet-4-6 --label sonnet --sync
    # analyze (1 label = ranking+bias; 2 labels = + inter-judge agreement)
    python -m eval.judge_pairwise --judge eval/results/judge_v2 --analyze sonnet gpt
"""

from __future__ import annotations

import argparse
import json
import re
from itertools import combinations
from pathlib import Path
from typing import Any

from .judge_batch import _provider_creds

_SYSTEM = ("You compare two AI lab-assistant answers to the same question for a whole-cell E. coli "
           "platform. Judge ONLY factual correctness against the tool output given as ground truth.")


def _prompt(case: dict[str, Any], ans_a: str, ans_b: str) -> str:
    to = json.dumps(case.get("tool_output"), default=str)[:3000]
    return ("\n".join([
        f"QUESTION:\n{case['prompt']}", "",
        f"TOOL OUTPUT (ground truth):\n{to}", "",
        "ANSWER A:\n" + (ans_a or "(empty answer)"), "",
        "ANSWER B:\n" + (ans_b or "(empty answer)"), "",
        "Which answer is more correct given the tool output? Ignore length and order. "
        'Reply ONLY with JSON: {"winner":"A"} or {"winner":"B"} or {"winner":"tie"}.',
    ]))


def _parse_winner(text: str) -> str | None:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            w = str(json.loads(m.group(0)).get("winner", "")).strip().lower()
            if w in ("a", "b", "tie"):
                return w
        except (ValueError, json.JSONDecodeError):
            pass
    t = text.strip().lower()
    return t if t in ("a", "b", "tie") else None


def _round1_by_case(judge_dir: Path, items_path: Path | None) -> dict[str, list[dict]]:
    key = json.loads((judge_dir / "judge_key.json").read_text(encoding="utf-8"))
    path = items_path or (judge_dir / "judge_items.jsonl")
    items = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    by: dict[str, list[dict]] = {}
    for it in items:
        if key.get(it["resp_id"], {}).get("round") == 1:
            by.setdefault(it["case_id"], []).append(it)
    return by


def run(judge_dir: Path, items_path: Path | None, kind: str, key_: str, base: str, model: str,
        out_path: Path) -> dict[str, int]:  # pragma: no cover (live API)
    import httpx

    from .judge_batch import _judge_once

    by_case = _round1_by_case(judge_dir, items_path)
    ok = bad = 0
    with httpx.Client(timeout=90) as client, out_path.open("w", encoding="utf-8") as handle:
        for cid, answers in by_case.items():
            for x, y in combinations(answers, 2):
                for a, b in ((x, y), (y, x)):                      # both orders
                    try:
                        text = _judge_once(client, kind, key_, base, model, _prompt(x, a["answer"], b["answer"]))
                        w = _parse_winner(text)
                    except httpx.HTTPError:
                        w = None
                    if w is None:
                        bad += 1
                        continue
                    handle.write(json.dumps({"case_id": cid, "a": a["resp_id"], "b": b["resp_id"],
                                             "winner": w}) + "\n")
                    handle.flush()
                    ok += 1
    return {"verdicts": ok, "unparsed": bad}


def _resolve(judge_dir: Path, label: str) -> tuple[dict, dict, dict]:
    """Return per-(unordered-pair) winner, per-model W/L/T, and position-bias counts for one judge."""
    key = json.loads((judge_dir / "judge_key.json").read_text(encoding="utf-8"))
    rows = [json.loads(l) for l in (judge_dir / f"judge_pairwise.{label}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    # collect the two ordered verdicts per unordered pair {resp_x,resp_y}
    pairs: dict[tuple[str, str], dict[tuple[str, str], str]] = {}
    for r in rows:
        upair = tuple(sorted((r["a"], r["b"])))
        pairs.setdefault(upair, {})[(r["a"], r["b"])] = r["winner"]  # winner is a SLOT: 'a'/'b'/'tie'
    winners: dict[tuple[str, str], str] = {}                          # unordered pair -> winning resp_id or 'tie'
    pos_biased = 0
    wlt: dict[str, list[int]] = {}                                    # model -> [wins, losses, ties]
    for upair, orders in pairs.items():
        if len(orders) < 2:
            continue
        # winning resp_id per order
        wins_resp = []
        slots = []
        for (a, b), v in orders.items():
            slots.append(v)
            wins_resp.append(a if v == "a" else b if v == "b" else "tie")
        # position bias: picked the same slot ('a' or 'b') in both orders
        if slots[0] == slots[1] and slots[0] in ("a", "b"):
            pos_biased += 1
        if wins_resp[0] == wins_resp[1] and wins_resp[0] != "tie":
            win = wins_resp[0]
        else:
            win = "tie"
        winners[upair] = win
        mx = key[upair[0]]["model"]
        my = key[upair[1]]["model"]
        for m in (mx, my):
            wlt.setdefault(m, [0, 0, 0])
        if win == "tie":
            wlt[mx][2] += 1
            wlt[my][2] += 1
        else:
            win_model = key[win]["model"]
            lose_model = my if win_model == mx else mx
            wlt[win_model][0] += 1
            wlt[lose_model][1] += 1
    bias_rate = pos_biased / max(1, len(winners))
    return winners, wlt, {"position_bias_rate": bias_rate, "pairs": len(winners)}


def _ranking(wlt: dict[str, list[int]]) -> list[tuple[str, float, str]]:
    out = []
    for m, (w, l, t) in wlt.items():
        games = w + l + t
        win_rate = (w + 0.5 * t) / games if games else 0.0
        out.append((m, win_rate, f"{w}-{l}-{t}"))
    return sorted(out, key=lambda r: -r[1])


def analyze(judge_dir: Path, labels: list[str]) -> str:
    L = [f"# Pairwise (Arena) — {', '.join(labels)}", ""]
    resolved = {}
    for lab in labels:
        winners, wlt, meta = _resolve(judge_dir, lab)
        resolved[lab] = winners
        L += [f"## {lab}: win-rate ranking ({meta['pairs']} pairs, position-bias rate {meta['position_bias_rate']*100:.0f}%)",
              "", "| Rank | Model | win-rate | W-L-T |", "|---|---|---|---|"]
        for i, (m, wr, rec) in enumerate(_ranking(wlt), 1):
            L.append(f"| {i} | {m.split(':', 1)[-1]} | {wr:.2f} | {rec} |")
        L.append("")
    if len(labels) == 2:
        a, b = labels
        shared = sorted(set(resolved[a]) & set(resolved[b]))
        agree = sum(1 for p in shared if resolved[a][p] == resolved[b][p]) / max(1, len(shared))
        L += ["## Inter-judge agreement (same winner per pair)", "",
              f"- {a} vs {b}: **{agree*100:.0f}%** agreement on {len(shared)} pairs.",
              "- Compare to the absolute-Likert weighted κ ≈ 0.74 between the same two judges.", ""]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge", default="eval/results/judge", type=Path)
    ap.add_argument("--items", default=None)
    ap.add_argument("--provider", default="anthropic")
    ap.add_argument("--model", default="")
    ap.add_argument("--db", default="/app/data/wcecoli.db")
    ap.add_argument("--label", default="judge")
    ap.add_argument("--sync", action="store_true")
    ap.add_argument("--analyze", nargs="+", metavar="LABEL", help="aggregate verdict files (1 or 2 labels)")
    ap.add_argument("--out", default=None, type=Path)
    args = ap.parse_args()

    if args.analyze:
        report = analyze(args.judge, args.analyze)
        (args.out.write_text(report, encoding="utf-8") if args.out else print(report))
        if args.out:
            print(f"Wrote {args.out}")
        return

    kind, key_, base, cfg_model = _provider_creds(args.provider, args.db)
    model = args.model or cfg_model
    items_path = Path(args.items) if args.items else None
    out = args.judge / f"judge_pairwise.{args.label}.jsonl"
    print(f"Pairwise judging with {args.provider}:{model} (sync) -> {out}")
    summary = run(args.judge, items_path, kind, key_, base, model, out)
    print(json.dumps({**summary, "out": str(out)}, indent=2))


if __name__ == "__main__":
    main()
