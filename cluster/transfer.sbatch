#!/bin/bash
# One transfer shard, run as one SLURM array task.
#
#   sbatch --array=0-<n>%<concurrency> cluster/transfer.sbatch <manifest.jsonl> <repo-root>
#
# Submitted by cluster/transfer.py dispatch; resources are set there, not here.
#
# The array index selects a shard (one line) of the manifest. transfer.py run syncs each
# unit of the shard to the bucket, writes a sentinel per unit as it goes, and ALWAYS exits
# 0: the sentinels carry the outcome. A non-zero exit under --requeue would make SLURM
# re-run a shard whose units had already succeeded. A re-run (requeue, or a retry
# dispatch of the same shard) skips every unit that already has a success sentinel.

set -uo pipefail

MANIFEST="${1:?usage: transfer.sbatch <manifest.jsonl> <repo-root>}"
INDEX="${SLURM_ARRAY_TASK_ID:?must run as a job array}"

# Passed explicitly by the dispatcher: sbatch runs a *copy* of this script from its spool
# directory, so BASH_SOURCE cannot locate the repo.
REPO_ROOT="${2:-${WCECOLI_REPO_ROOT:-${SLURM_SUBMIT_DIR:-$PWD}}}"
if [[ ! -f "${REPO_ROOT}/cluster/transfer.py" ]]; then
    echo "FATAL: ${REPO_ROOT} is not the wcEcoli repo root" >&2
    exit 0
fi

# shellcheck disable=SC1091
source "${REPO_ROOT}/cluster/transfer_env.sh" >/dev/null

echo "=== transfer shard ${SLURM_ARRAY_JOB_ID:-?}_${INDEX} on $(hostname) at $(date -Is) ==="
"${WCECOLI_HF_PYTHON}" "${REPO_ROOT}/cluster/transfer.py" run --manifest "${MANIFEST}" --index "${INDEX}"
echo "=== done (rc=$?) at $(date -Is) ==="
exit 0
