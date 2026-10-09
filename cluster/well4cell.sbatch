#!/bin/bash
# One well4cell build task (a scan shard or one output parquet file), run as one SLURM
# array task.
#
#   sbatch --array=0-<n>%<c> cluster/well4cell.sbatch <stage> <manifest.jsonl> <repo-root>
#
# Submitted by `cluster/w4c <stage> dispatch`; resources are set there. The task ALWAYS
# exits 0: its sentinel carries the outcome, and a re-run skips work whose success
# sentinel already exists (same pattern as cluster/transfer.sbatch).
set -uo pipefail
STAGE="${1:?usage: well4cell.sbatch <stage> <manifest.jsonl> <repo-root>}"
MANIFEST="${2:?manifest}"
REPO_ROOT="${3:-${WCECOLI_REPO_ROOT:-${SLURM_SUBMIT_DIR:-$PWD}}}"
INDEX="${SLURM_ARRAY_TASK_ID:?must run as a job array}"
if [[ ! -d "${REPO_ROOT}/cluster/well4cell_build" ]]; then
    echo "FATAL: ${REPO_ROOT} is not the wcEcoli repo root" >&2
    exit 0
fi
# shellcheck disable=SC1091
source "${REPO_ROOT}/cluster/well4cell_env.sh" >/dev/null
export PYTHONPATH="${REPO_ROOT}/cluster${PYTHONPATH:+:${PYTHONPATH}}"
echo "=== w4c ${STAGE} ${SLURM_ARRAY_JOB_ID:-?}_${INDEX} on $(hostname) at $(date -Is) ==="
"${W4C_PYTHON}" -m well4cell_build "${STAGE}" run --manifest "${MANIFEST}" --index "${INDEX}"
echo "=== done (rc=$?) at $(date -Is) ==="
exit 0
