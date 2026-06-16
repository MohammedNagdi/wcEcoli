"""CLI: run the assistant eval matrix (dataset x models) and emit results + a scorecard.

Examples
--------
    # From interface/backend, with the backend importable and providers configured in the DB:
    python -m eval.run_eval --dataset eval/datasets/oneshot.example.json \
        --models "ollama:qwen3:8b,ollama:llama3.1:8b" --out eval/results

    # Inside the running api container (providers already configured there):
    docker exec interface-api-1 python -m eval.run_eval --dataset eval/datasets/oneshot.example.json \
        --models "ollama:qwen3:8b" --out /tmp/eval

Deterministic checks run for free. The optional LLM judge is a separate, paid step (judge.py).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session

from app.config import settings
from app.db.engine import make_sqlite_engine

from .report import build_scorecard
from .runner import run_multiturn, run_oneshot
from .schema import Dataset, ModelTarget
from .transcript import build_transcript


def _unload_ollama(target: ModelTarget) -> None:
    """Evict a local model from Ollama (keep_alive=0) before loading the next, so benchmarking
    several models never stacks them in RAM (the cause of the 14B OOM in the multi-model run)."""
    if target.provider_id != "ollama":
        return
    import os
    import urllib.request

    base = (os.environ.get("OLLAMA_BASE_URL") or "http://host.docker.internal:11434").rstrip("/")
    try:
        req = urllib.request.Request(
            f"{base}/api/generate",
            data=json.dumps({"model": target.model, "keep_alive": 0}).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=20).read()
        print(f"  (unloaded {target.model} from memory)")
    except Exception as exc:  # noqa: BLE001 — best-effort
        print(f"  (unload skipped: {exc})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Assistant response-quality evaluation harness.")
    parser.add_argument("--dataset", required=True, help="Path to a dataset JSON file (see schema.py).")
    parser.add_argument("--models", required=True, help="Comma list of provider:model, e.g. 'ollama:qwen3:8b,openai:gpt-4.1-mini'.")
    parser.add_argument("--db", default=str(settings.database_path), help="SQLite DB to ground tools against.")
    parser.add_argument("--out", default="eval/results", help="Output directory for results + scorecard.")
    parser.add_argument("--limit", type=int, default=None, help="cap oneshot cases (small controlled run)")
    args = parser.parse_args()

    dataset = Dataset.model_validate_json(Path(args.dataset).read_text(encoding="utf-8"))
    if args.limit:
        dataset.oneshot = dataset.oneshot[: args.limit]
    targets = [ModelTarget.parse(spec) for spec in args.models.split(",") if spec.strip()]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    engine = make_sqlite_engine(args.db)
    results: list[dict] = []
    for target in targets:
        print(f"\n=== {target.label} ===")
        with Session(engine) as session:
            for case in dataset.oneshot:
                r = run_oneshot(session, case, target)
                results.append(r)
                print(f"  [oneshot] {case.id:<28} {'PASS' if r['passed'] else 'FAIL'}  {r['latency_ms']}ms")
            for scenario in dataset.multiturn:
                r = run_multiturn(session, scenario, target)
                results.append(r)
                print(f"  [multi ] {scenario.id:<28} {'PASS' if r['passed'] else 'FAIL'}  ~{r['avg_latency_ms']}ms/turn")
        _unload_ollama(target)  # free RAM before the next model loads

    raw_path = out_dir / f"results-{stamp}.jsonl"
    with raw_path.open("w", encoding="utf-8") as handle:
        for r in results:
            handle.write(json.dumps(r, default=str) + "\n")
    scorecard_path = out_dir / f"scorecard-{stamp}.md"
    scorecard_path.write_text(build_scorecard(results), encoding="utf-8")
    transcript_path = out_dir / f"transcript-{stamp}.md"
    transcript_path.write_text(build_transcript(results), encoding="utf-8")

    print(f"\nWrote {raw_path}\nWrote {scorecard_path}\nWrote {transcript_path}  <- paste this to Claude for judging")


if __name__ == "__main__":
    main()
