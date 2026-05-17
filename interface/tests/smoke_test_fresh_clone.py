#!/usr/bin/env python3
"""Fresh-clone smoke test — simulates a new user starting the stack.

Validates that:
  1. The seed database builds from scratch with ALL tables present
  2. No simulation data leaks (experiments, jobs, results tables empty)
  3. Gene catalog is populated with correct schema
  4. API health endpoint responds correctly
  5. All API routers are registered and reachable
  6. Frontend compiles without errors (optional, requires npm)

Run from the interface/ directory:
    cd interface
    python tests/smoke_test_fresh_clone.py

Or with pytest:
    cd interface
    python -m pytest tests/smoke_test_fresh_clone.py -v

Environment variables required (same as backend):
    RECONSTRUCTION_PATH  — path to reconstruction/ directory
    MODELS_PATH          — path to models/ directory

The test creates a temporary database, runs init_database() against it,
then boots the FastAPI app in test mode to validate endpoints.
"""

import os
import sys
import json
import sqlite3
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Ensure the backend package is importable
# ---------------------------------------------------------------------------
INTERFACE_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = INTERFACE_DIR / "backend"
REPO_ROOT = INTERFACE_DIR.parent

sys.path.insert(0, str(BACKEND_DIR))

# Set required env vars if not already set (point to repo data)
if "RECONSTRUCTION_PATH" not in os.environ:
    os.environ["RECONSTRUCTION_PATH"] = str(REPO_ROOT / "reconstruction")
if "MODELS_PATH" not in os.environ:
    os.environ["MODELS_PATH"] = str(REPO_ROOT / "models")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
WARN = "\033[93m!\033[0m"
failures = []


def check(label: str, condition: bool, detail: str = ""):
    if condition:
        print(f"  {PASS} {label}")
    else:
        msg = f"{label}: {detail}" if detail else label
        failures.append(msg)
        print(f"  {FAIL} {label}" + (f"  ({detail})" if detail else ""))


# ---------------------------------------------------------------------------
# Test 1: Database builds from scratch with complete schema
# ---------------------------------------------------------------------------

def test_database_build():
    """Build a fresh database and verify all tables exist with correct columns."""
    print("\n═══ Test 1: Fresh database build ═══")

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test_wcecoli.db"
        schema_version_path = Path(tmpdir) / ".schema_version"

        # Override settings for this test
        os.environ["DATABASE_PATH"] = str(db_path)

        # Reload settings to pick up the new path
        import importlib
        if "app.config" in sys.modules:
            importlib.reload(sys.modules["app.config"])
        from app.config import settings
        # Force the path (in case pydantic cached it)
        object.__setattr__(settings, 'database_path', db_path)

        # Ensure no pre-existing DB
        check("No pre-existing database", not db_path.exists())

        # Run init_database
        if "app.db.init_db" in sys.modules:
            importlib.reload(sys.modules["app.db.init_db"])
        from app.db.init_db import init_database
        init_database()

        check("Database file created", db_path.exists())

        # Connect and inspect schema
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()

        # Get all tables
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = {row[0] for row in cur.fetchall()}

        # Expected tables from models.py
        expected_tables = {
            "genes", "tf_edges", "aa_pathways", "conditions",
            "timelines", "variants", "complexes",
            "experiments", "simulation_jobs", "simulation_results",
        }

        print(f"\n  Tables found: {sorted(tables)}")
        for t in sorted(expected_tables):
            check(f"Table '{t}' exists", t in tables,
                  "MISSING — create_all() import bug?" if t not in tables else "")

        # ---------------------------------------------------------------------------
        # Test 2: No simulation data leaks
        # ---------------------------------------------------------------------------
        print("\n═══ Test 2: No simulation data leaks ═══")

        user_data_tables = ["experiments", "simulation_jobs", "simulation_results"]
        for t in user_data_tables:
            if t in tables:
                cur.execute(f"SELECT COUNT(*) FROM {t}")
                count = cur.fetchone()[0]
                check(f"'{t}' is empty (no leaked data)", count == 0,
                      f"found {count} rows — data leak!")

        # ---------------------------------------------------------------------------
        # Test 3: Gene catalog populated
        # ---------------------------------------------------------------------------
        print("\n═══ Test 3: Gene catalog populated ═══")

        if "genes" in tables:
            cur.execute("SELECT COUNT(*) FROM genes")
            gene_count = cur.fetchone()[0]
            check(f"Genes populated ({gene_count} rows)", gene_count > 100,
                  f"only {gene_count} genes — expected ~1500+")

            # Check key columns exist
            cur.execute("PRAGMA table_info(genes)")
            gene_cols = {row[1] for row in cur.fetchall()}
            for col in ["symbol", "ecoli_id", "category", "ko_index", "is_mechanistic"]:
                check(f"Gene column '{col}'", col in gene_cols)

            # Check is_mechanistic is populated (some should be True)
            cur.execute("SELECT COUNT(*) FROM genes WHERE is_mechanistic = 1")
            mech_count = cur.fetchone()[0]
            check(f"Mechanistic genes flagged ({mech_count})", mech_count > 0,
                  "no mechanistic genes — categorization may be broken")

            # Check categories aren't all 'other'
            cur.execute("SELECT COUNT(DISTINCT category) FROM genes")
            cat_count = cur.fetchone()[0]
            check(f"Gene categories diverse ({cat_count} distinct)", cat_count > 5,
                  f"only {cat_count} categories — prefix mapping may be broken")

        # ---------------------------------------------------------------------------
        # Test 4: SimulationJob and SimulationResult columns complete
        # ---------------------------------------------------------------------------
        print("\n═══ Test 4: Schema completeness ═══")

        if "simulation_jobs" in tables:
            cur.execute("PRAGMA table_info(simulation_jobs)")
            job_cols = {row[1] for row in cur.fetchall()}
            expected_job_cols = [
                "id", "experiment_id", "status", "phase", "sim_dir",
                "docker_container_id", "log_tail", "started_at", "finished_at",
                "error_message", "created_at", "variant_type", "variant_index",
                "condition", "seed", "generations", "timeline",
            ]
            for col in expected_job_cols:
                check(f"simulation_jobs.{col}", col in job_cols)

        if "simulation_results" in tables:
            cur.execute("PRAGMA table_info(simulation_results)")
            result_cols = {row[1] for row in cur.fetchall()}
            expected_result_cols = [
                "id", "job_id", "experiment_id", "seed", "generation",
                "division_time_sec", "final_mass_fg", "growth_rate",
                "doubling_time_min", "divided", "created_at",
            ]
            for col in expected_result_cols:
                check(f"simulation_results.{col}", col in result_cols)

        # Check other seed tables
        if "conditions" in tables:
            cur.execute("SELECT COUNT(*) FROM conditions")
            cond_count = cur.fetchone()[0]
            check(f"Conditions loaded ({cond_count})", cond_count > 0)

        if "variants" in tables:
            cur.execute("SELECT COUNT(*) FROM variants")
            var_count = cur.fetchone()[0]
            check(f"Variants loaded ({var_count})", var_count > 0)

            # Verify key variant types exist
            cur.execute("SELECT name FROM variants")
            variant_names = {row[0] for row in cur.fetchall()}
            for vt in ["gene_knockout", "wildtype"]:
                check(f"Variant type '{vt}'", vt in variant_names)

        if "timelines" in tables:
            cur.execute("SELECT COUNT(*) FROM timelines")
            tl_count = cur.fetchone()[0]
            check(f"Timelines loaded ({tl_count})", tl_count > 0)

        conn.close()

        # ---------------------------------------------------------------------------
        # Test 5: Schema version file written
        # ---------------------------------------------------------------------------
        print("\n═══ Test 5: Schema version tracking ═══")

        # The schema_version file is written next to the DB
        # But init_db uses settings.database_path.parent / ".schema_version"
        sv_path = db_path.parent / ".schema_version"
        check("Schema version file exists", sv_path.exists(),
              f"expected at {sv_path}")
        if sv_path.exists():
            version = sv_path.read_text().strip()
            check(f"Schema version = {version}", version.isdigit() and int(version) >= 4,
                  f"expected >= 4, got '{version}'")


# ---------------------------------------------------------------------------
# Test 6: FastAPI app boots and endpoints respond
# ---------------------------------------------------------------------------

def test_api_endpoints():
    """Boot the FastAPI app in test mode and check key endpoints."""
    print("\n═══ Test 6: API endpoints ═══")

    try:
        from fastapi.testclient import TestClient
    except ImportError:
        print(f"  {WARN} fastapi[testclient] not installed — skipping API tests")
        print(f"    Install with: pip install httpx")
        return

    try:
        # Import the app — this triggers lifespan which builds the DB
        from app.main import app
        client = TestClient(app)

        # Health check
        r = client.get("/api/health")
        check("GET /api/health → 200", r.status_code == 200)
        if r.status_code == 200:
            data = r.json()
            check("Health status = 'ok'", data.get("status") == "ok")

        # Gene catalog
        r = client.get("/api/genes?limit=5")
        check("GET /api/genes → 200", r.status_code == 200)
        if r.status_code == 200:
            data = r.json()
            genes = data.get("genes", data) if isinstance(data, dict) else data
            check("Genes returned", len(genes) > 0,
                  f"got {len(genes)} genes")

        # Experiments (should be empty)
        r = client.get("/api/experiments")
        check("GET /api/experiments → 200", r.status_code == 200)
        if r.status_code == 200:
            check("Experiments empty", len(r.json()) == 0,
                  f"got {len(r.json())} — data leak?")

        # Jobs (should be empty)
        r = client.get("/api/jobs")
        check("GET /api/jobs → 200", r.status_code == 200)
        if r.status_code == 200:
            check("Jobs empty", len(r.json()) == 0)

        # Failed jobs endpoint
        r = client.get("/api/jobs/failed")
        check("GET /api/jobs/failed → 200", r.status_code == 200)

        # Conditions
        r = client.get("/api/conditions")
        check("GET /api/conditions → 200", r.status_code == 200)

        # Variants
        r = client.get("/api/variants")
        check("GET /api/variants → 200", r.status_code == 200)

        # TF network
        r = client.get("/api/tf-network")
        check("GET /api/tf-network → 200", r.status_code == 200)

        # Comparison endpoint (no IDs — should 422 or 400)
        r = client.get("/api/experiments/compare?ids=")
        check("GET /api/experiments/compare (empty) → 4xx",
              r.status_code in (400, 422))

    except Exception as e:
        print(f"  {FAIL} API test failed: {e}")
        failures.append(f"API test exception: {e}")


# ---------------------------------------------------------------------------
# Test 7: Frontend compiles (optional)
# ---------------------------------------------------------------------------

def test_frontend_compiles():
    """Check that the frontend TypeScript compiles without errors."""
    import subprocess
    print("\n═══ Test 7: Frontend compilation (optional) ═══")

    frontend_dir = INTERFACE_DIR / "frontend"
    node_modules = frontend_dir / "node_modules"

    if not node_modules.exists():
        print(f"  {WARN} node_modules not found — run 'npm install' first. Skipping.")
        return

    try:
        result = subprocess.run(
            ["npx", "tsc", "--noEmit"],
            cwd=str(frontend_dir),
            capture_output=True,
            text=True,
            timeout=60,
            shell=True,  # needed on Windows
        )
        check("TypeScript compiles cleanly", result.returncode == 0,
              result.stdout[:200] if result.returncode != 0 else "")
        if result.returncode != 0 and result.stderr:
            print(f"    stderr: {result.stderr[:300]}")
    except FileNotFoundError:
        print(f"  {WARN} npx not found — skipping TypeScript check")
    except subprocess.TimeoutExpired:
        print(f"  {WARN} TypeScript compilation timed out — skipping")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("╔══════════════════════════════════════════════════════╗")
    print("║  wcEcoli Fresh-Clone Smoke Test                     ║")
    print("║  Simulates a new user cloning the repo and starting ║")
    print("║  the stack for the first time.                      ║")
    print("╚══════════════════════════════════════════════════════╝")

    # Verify reconstruction data exists
    recon_path = Path(os.environ["RECONSTRUCTION_PATH"])
    models_path = Path(os.environ["MODELS_PATH"])

    if not recon_path.exists():
        print(f"\n{FAIL} RECONSTRUCTION_PATH not found: {recon_path}")
        print("  Set RECONSTRUCTION_PATH to the reconstruction/ directory.")
        sys.exit(1)

    if not models_path.exists():
        print(f"\n{FAIL} MODELS_PATH not found: {models_path}")
        print("  Set MODELS_PATH to the models/ directory.")
        sys.exit(1)

    print(f"\n  Reconstruction: {recon_path}")
    print(f"  Models:         {models_path}")

    test_database_build()
    test_api_endpoints()
    test_frontend_compiles()

    # Summary
    print("\n" + "═" * 56)
    if failures:
        print(f"\n{FAIL} {len(failures)} failure(s):")
        for f in failures:
            print(f"  • {f}")
        sys.exit(1)
    else:
        print(f"\n{PASS} All checks passed — fresh clone is healthy.")
        sys.exit(0)


if __name__ == "__main__":
    main()
