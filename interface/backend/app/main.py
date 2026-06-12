"""wcEcoli Platform API - FastAPI application."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, SQLModel, create_engine

from app.config import settings

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
    _engine = create_engine(f"sqlite:///{settings.database_path}", echo=False)
    # Ensure user-data tables (experiments, simulation_jobs, simulation_results)
    # exist even when reconstruction data hasn't changed and init_database()
    # skipped the rebuild.
    import app.db.models  # noqa: F401
    SQLModel.metadata.create_all(_engine)

    # Lightweight schema migrations for columns added after initial release
    _run_migrations(_engine)

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


def _run_migrations(engine):
    """Apply lightweight schema migrations for columns added after initial release.

    Each migration is idempotent - safe to run multiple times. We check
    PRAGMA table_info to see if the column already exists before ALTER TABLE.
    """
    import sqlite3
    db_path = str(settings.database_path)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    try:
        # Migration 1: Add 'condition' column to simulation_jobs
        cur.execute("PRAGMA table_info(simulation_jobs)")
        cols = {row[1] for row in cur.fetchall()}
        if "condition" not in cols:
            logger.info("Migration: adding 'condition' column to simulation_jobs")
            cur.execute("ALTER TABLE simulation_jobs ADD COLUMN condition TEXT NOT NULL DEFAULT 'basal'")
            # Back-fill from experiments where possible
            cur.execute("""
                UPDATE simulation_jobs
                SET condition = (
                    SELECT COALESCE(e.condition, 'basal')
                    FROM experiments e
                    WHERE e.id = simulation_jobs.experiment_id
                )
                WHERE EXISTS (
                    SELECT 1 FROM experiments e WHERE e.id = simulation_jobs.experiment_id
                )
            """)
            conn.commit()
            logger.info("Migration: back-filled condition for %d job(s)", cur.rowcount)
        # Migration 2: Add 'batch_id' column to experiments
        cur.execute("PRAGMA table_info(experiments)")
        exp_cols = {row[1] for row in cur.fetchall()}
        if "batch_id" not in exp_cols:
            logger.info("Migration: adding 'batch_id' column to experiments")
            cur.execute("ALTER TABLE experiments ADD COLUMN batch_id TEXT NOT NULL DEFAULT ''")
            conn.commit()

        # Migration 3: Add 'divided' column to simulation_results
        cur.execute("PRAGMA table_info(simulation_results)")
        res_cols = {row[1] for row in cur.fetchall()}
        if "divided" not in res_cols:
            logger.info("Migration: adding 'divided' column to simulation_results")
            cur.execute("ALTER TABLE simulation_results ADD COLUMN divided INTEGER NOT NULL DEFAULT 1")
            # Back-fill: mark results with null division_time as not divided
            cur.execute("""
                UPDATE simulation_results
                SET divided = 0
                WHERE division_time_sec IS NULL
            """)
            conn.commit()
            logger.info("Migration: back-filled divided=0 for %d result(s) with null division_time", cur.rowcount)

        # Migration 4: Add 'is_mechanistic' column to genes
        cur.execute("PRAGMA table_info(genes)")
        gene_cols = {row[1] for row in cur.fetchall()}
        if "is_mechanistic" not in gene_cols:
            logger.info("Migration: adding 'is_mechanistic' column to genes")
            cur.execute("ALTER TABLE genes ADD COLUMN is_mechanistic INTEGER NOT NULL DEFAULT 0")
            conn.commit()

        # Migration 5: Add 'docker_container_id' column to simulation_jobs
        cur.execute("PRAGMA table_info(simulation_jobs)")
        job_cols = {row[1] for row in cur.fetchall()}
        if "docker_container_id" not in job_cols:
            logger.info("Migration: adding 'docker_container_id' column to simulation_jobs")
            cur.execute("ALTER TABLE simulation_jobs ADD COLUMN docker_container_id TEXT NOT NULL DEFAULT ''")
            conn.commit()

        # Migration 6: Upsert newly added variant files into existing live DBs.
        variant_path = settings.variants_dir / "multi_gene_knockout.py"
        if variant_path.exists():
            import re
            content = variant_path.read_text(encoding="utf-8")
            doc_match = re.search(r'"""(.*?)"""', content, re.DOTALL)
            docstring = doc_match.group(1).strip()[:2000] if doc_match else ""
            cur.execute("SELECT id FROM variants WHERE name = ?", ("multi_gene_knockout",))
            if cur.fetchone() is None:
                logger.info("Migration: adding 'multi_gene_knockout' variant")
                cur.execute(
                    "INSERT INTO variants (name, docstring, filename, parameter_count) VALUES (?, ?, ?, ?)",
                    ("multi_gene_knockout", docstring, "multi_gene_knockout.py", None),
                )
                conn.commit()

        # Migration 7: Assistant confirmation nonce + expiry (replay/staleness protection).
        cur.execute("PRAGMA table_info(assistant_confirmations)")
        conf_cols = {row[1] for row in cur.fetchall()}
        if conf_cols:  # table exists
            if "nonce" not in conf_cols:
                logger.info("Migration: adding 'nonce' column to assistant_confirmations")
                cur.execute("ALTER TABLE assistant_confirmations ADD COLUMN nonce TEXT NOT NULL DEFAULT ''")
                conn.commit()
            if "expires_at" not in conf_cols:
                logger.info("Migration: adding 'expires_at' column to assistant_confirmations")
                cur.execute("ALTER TABLE assistant_confirmations ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''")
                conn.commit()

        # Migration 8: Assistant provider secret encryption flag.
        cur.execute("PRAGMA table_info(assistant_provider_configs)")
        prov_cols = {row[1] for row in cur.fetchall()}
        if prov_cols and "secret_encrypted" not in prov_cols:
            logger.info("Migration: adding 'secret_encrypted' column to assistant_provider_configs")
            cur.execute("ALTER TABLE assistant_provider_configs ADD COLUMN secret_encrypted INTEGER NOT NULL DEFAULT 0")
            conn.commit()

    except Exception as exc:
        logger.warning("Migration check failed: %s", exc)
    finally:
        conn.close()


def _auto_reingest_stale_results(engine):
    """Re-ingest summary stats for jobs whose results have all-null fields.

    This fixes jobs that were ingested when the TableReader bridge was broken
    (e.g., before the standalone iff_reader replaced wholecell.io.tablereader).
    Runs once at API startup - only touches jobs marked 'done' with a sim_dir.
    """
    from sqlmodel import Session as Sess, select
    from app.db.models import SimulationJob, SimulationResult
    from datetime import datetime, timezone

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
                    from app.services.table_reader_bridge import (
                        SimOutReader, find_sim_outs, parse_sim_out_path,
                    )
                    sim_out_base = settings.sim_output_dir / job.sim_dir
                    sim_outs = find_sim_outs(sim_out_base)
                    if not sim_outs:
                        continue

                    # Delete old results
                    for r in results:
                        session.delete(r)
                    session.flush()

                    now = datetime.now(timezone.utc).isoformat()
                    for sim_out_path in sim_outs:
                        path_info = parse_sim_out_path(sim_out_path)
                        try:
                            reader = SimOutReader(sim_out_path)
                            summary = reader.extract_summary()
                        except Exception:
                            summary = {
                                "division_time_sec": None,
                                "final_mass_fg": None,
                                "growth_rate": None,
                                "doubling_time_min": None,
                                "divided": False,
                            }

                        new_result = SimulationResult(
                            job_id=job.id,
                            experiment_id=job.experiment_id,
                            seed=path_info.get("seed", job.seed),
                            generation=path_info.get("generation", 0),
                            division_time_sec=summary["division_time_sec"],
                            final_mass_fg=summary["final_mass_fg"],
                            growth_rate=summary["growth_rate"],
                            doubling_time_min=summary["doubling_time_min"],
                            divided=summary.get("divided", False),
                            created_at=now,
                        )
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
    return {
        "status": "ok",
        "version": "0.1.0",
        "database": str(settings.database_path),
        "reconstruction": str(settings.reconstruction_path),
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
