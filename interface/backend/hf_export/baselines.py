"""Reference baselines for the wcEcoli benchmark tasks — the leaderboard floor.

Deliberately simple (sklearn, no torch) so they run anywhere and set a beatable bar:
- **T1 growth** — Ridge on (genotype, condition) -> growth_rate. RMSE / R².
- **T2 viability** — LogisticRegression on (genotype, condition) -> divided. F1 / AUROC.
- **T3 forecast** — persistence (suffix = last prefix value) on cell_mass. RMSE / VRMSE.

Emits a markdown results table that drops straight into the dataset card.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from .dataset import WcEcoliShard


def _load_split(shard_dir: Path, name: str) -> list[str]:
    p = shard_dir / "splits" / f"{name}.jsonl"
    if not p.exists():
        return []
    return [json.loads(l)["h5_path"] for l in p.read_text().splitlines() if l.strip()]


def _rmse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.sqrt(np.mean((a - b) ** 2)))


def t1_growth(shard: WcEcoliShard, train, test) -> dict[str, Any]:
    from sklearn.linear_model import Ridge
    from sklearn.metrics import r2_score

    Xtr, cols = shard.tabular_features(train)
    ytr = shard.tabular_target(train, "growth_rate")
    # align test features to train columns
    Xte_full, cols_te = shard.tabular_features(test)
    Xte = np.zeros((len(test), len(cols)), dtype=np.float32)
    for j, c in enumerate(cols_te):
        if c in cols:
            Xte[:, cols.index(c)] = Xte_full[:, j]
    yte = shard.tabular_target(test, "growth_rate")
    mask_tr, mask_te = ~np.isnan(ytr), ~np.isnan(yte)
    if mask_tr.sum() < 2 or mask_te.sum() < 1:
        return {"task": "T1 growth", "note": "insufficient data"}
    model = Ridge(alpha=1.0).fit(Xtr[mask_tr], ytr[mask_tr])
    pred = model.predict(Xte[mask_te])
    return {"task": "T1 growth (Ridge)", "n_test": int(mask_te.sum()),
            "RMSE": _rmse(pred, yte[mask_te]),
            "R2": float(r2_score(yte[mask_te], pred)) if mask_te.sum() > 1 else None}


def t2_viability(shard: WcEcoliShard, train, test) -> dict[str, Any]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, f1_score, roc_auc_score

    Xtr, cols = shard.tabular_features(train)
    ytr = np.array([1 if r.get("divided") else 0 for r in train])
    Xte_full, cols_te = shard.tabular_features(test)
    Xte = np.zeros((len(test), len(cols)), dtype=np.float32)
    for j, c in enumerate(cols_te):
        if c in cols:
            Xte[:, cols.index(c)] = Xte_full[:, j]
    yte = np.array([1 if r.get("divided") else 0 for r in test])
    if len(set(ytr)) < 2 or len(test) < 1:
        return {"task": "T2 viability", "note": "only one class in train (all viable) — trivial"}
    model = LogisticRegression(max_iter=1000).fit(Xtr, ytr)
    pred = model.predict(Xte)
    out = {"task": "T2 viability (LogReg)", "n_test": len(test),
           "accuracy": float(accuracy_score(yte, pred)),
           "F1": float(f1_score(yte, pred, zero_division=0))}
    if len(set(yte)) > 1:
        out["AUROC"] = float(roc_auc_score(yte, model.predict_proba(Xte)[:, 1]))
    return out


def t3_forecast(shard: WcEcoliShard, test, channel: str = "cell_mass") -> dict[str, Any]:
    errs, trues = [], []
    n = 0
    for prefix, suffix in shard.forecast_pairs(test, channel=channel, prefix_frac=0.5):
        if suffix.size == 0:
            continue
        pred = np.full_like(suffix, prefix[-1])  # persistence
        errs.append(np.mean((pred - suffix) ** 2))
        trues.append(suffix)
        n += 1
    if not errs:
        return {"task": f"T3 forecast ({channel})", "note": "no trajectories"}
    rmse = float(np.sqrt(np.mean(errs)))
    std = float(np.std(np.concatenate(trues))) or 1.0
    return {"task": f"T3 forecast ({channel}, persistence)", "n_test": n, "RMSE": rmse, "VRMSE": rmse / std}


def run_baselines(shard_dir: str | Path) -> dict[str, Any]:
    shard_dir = Path(shard_dir)
    shard = WcEcoliShard(shard_dir)
    train = shard.rows(_load_split(shard_dir, "train")) or shard.metadata
    test = shard.rows(_load_split(shard_dir, "test")) or shard.metadata
    results = [t1_growth(shard, train, test), t2_viability(shard, train, test), t3_forecast(shard, test)]
    md = ["| Task | n_test | Metrics |", "|---|---|---|"]
    for r in results:
        metrics = ", ".join(f"{k}={v:.4g}" for k, v in r.items()
                            if k not in {"task", "n_test", "note"} and isinstance(v, (int, float)))
        md.append(f"| {r['task']} | {r.get('n_test', '—')} | {metrics or r.get('note', '')} |")
    (shard_dir / "baselines.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    return {"results": results, "table_md": "\n".join(md)}
