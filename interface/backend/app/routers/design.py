"""Read-only mechanistic gene knockout evidence endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from app.main import get_session
from app.services.design_evidence import (
    DesignEvidenceCatalog,
    DesignOverview,
    EssentialityStats,
    GeneEvidence,
    GeneKOSummary as GeneKOSummary,
)

router = APIRouter(prefix="/api/design", tags=["design"])


@router.get("/overview", response_model=DesignOverview)
def get_design_overview(
    category: Optional[str] = Query(None),
    phenotype: Optional[str] = Query(None),
    condition: str = Query("basal"),
    session: Session = Depends(get_session),
):
    return DesignEvidenceCatalog(session, condition).overview(category, phenotype)


@router.get("/essentiality", response_model=list[EssentialityStats])
def get_essentiality_by_category(
    condition: str = Query("basal"), session: Session = Depends(get_session)
):
    return DesignEvidenceCatalog(session, condition).category_stats()


@router.get("/genes/{symbol}", response_model=GeneEvidence)
def get_gene_evidence(
    symbol: str,
    condition: str = Query("basal"),
    experiment_id: Optional[int] = Query(None),
    session: Session = Depends(get_session),
):
    return DesignEvidenceCatalog(session, condition).detail(symbol, experiment_id)
