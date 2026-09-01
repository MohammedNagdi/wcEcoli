#!/usr/bin/env bash
# One campaign iteration: reconcile finished tasks, then dispatch more.
# Idempotent and safe to run concurrently with itself (writers serialize on an flock).
# Intended for scrontab; see cluster/RUN_SLURM.md.

set -euo pipefail

REPO_ROOT="${WCECOLI_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck disable=SC1091
source "${REPO_ROOT}/cluster/campaign_env.sh" >/dev/null

exec "${MICROMAMBA_BIN}" run -n "${WCECOLI_API_ENV}" \
    python -m app.services.slurm_campaign tick \
    --limit "${WCECOLI_TICK_LIMIT:-200}" \
    --max-in-flight "${WCECOLI_MAX_IN_FLIGHT}"
