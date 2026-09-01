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
import sys
import traceback
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path

SENTINEL_VERSION = 1


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
        payload["log_tail"] = ""
        return payload

    job = ManifestJob(
        id=entry["job_id"],
        experiment_id=entry["experiment_id"],
        sim_dir=entry["sim_dir"],
        seed=entry["seed"],
        generations=entry["generations"],
    )

    try:
        from app.services.sim_worker import _collect_results

        results = _collect_results(job, None, log_buffer)
        payload["status"] = "done"
        payload["results"] = [_result_to_dict(r) for r in results]
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
