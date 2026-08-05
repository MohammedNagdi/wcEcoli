"""Recover completed simulation jobs whose preserved results lost their job row."""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session, select

from app.db.models import Experiment, SimulationJob, SimulationResult

logger = logging.getLogger(__name__)

_RUN_DIR_RE = re.compile(
    r"^(?P<timestamp>\d{8}_\d{6})_.*_job(?P<job_id>\d+)(?:_attempt\d+)?$"
)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _run_directory_time(path: Path) -> datetime | None:
    match = _RUN_DIR_RE.match(path.name)
    if not match:
        return None
    try:
        return datetime.strptime(
            match.group("timestamp"),
            "%Y%m%d_%H%M%S",
        ).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _find_run_directory(
    output_dir: Path,
    job_id: int,
    completed_at: datetime | None,
) -> Path | None:
    if not output_dir.exists():
        return None

    candidates: list[Path] = []
    for path in output_dir.iterdir():
        if not path.is_dir():
            continue
        match = _RUN_DIR_RE.match(path.name)
        if match and int(match.group("job_id")) == job_id:
            candidates.append(path)

    if not candidates:
        return None
    if completed_at is None:
        return max(candidates, key=lambda path: path.name)

    def candidate_score(path: Path) -> tuple[int, float, str]:
        started_at = _run_directory_time(path)
        if started_at is None:
            return (2, float("inf"), path.name)
        after_completion = int(started_at > completed_at)
        return (
            after_completion,
            abs((completed_at - started_at).total_seconds()),
            path.name,
        )

    return min(candidates, key=candidate_score)


def recover_orphaned_simulation_jobs(engine, output_dir: Path) -> list[int]:
    """Recreate missing completed jobs from surviving experiment/result records.

    The operation is idempotent. It preserves each original job ID so existing
    result rows and result URLs become usable again.
    """
    recovered_ids: list[int] = []
    with Session(engine) as session:
        existing_job_ids = set(session.exec(select(SimulationJob.id)).all())
        grouped_results: dict[int, list[SimulationResult]] = defaultdict(list)
        for result in session.exec(select(SimulationResult)).all():
            if result.job_id not in existing_job_ids:
                grouped_results[result.job_id].append(result)

        for job_id, results in sorted(grouped_results.items()):
            experiment_ids = {result.experiment_id for result in results}
            if len(experiment_ids) != 1:
                logger.warning(
                    "Cannot recover job %d: result rows reference experiments %s",
                    job_id,
                    sorted(experiment_ids),
                )
                continue

            experiment_id = next(iter(experiment_ids))
            experiment = session.get(Experiment, experiment_id)
            if experiment is None:
                logger.warning(
                    "Cannot recover job %d: experiment %d is missing",
                    job_id,
                    experiment_id,
                )
                continue

            completed_times = [
                parsed
                for result in results
                if (parsed := _parse_datetime(result.created_at)) is not None
            ]
            completed_at = max(completed_times) if completed_times else None
            run_directory = _find_run_directory(output_dir, job_id, completed_at)
            started_at = _run_directory_time(run_directory) if run_directory else None
            generations = max(result.generation for result in results) + 1
            seed = min(result.seed for result in results)

            job = SimulationJob(
                id=job_id,
                experiment_id=experiment_id,
                status="done",
                phase="Recovered from preserved simulation results",
                sim_dir=run_directory.name if run_directory else "",
                log_tail="Recovered after database schema migration removed the job row.",
                started_at=started_at.isoformat() if started_at else "",
                finished_at=completed_at.isoformat() if completed_at else "",
                created_at=(
                    started_at.isoformat()
                    if started_at
                    else experiment.created_at
                ),
                variant_type=experiment.variant_type,
                variant_index=experiment.variant_index,
                condition=experiment.condition,
                seed=seed,
                generations=generations,
                timeline=experiment.timeline,
            )
            session.add(job)
            recovered_ids.append(job_id)

        if recovered_ids:
            session.commit()
            logger.warning(
                "Recovered %d orphaned historical simulation job(s): %s",
                len(recovered_ids),
                ", ".join(str(job_id) for job_id in recovered_ids),
            )

    return recovered_ids
