"""Gene catalog API endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select, col, func

from app.db.models import Gene, TFEdge
from app.main import get_session

router = APIRouter(prefix="/api/genes", tags=["genes"])


class GeneOut(BaseModel):
    id: int
    ecoli_id: str
    symbol: str
    synonyms: str
    left_end_pos: Optional[int]
    right_end_pos: Optional[int]
    direction: Optional[str]
    category: str
    ko_index: int
    is_mechanistic: bool = False


class GeneDetail(GeneOut):
    rna_ids: str
    monomer_id: Optional[str] = None
    monomer_name: Optional[str] = None
    complex_ids: str = ""         # JSON array of complex IDs
    regulated_by: list[dict]     # TFs that regulate this gene
    regulates: list[dict]        # genes this gene regulates (if it's a TF)


class CategoryCount(BaseModel):
    category: str
    count: int


class GeneSearchResult(BaseModel):
    genes: list[GeneOut]
    total: int
    page: int
    page_size: int


@router.get("", response_model=GeneSearchResult)
def list_genes(
    q: Optional[str] = Query(None, description="Search by symbol or synonym"),
    category: Optional[str] = Query(None, description="Filter by functional category"),
    mechanistic: Optional[bool] = Query(None, description="Filter by mechanistic status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=5000),
    session: Session = Depends(get_session),
):
    """List genes with optional search, category, and mechanistic filter."""
    stmt = select(Gene)

    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            (col(Gene.symbol).ilike(pattern)) | (col(Gene.synonyms).ilike(pattern))
        )
    if category:
        stmt = stmt.where(Gene.category == category)
    if mechanistic is not None:
        stmt = stmt.where(Gene.is_mechanistic == mechanistic)

    # Count total
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = session.exec(count_stmt).one()

    # Paginate
    stmt = stmt.order_by(Gene.symbol).offset((page - 1) * page_size).limit(page_size)
    genes = session.exec(stmt).all()

    return GeneSearchResult(
        genes=[GeneOut.model_validate(g, from_attributes=True) for g in genes],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/categories", response_model=list[CategoryCount])
def get_categories(session: Session = Depends(get_session)):
    """Get gene counts by functional category."""
    stmt = (
        select(Gene.category, func.count(Gene.id).label("count"))
        .group_by(Gene.category)
        .order_by(func.count(Gene.id).desc())
    )
    results = session.exec(stmt).all()
    return [CategoryCount(category=r[0], count=r[1]) for r in results]


@router.get("/search", response_model=list[GeneOut])
def search_genes(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
):
    """Quick search for autocomplete — returns top matches."""
    pattern = f"%{q}%"
    stmt = (
        select(Gene)
        .where((col(Gene.symbol).ilike(pattern)) | (col(Gene.synonyms).ilike(pattern)))
        .order_by(
            # Exact match first, then prefix, then contains
            col(Gene.symbol).ilike(q).desc(),
            col(Gene.symbol).ilike(f"{q}%").desc(),
            Gene.symbol,
        )
        .limit(limit)
    )
    genes = session.exec(stmt).all()
    return [GeneOut.model_validate(g, from_attributes=True) for g in genes]


@router.get("/by-ko-index/{ko_index}", response_model=GeneOut)
def get_gene_by_ko_index(ko_index: int, session: Session = Depends(get_session)):
    """Look up a gene by its knockout index (variant_index → gene)."""
    gene = session.exec(select(Gene).where(Gene.ko_index == ko_index)).first()
    if not gene:
        raise HTTPException(status_code=404, detail=f"No gene with ko_index={ko_index}")
    return GeneOut.model_validate(gene, from_attributes=True)


@router.get("/neighbors", response_model=list[GeneOut])
def get_gene_neighbors(
    symbol: str = Query(..., description="Gene symbol to center on"),
    window: int = Query(5000, ge=1000, le=50000, description="Window size in bp on each side"),
    session: Session = Depends(get_session),
):
    """Return genes near the requested gene on the chromosome."""
    gene = session.exec(select(Gene).where(Gene.symbol == symbol)).first()
    if not gene:
        gene = session.exec(select(Gene).where(col(Gene.symbol).ilike(symbol))).first()
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{symbol}' not found")
    if gene.left_end_pos is None or gene.right_end_pos is None:
        return []

    center = (gene.left_end_pos + gene.right_end_pos) // 2
    start = center - window
    end = center + window
    neighbors = session.exec(
        select(Gene)
        .where(col(Gene.left_end_pos).is_not(None))
        .where(col(Gene.right_end_pos).is_not(None))
        .where(Gene.right_end_pos >= start)
        .where(Gene.left_end_pos <= end)
        .order_by(Gene.left_end_pos)
    ).all()

    return [GeneOut.model_validate(g, from_attributes=True) for g in neighbors]


@router.get("/{symbol}", response_model=GeneDetail)
def get_gene(symbol: str, session: Session = Depends(get_session)):
    """Get full gene detail including regulatory edges."""
    gene = session.exec(select(Gene).where(Gene.symbol == symbol)).first()
    if not gene:
        # Try case-insensitive
        gene = session.exec(
            select(Gene).where(col(Gene.symbol).ilike(symbol))
        ).first()
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{symbol}' not found")

    # Get TFs that regulate this gene
    regulated_by = session.exec(
        select(TFEdge).where(TFEdge.target_symbol == gene.symbol)
    ).all()

    # Get genes this gene regulates (if it's a TF)
    regulates = session.exec(
        select(TFEdge).where(TFEdge.tf_symbol == gene.symbol)
    ).all()

    return GeneDetail(
        **{k: v for k, v in gene.__dict__.items() if not k.startswith("_")},
        regulated_by=[
            {"tf": e.tf_symbol, "log2fc": e.log2fc_mean, "type": e.regulation_direct}
            for e in regulated_by
        ],
        regulates=[
            {"target": e.target_symbol, "log2fc": e.log2fc_mean, "type": e.regulation_direct}
            for e in regulates
        ],
    )
