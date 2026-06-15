"""Turn raw eval results into a per-model / per-category markdown scorecard."""

from __future__ import annotations

from collections import defaultdict
from typing import Any


def build_scorecard(results: list[dict[str, Any]]) -> str:
    # (model, category) -> [pass booleans]; plus latency accumulation.
    by_cell: dict[tuple[str, str], list[bool]] = defaultdict(list)
    latency: dict[str, list[int]] = defaultdict(list)
    models: list[str] = []
    categories: list[str] = []

    for r in results:
        model, category = r["model"], r["category"]
        if model not in models:
            models.append(model)
        if category not in categories:
            categories.append(category)
        by_cell[(model, category)].append(bool(r["passed"]))
        if r["kind"] == "oneshot":
            latency[model].append(r.get("latency_ms", 0))
        else:
            latency[model].append(r.get("avg_latency_ms", 0))

    lines = ["# Assistant evaluation scorecard", ""]

    # Pass-rate matrix: categories x models.
    header = "| Category | " + " | ".join(models) + " |"
    sep = "|" + "---|" * (len(models) + 1)
    lines += ["## Pass rate by category", "", header, sep]
    for category in categories:
        row = [category]
        for model in models:
            cell = by_cell.get((model, category), [])
            row.append(f"{(sum(cell) / len(cell) * 100):.0f}% ({sum(cell)}/{len(cell)})" if cell else "—")
        lines.append("| " + " | ".join(row) + " |")

    # Overall + latency.
    lines += ["", "## Overall", "", "| Model | Pass rate | Median latency (ms) |", "|---|---|---|"]
    for model in models:
        allcells = [p for (m, _c), ps in by_cell.items() if m == model for p in ps]
        lat = sorted(latency[model])
        med = lat[len(lat) // 2] if lat else 0
        rate = f"{(sum(allcells) / len(allcells) * 100):.0f}% ({sum(allcells)}/{len(allcells)})" if allcells else "—"
        lines.append(f"| {model} | {rate} | {med} |")

    # Failing checks digest (what broke, grouped).
    fails: dict[str, int] = defaultdict(int)
    for r in results:
        checklists = [r] if r["kind"] == "oneshot" else r.get("turns", [])
        for item in checklists:
            for c in item.get("checks", []):
                if not c["passed"]:
                    fails[c["check"]] += 1
    if fails:
        lines += ["", "## Most common failing checks", "", "| Check | Failures |", "|---|---|"]
        for check, n in sorted(fails.items(), key=lambda kv: -kv[1]):
            lines.append(f"| {check} | {n} |")

    return "\n".join(lines) + "\n"
