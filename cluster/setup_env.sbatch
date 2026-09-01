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

REPO_ROOT="${WCECOLI_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "${REPO_ROOT}"
echo "Building environments on $(hostname) at $(date -Is)"
exec cluster/setup_env.sh "$@"
