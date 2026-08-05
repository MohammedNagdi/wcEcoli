#!/usr/bin/env bash
# Start the persistent simulation runner and database worker.
#
# Prerequisites:
#   Run from the repo root: ./interface/start-worker.sh <concurrency> [cpu-budget]
#
# Concurrency defaults to one. CPU budget defaults to the larger of the
# simulation demand and the Parca reservation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONCURRENCY="${1:-${SIM_RUNNER_CONCURRENCY:-1}}"
SIM_CPUS="${SIM_CPUS_PER_JOB:-1}"
PARCA_CPUS_VALUE="${PARCA_CPUS:-8}"

if ! [[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
    echo "Concurrency must be a positive integer" >&2
    exit 2
fi
for value_name in SIM_CPUS PARCA_CPUS_VALUE; do
    value="${!value_name}"
    if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
        echo "$value_name must be a positive integer" >&2
        exit 2
    fi
done
DEFAULT_BUDGET=$(( CONCURRENCY * SIM_CPUS ))
if (( PARCA_CPUS_VALUE > DEFAULT_BUDGET )); then
    DEFAULT_BUDGET="$PARCA_CPUS_VALUE"
fi
CPU_BUDGET="${2:-${SIM_RUNNER_CPU_BUDGET:-$DEFAULT_BUDGET}}"
if ! [[ "$CPU_BUDGET" =~ ^[1-9][0-9]*$ ]]; then
    echo "CPU_BUDGET must be a positive integer" >&2
    exit 2
fi
if (( PARCA_CPUS_VALUE > CPU_BUDGET )); then
    echo "CPU budget must be at least the Parca reservation ($PARCA_CPUS_VALUE)" >&2
    exit 2
fi

EFFECTIVE_CAPACITY=$(( CPU_BUDGET / SIM_CPUS ))
if (( EFFECTIVE_CAPACITY > CONCURRENCY )); then
    EFFECTIVE_CAPACITY="$CONCURRENCY"
fi

export SIM_RUNNER_CONCURRENCY="$CONCURRENCY"
export SIM_RUNNER_CPU_BUDGET="$CPU_BUDGET"
export SIM_CPUS_PER_JOB="$SIM_CPUS"
export PARCA_CPUS="$PARCA_CPUS_VALUE"

cd "$SCRIPT_DIR"
echo "Requested simulation concurrency: $CONCURRENCY"
echo "Runner CPU budget: $CPU_BUDGET"
echo "CPUs per simulation: $SIM_CPUS"
echo "Effective simultaneous simulations: $EFFECTIVE_CAPACITY"
echo "Parca CPU reservation: $PARCA_CPUS_VALUE"
if (( EFFECTIVE_CAPACITY < CONCURRENCY )); then
    echo "Warning: CPU budget limits concurrency to $EFFECTIVE_CAPACITY simulation(s)." >&2
fi
if [[ "${START_WORKER_DRY_RUN:-0}" == "1" ]]; then
    exit 0
fi
docker compose up -d --build sim-runner worker
