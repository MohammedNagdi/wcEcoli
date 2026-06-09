#!/usr/bin/env bash
# Start the simulation worker process.
#
# Prerequisites:
#   1. Build the Docker image:  docker compose -f interface/docker-compose.sim.yml build
#   2. Start the FastAPI backend (so the database exists)
#   3. Run this script from the repo root:  ./interface/start-worker.sh
#
# The worker polls the simulation_jobs table and runs simulations
# inside Docker containers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Set environment variables for native (non-Docker) execution
export RECONSTRUCTION_PATH="$REPO_ROOT/reconstruction"
export MODELS_PATH="$REPO_ROOT/models"
export DATABASE_PATH="$SCRIPT_DIR/backend/data/wcecoli.db"
export WCECOLI_ROOT="$REPO_ROOT"
export SIM_OUTPUT_DIR="$REPO_ROOT/out"
export DOCKER_IMAGE="wcecoli-sim:latest"
export PARCA_CPUS="${PARCA_CPUS:-8}"
export PARCA_LOCK_TIMEOUT="${PARCA_LOCK_TIMEOUT:-3600}"
export WCECOLI_HOST_RECONSTRUCTION="$REPO_ROOT/reconstruction"
export WCECOLI_HOST_MODELS="$REPO_ROOT/models"
export PYTHONPATH="$REPO_ROOT"

cd "$SCRIPT_DIR/backend"
echo "Starting wcEcoli simulation worker..."
echo "  Database: $DATABASE_PATH"
echo "  Output:   $SIM_OUTPUT_DIR"
echo "  Docker:   $DOCKER_IMAGE"
echo ""
python -m app.services.sim_worker
