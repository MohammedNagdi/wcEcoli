"""Media recipes router — exposes /api/media-recipes."""

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.db.models import MediaRecipe
from app.main import get_session

router = APIRouter(prefix="/api/media-recipes", tags=["media-recipes"])


@router.get("", response_model=list[MediaRecipe])
def list_media_recipes(session: Session = Depends(get_session)):
    """Return all media recipes ordered by insertion order (id)."""
    return session.exec(select(MediaRecipe).order_by(MediaRecipe.id)).all()
