#!/usr/bin/env bash
# Build the two micromamba environments needed to run wcEcoli campaigns on SLURM.
#
# Two environments are required, mirroring the two Docker images the platform uses:
#
#   wcecoli-sim   Python 3.10, numpy 1.26.3  -- runs runParca.py / runSim.py
#   wcecoli-api   Python 3.11, numpy 2.4.6   -- runs submit_campaign, dispatch,
#                                               reconcile and result ingestion
#
# They cannot be merged: interface/backend/pyproject.toml pins numpy==2.4.6 and
# requires-python>=3.11, while requirements.txt pins numpy==1.26.3.
#
# Building a scientific Python environment onto GPFS is I/O-bound and painfully slow on a
# busy login node -- measured at 44s of CPU across 29 minutes of wall time, entirely blocked
# on I/O. Run it on a compute node instead:
#
#     sbatch --account=<acct> --partition=<part> cluster/setup_env.sbatch
#
# The script is resumable: re-running installs into an existing environment rather than
# failing, so an interrupted build can simply be repeated.
#
# Usage:  cluster/setup_env.sh [--sim-only|--api-only]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAMBA_BIN="${MICROMAMBA_BIN:-$HOME/scripts/micromamba}"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$HOME/storage/micromamba}"

SIM_ENV="${WCECOLI_SIM_ENV:-wcecoli-sim}"
API_ENV="${WCECOLI_API_ENV:-wcecoli-api}"
DO_SIM=1
DO_API=1

case "${1:-}" in
  --sim-only) DO_API=0 ;;
  --api-only) DO_SIM=0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

if [[ ! -x "${MAMBA_BIN}" ]]; then
  echo "ERROR: micromamba not found at ${MAMBA_BIN} (override with MICROMAMBA_BIN)" >&2
  exit 1
fi

mm() { "${MAMBA_BIN}" "$@"; }

env_exists() { [[ -d "${MAMBA_ROOT_PREFIX}/envs/$1" ]]; }

# ---------------------------------------------------------------- simulation env
if [[ "${DO_SIM}" -eq 1 ]]; then
  if env_exists "${SIM_ENV}"; then
    echo "=== ${SIM_ENV} already exists; resuming into it ==="
  else
    echo "=== Creating ${SIM_ENV} (Python 3.10) ==="
    mm create -y -n "${SIM_ENV}" -c conda-forge \
        python=3.10 pip gcc_linux-64 gxx_linux-64 gfortran_linux-64 swig cmake make
  fi

  # Mirror docker/local/Dockerfile: install the conflict-prone packages first, in order,
  # then the remainder of requirements.txt with those entries filtered out.
  echo "=== Installing pinned installers ==="
  mm run -n "${SIM_ENV}" pip install --no-cache-dir \
      "pip<25.0" "setuptools==70.0.0" wheel cmake

  echo "=== Installing conflict-prone dependencies ==="
  mm run -n "${SIM_ENV}" pip install --no-cache-dir "stochastic-arrow>=1.1.0"
  mm run -n "${SIM_ENV}" pip install --no-cache-dir "Equation==1.2.01" --no-build-isolation
  mm run -n "${SIM_ENV}" pip install --no-cache-dir qdldl osqp

  echo "=== Installing requirements.txt ==="
  FILTERED="$(mktemp)"
  trap 'rm -f "${FILTERED}"' EXIT
  grep -vE '^(osqp|qdldl|stochastic-arrow|Equation)([<>=!~].*)?$' \
      "${ROOT_DIR}/requirements.txt" > "${FILTERED}"
  mm run -n "${SIM_ENV}" pip install --no-cache-dir -r "${FILTERED}"

  echo "=== Building Cython extensions (make compile) ==="
  ( cd "${ROOT_DIR}" && mm run -n "${SIM_ENV}" make compile )

  echo "=== Smoke test ==="
  ( cd "${ROOT_DIR}" && OPENBLAS_NUM_THREADS=1 PYTHONPATH="${ROOT_DIR}" \
      mm run -n "${SIM_ENV}" python -c \
      "import numpy, scipy, aesara, Bio; from wholecell.utils import filepath; print('sim env OK', numpy.__version__)" )
fi

# ------------------------------------------------------------------ control env
if [[ "${DO_API}" -eq 1 ]]; then
  if env_exists "${API_ENV}"; then
    echo "=== ${API_ENV} already exists; resuming into it ==="
  else
    echo "=== Creating ${API_ENV} (Python 3.11) ==="
    mm create -y -n "${API_ENV}" -c conda-forge python=3.11 pip
  fi

  # Direct dependencies from interface/backend/pyproject.toml, plus pyarrow.
  #
  # pyarrow is deliberately added even though pyproject.toml omits it: without it
  # SimOutReader.export_parquet() silently falls back to _export_csv(), which writes
  # CSV bytes into a file named *.parquet (table_reader_bridge.py:628).
  mm run -n "${API_ENV}" pip install --no-cache-dir \
      "fastapi==0.136.3" "uvicorn[standard]==0.48.0" "pydantic==2.13.4" \
      "pydantic-settings==2.14.1" "sqlmodel==0.0.38" "aiosqlite==0.22.1" \
      "h5py==3.16.0" "numpy==2.4.6" "scikit-learn==1.9.0" "pyarrow"

  echo "=== Smoke test ==="
  PYTHONPATH="${ROOT_DIR}/interface/backend" mm run -n "${API_ENV}" python -c \
      "import fastapi, sqlmodel, h5py, numpy, pyarrow; print('api env OK', numpy.__version__)"
fi

echo
echo "Done."
echo "  sim env: ${MAMBA_ROOT_PREFIX}/envs/${SIM_ENV}"
echo "  api env: ${MAMBA_ROOT_PREFIX}/envs/${API_ENV}"
