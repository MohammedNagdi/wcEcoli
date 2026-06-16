"""M2 packaging: splits, dataloader, baselines, card, croissant — on a tiny synthetic shard."""

import json

import numpy as np

from hf_export.card import build_croissant, build_dataset_card
from hf_export.dataset import WcEcoliShard
from hf_export.splits import build_splits, write_splits


def _make_shard(tmp_path):
    import h5py

    # 6 trajectories: WT across 3 conditions (basal, glc, acetate) + a dnaA KO, ×2 seeds-ish.
    rows = []
    specs = [
        ("basal", "WT", "", 0, 0.020, True), ("basal", "WT", "", 1, 0.021, True),
        ("glc", "WT", "", 0, 0.030, True), ("acetate", "WT", "", 0, 0.010, True),
        ("basal", "dnaA_KO", "dnaA", 0, 0.005, False), ("glc", "dnaA_KO", "dnaA", 0, 0.006, False),
    ]
    with h5py.File(tmp_path / "trajectories.h5", "w") as h5:
        for cond, geno, ko, seed, gr, divided in specs:
            path = f"cond={cond}/geno={geno}/seed={seed}/gen=0"
            grp = h5.require_group(path)
            t = np.linspace(0, 3600, 20, dtype=np.float32)
            for ch, vals in {"cell_mass": 300 * (1 + gr * t / 60), "growth_rate": np.full_like(t, gr)}.items():
                sub = grp.require_group(ch)
                sub.create_dataset("time", data=t)
                sub.create_dataset("value", data=vals.astype(np.float32))
            rows.append({"h5_path": path, "genotype": geno, "ko_gene": ko, "condition": cond,
                         "seed": seed, "generation": 0, "growth_rate": gr, "divided": divided,
                         "channels": ["cell_mass", "growth_rate"]})
    (tmp_path / "metadata.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (tmp_path / "manifest.json").write_text(json.dumps({
        "version": "v0", "n_jobs": 6, "n_cell_trajectories": 6,
        "channels": ["cell_mass", "growth_rate"], "matrix_channels": {},
        "conditions": ["acetate", "basal", "glc"], "genotypes": ["WT", "dnaA_KO"],
    }))
    return tmp_path


def test_splits_hold_out_condition_and_gene(tmp_path):
    shard = _make_shard(tmp_path)
    meta = [json.loads(l) for l in (shard / "metadata.jsonl").read_text().splitlines()]
    splits = build_splits(meta, test_conditions={"acetate"}, test_gene_frac=0.0, val_seed=1)
    test_conds = {r["condition"] for r in meta if r["h5_path"] in set(splits["test"])}
    assert "acetate" in test_conds                 # held-out condition lands in test
    assert all("acetate" not in p for p in splits["train"])  # and never in train
    assert len(splits["val"]) >= 1                 # seed==1 -> val


def test_dataloader_features_and_forecast(tmp_path):
    shard = WcEcoliShard(_make_shard(tmp_path))
    rows = shard.rows()
    X, cols = shard.tabular_features(rows)
    assert X.shape == (6, len(cols)) and X.sum() == 12       # 2 one-hots per row
    y = shard.tabular_target(rows, "growth_rate")
    assert y.shape == (6,) and y.min() > 0
    pairs = list(shard.forecast_pairs(rows, "cell_mass", 0.5))
    assert len(pairs) == 6 and all(p[0].size and p[1].size for p in pairs)


def test_baselines_and_card(tmp_path):
    from hf_export.baselines import run_baselines

    shard_dir = _make_shard(tmp_path)
    write_splits(shard_dir, test_conditions={"acetate"}, test_gene_frac=0.0, val_seed=1)
    out = run_baselines(shard_dir)
    assert (shard_dir / "baselines.md").exists()
    tasks = {r["task"].split()[0] for r in out["results"]}
    assert tasks == {"T1", "T2", "T3"}

    manifest = json.loads((shard_dir / "manifest.json").read_text())
    card = build_dataset_card(manifest, {"train": 4, "val": 1, "test": 1}, out["table_md"])
    assert card.startswith("---") and "license: cc-by-4.0" in card and "wcEcoli Cell Dataset" in card
    cr = build_croissant(manifest)
    assert cr["@type"] == "Dataset" and any(f["@id"] == "growth_rate" for f in cr["recordSet"][0]["field"])
