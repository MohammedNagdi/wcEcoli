"""Publish builder drafts into canonical reconstruction files and DB rows."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import settings
from app.db.models import BuilderSectionDraft, Condition, MediaRecipe, Timeline
from app.services.timelines import validate_timeline_definition


MEDIA_STOCK_HEADER = '"molecule id"\t"concentration (units.mmol / units.L)"'
ENVIRONMENT_HEADER = '"molecule id"\t"exchange molecule location"\t"formula weight"'
MEDIA_RECIPE_HEADER = (
    '"media id"\t"base media"\t"base media volume (units.L)"\t"added media"\t'
    '"added media volume (units.L)"\t"ingredients"\t"ingredients weight (units.g)"\t'
    '"ingredients counts (units.mmol)"\t"ingredients volume (units.L)"'
)
CONDITION_HEADER = (
    '"condition"\t"nutrients"\t"genotype perturbations"\t"doubling time (units.min)"\t'
    '"active TFs"\t"inactive TFs"'
)
TF_CONDITION_HEADER = (
    '"TF"\t"active TF"\t"active nutrients"\t"active genotype perturbations"\t'
    '"inactive nutrients"\t"inactive genotype perturbations"\t"TF type"'
)
TIMELINE_HEADER = '"timeline"\t"events"'


def preview_builder_draft(session: Session, draft: BuilderSectionDraft) -> dict[str, Any]:
    payload = _load_payload(draft)
    changes: list[dict[str, Any]] = []
    warnings: list[str] = []

    if draft.section == 'media':
        stock_name = _require_nonempty(payload.get('draft_name') or payload.get('draftMediaStockName'), 'Media name')
        rows = _preview_media(payload, stock_name, warnings)
        changes.extend(rows)
    elif draft.section == 'mediaRecipe':
        changes.append(_preview_media_recipe(session, payload))
    elif draft.section == 'condition':
        changes.append(_preview_condition(session, payload))
    elif draft.section == 'tfCondition':
        changes.append(_preview_tf_conditions(session, payload))
    elif draft.section == 'timeline':
        changes.append(_preview_timeline(session, payload))
    else:
        raise HTTPException(status_code=422, detail=f"Unsupported builder section '{draft.section}'.")

    return {
        'section': draft.section,
        'draft_id': draft.id or 0,
        'draft_name': draft.name,
        'changes': changes,
        'warnings': warnings,
    }


def publish_builder_draft(session: Session, draft: BuilderSectionDraft) -> BuilderSectionDraft:
    payload = _load_payload(draft)

    if draft.section == 'media':
        published_name = _publish_media(payload)
    elif draft.section == 'mediaRecipe':
        published_name = _publish_media_recipe(session, payload)
    elif draft.section == 'condition':
        published_name = _publish_condition(session, payload)
    elif draft.section == 'tfCondition':
        published_name = _publish_tf_conditions(session, payload)
    elif draft.section == 'timeline':
        published_name = _publish_timeline(session, payload)
    else:
        raise HTTPException(status_code=422, detail=f"Unsupported builder section '{draft.section}'.")

    timestamp = _now_iso()
    draft.status = 'published'
    draft.published_at = timestamp
    draft.published_name = published_name
    draft.updated_at = timestamp
    session.add(draft)
    session.commit()
    session.refresh(draft)
    return draft


def _preview_media(payload: dict[str, Any], stock_name: str, warnings: list[str]) -> list[dict[str, Any]]:
    _require_create_mode(payload)
    stock_path = settings.condition_media_dir / f'{stock_name}.tsv'
    if stock_path.exists():
        warnings.append(f"Growth medium '{stock_name}' already exists and publish will be rejected.")

    rows = _nonempty_rows(payload.get('rows') or payload.get('draftMediaRows') or [], ('molecule_id', 'concentration'))
    if not rows:
        raise HTTPException(status_code=422, detail='Growth medium must include at least one composition row.')

    environment_rows = _normalize_environment_rows(payload.get('environment_rows') or payload.get('draftEnvironmentRows') or [])
    existing_environment = _read_environment_rows()
    staged_environment = {row['molecule_id']: row for row in environment_rows}
    for row in rows:
        molecule_id = _require_nonempty(row.get('molecule_id'), 'Molecule ID')
        concentration = _require_nonempty(row.get('concentration'), f"Concentration for {molecule_id}")
        _ensure_safe_cell(molecule_id, 'Molecule ID')
        _ensure_safe_cell(concentration, f"Concentration for {molecule_id}")
        if molecule_id not in existing_environment and molecule_id not in staged_environment:
            raise HTTPException(
                status_code=422,
                detail=f"Molecule '{molecule_id}' is not in environment_molecules.tsv and no draft registry row was provided.",
            )

    registry_lines = []
    for molecule_id, row in staged_environment.items():
        existing = existing_environment.get(molecule_id)
        if existing and (
            existing['exchange_molecule_location'] != row['exchange_molecule_location']
            or existing['formula_weight'] != row['formula_weight']
        ):
            warnings.append(f"Environment molecule '{molecule_id}' already exists with different metadata.")
        if not existing:
            registry_lines.append(_format_row([row['molecule_id'], row['exchange_molecule_location'], row['formula_weight']]))

    media_lines = [MEDIA_STOCK_HEADER] + [
        _format_row([
            _require_nonempty(row.get('molecule_id'), 'Molecule ID'),
            _require_nonempty(row.get('concentration'), 'Concentration'),
        ])
        for row in rows
    ]

    changes: list[dict[str, Any]] = []
    if registry_lines:
        changes.append({
            'file': 'condition/environment_molecules.tsv',
            'action': 'append',
            'rows': registry_lines,
        })
    changes.append({
        'file': f'condition/media/{stock_name}.tsv',
        'action': 'create',
        'rows': ['# Generated by Experimental Conditions Builder', *media_lines],
    })
    return changes


def _publish_media(payload: dict[str, Any]) -> str:
    _require_create_mode(payload)
    stock_name = _require_nonempty(payload.get('draft_name') or payload.get('draftMediaStockName'), 'Media name')
    stock_path = settings.condition_media_dir / f'{stock_name}.tsv'
    if stock_path.exists():
        raise HTTPException(status_code=409, detail=f"Growth medium '{stock_name}' already exists.")

    rows = _nonempty_rows(payload.get('rows') or payload.get('draftMediaRows') or [], ('molecule_id', 'concentration'))
    if not rows:
        raise HTTPException(status_code=422, detail='Growth medium must include at least one composition row.')

    environment_rows = _normalize_environment_rows(payload.get('environment_rows') or payload.get('draftEnvironmentRows') or [])
    existing_environment = _read_environment_rows()
    staged_environment = {row['molecule_id']: row for row in environment_rows}

    for row in rows:
        molecule_id = _require_nonempty(row.get('molecule_id'), 'Molecule ID')
        concentration = _require_nonempty(row.get('concentration'), f"Concentration for {molecule_id}")
        _ensure_safe_cell(molecule_id, 'Molecule ID')
        _ensure_safe_cell(concentration, f"Concentration for {molecule_id}")
        if molecule_id not in existing_environment and molecule_id not in staged_environment:
            raise HTTPException(
                status_code=422,
                detail=f"Molecule '{molecule_id}' is not in environment_molecules.tsv and no draft registry row was provided.",
            )

    for molecule_id, row in staged_environment.items():
        existing = existing_environment.get(molecule_id)
        if existing and (
            existing['exchange_molecule_location'] != row['exchange_molecule_location']
            or existing['formula_weight'] != row['formula_weight']
        ):
            raise HTTPException(
                status_code=409,
                detail=f"Environment molecule '{molecule_id}' already exists with different metadata.",
            )

    if staged_environment:
        append_lines_atomic(
            settings.environment_molecules_tsv,
            [_format_row([row['molecule_id'], row['exchange_molecule_location'], row['formula_weight']]) for row in staged_environment.values()],
            header=ENVIRONMENT_HEADER,
            comment_prefix='# formula weight is in  (units.g / units.mol)',
        )

    media_lines = [MEDIA_STOCK_HEADER] + [
        _format_row([
            _require_nonempty(row.get('molecule_id'), 'Molecule ID'),
            _require_nonempty(row.get('concentration'), 'Concentration'),
        ])
        for row in rows
    ]
    write_lines_atomic(stock_path, ['# Generated by Experimental Conditions Builder', *media_lines])
    return stock_name


def _preview_media_recipe(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    _require_create_mode(payload)
    draft = _require_mapping(payload.get('draft'), 'Media recipe draft')
    media_id = _require_nonempty(draft.get('media_id'), 'Media formulation ID')
    if session.exec(select(MediaRecipe).where(MediaRecipe.media_id == media_id)).first():
        raise HTTPException(status_code=409, detail=f"Media formulation '{media_id}' already exists.")

    base_media = _require_nonempty(draft.get('base_media'), 'Base medium')
    _ensure_media_stock_exists(base_media, 'Base medium')
    added_media = str(draft.get('added_media') or '').strip()
    if added_media:
        _ensure_media_stock_exists(added_media, 'Added medium')

    row = [
        media_id,
        base_media,
        str(draft.get('base_media_volume') or '1.0'),
        added_media,
        str(draft.get('added_media_volume') or '0'),
        str(draft.get('ingredients') or '[]'),
        str(draft.get('ingredients_weight') or '[]'),
        str(draft.get('ingredients_counts') or '[]'),
        str(draft.get('ingredients_volume') or '[]'),
    ]
    _ensure_cells_safe(row, 'Media recipe row')
    return {'file': 'condition/media_recipes.tsv', 'action': 'append', 'rows': [_format_row(row)]}


def _publish_media_recipe(session: Session, payload: dict[str, Any]) -> str:
    _require_create_mode(payload)
    draft = _require_mapping(payload.get('draft'), 'Media recipe draft')
    media_id = _require_nonempty(draft.get('media_id'), 'Media formulation ID')
    if session.exec(select(MediaRecipe).where(MediaRecipe.media_id == media_id)).first():
        raise HTTPException(status_code=409, detail=f"Media formulation '{media_id}' already exists.")

    base_media = _require_nonempty(draft.get('base_media'), 'Base medium')
    _ensure_media_stock_exists(base_media, 'Base medium')
    added_media = str(draft.get('added_media') or '').strip()
    if added_media:
        _ensure_media_stock_exists(added_media, 'Added medium')

    row = [
        media_id,
        base_media,
        str(draft.get('base_media_volume') or '1.0'),
        added_media,
        str(draft.get('added_media_volume') or '0'),
        str(draft.get('ingredients') or '[]'),
        str(draft.get('ingredients_weight') or '[]'),
        str(draft.get('ingredients_counts') or '[]'),
        str(draft.get('ingredients_volume') or '[]'),
    ]
    _ensure_cells_safe(row, 'Media recipe row')
    append_lines_atomic(settings.media_recipes_tsv, [_format_row(row)], header=MEDIA_RECIPE_HEADER)

    recipe = MediaRecipe(
        media_id=media_id,
        base_media=base_media,
        added_media=added_media,
        ingredients=str(draft.get('ingredients') or '[]'),
    )
    session.add(recipe)
    session.commit()
    return media_id


def _preview_condition(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    _require_create_mode(payload)
    draft = _require_mapping(payload.get('draft'), 'Condition draft')
    condition_name = _require_nonempty(draft.get('condition'), 'Condition name')
    if session.exec(select(Condition).where(Condition.name == condition_name)).first():
        raise HTTPException(status_code=409, detail=f"Condition '{condition_name}' already exists.")

    nutrients = _require_nonempty(draft.get('nutrients'), 'Condition nutrients')
    _ensure_media_recipe_exists(session, nutrients)
    doubling_time = str(draft.get('doubling_time') or '44.0')
    row = [
        condition_name,
        nutrients,
        str(draft.get('genotype_perturbations') or '{}'),
        doubling_time,
        str(draft.get('active_tfs') or '[]'),
        str(draft.get('inactive_tfs') or '[]'),
    ]
    _ensure_cells_safe(row, 'Condition row')
    return {'file': 'condition/condition_defs.tsv', 'action': 'append', 'rows': [_format_row(row)]}


def _publish_condition(session: Session, payload: dict[str, Any]) -> str:
    _require_create_mode(payload)
    draft = _require_mapping(payload.get('draft'), 'Condition draft')
    condition_name = _require_nonempty(draft.get('condition'), 'Condition name')
    if session.exec(select(Condition).where(Condition.name == condition_name)).first():
        raise HTTPException(status_code=409, detail=f"Condition '{condition_name}' already exists.")

    nutrients = _require_nonempty(draft.get('nutrients'), 'Condition nutrients')
    _ensure_media_recipe_exists(session, nutrients)
    doubling_time = str(draft.get('doubling_time') or '44.0')
    row = [
        condition_name,
        nutrients,
        str(draft.get('genotype_perturbations') or '{}'),
        doubling_time,
        str(draft.get('active_tfs') or '[]'),
        str(draft.get('inactive_tfs') or '[]'),
    ]
    _ensure_cells_safe(row, 'Condition row')
    append_lines_atomic(settings.condition_defs_tsv, [_format_row(row)], header=CONDITION_HEADER)

    session.add(
        Condition(
            name=condition_name,
            nutrients=nutrients,
            genotype_perturbations=str(draft.get('genotype_perturbations') or '{}'),
            doubling_time=_parse_float(doubling_time, 'Doubling time'),
            active_tfs=str(draft.get('active_tfs') or '[]'),
            inactive_tfs=str(draft.get('inactive_tfs') or '[]'),
        )
    )
    session.commit()
    return condition_name


def _preview_tf_conditions(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    _require_create_mode(payload)
    rows = _require_list(payload.get('draft'), 'TF condition draft rows')
    normalized_rows = []
    existing_rows = {tuple(row) for row in _read_plain_rows(settings.tf_condition_tsv)}

    for index, row in enumerate(rows, start=1):
        mapping = _require_mapping(row, f'TF condition row {index}')
        normalized = [
            _require_nonempty(mapping.get('tf'), f'TF name for row {index}'),
            _require_nonempty(mapping.get('active_tf'), f'Active TF for row {index}'),
            _require_nonempty(mapping.get('active_nutrients'), f'Active nutrients for row {index}'),
            str(mapping.get('active_genotype_perturbations') or '{}'),
            _require_nonempty(mapping.get('inactive_nutrients'), f'Inactive nutrients for row {index}'),
            str(mapping.get('inactive_genotype_perturbations') or '{}'),
            _require_nonempty(mapping.get('tf_type'), f'TF type for row {index}'),
        ]
        _ensure_media_recipe_exists(session, normalized[2])
        _ensure_media_recipe_exists(session, normalized[4])
        _ensure_cells_safe(normalized, f'TF condition row {index}')
        if tuple(normalized) in existing_rows:
            raise HTTPException(status_code=409, detail=f"TF condition row {index} already exists in tf_condition.tsv.")
        normalized_rows.append(normalized)

    if not normalized_rows:
        raise HTTPException(status_code=422, detail='TF condition publish requires at least one draft row.')

    return {
        'file': 'condition/tf_condition.tsv',
        'action': 'append',
        'rows': [_format_row(row) for row in normalized_rows],
    }


def _publish_tf_conditions(session: Session, payload: dict[str, Any]) -> str:
    _require_create_mode(payload)
    rows = _require_list(payload.get('draft'), 'TF condition draft rows')
    normalized_rows = []
    existing_rows = {tuple(row) for row in _read_plain_rows(settings.tf_condition_tsv)}

    for index, row in enumerate(rows, start=1):
        mapping = _require_mapping(row, f'TF condition row {index}')
        normalized = [
            _require_nonempty(mapping.get('tf'), f'TF name for row {index}'),
            _require_nonempty(mapping.get('active_tf'), f'Active TF for row {index}'),
            _require_nonempty(mapping.get('active_nutrients'), f'Active nutrients for row {index}'),
            str(mapping.get('active_genotype_perturbations') or '{}'),
            _require_nonempty(mapping.get('inactive_nutrients'), f'Inactive nutrients for row {index}'),
            str(mapping.get('inactive_genotype_perturbations') or '{}'),
            _require_nonempty(mapping.get('tf_type'), f'TF type for row {index}'),
        ]
        _ensure_media_recipe_exists(session, normalized[2])
        _ensure_media_recipe_exists(session, normalized[4])
        _ensure_cells_safe(normalized, f'TF condition row {index}')
        if tuple(normalized) in existing_rows:
            raise HTTPException(status_code=409, detail=f"TF condition row {index} already exists in tf_condition.tsv.")
        normalized_rows.append(normalized)

    if not normalized_rows:
        raise HTTPException(status_code=422, detail='TF condition publish requires at least one draft row.')

    append_lines_atomic(
        settings.tf_condition_tsv,
        [_format_row(row) for row in normalized_rows],
        header=TF_CONDITION_HEADER,
    )
    suffix = '' if len(normalized_rows) == 1 else 's'
    return f'{len(normalized_rows)} TF rule{suffix}'


def _preview_timeline(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    _require_create_mode(payload)
    timeline_name = _require_nonempty(payload.get('name') or payload.get('draftTimelineName'), 'Timeline name')
    if session.exec(select(Timeline).where(Timeline.name == timeline_name)).first():
        raise HTTPException(status_code=409, detail=f"Timeline '{timeline_name}' already exists.")

    definition = _require_nonempty(payload.get('events') or payload.get('draftTimelineEvents'), 'Timeline events')
    normalized_definition = validate_timeline_definition(session, definition)
    row = [timeline_name, normalized_definition]
    _ensure_cells_safe(row, 'Timeline row')
    return {'file': 'condition/timelines_def.tsv', 'action': 'append', 'rows': [_format_row(row)]}


def _publish_timeline(session: Session, payload: dict[str, Any]) -> str:
    _require_create_mode(payload)
    timeline_name = _require_nonempty(payload.get('name') or payload.get('draftTimelineName'), 'Timeline name')
    if session.exec(select(Timeline).where(Timeline.name == timeline_name)).first():
        raise HTTPException(status_code=409, detail=f"Timeline '{timeline_name}' already exists.")

    definition = _require_nonempty(payload.get('events') or payload.get('draftTimelineEvents'), 'Timeline events')
    normalized_definition = validate_timeline_definition(session, definition)
    row = [timeline_name, normalized_definition]
    _ensure_cells_safe(row, 'Timeline row')
    append_lines_atomic(settings.timelines_def_tsv, [_format_row(row)], header=TIMELINE_HEADER)

    session.add(Timeline(name=timeline_name, definition=normalized_definition))
    session.commit()
    return timeline_name


def write_lines_atomic(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile('w', encoding='utf-8', delete=False, dir=path.parent) as handle:
        handle.write('\n'.join(lines) + '\n')
        temp_path = Path(handle.name)
    temp_path.replace(path)


def append_lines_atomic(path: Path, new_lines: list[str], *, header: str, comment_prefix: str | None = None) -> None:
    existing_lines: list[str] = []
    if path.exists():
        existing_lines = path.read_text(encoding='utf-8').splitlines()
    else:
        if comment_prefix:
            existing_lines.append(comment_prefix)
        existing_lines.append(header)

    write_lines_atomic(path, [*existing_lines, *new_lines])


def _load_payload(draft: BuilderSectionDraft) -> dict[str, Any]:
    try:
        value = json.loads(draft.payload or '{}')
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Draft payload is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail='Draft payload must be a JSON object.')
    return value


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_create_mode(payload: dict[str, Any]) -> None:
    mode = str(payload.get('mode') or 'create')
    if mode != 'create':
        raise HTTPException(status_code=422, detail='Only draft-created builder sections can be published.')


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail=f'{label} must be a JSON object.')
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise HTTPException(status_code=422, detail=f'{label} must be a JSON array.')
    return value


def _require_nonempty(value: Any, label: str) -> str:
    normalized = str(value or '').strip()
    if not normalized:
        raise HTTPException(status_code=422, detail=f'{label} must not be empty.')
    return normalized


def _nonempty_rows(rows: Any, required_keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise HTTPException(status_code=422, detail='Draft rows must be a JSON array.')
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if any(str(row.get(key) or '').strip() for key in required_keys):
            normalized.append(row)
    return normalized


def _normalize_environment_rows(rows: Any) -> list[dict[str, str]]:
    normalized = []
    for row in _nonempty_rows(rows, ('molecule_id',)):
        normalized.append({
            'molecule_id': _require_nonempty(row.get('molecule_id'), 'Environment molecule ID'),
            'exchange_molecule_location': _require_nonempty(row.get('exchange_molecule_location') or '[p]', 'Environment molecule location'),
            'formula_weight': _require_nonempty(row.get('formula_weight') or 'None', 'Environment molecule formula weight'),
        })
    return normalized


def _read_environment_rows() -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    if not settings.environment_molecules_tsv.exists():
        return rows
    for values in _read_plain_rows(settings.environment_molecules_tsv):
        if len(values) < 3:
            continue
        rows[values[0]] = {
            'molecule_id': values[0],
            'exchange_molecule_location': values[1],
            'formula_weight': values[2],
        }
    return rows


def _read_plain_rows(path: Path) -> list[list[str]]:
    rows: list[list[str]] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        parts = [part.strip() for part in line.split('\t')]
        if parts and parts[0].strip('"').lower() in {
            'molecule id',
            'media id',
            'condition',
            'tf',
            'timeline',
        }:
            continue
        rows.append([part.strip().strip('"') for part in parts])
    return rows


def _ensure_media_stock_exists(name: str, label: str) -> None:
    path = settings.condition_media_dir / f'{name}.tsv'
    if not path.exists():
        raise HTTPException(status_code=422, detail=f"{label} '{name}' does not exist as a published growth medium file.")


def _ensure_media_recipe_exists(session: Session, media_id: str) -> None:
    if not session.exec(select(MediaRecipe).where(MediaRecipe.media_id == media_id)).first():
        raise HTTPException(status_code=422, detail=f"Media formulation '{media_id}' has not been published yet.")


def _ensure_safe_cell(value: str, label: str) -> None:
    if '\t' in value or '\n' in value or '\r' in value:
        raise HTTPException(status_code=422, detail=f'{label} must not contain tabs or newlines.')


def _ensure_cells_safe(values: list[str], label: str) -> None:
    for value in values:
        _ensure_safe_cell(str(value), label)


def _parse_float(value: str, label: str) -> float | None:
    try:
        return float(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f'{label} must be numeric.') from exc


def _format_row(values: list[str]) -> str:
    return '\t'.join(str(value) for value in values)
