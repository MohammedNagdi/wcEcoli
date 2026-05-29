"""Timeline parsing, validation, and condition inference helpers."""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlmodel import Session, select

from app.db.models import Condition, MediaRecipe, Timeline, UserTimeline


@dataclass(frozen=True)
class TimelineEvent:
    time_sec: float
    media_id: str


def parse_timeline_definition(definition: str) -> list[TimelineEvent]:
    """Parse a raw wcEcoli timeline string into ordered events."""
    raw = definition.strip().strip('"').strip("'")
    if not raw:
        return []

    events: list[TimelineEvent] = []
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        bits = item.split(None, 1)
        if len(bits) != 2:
            raise ValueError(f"Invalid timeline event: {item}")
        try:
            time_sec = float(bits[0])
        except ValueError as exc:
            raise ValueError(f"Invalid timeline event time: {bits[0]}") from exc
        media_id = bits[1].strip()
        if not media_id:
            raise ValueError(f"Invalid timeline event media: {item}")
        events.append(TimelineEvent(time_sec=time_sec, media_id=media_id))

    return sorted(events, key=lambda event: event.time_sec)


def build_timeline_definition(events: list[TimelineEvent]) -> str:
    """Serialize parsed events back into the CLI timeline format."""
    parts: list[str] = []
    for event in sorted(events, key=lambda e: e.time_sec):
        time_value = int(event.time_sec) if event.time_sec.is_integer() else event.time_sec
        parts.append(f"{time_value} {event.media_id}")
    return ", ".join(parts)


def validate_timeline_definition(session: Session, definition: str) -> str:
    """Validate a raw timeline string and return its normalized form."""
    try:
        events = parse_timeline_definition(definition)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if not events:
        raise HTTPException(status_code=422, detail="Timeline must contain at least one event.")
    if events[0].time_sec != 0:
        raise HTTPException(status_code=422, detail="Timeline must start with an event at 0 seconds.")

    known_media = {
        recipe.media_id
        for recipe in session.exec(select(MediaRecipe)).all()
    }
    if not known_media:
        raise HTTPException(status_code=503, detail="Media recipes are not loaded.")

    seen_times: set[float] = set()
    for event in events:
        if event.time_sec < 0:
            raise HTTPException(status_code=422, detail="Timeline event times must be non-negative.")
        if event.time_sec in seen_times:
            raise HTTPException(status_code=422, detail="Timeline event times must be unique.")
        seen_times.add(event.time_sec)
        if event.media_id not in known_media:
            raise HTTPException(status_code=422, detail=f"Unknown media recipe: {event.media_id}")

    return build_timeline_definition(events)


def resolve_timeline_definition(session: Session, value: str) -> str:
    """Resolve a raw timeline string or a saved timeline name to raw events."""
    timeline = value.strip()
    if not timeline:
        return ""
    if " " in timeline:
        return validate_timeline_definition(session, timeline)

    predefined = session.exec(select(Timeline).where(Timeline.name == timeline)).first()
    if predefined and predefined.definition:
        return validate_timeline_definition(session, predefined.definition)

    user_timeline = session.exec(select(UserTimeline).where(UserTimeline.name == timeline)).first()
    if user_timeline and user_timeline.definition:
        return validate_timeline_definition(session, user_timeline.definition)

    return validate_timeline_definition(session, timeline)


def infer_condition_from_timeline(session: Session, definition: str, default: str = "basal") -> str:
    """Infer the initial model condition from the first timeline media recipe."""
    try:
        events = parse_timeline_definition(definition)
    except ValueError:
        return default

    if not events:
        return default

    first_media = events[0].media_id
    condition = session.exec(
        select(Condition).where(Condition.nutrients == first_media)
    ).first()
    return condition.name if condition else default
