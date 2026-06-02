"""Condition catalog router — exposes the full flat reconstruction condition surface."""

from __future__ import annotations

import csv
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings

router = APIRouter(prefix="/api/condition-catalog", tags=["condition-catalog"])


class MediaStockRowOut(BaseModel):
    molecule_id: str
    concentration: str


class MediaStockOut(BaseModel):
    name: str
    rows: list[MediaStockRowOut]


class EnvironmentMoleculeOut(BaseModel):
    molecule_id: str
    exchange_molecule_location: str
    formula_weight: str


class MediaRecipeRecordOut(BaseModel):
    media_id: str
    base_media: str
    base_media_volume: str
    added_media: str
    added_media_volume: str
    ingredients: str
    ingredients_weight: str
    ingredients_counts: str
    ingredients_volume: str


class ConditionRecordOut(BaseModel):
    condition: str
    nutrients: str
    genotype_perturbations: str
    doubling_time: str
    active_tfs: str
    inactive_tfs: str


class TfConditionRecordOut(BaseModel):
    tf: str
    active_tf: str
    active_nutrients: str
    active_genotype_perturbations: str
    inactive_nutrients: str
    inactive_genotype_perturbations: str
    tf_type: str


class TimelineRecordOut(BaseModel):
    timeline: str
    events: str


class ConditionCatalogOut(BaseModel):
    media_stocks: list[MediaStockOut]
    environment_molecules: list[EnvironmentMoleculeOut]
    media_recipes: list[MediaRecipeRecordOut]
    conditions: list[ConditionRecordOut]
    tf_conditions: list[TfConditionRecordOut]
    timelines: list[TimelineRecordOut]


def _read_tsv_dicts(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []

    with open(path, encoding="utf-8") as handle:
        lines = [line for line in handle if line.strip() and not line.lstrip().startswith("#")]

    if not lines:
        return []

    reader = csv.DictReader(lines, delimiter="\t")
    rows: list[dict[str, str]] = []
    for row in reader:
        cleaned: dict[str, str] = {}
        for key, value in row.items():
            if key is None:
                continue
            cleaned[key.strip().strip('"')] = (value or "").strip()
        rows.append(cleaned)
    return rows


def _load_media_stocks() -> list[MediaStockOut]:
    stocks: list[MediaStockOut] = []
    media_dir = settings.condition_media_dir
    if not media_dir.exists():
        return stocks

    for path in sorted(media_dir.glob("*.tsv")):
        rows = _read_tsv_dicts(path)
        stocks.append(
            MediaStockOut(
                name=path.stem,
                rows=[
                    MediaStockRowOut(
                        molecule_id=row.get("molecule id", ""),
                        concentration=row.get("concentration (units.mmol / units.L)", ""),
                    )
                    for row in rows
                ],
            )
        )
    return stocks


@router.get("", response_model=ConditionCatalogOut)
def get_condition_catalog() -> ConditionCatalogOut:
    environment_rows = _read_tsv_dicts(settings.environment_molecules_tsv)
    media_recipe_rows = _read_tsv_dicts(settings.media_recipes_tsv)
    condition_rows = _read_tsv_dicts(settings.condition_defs_tsv)
    tf_condition_rows = _read_tsv_dicts(settings.tf_condition_tsv)
    timeline_rows = _read_tsv_dicts(settings.timelines_def_tsv)

    return ConditionCatalogOut(
        media_stocks=_load_media_stocks(),
        environment_molecules=[
            EnvironmentMoleculeOut(
                molecule_id=row.get("molecule id", ""),
                exchange_molecule_location=row.get("exchange molecule location", ""),
                formula_weight=row.get("formula weight", ""),
            )
            for row in environment_rows
        ],
        media_recipes=[
            MediaRecipeRecordOut(
                media_id=row.get("media id", ""),
                base_media=row.get("base media", ""),
                base_media_volume=row.get("base media volume (units.L)", ""),
                added_media=row.get("added media", ""),
                added_media_volume=row.get("added media volume (units.L)", ""),
                ingredients=row.get("ingredients", ""),
                ingredients_weight=row.get("ingredients weight (units.g)", ""),
                ingredients_counts=row.get("ingredients counts (units.mmol)", ""),
                ingredients_volume=row.get("ingredients volume (units.L)", ""),
            )
            for row in media_recipe_rows
        ],
        conditions=[
            ConditionRecordOut(
                condition=row.get("condition", ""),
                nutrients=row.get("nutrients", ""),
                genotype_perturbations=row.get("genotype perturbations", ""),
                doubling_time=row.get("doubling time (units.min)", ""),
                active_tfs=row.get("active TFs", ""),
                inactive_tfs=row.get("inactive TFs", ""),
            )
            for row in condition_rows
        ],
        tf_conditions=[
            TfConditionRecordOut(
                tf=row.get("TF", ""),
                active_tf=row.get("active TF", ""),
                active_nutrients=row.get("active nutrients", ""),
                active_genotype_perturbations=row.get("active genotype perturbations", ""),
                inactive_nutrients=row.get("inactive nutrients", ""),
                inactive_genotype_perturbations=row.get("inactive genotype perturbations", ""),
                tf_type=row.get("TF type", ""),
            )
            for row in tf_condition_rows
        ],
        timelines=[
            TimelineRecordOut(
                timeline=row.get("timeline", ""),
                events=row.get("events", ""),
            )
            for row in timeline_rows
        ],
    )