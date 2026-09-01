#!/bin/bash
# Build the campaign environments on a compute node.
#
#   sbatch --account=<acct> --partition=<part> cluster/setup_env.sbatch
#
# Login nodes are the wrong place for this: writing a scientific Python environment to GPFS
# is I/O-bound, and a shared login node under load makes it glacial. Compute nodes have
# outbound internet access, so pip works here.

#SBATCH --job-name=wce-setup-env
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=04:00:00
#SBATCH --output=setup_env-%j.out

set -euo pipefail

# NOT from BASH_SOURCE: sbatch runs a *copy* of this script from its spool directory.
REPO_ROOT="${WCECOLI_REPO_ROOT:-${SLURM_SUBMIT_DIR:-$PWD}}"
if [[ ! -x "${REPO_ROOT}/cluster/setup_env.sh" ]]; then
    echo "FATAL: ${REPO_ROOT} is not the wcEcoli repo root." >&2
    echo "       Submit from the repo root, or set WCECOLI_REPO_ROOT." >&2
    exit 1
fi
cd "${REPO_ROOT}"
echo "Building environments on $(hostname) at $(date -Is)"
exec cluster/setup_env.sh "$@"
