"""Builder drafts router — durable draft storage for Environment Builder sections."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db.models import BuilderSectionDraft
from app.main import get_session
from app.services.builder_publish import publish_builder_draft

router = APIRouter(prefix="/api/builder-drafts", tags=["builder-drafts"])

BuilderSectionName = Literal["media", "mediaRecipe", "condition", "tfCondition", "timeline"]
VALID_SECTIONS = {"media", "mediaRecipe", "condition", "tfCondition", "timeline"}


class BuilderDraftInput(BaseModel):
    name: str
    payload: dict[str, Any] = Field(default_factory=dict)


class BuilderDraftOut(BaseModel):
    id: int
    section: BuilderSectionName
    name: str
    payload: dict[str, Any]
    status: str
    created_at: str
    updated_at: str
    published_at: str
    published_name: str


class BuilderDraftCollectionOut(BaseModel):
    media: list[BuilderDraftOut] = Field(default_factory=list)
    mediaRecipe: list[BuilderDraftOut] = Field(default_factory=list)
    condition: list[BuilderDraftOut] = Field(default_factory=list)
    tfCondition: list[BuilderDraftOut] = Field(default_factory=list)
    timeline: list[BuilderDraftOut] = Field(default_factory=list)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_name(name: str) -> str:
    normalized = name.strip()
    if not normalized:
        raise HTTPException(status_code=422, detail="Draft name must not be empty.")
    return normalized


def _serialize_payload(payload: dict[str, Any]) -> str:
    try:
        return json.dumps(payload, separators=(",", ":"))
    except TypeError as exc:
        raise HTTPException(status_code=422, detail=f"Draft payload must be JSON-serializable: {exc}") from exc


def _to_out(record: BuilderSectionDraft) -> BuilderDraftOut:
    return BuilderDraftOut(
        id=record.id or 0,
        section=record.section,  # type: ignore[arg-type]
        name=record.name,
        payload=json.loads(record.payload or "{}"),
        status=record.status,
        created_at=record.created_at,
        updated_at=record.updated_at,
        published_at=record.published_at,
        published_name=record.published_name,
    )


def _require_valid_section(section: str) -> BuilderSectionName:
    if section not in VALID_SECTIONS:
        raise HTTPException(status_code=404, detail=f"Unknown builder section '{section}'.")
    return section  # type: ignore[return-value]


def _find_duplicate(
    session: Session,
    *,
    section: BuilderSectionName,
    name: str,
    exclude_id: int | None = None,
) -> BuilderSectionDraft | None:
    candidates = session.exec(
        select(BuilderSectionDraft)
        .where(BuilderSectionDraft.section == section)
        .where(BuilderSectionDraft.name == name)
    ).all()
    for draft in candidates:
        if exclude_id is None or draft.id != exclude_id:
            return draft
    return None


@router.get("", response_model=BuilderDraftCollectionOut)
def list_builder_drafts(session: Session = Depends(get_session)):
    drafts = session.exec(select(BuilderSectionDraft).order_by(BuilderSectionDraft.section, BuilderSectionDraft.id)).all()
    grouped: dict[str, list[BuilderDraftOut]] = {section: [] for section in VALID_SECTIONS}
    for draft in drafts:
        grouped[draft.section].append(_to_out(draft))
    return BuilderDraftCollectionOut(**grouped)


@router.get("/{section}", response_model=list[BuilderDraftOut])
def list_builder_section_drafts(section: str, session: Session = Depends(get_session)):
    normalized_section = _require_valid_section(section)
    drafts = session.exec(
        select(BuilderSectionDraft)
        .where(BuilderSectionDraft.section == normalized_section)
        .order_by(BuilderSectionDraft.id)
    ).all()
    return [_to_out(draft) for draft in drafts]


@router.post("/{section}", response_model=BuilderDraftOut)
def create_builder_section_draft(
    section: str,
    data: BuilderDraftInput,
    session: Session = Depends(get_session),
):
    normalized_section = _require_valid_section(section)
    normalized_name = _normalize_name(data.name)
    if _find_duplicate(session, section=normalized_section, name=normalized_name):
        raise HTTPException(
            status_code=409,
            detail=f"A {normalized_section} draft named '{normalized_name}' already exists.",
        )

    timestamp = _now_iso()
    draft = BuilderSectionDraft(
        section=normalized_section,
        name=normalized_name,
        payload=_serialize_payload(data.payload),
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(draft)
    session.commit()
    session.refresh(draft)
    return _to_out(draft)


@router.put("/{section}/{draft_id}", response_model=BuilderDraftOut)
def update_builder_section_draft(
    section: str,
    draft_id: int,
    data: BuilderDraftInput,
    session: Session = Depends(get_session),
):
    normalized_section = _require_valid_section(section)
    draft = session.get(BuilderSectionDraft, draft_id)
    if not draft or draft.section != normalized_section:
        raise HTTPException(status_code=404, detail="Builder draft not found.")

    normalized_name = _normalize_name(data.name)
    if _find_duplicate(session, section=normalized_section, name=normalized_name, exclude_id=draft_id):
        raise HTTPException(
            status_code=409,
            detail=f"A {normalized_section} draft named '{normalized_name}' already exists.",
        )

    draft.name = normalized_name
    draft.payload = _serialize_payload(data.payload)
    draft.updated_at = _now_iso()
    session.add(draft)
    session.commit()
    session.refresh(draft)
    return _to_out(draft)


@router.delete("/{section}/{draft_id}", status_code=204)
def delete_builder_section_draft(
    section: str,
    draft_id: int,
    session: Session = Depends(get_session),
):
    normalized_section = _require_valid_section(section)
    draft = session.get(BuilderSectionDraft, draft_id)
    if not draft or draft.section != normalized_section:
        raise HTTPException(status_code=404, detail="Builder draft not found.")

    session.delete(draft)
    session.commit()


@router.post("/{section}/{draft_id}/publish", response_model=BuilderDraftOut)
def publish_builder_section_draft(
    section: str,
    draft_id: int,
    session: Session = Depends(get_session),
):
    normalized_section = _require_valid_section(section)
    draft = session.get(BuilderSectionDraft, draft_id)
    if not draft or draft.section != normalized_section:
        raise HTTPException(status_code=404, detail="Builder draft not found.")

    published = publish_builder_draft(session, draft)
    return _to_out(published)
