#!/usr/bin/env bash
set -euo pipefail

export PYTHONPATH="${PYTHONPATH:-/wcEcoli}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"

cd /wcEcoli
exec "$@"
