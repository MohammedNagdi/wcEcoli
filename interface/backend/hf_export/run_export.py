"""Export completed simulations to the HF dataset layout (HDF5 trajectories + metadata.jsonl).

Run inside the api container (it has the sim output volume + readers):
    docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_v0 [--limit N]

Produces:  <out>/trajectories.h5   <out>/metadata.jsonl   <out>/manifest.json
The HDF5 + metadata are the basis for the Hugging Face upload (v0 pilot shard).
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from sqlmodel import Session, select

from app.config import settings
from app.db.engine import make_sqlite_engine
from app.db.models import Experiment, SimulationJob

from .converter import MATRIX_CHANNELS, build_record, group_path, write_matrix_channels, write_sim

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("hf_export")


def _genotype(exp: Experiment | None) -> tuple[str, str]:
    """(genotype label, ko_gene) from an experiment."""
    if exp is None or (exp.variant_type or "").lower() in {"wildtype", ""}:
        return "WT", ""
    gene = exp.gene_symbol or ""
    return (f"{gene}_KO" if gene else (exp.variant_type or "variant")), gene


def export(out_dir: Path, limit: int | None, full_tensors: bool = False) -> dict:
    import h5py
    import numpy as np
    from app.services.table_reader_bridge import SimOutReader, find_sim_outs

    out_dir.mkdir(parents=True, exist_ok=True)
    engine = make_sqlite_engine(settings.database_path)
    records: list[dict] = []
    n_jobs = n_traj = 0
    reference_ids: dict[str, list[str]] = {}  # written once under /reference
    matrix_cols: dict[str, int] = {}

    with Session(engine) as session, h5py.File(out_dir / "trajectories.h5", "w") as h5:
        jobs = session.exec(
            select(SimulationJob).where(SimulationJob.status == "done").order_by(SimulationJob.id)
        ).all()
        if limit:
            jobs = jobs[:limit]
        for job in jobs:
            exp = session.get(Experiment, job.experiment_id)
            genotype, ko_gene = _genotype(exp)
            if not job.sim_dir:
                continue
            base = settings.sim_output_dir / job.sim_dir
            try:
                sim_outs = find_sim_outs(base)
            except Exception as exc:  # noqa: BLE001
                logger.warning("job %s: cannot locate sim_outs: %s", job.id, exc)
                continue
            if not sim_outs:
                continue
            n_jobs += 1
            for generation, sim_out_path in enumerate(sim_outs):
                try:
                    reader = SimOutReader(sim_out_path)
                    channels = reader.extract_all_channels()
                    summary = reader.extract_summary()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("job %s gen %s: read failed: %s", job.id, generation, exc)
                    continue
                if not channels:
                    continue
                path = group_path(job.condition or "unknown", genotype, job.seed, generation)
                attrs = {
                    "variant_type": exp.variant_type if exp else job.variant_type,
                    "ko_gene": ko_gene, "condition": job.condition or "",
                    "seed": int(job.seed), "generation": generation, "job_id": int(job.id),
                    **{k: ("" if v is None else v) for k, v in summary.items()},
                }
                written = write_sim(h5, path, channels, attrs)
                if not written:
                    continue

                # High-dimensional per-gene/per-reaction matrices (opt-in; the dataset's real value).
                if full_tensors:
                    matrices = {}
                    for ch_name, mol_type in MATRIX_CHANNELS.items():
                        try:
                            mat = reader.extract_full_matrix(mol_type)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("job %s gen %s: matrix %s failed: %s", job.id, generation, ch_name, exc)
                            mat = None
                        if mat is not None:
                            matrices[ch_name] = mat
                    ids_by_channel = write_matrix_channels(h5, path, matrices)
                    for ch_name, ids in ids_by_channel.items():
                        reference_ids.setdefault(ch_name, ids)  # ids are model-wide; store once
                        matrix_cols[ch_name] = len(ids)
                    written = written + list(matrices.keys())

                n_traj += 1
                records.append(build_record(
                    path=path, variant_type=attrs["variant_type"], condition=job.condition or "",
                    genotype=genotype, ko_gene=ko_gene, seed=int(job.seed), generation=generation,
                    job_id=int(job.id), channels_written=written, summary=summary,
                    provenance={"experiment_id": job.experiment_id,
                                "variant_index": getattr(job, "variant_index", None)},
                ))

        # Column-id maps for the high-dim matrices, stored ONCE (model-wide, not per cell).
        if reference_ids:
            ref = h5.require_group("reference")
            str_dt = h5py.string_dtype(encoding="utf-8")
            for ch_name, ids in reference_ids.items():
                ref.create_dataset(f"{ch_name}_ids", data=np.array(ids, dtype=object), dtype=str_dt)

    (out_dir / "metadata.jsonl").write_text(
        "".join(json.dumps(r, default=str) + "\n" for r in records), encoding="utf-8")
    manifest = {
        "version": "v0", "n_jobs": n_jobs, "n_cell_trajectories": n_traj,
        "channels": sorted({c for r in records for c in r["channels"]}),
        "matrix_channels": matrix_cols,
        "conditions": sorted({r["condition"] for r in records}),
        "genotypes": sorted({r["genotype"] for r in records}),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    logger.info("Exported %s jobs / %s trajectories -> %s", n_jobs, n_traj, out_dir)
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=None, help="cap number of jobs (pilot shard)")
    ap.add_argument("--full-tensors", action="store_true",
                    help="also export per-gene mRNA/protein + per-reaction flux matrices (large)")
    args = ap.parse_args()
    print(json.dumps(export(args.out, args.limit, args.full_tensors), indent=2))


if __name__ == "__main__":
    main()
