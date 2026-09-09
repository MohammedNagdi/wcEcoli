"""Task-side result ingestion. Runs inside the SLURM array task, never on the controller.

Ingestion is not a cheap status check: ``_collect_results`` instantiates a ``SimOutReader``
per generation, extracts summaries, and writes a Parquet export for each. Doing that on the
controller would serialize every completed job through one core and make the reconciler
slower than the cluster. Running it here parallelizes it across the allocation for free.

This module deliberately performs **no database access**. The controller is the only writer
(see ``slurm_campaign``), and hundreds of concurrent SQLite readers over GPFS is exactly the
failure mode that discipline exists to avoid. Everything ``_collect_results`` needs arrives
in the manifest line: it reads only ``job.sim_dir``, ``job.generations``, ``job.seed``,
``job.id`` and ``job.experiment_id``, and ignores its ``experiment`` argument entirely.

Invoked by cluster/task.sbatch as:
    python -m app.services.slurm_ingest prelude --manifest <path> --index <n>
    python -m app.services.slurm_ingest ingest  --manifest <path> --index <n> --returncode <rc>

``prelude`` emits a sourceable shell fragment so the task script never has to parse JSON in
bash; ``ingest`` runs the real result extraction and writes the sentinel.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import sys
import traceback
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path

SENTINEL_VERSION = 1

# Measured on klone: one 4-generation job produces ~2.8 GB across ~1259 files, dominated by
# the per-molecule matrix listeners (RnaSynthProb ~339 MB/gen, RibosomeData ~166 MB/gen).
# At that rate the full 56k-job matrix would need ~157 TB and ~70M inodes -- several times
# the entire /gscratch/amath allocation. Pruning converts each generation to a compressed
# HDF5 and deletes the raw simOut tree, trading `--full-tensors` for feasibility.
#
# OFF by default: it is irreversible, and run_export() reads raw simOut today.
PRUNE_SIMOUT = os.environ.get("WCECOLI_PRUNE_SIMOUT", "0") == "1"
PRUNE_KEEP_TENSORS = os.environ.get("WCECOLI_PRUNE_KEEP_TENSORS", "0") == "1"


@dataclass
class ManifestJob:
    """The subset of SimulationJob that ``_collect_results`` actually reads."""

    id: int
    experiment_id: int
    sim_dir: str
    seed: int
    generations: int


def read_manifest_line(manifest: Path, index: int) -> dict:
    with manifest.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream):
            if line_number == index:
                return json.loads(line)
    raise IndexError("manifest {} has no index {}".format(manifest, index))


def sentinel_path(manifest: Path, index: int) -> Path:
    return manifest.parent / (manifest.stem + ".sentinels") / "{}.json".format(index)


def write_sentinel(path: Path, payload: dict):
    """Write a sentinel atomically so a reconciler never reads a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".{}.tmp".format(uuid.uuid4().hex))
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n")
    temporary.replace(path)


PRUNED_H5_NAME = "channels.h5"
PRUNED_MARKER = "pruned.json"


def convert_and_prune(sim_dir: str, log) -> dict:
    """Write a per-generation HDF5 next to the run, then delete the raw simOut tree.

    ``log`` is appended to in place (a deque or list), so pass the caller's own buffer --
    a copy silently discards the summary line.

    Returns a summary of what was converted and reclaimed. Raises on any failure: the
    caller must never delete simOut when conversion did not demonstrably succeed.
    """
    import h5py
    from app.config import settings
    from app.services.table_reader_bridge import (
        SimOutReader, find_sim_outs, parse_sim_out_path,
    )
    from hf_export.converter import MATRIX_CHANNELS, write_matrix_channels, write_sim

    base = settings.sim_output_dir / sim_dir
    sim_outs = find_sim_outs(base)
    if not sim_outs:
        raise RuntimeError("no simOut directories to convert")

    export_dir = base / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    h5_path = export_dir / "channels.h5"
    temporary = h5_path.with_suffix(".{}.tmp".format(uuid.uuid4().hex))

    converted = 0
    with h5py.File(temporary, "w") as h5:
        h5.attrs["sim_dir"] = sim_dir
        h5.attrs["keeps_tensors"] = bool(PRUNE_KEEP_TENSORS)
        for sim_out_path in sim_outs:
            info = parse_sim_out_path(sim_out_path)
            reader = SimOutReader(sim_out_path)
            group = "seed{}/gen{}".format(info.get("seed", 0), info.get("generation", 0))
            # The summary must travel with the channels: once simOut is gone it cannot be
            # recomputed, and run_export needs it for both the HDF5 attrs and metadata.jsonl.
            summary = reader.extract_summary()
            attrs = {
                "seed": int(info.get("seed", 0)),
                "generation": int(info.get("generation", 0)),
                "sim_dir": sim_dir,
                "variant_dir": str(info.get("variant_dir", "")),
            }
            attrs.update({k: ("" if v is None else v) for k, v in summary.items()})
            write_sim(h5, group, reader.extract_all_channels(), attrs)
            # Record which summary keys came from the reader so the exporter can separate
            # them from the structural attrs without hardcoding a list.
            h5[group].attrs["summary_keys"] = ",".join(sorted(summary))
            if PRUNE_KEEP_TENSORS:
                # The same per-gene/per-reaction tensors run_export writes for --full-tensors.
                # Without these the pruned dataset keeps only the V0 scalar channels.
                matrices = {}
                for channel_name, molecule_type in MATRIX_CHANNELS.items():
                    matrix = reader.extract_full_matrix(molecule_type)
                    if matrix is not None:
                        matrices[channel_name] = matrix
                ids_by_channel = write_matrix_channels(h5, group + "/matrices", matrices)
                # write_matrix_channels only returns the column ids; persist them, or the
                # exporter cannot rebuild the /reference id maps after simOut is deleted.
                #
                # As datasets, not attributes: these lists run to thousands of gene and
                # reaction ids and blow HDF5's 64 KB object-header limit as attributes.
                # They are model-wide, so one copy per file under /reference is enough.
                for channel_name, ids in ids_by_channel.items():
                    reference = "reference/" + channel_name
                    if reference not in h5:
                        h5.create_dataset(
                            reference,
                            data=[str(i) for i in ids],
                            dtype=h5py.string_dtype(),
                            compression="gzip",
                            compression_opts=4,
                        )
            converted += 1
    temporary.replace(h5_path)

    if converted != len(sim_outs):
        raise RuntimeError("converted {} of {} generations".format(converted, len(sim_outs)))

    reclaimed_files = 0
    for sim_out_path in sim_outs:
        reclaimed_files += sum(1 for _ in sim_out_path.rglob("*"))
        shutil.rmtree(sim_out_path)
    # A marker so run_export (and a human) can tell "pruned" from "never ran".
    (export_dir / PRUNED_MARKER).write_text(json.dumps({
        "pruned_at": __import__("datetime").datetime.now().astimezone().isoformat(),
        "generations": converted,
        "keeps_tensors": bool(PRUNE_KEEP_TENSORS),
        "reclaimed_files": reclaimed_files,
    }, indent=2) + "\n")
    log.append("Pruned {} simOut tree(s), reclaimed ~{} files".format(len(sim_outs), reclaimed_files))
    return {
        "generations": converted,
        "h5": str(h5_path),
        "h5_bytes": h5_path.stat().st_size,
        "reclaimed_files": reclaimed_files,
    }


def _consume_sim_log(log) -> None:
    """Append the tail of the simulation's own output to ``log``, then delete the file.

    cluster/task.sbatch tees the run to $WCE_SIM_LOG. It is the only route by which a
    traceback reaches the database: the SLURM .out path is not knowable from inside the
    task, and log_tail is what `wce status` and the failure triage read. The file is
    removed once read -- the .out file is the archive, this is only the handoff -- so a
    ~1 MB-per-run log does not accumulate across a 63k-job matrix.
    """
    path = os.environ.get("WCE_SIM_LOG", "")
    if not path or not Path(path).is_file():
        return
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
        # ``log`` is a bounded deque; extending it keeps only the last maxlen lines.
        log.extend(lines)
    except OSError as exc:
        log.append("Could not read sim log {}: {}".format(path, exc))
        return
    try:
        Path(path).unlink()
    except OSError:
        pass


def _result_to_dict(result) -> dict:
    return {
        "job_id": result.job_id,
        "experiment_id": result.experiment_id,
        "seed": result.seed,
        "generation": result.generation,
        "division_time_sec": result.division_time_sec,
        "final_mass_fg": result.final_mass_fg,
        "growth_rate": result.growth_rate,
        "doubling_time_min": result.doubling_time_min,
        "divided": result.divided,
        "created_at": result.created_at,
    }


def ingest(manifest: Path, index: int, returncode: int) -> dict:
    entry = read_manifest_line(manifest, index)
    log_buffer: deque[str] = deque(maxlen=int(os.environ.get("LOG_TAIL_LINES", "200")))
    payload = {
        "version": SENTINEL_VERSION,
        "job_id": entry["job_id"],
        "attempt": entry["attempt"],
        "index": index,
        "slurm_task_id": "{}_{}".format(
            os.environ.get("SLURM_ARRAY_JOB_ID", ""), os.environ.get("SLURM_ARRAY_TASK_ID", "")
        ),
        "node": os.environ.get("SLURMD_NODENAME", ""),
        "returncode": returncode,
    }

    if returncode != 0:
        payload["status"] = "failed"
        payload["error"] = "Simulation failed with exit code {}".format(returncode)
        payload["results"] = []
        _consume_sim_log(log_buffer)
        payload["log_tail"] = "\n".join(log_buffer)
        return payload

    job = ManifestJob(
        id=entry["job_id"],
        experiment_id=entry["experiment_id"],
        sim_dir=entry["sim_dir"],
        seed=entry["seed"],
        generations=entry["generations"],
    )

    _consume_sim_log(log_buffer)
    try:
        from app.services.sim_worker import _collect_results

        results = _collect_results(job, None, log_buffer)
        payload["status"] = "done"
        payload["results"] = [_result_to_dict(r) for r in results]
        if PRUNE_SIMOUT:
            # Only after results were extracted successfully -- pruning is irreversible.
            payload["prune"] = convert_and_prune(entry["sim_dir"], log_buffer)
    except Exception as exc:  # noqa: BLE001 - the sentinel is the only channel back
        payload["status"] = "failed"
        payload["error"] = "{}: {}".format(type(exc).__name__, exc)
        payload["traceback"] = traceback.format_exc()
        payload["results"] = []
    payload["log_tail"] = "\n".join(log_buffer)
    return payload


def emit_prelude(manifest: Path, index: int) -> str:
    """Render one manifest entry as shell variable assignments.

    Keeping the JSON parsing in Python means the task script never has to quote or eval
    untrusted strings; every value here goes through shlex.quote.
    """
    entry = read_manifest_line(manifest, index)
    lines = [
        "WCE_JOB_ID={}".format(shlex.quote(str(entry["job_id"]))),
        "WCE_ATTEMPT={}".format(shlex.quote(str(entry["attempt"]))),
        "WCE_RUN_ID={}".format(shlex.quote(entry["run_id"])),
        "WCE_PARCA_RUN_ID={}".format(shlex.quote(entry["parca_run_id"])),
        "WCE_SIM_ARGV=({})".format(" ".join(shlex.quote(a) for a in entry["argv"])),
    ]
    for key, value in sorted((entry.get("env") or {}).items()):
        lines.append("export {}={}".format(key, shlex.quote(str(value))))
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="wcEcoli SLURM array task helper")
    sub = parser.add_subparsers(dest="command", required=True)

    prelude_parser = sub.add_parser("prelude", help="emit sourceable shell for one task")
    prelude_parser.add_argument("--manifest", required=True, type=Path)
    prelude_parser.add_argument("--index", required=True, type=int)

    ingest_parser = sub.add_parser("ingest", help="extract results and write the sentinel")
    ingest_parser.add_argument("--manifest", required=True, type=Path)
    ingest_parser.add_argument("--index", required=True, type=int)
    ingest_parser.add_argument("--returncode", required=True, type=int)

    args = parser.parse_args(argv)

    if args.command == "prelude":
        sys.stdout.write(emit_prelude(args.manifest, args.index))
        return 0

    payload = ingest(args.manifest, args.index, args.returncode)
    write_sentinel(sentinel_path(args.manifest, args.index), payload)
    print("sentinel: {} status={}".format(payload["status"], payload.get("error", "")),
          file=sys.stderr)
    # Always exit 0: the sentinel carries the outcome. A non-zero exit here would make SLURM
    # think the *task* failed and, with --requeue, re-run a simulation that already succeeded.
    return 0


if __name__ == "__main__":
    sys.exit(main())
