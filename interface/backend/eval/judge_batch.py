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

from .judge_blind import RUBRIC, RUBRIC_ANCHORED

RUBRICS = {"base": RUBRIC, "anchored": RUBRIC_ANCHORED}

_JUDGE_MAX_TOKENS = 400
_SYSTEM = ("You are a careful, unbiased grader of an AI lab-assistant answer for a whole-cell E. coli "
           "simulation platform. Grade only from the tool output given as ground truth.")


def build_prompt(item: dict[str, Any], rubric: str = RUBRIC) -> str:
    """One self-contained judge prompt for a single blinded answer."""
    parts = [rubric, "", "Grade THIS one answer. Return ONLY the JSON object (no prose).", "",
             f"QUESTION:\n{item['prompt']}", "",
             f"TOOL OUTPUT (ground truth):\n{json.dumps(item.get('tool_output'), default=str)[:4000]}"]
    if item.get("gold"):
        parts += ["", f"REFERENCE ANSWER:\n{item['gold']}"]
    parts += ["", f"ASSISTANT ANSWER:\n{item['answer'] or '(empty answer)'}"]
    return "\n".join(parts)


def build_requests(items: list[dict[str, Any]], model: str, rubric: str = RUBRIC) -> list[dict[str, Any]]:
    """Anthropic Message-Batch request objects, one per answer (custom_id = resp_id)."""
    return [{
        "custom_id": it["resp_id"],
        "params": {
            "model": model,
            "max_tokens": _JUDGE_MAX_TOKENS,
            "system": _SYSTEM,
            "messages": [{"role": "user", "content": build_prompt(it, rubric)}],
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


def _provider_creds(provider_id: str, db_path) -> tuple[str, str, str, str]:
    """(kind, api_key, base_url, model) from the runtime spec + the encrypted provider config."""
    from sqlmodel import Session, select

    from app.db.engine import make_sqlite_engine
    from app.db.models import AssistantProviderConfig
    from app.services.assistant_runtime import RUNTIME_PROVIDER_SPECS
    from app.services.assistant_secrets import reveal

    spec = RUNTIME_PROVIDER_SPECS.get(provider_id)
    if not spec:
        raise SystemExit(f"Unknown provider '{provider_id}'.")
    engine = make_sqlite_engine(db_path)
    with Session(engine) as session:
        cfg = session.exec(select(AssistantProviderConfig)
                           .where(AssistantProviderConfig.provider_id == provider_id)).first()
    if not cfg:
        raise SystemExit(f"No '{provider_id}' provider configured — add a key in Provider setup first.")
    key = reveal(cfg.secret_value or "", bool(getattr(cfg, "secret_encrypted", False))).strip()
    if not key:
        raise SystemExit(f"'{provider_id}' provider has no usable API key.")
    base = (getattr(cfg, "endpoint_url", "") or spec.default_base_url).rstrip("/")
    return spec.kind, key, base, getattr(cfg, "model", "") or spec.default_model


def _judge_once(client, kind: str, key: str, base_url: str, model: str, prompt: str) -> str:
    if kind == "anthropic":
        r = client.post(f"{base_url}/messages",
                        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                 "content-type": "application/json"},
                        json={"model": model, "max_tokens": _JUDGE_MAX_TOKENS, "system": _SYSTEM,
                              "messages": [{"role": "user", "content": prompt}]})
        r.raise_for_status()
        return "\n".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
    r = client.post(f"{base_url}/chat/completions",
                    headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
                    json={"model": model, "max_tokens": _JUDGE_MAX_TOKENS, "temperature": 0,
                          "messages": [{"role": "system", "content": _SYSTEM},
                                       {"role": "user", "content": prompt}]})
    r.raise_for_status()
    return (r.json().get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def _run_sync(items: list[dict[str, Any]], kind: str, key: str, base_url: str, model: str,
              rubric: str, out_path: Path) -> dict[str, int]:  # pragma: no cover (live API)
    """One HTTPS call per answer — immediate (no batch latency). Anthropic or OpenAI-compatible."""
    import httpx

    ok = bad = 0
    with httpx.Client(timeout=90) as client, out_path.open("w", encoding="utf-8") as handle:
        for i, item in enumerate(items, 1):
            try:
                text = _judge_once(client, kind, key, base_url, model, build_prompt(item, rubric))
                score = parse_score(item["resp_id"], text)
            except httpx.HTTPError as exc:
                print(f"  [{i}/{len(items)}] {item['resp_id']} HTTP error: {exc}")
                score = None
            if score:
                handle.write(json.dumps(score) + "\n")
                handle.flush()
                ok += 1
            else:
                bad += 1
            if i % 25 == 0:
                print(f"  judged {i}/{len(items)} (ok={ok} unparsed={bad})")
    return {"ok": ok, "unparsed": bad}


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
    ap.add_argument("--label", default="judge2", help="output is judge_scores.<label>.jsonl")
    ap.add_argument("--limit", type=int, default=None, help="judge only the first N items")
    ap.add_argument("--rubric", choices=list(RUBRICS), default="base", help="scoring rubric variant")
    ap.add_argument("--items", default=None, help="judge a specific items.jsonl (default: <judge>/judge_items.jsonl)")
    ap.add_argument("--sync", action="store_true", help="one live call per item (immediate; no 50%% batch discount)")
    ap.add_argument("--submit", action="store_true", help="actually submit the batch (costs money)")
    args = ap.parse_args()

    items_path = Path(args.items) if args.items else args.judge / "judge_items.jsonl"
    items = [json.loads(l) for l in items_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if args.limit:
        items = items[: args.limit]
    rubric = RUBRICS[args.rubric]
    model = args.model
    kind = "anthropic"
    key = base = ""
    if args.submit or args.sync or not args.model:
        kind, key, base, cfg_model = _provider_creds(args.provider, args.db)
        model = args.model or cfg_model

    if args.sync:
        out = args.judge / f"judge_scores.{args.label}.jsonl"
        print(f"Judging {len(items)} items live with {args.provider}:{model} (sync, {args.rubric} rubric) -> {out}")
        summary = _run_sync(items, kind, key, base, model, rubric, out)
        print(json.dumps({**summary, "out": str(out)}, indent=2))
        return
    if kind != "anthropic":
        raise SystemExit("Batch mode is Anthropic-only; use --sync for OpenAI-compatible providers.")

    requests = build_requests(items, model, rubric)
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
    out = args.judge / f"judge_scores.{args.label}.jsonl"
    out.write_text("\n".join(json.dumps(s) for s in scores), encoding="utf-8")
    print(f"Wrote {out} ({len(scores)}/{len(requests)} parsed).")


if __name__ == "__main__":
    main()
