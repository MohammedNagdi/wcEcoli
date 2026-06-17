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
import os
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session

from app.config import settings
from app.db.engine import make_sqlite_engine

from .report import build_scorecard
from .runner import run_multiturn, run_oneshot
from .schema import Dataset, ModelTarget
from .transcript import build_transcript


def _run_config(args, dataset_text: str, targets: list[ModelTarget], stamp: str) -> dict:
    """Full reproducibility record: dataset hash, model digests, options, harness commit."""
    import hashlib
    import os
    import subprocess
    import urllib.request

    def git_commit() -> str:
        try:
            return subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL).decode().strip()
        except Exception:  # noqa: BLE001
            return "unknown"

    def ollama_digest(model: str) -> str:
        base = (os.environ.get("OLLAMA_BASE_URL") or "http://host.docker.internal:11434").rstrip("/")
        try:
            req = urllib.request.Request(f"{base}/api/show", data=json.dumps({"name": model}).encode(),
                                         headers={"Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=15))
            det = d.get("details", {})
            return f"{det.get('parameter_size', '?')}/{det.get('quantization_level', '?')}"
        except Exception:  # noqa: BLE001
            return "unknown"

    return {
        "timestamp": stamp,
        "harness_git_commit": git_commit(),
        "dataset_path": args.dataset,
        "dataset_sha256": hashlib.sha256(dataset_text.encode("utf-8")).hexdigest(),
        "repeats": args.repeats,
        "limit": args.limit,
        "models": [
            {"label": t.label, "provider": t.provider_id, "model": t.model,
             "spec": ollama_digest(t.model) if t.provider_id == "ollama" else "n/a"}
            for t in targets
        ],
        "ollama_options": {
            "num_ctx": getattr(settings, "assistant_ollama_num_ctx", None),
            "keep_alive": getattr(settings, "assistant_ollama_keep_alive", None),
        },
        "note": "Single-call temperature is the model/Ollama default; set --repeats>=3 for stochastic CIs.",
    }


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
    parser.add_argument("--repeats", type=int, default=1,
                        help="run each case N times for multi-sample CIs (stochastic models)")
    args = parser.parse_args()

    dataset_text = Path(args.dataset).read_text(encoding="utf-8")
    dataset = Dataset.model_validate_json(dataset_text)
    if args.limit:
        dataset.oneshot = dataset.oneshot[: args.limit]
    targets = [ModelTarget.parse(spec) for spec in args.models.split(",") if spec.strip()]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    # Reproducibility record (audit: run-config metadata) — written next to the results.
    runconfig = _run_config(args, dataset_text, targets, stamp)
    (out_dir / f"runconfig-{stamp}.json").write_text(json.dumps(runconfig, indent=2), encoding="utf-8")

    engine = make_sqlite_engine(args.db)
    raw_path = out_dir / f"results-{stamp}.jsonl"
    scorecard_path = out_dir / f"scorecard-{stamp}.md"
    transcript_path = out_dir / f"transcript-{stamp}.md"
    results: list[dict] = []

    # Checkpoint each result to the JSONL as it is produced (flush + fsync) so a crash mid-run loses
    # at most the in-flight case, not the whole run. The JSONL is the source of truth; analyze.py
    # reads it directly, so a partial file is still fully analyzable. Scorecard/transcript are
    # rebuilt from whatever completed, even on an exception (finally).
    def checkpoint(r: dict, handle) -> None:
        handle.write(json.dumps(r, default=str) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        results.append(r)

    try:
        with raw_path.open("w", encoding="utf-8") as handle:
            for target in targets:
                print(f"\n=== {target.label} ===")
                with Session(engine) as session:
                    for sample in range(args.repeats):
                        for case in dataset.oneshot:
                            r = run_oneshot(session, case, target)
                            r["sample"] = sample  # lets the analysis aggregate per-item across repeats
                            checkpoint(r, handle)
                            tag = f" s{sample}" if args.repeats > 1 else ""
                            print(f"  [oneshot{tag}] {case.id:<26} {'PASS' if r['passed'] else 'FAIL'}  {r['latency_ms']}ms")
                        for scenario in dataset.multiturn:
                            r = run_multiturn(session, scenario, target)
                            r["sample"] = sample
                            checkpoint(r, handle)
                            print(f"  [multi ] {scenario.id:<28} {'PASS' if r['passed'] else 'FAIL'}  ~{r['avg_latency_ms']}ms/turn")
                _unload_ollama(target)  # free RAM before the next model loads
    finally:
        # Always emit the human-readable artifacts from whatever completed (full run OR partial crash).
        if results:
            scorecard_path.write_text(build_scorecard(results), encoding="utf-8")
            transcript_path.write_text(build_transcript(results), encoding="utf-8")
            print(f"\nWrote {raw_path} ({len(results)} results)"
                  f"\nWrote {scorecard_path}\nWrote {transcript_path}  <- paste this to Claude for judging")


if __name__ == "__main__":
    main()
