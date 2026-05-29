"""User timelines router — exposes /api/user-timelines (GET + POST)."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.models import UserTimeline
from app.main import get_session
from app.services.timelines import validate_timeline_definition

router = APIRouter(prefix="/api/user-timelines", tags=["user-timelines"])


class UserTimelineCreate(BaseModel):
    name: str
    definition: str


@router.get("", response_model=list[UserTimeline])
def list_user_timelines(session: Session = Depends(get_session)):
    """Return all user-saved timelines ordered by id."""
    return session.exec(select(UserTimeline).order_by(UserTimeline.id)).all()


@router.post("", response_model=UserTimeline)
def create_user_timeline(
    data: UserTimelineCreate,
    session: Session = Depends(get_session),
):
    """Save a new named timeline. Returns 409 if the name already exists."""
    name = data.name.strip()
    definition = data.definition.strip()

    if not name:
        raise HTTPException(status_code=422, detail="Name must not be empty.")
    definition = validate_timeline_definition(session, definition)

    existing = session.exec(
        select(UserTimeline).where(UserTimeline.name == name)
    ).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"A timeline named '{name}' already exists.",
        )

    tl = UserTimeline(
        name=name,
        definition=definition,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    session.add(tl)
    session.commit()
    session.refresh(tl)
    return tl
