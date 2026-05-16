"""Pathway and TF network API endpoints."""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db.models import AAPathway, TFEdge, Condition, Timeline, Variant
from app.main import get_session

router = APIRouter(prefix="/api", tags=["pathways"])


# --- TF Network ---

class TFNode(BaseModel):
    symbol: str
    target_count: int
    targets: list[dict]


class TFNetworkOut(BaseModel):
    tfs: list[TFNode]
    total_edges: int


@router.get("/tf-network", response_model=TFNetworkOut)
def get_tf_network(session: Session = Depends(get_session)):
    """Get the full TF → target regulatory network."""
    edges = session.exec(select(TFEdge)).all()

    # Group by TF
    tf_map: dict[str, list[dict]] = {}
    for e in edges:
        tf_map.setdefault(e.tf_symbol, []).append({
            "target": e.target_symbol,
            "log2fc": e.log2fc_mean,
            "type": e.regulation_direct,
        })

    tfs = [
        TFNode(symbol=tf, target_count=len(targets), targets=targets)
        for tf, targets in sorted(tf_map.items(), key=lambda x: -len(x[1]))
    ]

    return TFNetworkOut(tfs=tfs, total_edges=len(edges))


@router.get("/tf-network/{tf_symbol}", response_model=TFNode)
def get_tf_subnetwork(tf_symbol: str, session: Session = Depends(get_session)):
    """Get all targets for a specific TF."""
    from fastapi import HTTPException
    edges = session.exec(
        select(TFEdge).where(TFEdge.tf_symbol == tf_symbol)
    ).all()
    if not edges:
        raise HTTPException(404, f"TF '{tf_symbol}' not found")
    return TFNode(
        symbol=tf_symbol,
        target_count=len(edges),
        targets=[
            {"target": e.target_symbol, "log2fc": e.log2fc_mean, "type": e.regulation_direct}
            for e in edges
        ],
    )


# --- Amino acid pathways ---

class AAPathwayOut(BaseModel):
    amino_acid: str
    enzymes: str
    reverse_enzymes: str
    kcat: float | None
    ki_lower: float | None
    ki_upper: float | None
    upstream_aas: str
    downstream_aas: str
    notes: str


@router.get("/pathways/amino-acids", response_model=list[AAPathwayOut])
def list_aa_pathways(session: Session = Depends(get_session)):
    """List all amino acid biosynthesis pathways with kinetic parameters."""
    pathways = session.exec(select(AAPathway).order_by(AAPathway.amino_acid)).all()
    return [AAPathwayOut.model_validate(p, from_attributes=True) for p in pathways]


# --- Conditions ---

class ConditionOut(BaseModel):
    name: str
    nutrients: str
    doubling_time: float | None


@router.get("/conditions", response_model=list[ConditionOut])
def list_conditions(session: Session = Depends(get_session)):
    """List all growth conditions."""
    conditions = session.exec(select(Condition).order_by(Condition.name)).all()
    return [ConditionOut.model_validate(c, from_attributes=True) for c in conditions]


# --- Timelines ---

class TimelineOut(BaseModel):
    name: str
    definition: str


@router.get("/timelines", response_model=list[TimelineOut])
def list_timelines(session: Session = Depends(get_session)):
    """List all timeline experiments."""
    timelines = session.exec(select(Timeline).order_by(Timeline.name)).all()
    return [TimelineOut.model_validate(t, from_attributes=True) for t in timelines]


# --- Variants ---

class VariantOut(BaseModel):
    name: str
    docstring: str
    filename: str


@router.get("/variants", response_model=list[VariantOut])
def list_variants(session: Session = Depends(get_session)):
    """List all simulation variant types."""
    variants = session.exec(select(Variant).order_by(Variant.name)).all()
    return [VariantOut.model_validate(v, from_attributes=True) for v in variants]
