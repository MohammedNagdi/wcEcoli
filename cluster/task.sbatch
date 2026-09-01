#!/bin/bash
# One wcEcoli simulation job, run as one SLURM array task.
#
#   sbatch --array=0-<n>%<throttle> cluster/task.sbatch <manifest.jsonl> <repo-root>
#
# Submitted by app.services.slurm_campaign.dispatch; resources (--account, --partition,
# --mem, --time, --cpus-per-task) are set there, not here, so one script serves every tier.
#
# The array index selects a line of the manifest. Two environments are used, mirroring the
# platform's two Docker images: the simulation runs under wcecoli-sim (Python 3.10 /
# numpy 1.26.3) and result ingestion under wcecoli-api (Python 3.11 / numpy 2.4.6). They
# cannot be merged -- the pins are mutually exclusive.
#
# This script is idempotent by construction. ckpt is PreemptMode=REQUEUE with GraceTime=0:
# a preempted task is killed with no warning and re-run from the start. So the task wipes
# its own output directory on entry; a re-run is always clean, and preemption, node failure
# and manual resubmission are all the same code path.

set -uo pipefail

MANIFEST="${1:?usage: task.sbatch <manifest.jsonl> <repo-root>}"
INDEX="${SLURM_ARRAY_TASK_ID:?must run as a job array}"

# Passed explicitly by the dispatcher. It cannot be derived from BASH_SOURCE, because sbatch
# runs a *copy* of this script from its spool directory, not the file in the repo.
REPO_ROOT="${2:-${WCECOLI_REPO_ROOT:-${SLURM_SUBMIT_DIR:-$PWD}}}"
if [[ ! -d "${REPO_ROOT}/runscripts" ]]; then
    echo "FATAL: ${REPO_ROOT} is not the wcEcoli repo root" >&2
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

# Multi-threaded BLAS changes results and runs slower when many single-core simulations share
# a node (see the note at the top of requirements.txt). One thread per task, always.
export OPENBLAS_NUM_THREADS=1
export OMP_NUM_THREADS=1
export MKL_NUM_THREADS=1
export NUMEXPR_NUM_THREADS=1
export PYTHONDONTWRITEBYTECODE=1

echo "=== wcEcoli task ${SLURM_ARRAY_JOB_ID:-?}_${INDEX} on $(hostname) at $(date -Is) ==="

# ---------------------------------------------------------------- read the manifest entry
PRELUDE="$(mktemp)"
trap 'rm -f "${PRELUDE}"' EXIT
if ! PYTHONPATH="${BACKEND_ROOT}" "${MAMBA_BIN}" run -n "${API_ENV}" \
        python -m app.services.slurm_ingest prelude \
        --manifest "${MANIFEST}" --index "${INDEX}" > "${PRELUDE}"; then
    echo "FATAL: could not read manifest ${MANIFEST} index ${INDEX}" >&2
    exit 1
fi
# shellcheck disable=SC1090
source "${PRELUDE}"

echo "job_id=${WCE_JOB_ID} attempt=${WCE_ATTEMPT} run_id=${WCE_RUN_ID}"

# ------------------------------------------------------------------ prepare the run directory
# OUT_DIR is hardcoded as <repo>/out in wholecell/utils/filepath.py, so <repo>/out must be
# the campaign output root (a symlink, mirroring the Docker bind mount). See cluster/RUN_SLURM.md.
OUT_ROOT="${REPO_ROOT}/out"
if [[ ! -d "${OUT_ROOT}" ]]; then
    echo "FATAL: ${OUT_ROOT} does not exist; link it at the campaign root first" >&2
    exit 1
fi

RUN_DIR="${OUT_ROOT}/${WCE_RUN_ID}"
PARCA_KB="${OUT_ROOT}/${WCE_PARCA_RUN_ID}/kb"
if [[ ! -f "${PARCA_KB}/simData.cPickle" ]]; then
    echo "FATAL: frozen Parca cache missing at ${PARCA_KB}" >&2
    exit 1
fi

# Wipe on entry: this attempt owns this directory outright.
rm -rf "${RUN_DIR}"
mkdir -p "${RUN_DIR}"
# Relative symlink so the tree stays movable; the kb itself is read-only and shared.
ln -sfn "../${WCE_PARCA_RUN_ID}/kb" "${RUN_DIR}/kb"

# ---------------------------------------------------------------------------- run the simulation
cd "${REPO_ROOT}"
echo "--- sim: ${WCE_SIM_ARGV[*]}"
PYTHONPATH="${REPO_ROOT}" "${MAMBA_BIN}" run -n "${SIM_ENV}" "${WCE_SIM_ARGV[@]}"
SIM_RC=$?
echo "--- sim exited with code ${SIM_RC}"

# ------------------------------------------------------------------------------------ ingest
# Ingestion runs here rather than on the controller so that SimOutReader parsing and Parquet
# export parallelize across the cluster instead of serializing through one core.
# It always exits 0; the sentinel carries the real outcome. A non-zero exit would make SLURM
# requeue a simulation that had already succeeded.
PYTHONPATH="${BACKEND_ROOT}" "${MAMBA_BIN}" run -n "${API_ENV}" \
    python -m app.services.slurm_ingest ingest \
    --manifest "${MANIFEST}" --index "${INDEX}" --returncode "${SIM_RC}"
INGEST_RC=$?

if [[ "${INGEST_RC}" -ne 0 ]]; then
    echo "FATAL: ingestion helper itself failed (rc=${INGEST_RC}); no sentinel written" >&2
    exit "${INGEST_RC}"
fi

echo "=== done at $(date -Is) ==="
exit "${SIM_RC}"
