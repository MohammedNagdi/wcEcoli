"""Idempotent, additive schema migrations for live databases.

``init_database`` rebuilds the reference tables when the reconstruction data changes, but
user-data tables (experiments, simulation_jobs, simulation_results) survive rebuilds and
only ever gain columns here. Every step checks ``PRAGMA table_info`` first, so running this
on an up-to-date database is a no-op.
"""

from __future__ import annotations

import logging

from app.config import settings

logger = logging.getLogger(__name__)


def run_migrations(engine=None):
    """Apply lightweight schema migrations for columns added after initial release.

    Shared by the FastAPI startup hook and the SLURM controller (``wce init-db``), so a
    campaign database that predates a column gets it without the API ever running.

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

        # Migration 6: Persistent runner task ownership and lease fields.
        cur.execute("PRAGMA table_info(simulation_jobs)")
        job_cols = {row[1] for row in cur.fetchall()}
        runner_columns = {
            "runner_task_id": "TEXT NOT NULL DEFAULT ''",
            "worker_id": "TEXT NOT NULL DEFAULT ''",
            "heartbeat_at": "TEXT NOT NULL DEFAULT ''",
            "lease_expires_at": "TEXT NOT NULL DEFAULT ''",
            "attempt": "INTEGER NOT NULL DEFAULT 0",
        }
        for column, declaration in runner_columns.items():
            if column not in job_cols:
                logger.info("Migration: adding '%s' column to simulation_jobs", column)
                cur.execute(
                    "ALTER TABLE simulation_jobs ADD COLUMN {} {}".format(column, declaration)
                )
                conn.commit()

        # Migration 7: Upsert newly added variant files into existing live DBs.
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

        # Migration 9: Per-conversation assistant provider/model selection.
        cur.execute("PRAGMA table_info(assistant_conversations)")
        conversation_cols = {row[1] for row in cur.fetchall()}
        if conversation_cols:
            if "provider_id" not in conversation_cols:
                logger.info("Migration: adding 'provider_id' column to assistant_conversations")
                cur.execute("ALTER TABLE assistant_conversations ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''")
                conn.commit()
            if "model" not in conversation_cols:
                logger.info("Migration: adding 'model' column to assistant_conversations")
                cur.execute("ALTER TABLE assistant_conversations ADD COLUMN model TEXT NOT NULL DEFAULT ''")
                conn.commit()

        # Migration 10: Lineage termination. A cell that stops growing and dies before
        # dividing is a result (the trajectory up to its death), not a crashed job. The
        # job is 'done' with lineage_terminated=1; the generation it died in carries
        # terminated=1 and every earlier generation is a normal, complete one.
        cur.execute("PRAGMA table_info(simulation_jobs)")
        job_cols = {row[1] for row in cur.fetchall()}
        for column, declaration in {
            "lineage_terminated": "INTEGER NOT NULL DEFAULT 0",
            "termination_reason": "TEXT NOT NULL DEFAULT ''",
        }.items():
            if column not in job_cols:
                logger.info("Migration: adding '%s' column to simulation_jobs", column)
                cur.execute("ALTER TABLE simulation_jobs ADD COLUMN {} {}".format(column, declaration))
                conn.commit()
        cur.execute("PRAGMA table_info(simulation_results)")
        res_cols = {row[1] for row in cur.fetchall()}
        for column, declaration in {
            "terminated": "INTEGER NOT NULL DEFAULT 0",
            "termination_reason": "TEXT NOT NULL DEFAULT ''",
        }.items():
            if column not in res_cols:
                logger.info("Migration: adding '%s' column to simulation_results", column)
                cur.execute("ALTER TABLE simulation_results ADD COLUMN {} {}".format(column, declaration))
                conn.commit()

    except Exception as exc:
        logger.exception("Database migration failed")
        raise RuntimeError("Database migration failed") from exc
    finally:
        conn.close()
