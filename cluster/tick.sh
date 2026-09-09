#!/usr/bin/env bash
# One campaign iteration: reconcile finished tasks, then dispatch more.
# Idempotent and safe to run concurrently with itself (writers serialize on an flock).
# Intended for scrontab; see cluster/RUN_SLURM.md.

set -euo pipefail

REPO_ROOT="${WCECOLI_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck disable=SC1091
source "${REPO_ROOT}/cluster/campaign_env.sh" >/dev/null

# Invoke the environment's interpreter directly rather than through `micromamba run`:
# that takes an exclusive lock on ~/.cache/mamba/proc, so concurrent array tasks serialize
# on one lock file on GPFS and each logs "Waiting for other mamba process to finish".
# Nothing here needs the activation hooks -- campaign_env.sh sets PYTHONPATH and
# LD_LIBRARY_PATH itself.
# --limit sizes one array; --max-in-flight caps the total submitted across arrays. Each
# dispatch claims min(limit, max_in_flight - in_flight) jobs, so a limit below
# max_in_flight only slows the ramp -- it takes ceil(max_in_flight/limit) ticks to reach
# the target instead of one. Default them to the same number and the target is reached on
# the first tick. WCECOLI_TICK_LIMIT still overrides for a deliberately gentle ramp.
exec "${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_API_ENV}/bin/python" \
    -m app.services.slurm_campaign tick \
    --limit "${WCECOLI_TICK_LIMIT:-${WCECOLI_MAX_IN_FLIGHT}}" \
    --max-in-flight "${WCECOLI_MAX_IN_FLIGHT}"
