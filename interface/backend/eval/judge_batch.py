"""Automated judge over the blinded worksheet, via a hosted model's **Batches API** (50% off).

Each blinded answer is a single, independent judge request — the textbook Batches fit. This reads the
structured `judge_items.jsonl` emitted by `judge_blind`, builds one judge request per answer, and (with
``--submit``) sends them as one Anthropic Message Batch, polls to completion, and writes
`judge_scores.jsonl` in the exact shape `judge_analyze` consumes. Without ``--submit`` it is a
**dry run**: it writes the batch request file and prints token/cost estimates without spending.

The provider key is read from the platform's encrypted provider config (never hard-coded); base URL and
model default to the configured Anthropic provider. Use a STRONG judge model (e.g. Sonnet) for low
variance — `--model claude-sonnet-4-6`.

    python -m eval.judge_batch --judge eval/results/judge                 # dry run (no spend)
    python -m eval.judge_batch --judge eval/results/judge --submit --model claude-sonnet-4-6
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from .judge_blind import RUBRIC

_JUDGE_MAX_TOKENS = 400
_SYSTEM = ("You are a careful, unbiased grader of an AI lab-assistant answer for a whole-cell E. coli "
           "simulation platform. Grade only from the tool output given as ground truth.")


def build_prompt(item: dict[str, Any]) -> str:
    """One self-contained judge prompt for a single blinded answer."""
    parts = [RUBRIC, "", "Grade THIS one answer. Return ONLY the JSON object (no prose).", "",
             f"QUESTION:\n{item['prompt']}", "",
             f"TOOL OUTPUT (ground truth):\n{json.dumps(item.get('tool_output'), default=str)[:4000]}"]
    if item.get("gold"):
        parts += ["", f"REFERENCE ANSWER:\n{item['gold']}"]
    parts += ["", f"ASSISTANT ANSWER:\n{item['answer'] or '(empty answer)'}"]
    return "\n".join(parts)


def build_requests(items: list[dict[str, Any]], model: str) -> list[dict[str, Any]]:
    """Anthropic Message-Batch request objects, one per answer (custom_id = resp_id)."""
    return [{
        "custom_id": it["resp_id"],
        "params": {
            "model": model,
            "max_tokens": _JUDGE_MAX_TOKENS,
            "system": _SYSTEM,
            "messages": [{"role": "user", "content": build_prompt(it)}],
        },
    } for it in items]


def parse_score(resp_id: str, text: str) -> dict[str, Any] | None:
    """Pull the JSON score object out of a judge completion; tolerate surrounding prose."""
    try:
        obj = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except (ValueError, json.JSONDecodeError):
        return None
    out = {"resp_id": resp_id, "flags": obj.get("flags", []) or [], "why": str(obj.get("why", ""))}
    for axis in ("correctness", "helpfulness"):
        if axis in obj:
            try:
                out[axis] = int(round(float(obj[axis])))
            except (TypeError, ValueError):
                pass
    return out if ("correctness" in out or "helpfulness" in out) else None


def _anthropic_creds(provider_id: str, db_path) -> tuple[str, str, str]:
    """(api_key, base_url, model) from the platform's encrypted provider config."""
    from sqlmodel import Session, select

    from app.db.engine import make_sqlite_engine
    from app.db.models import AssistantProviderConfig
    from app.services.assistant_secrets import reveal

    engine = make_sqlite_engine(db_path)
    with Session(engine) as session:
        cfg = session.exec(select(AssistantProviderConfig)
                           .where(AssistantProviderConfig.provider_id == provider_id)).first()
    if not cfg:
        raise SystemExit(f"No '{provider_id}' provider configured — add a key in Provider setup first.")
    key = reveal(cfg.secret_value or "", bool(getattr(cfg, "secret_encrypted", False))).strip()
    if not key:
        raise SystemExit(f"'{provider_id}' provider has no usable API key.")
    base = (getattr(cfg, "base_url", "") or "https://api.anthropic.com/v1").rstrip("/")
    return key, base, getattr(cfg, "model", "") or "claude-haiku-4-5"


def _submit_and_collect(requests: list[dict[str, Any]], key: str, base_url: str,
                        poll_sec: int = 30) -> list[dict[str, Any]]:  # pragma: no cover (live API)
    import httpx

    headers = {"x-api-key": key, "anthropic-version": "2023-06-01",
               "anthropic-beta": "message-batches-2024-09-24", "content-type": "application/json"}
    with httpx.Client(timeout=60) as client:
        created = client.post(f"{base_url}/messages/batches", headers=headers,
                              json={"requests": requests}).raise_for_status().json()
        batch_id = created["id"]
        print(f"submitted batch {batch_id} ({len(requests)} requests); polling…")
        while True:
            batch = client.get(f"{base_url}/messages/batches/{batch_id}", headers=headers).raise_for_status().json()
            if batch.get("processing_status") == "ended":
                break
            time.sleep(poll_sec)
        results_url = batch["results_url"]
        out = []
        for line in client.get(results_url, headers=headers).raise_for_status().text.splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            res = row.get("result", {})
            if res.get("type") != "succeeded":
                continue
            text = "\n".join(b.get("text", "") for b in res["message"].get("content", [])
                             if b.get("type") == "text")
            score = parse_score(row["custom_id"], text)
            if score:
                out.append(score)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge", default="eval/results/judge", type=Path)
    ap.add_argument("--provider", default="anthropic")
    ap.add_argument("--model", default="", help="judge model (default: the configured provider model)")
    ap.add_argument("--db", default="/app/data/wcecoli.db")
    ap.add_argument("--submit", action="store_true", help="actually submit the batch (costs money)")
    args = ap.parse_args()

    items = [json.loads(l) for l in (args.judge / "judge_items.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    model = args.model
    key = base = ""
    if args.submit or not args.model:
        key, base, cfg_model = _anthropic_creds(args.provider, args.db)
        model = args.model or cfg_model
    requests = build_requests(items, model)

    if not args.submit:
        out = args.judge / "judge_batch_requests.jsonl"
        out.write_text("\n".join(json.dumps(r) for r in requests), encoding="utf-8")
        approx_in = sum(len(json.dumps(r["params"]["messages"])) for r in requests) // 4
        print(json.dumps({"dry_run": True, "requests": len(requests), "model": model,
                          "approx_input_tokens": approx_in,
                          "note": "Batches API bills at 50% of standard rates. Re-run with --submit to judge.",
                          "wrote": str(out)}, indent=2))
        return

    scores = _submit_and_collect(requests, key, base)
    out = args.judge / "judge_scores.jsonl"
    out.write_text("\n".join(json.dumps(s) for s in scores), encoding="utf-8")
    print(f"Wrote {out} ({len(scores)}/{len(requests)} parsed). Now run: python -m eval.judge_analyze --judge {args.judge}")


if __name__ == "__main__":
    main()
