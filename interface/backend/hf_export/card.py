"""Generate the Hugging Face dataset card (README.md) and Croissant metadata from a shard's manifest.

Auto-filled from `manifest.json` so the counts/channels never drift from the data.
"""

from __future__ import annotations

from typing import Any

_CITATION = """@misc{wcecoli_cell_dataset,
  title  = {wcEcoli Cell Dataset: whole-cell E. coli simulation trajectories},
  note   = {Generated with the wcEcoli whole-cell model (Covert lab) via the wcEcoli platform},
  year   = {2026}
}"""


def build_dataset_card(manifest: dict[str, Any], split_counts: dict[str, int], baselines_md: str = "") -> str:
    chans = manifest.get("channels", [])
    matrix = manifest.get("matrix_channels", {})
    fm = [
        "---",
        "license: cc-by-4.0",
        "task_categories:",
        "  - time-series-forecasting",
        "  - tabular-regression",
        "tags:",
        "  - biology",
        "  - systems-biology",
        "  - whole-cell",
        "  - e-coli",
        "  - simulation",
        "size_categories:",
        f"  - {'n<1K' if manifest.get('n_cell_trajectories',0) < 1000 else '1K<n<10K'}",
        "---",
        "",
    ]
    body = [
        "# wcEcoli Cell Dataset",
        "",
        "Whole-cell *E. coli* K-12 simulation trajectories — **mechanistically complete, fully observable, "
        "causally-perturbed cellular dynamics** in a uniform format with benchmark tasks. \"The Well, for the "
        "cell.\" Generated with the wcEcoli whole-cell model.",
        "",
        "## What's inside",
        f"- **{manifest.get('n_cell_trajectories', 0)} cell trajectories** from "
        f"{manifest.get('n_jobs', 0)} simulation jobs.",
        f"- **Conditions:** {', '.join(manifest.get('conditions', [])) or '—'}",
        f"- **Genotypes:** {', '.join(manifest.get('genotypes', [])) or '—'}",
        f"- **Scalar channels ({len(chans)}):** {', '.join(chans)}",
    ]
    if matrix:
        body.append("- **High-dimensional channels:** "
                    + ", ".join(f"`{k}` ({v} cols)" for k, v in matrix.items())
                    + " — per-gene/per-reaction tensors; column ids under `/reference`.")
    body += [
        "",
        "## Layout",
        "```",
        "/reference/<matrix>_ids                # column ids (stored once)",
        "/cond=<c>/geno=<g>/seed=<s>/gen=<n>",
        "    <channel>/value [T] or [T, N] float32   <channel>/time [T] float32",
        "```",
        "`metadata.jsonl` — one flat row per trajectory (the split/benchmark index).",
        "",
        "## Splits (held-out genotype + condition, not random)",
        f"- train: {split_counts.get('train', 0)}  ·  val: {split_counts.get('val', 0)}  "
        f"·  test: {split_counts.get('test', 0)}",
        "A model must generalize to **unseen knockouts and unseen media**, not memorize.",
        "",
        "## Benchmark tasks & baselines",
        "- **T1** genotype+condition → growth rate (regression)",
        "- **T2** knockout viability (classification)",
        "- **T3** trajectory forecasting (prefix → suffix)",
        "",
        baselines_md or "_Run `python -m hf_export.package_release <shard>` to fill baseline scores._",
        "",
        "## Usage",
        "```python",
        "from hf_export.dataset import WcEcoliShard",
        "shard = WcEcoliShard('path/to/shard')",
        "rows = shard.rows()",
        "X, cols = shard.tabular_features(rows); y = shard.tabular_target(rows, 'growth_rate')",
        "```",
        "",
        "## License & citation",
        "CC-BY-4.0. Credit the wcEcoli whole-cell model (Covert lab).",
        "```bibtex",
        _CITATION,
        "```",
        "",
        "## Limitations",
        "Simulation, not experimental, data — biased by the model's assumptions; noise-free unless added.",
    ]
    return "\n".join(fm + body) + "\n"


def build_croissant(manifest: dict[str, Any]) -> dict[str, Any]:
    """Minimal MLCommons Croissant (JSON-LD) so HF tools understand the structure."""
    return {
        "@context": {"@vocab": "https://schema.org/", "cr": "http://mlcommons.org/croissant/"},
        "@type": "Dataset",
        "name": "wcEcoli Cell Dataset",
        "description": "Whole-cell E. coli simulation trajectories with benchmark tasks.",
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "version": manifest.get("version", "v0"),
        "distribution": [
            {"@type": "cr:FileObject", "@id": "trajectories.h5", "encodingFormat": "application/x-hdf5"},
            {"@type": "cr:FileObject", "@id": "metadata.jsonl", "encodingFormat": "application/jsonlines"},
        ],
        "recordSet": [{
            "@type": "cr:RecordSet", "@id": "trajectories",
            "field": [
                {"@type": "cr:Field", "@id": "h5_path", "dataType": "Text"},
                {"@type": "cr:Field", "@id": "genotype", "dataType": "Text"},
                {"@type": "cr:Field", "@id": "condition", "dataType": "Text"},
                {"@type": "cr:Field", "@id": "seed", "dataType": "Integer"},
                {"@type": "cr:Field", "@id": "growth_rate", "dataType": "Float"},
                {"@type": "cr:Field", "@id": "divided", "dataType": "Boolean"},
            ],
        }],
        "citation": _CITATION,
    }
