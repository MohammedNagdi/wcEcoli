"""Machine Learning API — train surrogate models on simulation features."""

import json
import logging
import math
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app.db.models import Experiment, Gene, SimulationJob, SimulationResult
from app.main import get_session

router = APIRouter(prefix="/api/ml", tags=["ml"])
logger = logging.getLogger(__name__)


# ── Request / response models ────────────────────────────────────────────

class TrainRequest(BaseModel):
    """Model training configuration."""
    algorithm: str = "random_forest"  # random_forest, gradient_boosting, logistic_regression
    target: str = "divided"  # divided, growth_rate, doubling_time_min
    condition: str = ""  # filter: empty = all
    variant_type: str = ""  # filter: empty = all
    mechanistic_only: bool = True
    test_fraction: float = 0.2
    # Algorithm-specific hyperparameters
    n_estimators: int = 100
    max_depth: Optional[int] = None
    random_state: int = 42


class ConfusionMatrix(BaseModel):
    tp: int
    fp: int
    tn: int
    fn: int


class FeatureImportance(BaseModel):
    feature: str
    importance: float
    gene_symbol: str = ""
    category: str = ""


class ClassificationMetrics(BaseModel):
    accuracy: float
    precision: float
    recall: float
    f1: float
    auc_roc: Optional[float]
    confusion: ConfusionMatrix


class RegressionMetrics(BaseModel):
    r2: float
    rmse: float
    mae: float
    mape: Optional[float]


class TrainResponse(BaseModel):
    """Model training results."""
    model_id: str
    algorithm: str
    target: str
    task_type: str  # classification or regression
    n_samples: int
    n_train: int
    n_test: int
    n_features: int
    training_time_sec: float
    classification: Optional[ClassificationMetrics] = None
    regression: Optional[RegressionMetrics] = None
    feature_importances: list[FeatureImportance]
    cross_val_scores: list[float] = []
    cross_val_mean: Optional[float] = None
    cross_val_std: Optional[float] = None


class ModelSummary(BaseModel):
    model_id: str
    algorithm: str
    target: str
    task_type: str
    n_samples: int
    accuracy: Optional[float] = None
    r2: Optional[float] = None
    created_at: str


class DataSummary(BaseModel):
    """Quick summary of available ML data."""
    total_experiments: int
    total_completed_jobs: int
    total_genes: int
    mechanistic_genes: int
    divided_count: int
    not_divided_count: int
    conditions: list[str]
    variant_types: list[str]


# ── In-memory model store ────────────────────────────────────────────────

_trained_models: dict[str, dict] = {}


# ── Helper: extract features ─────────────────────────────────────────────

def _extract_feature_matrix(
    session: Session,
    condition: str = "",
    variant_type: str = "",
    mechanistic_only: bool = True,
):
    """Extract feature matrix as lists, ready for sklearn."""

    stmt = (
        select(SimulationJob, Experiment)
        .join(Experiment, SimulationJob.experiment_id == Experiment.id)
        .where(SimulationJob.status == "done")
    )
    if condition:
        stmt = stmt.where(Experiment.condition == condition)
    if variant_type:
        stmt = stmt.where(Experiment.variant_type == variant_type)

    job_exp_pairs = session.exec(stmt).all()

    gene_cache: dict[str, Gene] = {}
    all_genes = session.exec(select(Gene)).all()
    for g in all_genes:
        gene_cache[g.symbol.lower()] = g

    rows = []
    for job, experiment in job_exp_pairs:
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .order_by(SimulationResult.generation)
            .limit(1)
        ).first()
        if not result:
            continue

        gene = gene_cache.get(experiment.gene_symbol.lower()) if experiment.gene_symbol else None
        if mechanistic_only and (not gene or not gene.is_mechanistic):
            continue

        rows.append({
            "experiment_id": experiment.id,
            "gene_symbol": experiment.gene_symbol or "",
            "ko_index": gene.ko_index if gene else experiment.variant_index,
            "category": gene.category if gene else "",
            "is_mechanistic": gene.is_mechanistic if gene else False,
            "variant_type": experiment.variant_type,
            "variant_index": experiment.variant_index,
            "condition": experiment.condition,
            "seed": job.seed,
            "divided": result.division_time_sec is not None,
            "division_time_sec": result.division_time_sec,
            "final_mass_fg": result.final_mass_fg,
            "growth_rate": result.growth_rate,
            "doubling_time_min": result.doubling_time_min,
        })

    return rows


# ── GET /api/ml/data-summary ─────────────────────────────────────────────

@router.get("/data-summary", response_model=DataSummary)
def get_data_summary(session: Session = Depends(get_session)):
    """Get a quick summary of available data for ML training."""

    total_exp = session.exec(select(Experiment)).all()
    total_jobs = session.exec(
        select(SimulationJob).where(SimulationJob.status == "done")
    ).all()

    genes = session.exec(select(Gene)).all()
    mechanistic = [g for g in genes if g.is_mechanistic]

    # Get conditions and variant types from completed experiments
    conditions = set()
    variant_types = set()
    exp_ids_with_jobs = set(j.experiment_id for j in total_jobs)
    for e in total_exp:
        if e.id in exp_ids_with_jobs:
            conditions.add(e.condition)
            variant_types.add(e.variant_type)

    # Count divided vs not divided
    divided = 0
    not_divided = 0
    for job in total_jobs:
        result = session.exec(
            select(SimulationResult)
            .where(SimulationResult.job_id == job.id)
            .limit(1)
        ).first()
        if result:
            if result.division_time_sec is not None:
                divided += 1
            else:
                not_divided += 1

    return DataSummary(
        total_experiments=len(total_exp),
        total_completed_jobs=len(total_jobs),
        total_genes=len(genes),
        mechanistic_genes=len(mechanistic),
        divided_count=divided,
        not_divided_count=not_divided,
        conditions=sorted(conditions),
        variant_types=sorted(variant_types),
    )


# ── POST /api/ml/train ──────────────────────────────────────────────────

@router.post("/train", response_model=TrainResponse)
def train_model(body: TrainRequest, session: Session = Depends(get_session)):
    """Train a surrogate model on the simulation feature matrix.

    Supports:
    - Classification: predict whether a gene knockout cell divides (target=divided)
    - Regression: predict growth_rate, doubling_time_min, etc.
    """
    try:
        import numpy as np
        from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
        from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
        from sklearn.linear_model import LogisticRegression, Ridge
        from sklearn.metrics import (
            accuracy_score, precision_score, recall_score, f1_score,
            roc_auc_score, confusion_matrix,
            r2_score, mean_squared_error, mean_absolute_error,
        )
        from sklearn.model_selection import cross_val_score, train_test_split
        from sklearn.preprocessing import LabelEncoder
    except ImportError:
        raise HTTPException(
            500,
            "scikit-learn not installed. Run: pip install scikit-learn numpy",
        )

    # Extract data
    rows = _extract_feature_matrix(
        session,
        condition=body.condition,
        variant_type=body.variant_type,
        mechanistic_only=body.mechanistic_only,
    )

    if len(rows) < 10:
        raise HTTPException(
            400,
            f"Not enough data: {len(rows)} samples (need at least 10). "
            "Run more simulations or relax filters.",
        )

    # Build feature matrix
    # Encode categorical features
    categories = sorted(set(r["category"] for r in rows))
    cat_encoder = {c: i for i, c in enumerate(categories)}

    conditions = sorted(set(r["condition"] for r in rows))
    cond_encoder = {c: i for i, c in enumerate(conditions)}

    X = []
    y = []
    gene_symbols = []
    gene_categories = []

    is_classification = body.target == "divided"

    for r in rows:
        features = [
            r["ko_index"],
            cat_encoder.get(r["category"], 0),
            1 if r["is_mechanistic"] else 0,
            r["variant_index"],
            cond_encoder.get(r["condition"], 0),
        ]
        X.append(features)

        if is_classification:
            y.append(1 if r["divided"] else 0)
        else:
            val = r.get(body.target)
            if val is None:
                val = 0.0
            y.append(val)

        gene_symbols.append(r["gene_symbol"])
        gene_categories.append(r["category"])

    X = np.array(X, dtype=float)
    y = np.array(y, dtype=float)

    feature_names = ["ko_index", "category_encoded", "is_mechanistic", "variant_index", "condition_encoded"]

    # Train/test split
    test_size = max(0.1, min(0.5, body.test_fraction))
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=body.random_state, stratify=y if is_classification else None,
    )

    # Select algorithm
    algo_map_clf = {
        "random_forest": lambda: RandomForestClassifier(
            n_estimators=body.n_estimators, max_depth=body.max_depth,
            random_state=body.random_state, n_jobs=-1,
        ),
        "gradient_boosting": lambda: GradientBoostingClassifier(
            n_estimators=body.n_estimators, max_depth=body.max_depth or 3,
            random_state=body.random_state,
        ),
        "logistic_regression": lambda: LogisticRegression(
            max_iter=1000, random_state=body.random_state,
        ),
    }

    algo_map_reg = {
        "random_forest": lambda: RandomForestRegressor(
            n_estimators=body.n_estimators, max_depth=body.max_depth,
            random_state=body.random_state, n_jobs=-1,
        ),
        "gradient_boosting": lambda: GradientBoostingRegressor(
            n_estimators=body.n_estimators, max_depth=body.max_depth or 3,
            random_state=body.random_state,
        ),
        "logistic_regression": lambda: Ridge(alpha=1.0),  # fallback for regression
    }

    if is_classification:
        factory = algo_map_clf.get(body.algorithm)
    else:
        factory = algo_map_reg.get(body.algorithm)

    if not factory:
        raise HTTPException(400, f"Unknown algorithm: {body.algorithm}")

    # Train
    t0 = time.time()
    model = factory()
    model.fit(X_train, y_train)
    training_time = time.time() - t0

    y_pred = model.predict(X_test)

    # Metrics
    classification_metrics = None
    regression_metrics = None

    if is_classification:
        y_pred_int = y_pred.astype(int)
        y_test_int = y_test.astype(int)
        cm = confusion_matrix(y_test_int, y_pred_int, labels=[0, 1])
        tn, fp, fn, tp = cm.ravel() if cm.size == 4 else (0, 0, 0, 0)

        try:
            if hasattr(model, "predict_proba"):
                y_proba = model.predict_proba(X_test)[:, 1]
                auc = float(roc_auc_score(y_test_int, y_proba))
            else:
                auc = None
        except Exception:
            auc = None

        classification_metrics = ClassificationMetrics(
            accuracy=float(accuracy_score(y_test_int, y_pred_int)),
            precision=float(precision_score(y_test_int, y_pred_int, zero_division=0)),
            recall=float(recall_score(y_test_int, y_pred_int, zero_division=0)),
            f1=float(f1_score(y_test_int, y_pred_int, zero_division=0)),
            auc_roc=auc,
            confusion=ConfusionMatrix(tp=int(tp), fp=int(fp), tn=int(tn), fn=int(fn)),
        )
    else:
        r2 = float(r2_score(y_test, y_pred))
        rmse = float(np.sqrt(mean_squared_error(y_test, y_pred)))
        mae = float(mean_absolute_error(y_test, y_pred))
        mask = y_test != 0
        mape = float(np.mean(np.abs((y_test[mask] - y_pred[mask]) / y_test[mask])) * 100) if mask.any() else None
        regression_metrics = RegressionMetrics(r2=r2, rmse=rmse, mae=mae, mape=mape)

    # Feature importances
    importances = []
    if hasattr(model, "feature_importances_"):
        fi = model.feature_importances_
        for i, name in enumerate(feature_names):
            importances.append(FeatureImportance(
                feature=name,
                importance=float(fi[i]),
            ))
    elif hasattr(model, "coef_"):
        coef = model.coef_.flatten() if model.coef_.ndim > 1 else model.coef_
        for i, name in enumerate(feature_names):
            importances.append(FeatureImportance(
                feature=name,
                importance=float(abs(coef[i])),
            ))
    importances.sort(key=lambda x: x.importance, reverse=True)

    # Cross-validation
    scoring = "accuracy" if is_classification else "r2"
    n_cv = min(5, len(X) // 2)
    cv_scores = []
    cv_mean = None
    cv_std = None
    if n_cv >= 2:
        try:
            scores = cross_val_score(factory(), X, y, cv=n_cv, scoring=scoring)
            cv_scores = [float(s) for s in scores]
            cv_mean = float(np.mean(scores))
            cv_std = float(np.std(scores))
        except Exception as e:
            logger.warning("Cross-validation failed: %s", e)

    # Store model
    model_id = f"{body.algorithm}_{body.target}_{int(time.time())}"
    _trained_models[model_id] = {
        "model": model,
        "feature_names": feature_names,
        "cat_encoder": cat_encoder,
        "cond_encoder": cond_encoder,
        "target": body.target,
        "task_type": "classification" if is_classification else "regression",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    return TrainResponse(
        model_id=model_id,
        algorithm=body.algorithm,
        target=body.target,
        task_type="classification" if is_classification else "regression",
        n_samples=len(X),
        n_train=len(X_train),
        n_test=len(X_test),
        n_features=len(feature_names),
        training_time_sec=round(training_time, 3),
        classification=classification_metrics,
        regression=regression_metrics,
        feature_importances=importances,
        cross_val_scores=cv_scores,
        cross_val_mean=cv_mean,
        cross_val_std=cv_std,
    )


# ── GET /api/ml/models ──────────────────────────────────────────────────

@router.get("/models", response_model=list[ModelSummary])
def list_models():
    """List all trained models in the current session."""
    summaries = []
    for model_id, info in _trained_models.items():
        summaries.append(ModelSummary(
            model_id=model_id,
            algorithm=model_id.split("_")[0] + ("_" + model_id.split("_")[1] if len(model_id.split("_")) > 2 else ""),
            target=info["target"],
            task_type=info["task_type"],
            n_samples=0,  # not stored, just for summary
            created_at=info["created_at"],
        ))
    return summaries
