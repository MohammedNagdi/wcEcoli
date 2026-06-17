"""Airtight post-hoc analysis of eval results — every number is computed, none narrated.

Loads the stored per-case results, and for each model uses ONLY its newest complete run (no mixing
runs). Reports, with **Wilson 95% CIs**:
  - overall pass rate, per-category pass rate,
  - **tool-emission rate** (did the model emit ANY tool call — the decisive axis for a tool-grounded
    assistant), and
  - split skill axes (BFCL-style): tool-selection, grounding/faithfulness, format, assertion,
    side-effect — each over its applicable subset only.
Pairwise model differences on overall pass use **McNemar's exact test** (paired on item id) with
**Holm–Bonferroni** correction, plus a paired-bootstrap difference CI.

Subjective axes (correctness, helpfulness) are NOT computed here — they require a calibrated judge
(separate step) and are deliberately left out rather than faked.

    python -m eval.analyze --results eval/results --out eval/results/analysis.md
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any

from .stats import Proportion, bootstrap_mean_ci, holm, mcnemar_exact, paired_bootstrap_diff, wilson

# An axis = (label, predicate that returns True/False/None for a case). None = not applicable.
AXES: dict[str, str] = {
    "tool_selection": "all `tool_called:*` checks passed (cases with expected tools)",
    "grounding": "faithfulness check passed (cases with tool output)",
    "format": "no raw tool-JSON leaked",
    "assertion": "all `assert:*` checks passed",
    "side_effect": "side-effect expectation met",
}


def _axis_value(row: dict[str, Any], axis: str) -> bool | None:
    checks = row["checks"]

    def of(prefix: str) -> list[bool]:
        return [c["passed"] for c in checks if c["check"].startswith(prefix)]

    if axis == "tool_selection":
        vals = of("tool_called:")
    elif axis == "grounding":
        # Only meaningful when tools actually fired — otherwise "faithfulness" auto-passes vacuously
        # (nothing to be unfaithful to), which would flatter models that never call tools.
        vals = of("faithfulness") if row.get("tool_names") else []
    elif axis == "format":
        vals = of("no_raw_tool_json")
    elif axis == "assertion":
        vals = of("assert:")
    elif axis == "side_effect":
        vals = [c["passed"] for c in checks if c["check"] in ("side_effect_expected", "no_unexpected_side_effect")]
    else:
        vals = []
    return all(vals) if vals else None


def load_latest_per_model(results_dir: Path) -> dict[str, list[dict[str, Any]]]:
    """For each model, the rows from its NEWEST results file (filenames sort by timestamp)."""
    model_rows: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(results_dir.glob("results-*.jsonl")):  # ascending time -> newest wins
        by_model: dict[str, list[dict[str, Any]]] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("kind") == "oneshot":
                by_model.setdefault(r["model"], []).append(r)
        for model, rows in by_model.items():
            model_rows[model] = rows  # overwrite with the newer file's rows
    return model_rows


def _estimate(item_outcomes: list[list[float]]) -> Proportion | None:
    """Aggregate to the ITEM level. Single sample/item -> exact Wilson; repeats -> item bootstrap
    over per-item pass-fractions (no pseudo-replication). ``item_outcomes`` excludes N/A items."""
    items = [o for o in item_outcomes if o]
    n = len(items)
    if n == 0:
        return None
    if all(len(o) == 1 for o in items):
        k = sum(int(o[0]) for o in items)
        return wilson(k, n)
    fracs = [sum(o) / len(o) for o in items]
    point, lo, hi = bootstrap_mean_ci(fracs)
    return Proportion(round(point * n), n, point, lo, hi)


def _by_item(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r["id"], []).append(r)
    return out


def _model_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    items = _by_item(rows)
    overall = [[1.0 if r["passed"] else 0.0 for r in rs] for rs in items.values()]
    tool = [[1.0 if r.get("tool_names") else 0.0 for r in rs] for rs in items.values()]

    cats: dict[str, list[list[float]]] = {}
    for rs in items.values():
        c = rs[0]["category"]
        cats.setdefault(c, []).append([1.0 if r["passed"] else 0.0 for r in rs])

    axes: dict[str, Any] = {}
    for axis in AXES:
        per_item = []
        for rs in items.values():
            vals = [1.0 if _axis_value(r, axis) else 0.0 for r in rs if _axis_value(r, axis) is not None]
            if vals:
                per_item.append(vals)
        axes[axis] = _estimate(per_item)

    latencies = sorted(r["latency_ms"] for r in rows)
    return {
        "n": len(items),
        "overall": _estimate(overall),
        "tool_emit": _estimate(tool),
        "by_category": {c: _estimate(v) for c, v in cats.items()},
        "axes": axes,
        "latency_median_ms": int(statistics.median(latencies)) if latencies else 0,
    }


def _pairwise(model_rows: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Paired McNemar (Holm-corrected) on overall pass for every model pair with shared items."""
    # Per-item pass FRACTION per model (handles --repeats); single-sample -> 0/1.
    def frac(rows: list[dict[str, Any]]) -> dict[str, float]:
        return {rid: sum(1 for r in rs if r["passed"]) / len(rs) for rid, rs in _by_item(rows).items()}

    passmap = {m: frac(rows) for m, rows in model_rows.items()}
    models = sorted(model_rows)
    raw: dict[str, float] = {}
    detail: dict[str, dict[str, Any]] = {}
    for i, a in enumerate(models):
        for bm in models[i + 1:]:
            common = sorted(set(passmap[a]) & set(passmap[bm]))
            if len(common) < 10:
                continue
            va = [passmap[a][k] for k in common]
            vb = [passmap[bm][k] for k in common]
            # McNemar needs paired binary -> binarize per-item fractions by majority (>=0.5).
            ba = [1 if x >= 0.5 else 0 for x in va]
            bb = [1 if y >= 0.5 else 0 for y in vb]
            b = sum(1 for x, y in zip(ba, bb) if x == 1 and y == 0)
            c = sum(1 for x, y in zip(ba, bb) if x == 0 and y == 1)
            key = f"{a} vs {bm}"
            raw[key] = mcnemar_exact(b, c)
            diff, lo, hi = paired_bootstrap_diff(va, vb, n_boot=10000, seed=0)
            detail[key] = {"n": len(common), "b": b, "c": c, "diff": diff, "lo": lo, "hi": hi}
    adj = holm(raw)
    out = []
    for key, p in sorted(raw.items(), key=lambda kv: kv[1]):
        d = detail[key]
        out.append({"pair": key, "p_raw": p, "p_holm": adj[key], "significant": adj[key] < 0.05, **d})
    return out


def build_report(model_rows: dict[str, list[dict[str, Any]]]) -> str:
    summ = {m: _model_summary(rows) for m, rows in model_rows.items()}
    order = sorted(summ, key=lambda m: -summ[m]["overall"].p)
    L = ["# Eval analysis (computed — Wilson 95% CIs)", ""]

    L += ["## Overall (sorted by pass rate)", "",
          "| Model | n | Pass [95% CI] | Tool-emit [95% CI] | Median latency |",
          "|---|---|---|---|---|"]
    for m in order:
        s = summ[m]
        L.append(f"| {m} | {s['n']} | {s['overall'].pct()} | {s['tool_emit'].pct()} | {s['latency_median_ms']/1000:.0f}s |")

    L += ["", "## Split skill axes [95% CI] (each over its applicable subset only)", "",
          "| Model | " + " | ".join(AXES) + " |", "|---|" + "---|" * len(AXES)]
    for m in order:
        cells = []
        for axis in AXES:
            v = summ[m]["axes"][axis]
            cells.append(v.pct() if v else "—")
        L.append(f"| {m} | " + " | ".join(cells) + " |")

    L += ["", "## Pairwise significance (McNemar exact, Holm-corrected; paired on item id)", "",
          "| Comparison | n | b/c (discordant) | Δpass [95% CI] | p (Holm) | significant? |",
          "|---|---|---|---|---|---|"]
    for row in _pairwise(model_rows):
        L.append(f"| {row['pair']} | {row['n']} | {row['b']}/{row['c']} | "
                 f"{row['diff']*100:+.0f}% [{row['lo']*100:+.0f}, {row['hi']*100:+.0f}] | "
                 f"{row['p_holm']:.3f} | {'**yes**' if row['significant'] else 'no (tie)'} |")

    L += ["", "## Notes / limitations (anti-slop)",
          "- **Single sample per item** (no `--repeats`): CIs reflect binomial uncertainty at n=30 only,"
          " not run-to-run model stochasticity. Re-run with `--repeats >=3` for variance over samples.",
          "- **Subjective axes (correctness, helpfulness) are NOT in this report** — they require a"
          " calibrated judge with bias controls; they are intentionally omitted rather than estimated.",
          "- **`grounding` is conditional on tool-emission** (only cases where tools fired) and uses a"
          " substring-overlap faithfulness heuristic (documented false +/-) — a screen, not a validated"
          " metric. Models that rarely call tools show `—` (no applicable cases), not a flattering 100%.",
          "- Each model uses only its newest complete run; mixing runs is avoided.",
          ""]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="eval/results", type=Path, help="dir of results-*.jsonl")
    ap.add_argument("--out", default=None, type=Path, help="write the report here (else stdout)")
    args = ap.parse_args()
    model_rows = load_latest_per_model(args.results)
    report = build_report(model_rows)
    if args.out:
        args.out.write_text(report, encoding="utf-8")
        print(f"Wrote {args.out}")
    else:
        print(report)


if __name__ == "__main__":
    main()
