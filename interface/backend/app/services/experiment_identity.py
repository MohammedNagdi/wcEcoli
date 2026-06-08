"""Helpers for comparing experiment/run identity across UI-created records."""

import json
from typing import Any

from sqlmodel import Session

from app.services.timelines import resolve_timeline_definition


DEFAULT_LENGTH_SEC = 10800


def parse_sim_params(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def seed_tuple(params: dict[str, Any], default_seed: int = 0) -> tuple[int, ...]:
    seeds = params.get("seeds")
    if isinstance(seeds, list):
        return tuple(sorted(int(seed) for seed in seeds))
    if seeds is not None:
        return tuple(range(int(seeds)))
    if "seed" in params:
        return (int(params["seed"]),)
    return (default_seed,)


def run_param_key(sim_params: str, default_seed: int = 0) -> tuple[tuple[int, ...], int, float]:
    params = parse_sim_params(sim_params)
    generations = int(params.get("generations", 1))
    length_sec = float(params.get("length_sec", DEFAULT_LENGTH_SEC))
    return seed_tuple(params, default_seed), generations, length_sec


def resolved_timeline_key(session: Session, timeline: str) -> str:
    return resolve_timeline_definition(session, timeline) if timeline else ""


def experiment_environment_key(
    session: Session,
    *,
    condition: str,
    timeline: str,
    sim_params: str,
) -> tuple[str, str, tuple[tuple[int, ...], int, float]]:
    return (
        condition or "basal",
        resolved_timeline_key(session, timeline),
        run_param_key(sim_params),
    )
