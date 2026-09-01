#!/bin/bash
# Build the shared Parca cache once, then freeze it read-only.
#
#   sbatch --account=<acct> --partition=<part> cluster/parca.sbatch
#
# Every simulation job reads this one kb/ directory through a symlink. Letting each job
# check-and-maybe-build it would put thousands of tasks in a race over the same output
# directory on GPFS, so it is built here, once, deliberately, and then made read-only so a
# buggy task cannot corrupt the shared input.
#
# Parca is the only stage that uses multiple cores (PARCA_CPUS, default 8).

#SBATCH --job-name=wce-parca
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=04:00:00

set -euo pipefail

# NOT from BASH_SOURCE: sbatch runs a *copy* of this script from its spool directory.
REPO_ROOT="${WCECOLI_REPO_ROOT:-${SLURM_SUBMIT_DIR:-$PWD}}"
if [[ ! -d "${REPO_ROOT}/runscripts" ]]; then
    echo "FATAL: ${REPO_ROOT} is not the wcEcoli repo root (submit from it, or set" \
         "WCECOLI_REPO_ROOT)." >&2
    exit 1
fi
BACKEND_ROOT="${REPO_ROOT}/interface/backend"

# Pick up campaign paths and SLURM defaults. sbatch exports the submitting environment by
# default, but sourcing here keeps the script correct when run directly or via scrontab.
# shellcheck disable=SC1091
source "${REPO_ROOT}/cluster/campaign_env.sh" >/dev/null
MAMBA_BIN="${MICROMAMBA_BIN:-$HOME/scripts/micromamba}"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$HOME/storage/micromamba}"
SIM_ENV="${WCECOLI_SIM_ENV:-wcecoli-sim}"
API_ENV="${WCECOLI_API_ENV:-wcecoli-api}"
PARCA_CPUS="${PARCA_CPUS:-8}"

export OPENBLAS_NUM_THREADS=1
export OMP_NUM_THREADS=1
export MKL_NUM_THREADS=1

# The cache directory name is content-addressed over reconstruction/ and models/, so ask the
# controller rather than hardcoding it. Pin it afterwards with WCECOLI_PARCA_RUN_ID.
PARCA_RUN_ID="${WCECOLI_PARCA_RUN_ID:-$(PYTHONPATH="${BACKEND_ROOT}" "${MAMBA_BIN}" run -n "${API_ENV}" \
    python -m app.services.slurm_campaign parca-id)}"
echo "Parca cache id: ${PARCA_RUN_ID}"

OUT_ROOT="${REPO_ROOT}/out"
TARGET="${OUT_ROOT}/${PARCA_RUN_ID}"

if [[ -f "${TARGET}/kb/simData.cPickle" ]]; then
    echo "Parca cache already present at ${TARGET}/kb - nothing to do."
    exit 0
fi

# A partial cache from an interrupted build must not be reused.
chmod -R u+w "${TARGET}" 2>/dev/null || true
rm -rf "${TARGET}"

cd "${REPO_ROOT}"
PYTHONPATH="${REPO_ROOT}" "${MAMBA_BIN}" run -n "${SIM_ENV}" \
    python runscripts/manual/runParca.py -c "${PARCA_CPUS}" "${PARCA_RUN_ID}"

echo "Verifying..."
PYTHONPATH="${BACKEND_ROOT}" WCECOLI_PARCA_RUN_ID="${PARCA_RUN_ID}" \
    "${MAMBA_BIN}" run -n "${API_ENV}" \
    python -m app.services.slurm_campaign verify-parca

# Freeze. Simulation tasks only ever read this.
chmod -R a-w "${TARGET}"

echo
echo "Parca cache frozen at ${TARGET}"
echo "Pin it for every later command:"
echo "    export WCECOLI_PARCA_RUN_ID=${PARCA_RUN_ID}"
