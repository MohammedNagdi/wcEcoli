"""wcEcoli Platform API - FastAPI application."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, SQLModel

from app.config import settings
from app.db.engine import make_sqlite_engine
from app.db.migrations import run_migrations as _run_migrations

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(name)s - %(message)s")
logger = logging.getLogger(__name__)

# Global engine - set during startup
_engine = None


def get_session():
    """Dependency that yields a database session."""
    with Session(_engine) as session:
        yield session


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup."""
    global _engine
    from app.db.init_db import init_database
    init_database()
    _engine = make_sqlite_engine(settings.database_path)
    # Ensure user-data tables (experiments, simulation_jobs, simulation_results)
    # exist even when reconstruction data hasn't changed and init_database()
    # skipped the rebuild.
    import app.db.models  # noqa: F401
    SQLModel.metadata.create_all(_engine)

    # Lightweight schema migrations for columns added after initial release
    _run_migrations(_engine)

    # Restore historical job links if an earlier schema rebuild preserved
    # experiments/results but silently dropped their simulation_jobs rows.
    from app.services.job_recovery import recover_orphaned_simulation_jobs
    recover_orphaned_simulation_jobs(_engine, settings.sim_output_dir)

    # Auto-reingest any completed jobs with null summary stats
    # (caused by earlier broken TableReader import)
    _auto_reingest_stale_results(_engine)

    # Apply any DB-stored assistant runtime overrides over the environment defaults.
    try:
        from app.services.assistant_harness import _get_or_create_runtime_settings, apply_runtime_settings_to_env
        with Session(_engine) as _session:
            apply_runtime_settings_to_env(_get_or_create_runtime_settings(_session))
    except Exception as exc:  # noqa: BLE001 — never block startup on settings
        logger.warning("Assistant runtime settings not applied: %s", exc)

    logger.info("wcEcoli API ready - database at %s", settings.database_path)
    yield
    logger.info("Shutting down")


def _auto_reingest_stale_results(engine):
    """Re-ingest summary stats for jobs whose results have all-null fields.

    This fixes jobs that were ingested when the TableReader bridge was broken
    (e.g., before the standalone iff_reader replaced wholecell.io.tablereader).
    Runs once at API startup - only touches jobs marked 'done' with a sim_dir.
    """
    from collections import deque
    from sqlmodel import Session as Sess, select
    from app.db.models import Experiment, SimulationJob, SimulationResult
    from app.services.sim_worker import _collect_results

    try:
        with Sess(engine) as session:
            # Find done jobs
            done_jobs = session.exec(
                select(SimulationJob).where(SimulationJob.status == "done")
            ).all()

            for job in done_jobs:
                if not job.sim_dir:
                    continue

                # Check if all results for this job have null stats
                results = session.exec(
                    select(SimulationResult).where(
                        SimulationResult.job_id == job.id
                    )
                ).all()

                if not results:
                    continue

                all_null = all(
                    r.final_mass_fg is None and r.growth_rate is None
                    for r in results
                )
                if not all_null:
                    continue

                # Re-ingest
                logger.info("Auto-reingesting job %d (stale null results)", job.id)
                try:
                    experiment = session.get(Experiment, job.experiment_id)
                    if not experiment:
                        continue
                    new_results = _collect_results(
                        job, experiment, deque(maxlen=settings.log_tail_lines)
                    )
                    # Preserve historical rows unless every replacement was
                    # validated and parsed successfully.
                    for r in results:
                        session.delete(r)
                    for new_result in new_results:
                        session.add(new_result)

                    session.commit()
                    logger.info("  -> Reingested job %d successfully", job.id)

                except Exception as exc:
                    logger.warning("  -> Failed to reingest job %d: %s", job.id, exc)
                    session.rollback()

    except Exception as exc:
        logger.warning("Auto-reingest check failed: %s", exc)


app = FastAPI(
    title="wcEcoli Platform API",
    description="REST API for the whole-cell E. coli model",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health_check():
    """Health check endpoint."""
    from app.services.sim_runner_client import RunnerClient, RunnerError

    try:
        runner = RunnerClient(settings.sim_runner_socket, timeout=1).health()
    except RunnerError as exc:
        runner = {"status": "unavailable", "error": str(exc)}
    return {
        "status": "ok",
        "version": "0.1.0",
        "database": str(settings.database_path),
        "reconstruction": str(settings.reconstruction_path),
        "simulation_runner": runner,
    }


# Register routers
from app.routers.genes import router as genes_router  # noqa: E402
from app.routers.pathways import router as pathways_router  # noqa: E402
from app.routers.experiments import router as experiments_router  # noqa: E402
from app.routers.jobs import router as jobs_router  # noqa: E402
from app.routers.results import router as results_router  # noqa: E402
from app.routers.molecules import router as molecules_router  # noqa: E402
from app.routers.ml import router as ml_router  # noqa: E402
from app.routers.design import router as design_router  # noqa: E402
from app.routers.media_recipes import router as media_recipes_router  # noqa: E402
from app.routers.condition_catalog import router as condition_catalog_router  # noqa: E402
from app.routers.builder_drafts import router as builder_drafts_router  # noqa: E402
from app.routers.user_timelines import router as user_timelines_router  # noqa: E402
from app.routers.platform import router as platform_router  # noqa: E402
from app.routers.assistant import router as assistant_router  # noqa: E402

app.include_router(genes_router)
app.include_router(pathways_router)
app.include_router(experiments_router)
app.include_router(jobs_router)
app.include_router(results_router)
app.include_router(molecules_router)
app.include_router(ml_router)
app.include_router(design_router)
app.include_router(media_recipes_router)
app.include_router(condition_catalog_router)
app.include_router(builder_drafts_router)
app.include_router(user_timelines_router)
app.include_router(platform_router)
app.include_router(assistant_router)
