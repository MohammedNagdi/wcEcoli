"""Validation and metadata helpers for multi-gene knockout experiments."""

import json
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app.db.models import Gene


MULTI_GENE_KNOCKOUT_TYPE = "multi_gene_knockout"
MULTI_GENE_KNOCKOUT_KEY = "multi_gene_knockout"


def parse_sim_params(raw: str) -> dict[str, Any]:
    if not raw or raw == "{}":
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Invalid sim_params JSON: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(400, "sim_params must be a JSON object")
    return parsed


def resolve_multi_gene_targets(session: Session, gene_symbols: list[str]) -> tuple[list[str], list[int]]:
    cleaned = [symbol.strip() for symbol in gene_symbols if symbol and symbol.strip()]
    if len(cleaned) < 2:
        raise HTTPException(400, "multi_gene_knockout requires at least two genes")

    lowered = [symbol.lower() for symbol in cleaned]
    if len(set(lowered)) != len(lowered):
        raise HTTPException(400, "Duplicate genes are not allowed in multi_gene_knockout")

    genes: list[Gene] = []
    for symbol in cleaned:
        gene = session.exec(select(Gene).where(col(Gene.symbol).ilike(symbol))).first()
        if not gene:
            raise HTTPException(400, f"Unknown gene: {symbol}")
        if gene.ko_index < 1:
            raise HTTPException(400, f"Gene {gene.symbol} does not have a valid knockout index")
        genes.append(gene)

    canonical = sorted(
        ((gene.symbol, gene.ko_index) for gene in genes),
        key=lambda item: (item[1], item[0].lower()),
    )
    ko_indices = sorted({ko_index for _, ko_index in canonical})
    if len(ko_indices) < 2:
        raise HTTPException(
            400,
            "Selected genes map to fewer than two unique wcEcoli knockout targets",
        )
    return [symbol for symbol, _ in canonical], ko_indices


def with_multi_gene_targets(raw_sim_params: str, gene_symbols: list[str], session: Session) -> tuple[str, list[str], list[int]]:
    canonical_symbols, ko_indices = resolve_multi_gene_targets(session, gene_symbols)
    params = parse_sim_params(raw_sim_params)
    params[MULTI_GENE_KNOCKOUT_KEY] = {
        "gene_symbols": canonical_symbols,
        "ko_indices": ko_indices,
    }
    return json.dumps(params, sort_keys=True), canonical_symbols, ko_indices


def strip_multi_gene_targets(raw_sim_params: str) -> str:
    params = parse_sim_params(raw_sim_params)
    params.pop(MULTI_GENE_KNOCKOUT_KEY, None)
    return json.dumps(params, sort_keys=True)


def ko_indices_from_sim_params(raw_sim_params: str) -> list[int]:
    params = parse_sim_params(raw_sim_params)
    metadata = params.get(MULTI_GENE_KNOCKOUT_KEY)
    if not isinstance(metadata, dict):
        raise HTTPException(400, "multi_gene_knockout metadata is missing from sim_params")
    ko_indices = metadata.get("ko_indices")
    if (
        not isinstance(ko_indices, list)
        or len(ko_indices) < 2
        or any(isinstance(index, bool) or not isinstance(index, int) or index < 1 for index in ko_indices)
        or len(set(ko_indices)) != len(ko_indices)
    ):
        raise HTTPException(
            400,
            "multi_gene_knockout ko_indices must contain at least two unique positive integers",
        )
    return ko_indices
