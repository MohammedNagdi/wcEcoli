#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${WCECOLI_CONDA_ENV:-wcecoli}"
if [[ "${1:-}" != "" ]]; then
  ENV_NAME="$1"
fi

if ! command -v conda >/dev/null 2>&1; then
  echo "ERROR: conda is not installed or not on PATH"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

source "$(conda info --base)/etc/profile.d/conda.sh"

echo "[1/7] Cleaning stale build metadata"
find . -name "*.egg-info" -type d -prune -exec rm -rf {} +
find . -name "*.egg-info" -type f -delete
rm -rf build dist

echo "[2/7] Creating conda env '${ENV_NAME}' (python=3.10)"
if conda env list | awk '{print $1}' | grep -qx "${ENV_NAME}"; then
  echo "Environment '${ENV_NAME}' already exists; reusing it."
else
  conda create -n "${ENV_NAME}" python=3.10 -y
fi

conda activate "${ENV_NAME}"

echo "[3/7] Installing pinned build tooling"
pip install "setuptools==70.0.0" "pip<25.0" wheel cmake

echo "[4/7] Installing conflict-prone dependencies first"
pip install "stochastic-arrow>=1.1.0"
pip install Equation==1.2.01 --no-build-isolation
pip install qdldl osqp

echo "[5/7] Installing remaining requirements"
pip install -r <(grep -vE "^(osqp|qdldl|stochastic-arrow)([<>=!~].*)?$" requirements.txt)

echo "[6/7] Compiling C extensions"
make clean compile

echo "[7/7] Registering project (best effort)"
pip install -e . --no-deps --no-build-isolation || true

export PYTHONPATH="${ROOT_DIR}"
export OPENBLAS_NUM_THREADS=1
export OMP_NUM_THREADS=1

cat <<MSG

Conda fallback setup completed.

Environment: ${ENV_NAME}
Project root: ${ROOT_DIR}

For future sessions:
  conda activate ${ENV_NAME}
  export PYTHONPATH="${ROOT_DIR}"
  export OPENBLAS_NUM_THREADS=1
  export OMP_NUM_THREADS=1

Example runs:
  python runscripts/manual/runParca.py sim1
  python runscripts/manual/runSim.py --generations 5 --init-sims 10 sim1
MSG
