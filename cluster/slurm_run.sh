#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="${ROOT_DIR}"
SIF_PATH="${ROOT_DIR}/cluster/images/wcecoli-local.sif"
JOB_NAME="wcecoli"
TIME_LIMIT="12:00:00"
CPUS=8
MEMORY="32G"
PARTITION=""
ACCOUNT=""
LOG_DIR="${ROOT_DIR}/out/slurm"
DIRECT_MODE=0
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: cluster/slurm_run.sh [options] -- <command...>

Options:
  --sif <path>         Path to .sif image (default: ${SIF_PATH})
  --workdir <path>     Repo/work directory to bind as /wcEcoli (default: ${WORKDIR})
  --job-name <name>    Slurm job name (default: ${JOB_NAME})
  --time <hh:mm:ss>    Time limit (default: ${TIME_LIMIT})
  --cpus <n>           CPUs per task (default: ${CPUS})
  --mem <size>         Memory request (default: ${MEMORY})
  --partition <name>   Optional Slurm partition
  --account <name>     Optional Slurm account
  --direct             Execute apptainer command directly (no sbatch)
  --dry-run            Print generated command/script without executing
  -h, --help           Show this help

Examples:
  cluster/slurm_run.sh -- python runscripts/manual/runSim.py --generations 5 --init-sims 10 sim1
  cluster/slurm_run.sh --job-name parca --time 24:00:00 -- python runscripts/manual/runParca.py sim1
USAGE
}

shell_quote() {
  printf '%q' "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sif)
      SIF_PATH="$2"
      shift 2
      ;;
    --workdir)
      WORKDIR="$2"
      shift 2
      ;;
    --job-name)
      JOB_NAME="$2"
      shift 2
      ;;
    --time)
      TIME_LIMIT="$2"
      shift 2
      ;;
    --cpus)
      CPUS="$2"
      shift 2
      ;;
    --mem)
      MEMORY="$2"
      shift 2
      ;;
    --partition)
      PARTITION="$2"
      shift 2
      ;;
    --account)
      ACCOUNT="$2"
      shift 2
      ;;
    --direct)
      DIRECT_MODE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "ERROR: no command provided"
  usage
  exit 1
fi

if command -v apptainer >/dev/null 2>&1; then
  APPTAINER_BIN="apptainer"
elif command -v singularity >/dev/null 2>&1; then
  APPTAINER_BIN="singularity"
else
  APPTAINER_BIN="${WCECOLI_APPTAINER_BIN:-apptainer}"
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    echo "ERROR: apptainer/singularity not found on PATH"
    exit 1
  fi
  echo "[dry-run] apptainer/singularity not found; using '${APPTAINER_BIN}' in generated commands."
fi

BIND_SPEC="${WORKDIR}:/wcEcoli,${WORKDIR}/out:/wcEcoli/out,${WORKDIR}/cache:/wcEcoli/cache"
mkdir -p "${LOG_DIR}" "${WORKDIR}/out" "${WORKDIR}/cache"

# Build command string safely for bash -lc execution.
printf -v COMMAND_STR '%q ' "$@"
COMMAND_STR="${COMMAND_STR% }"

if [[ "${DIRECT_MODE}" -eq 1 ]]; then
  RUN_CMD="${APPTAINER_BIN} exec --bind $(shell_quote "${BIND_SPEC}") $(shell_quote "${SIF_PATH}") bash -lc $(shell_quote "${COMMAND_STR}")"
  echo "[direct] ${RUN_CMD}"
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    eval "${RUN_CMD}"
  fi
  exit 0
fi

WORKDIR_Q="$(shell_quote "${WORKDIR}")"
BIND_SPEC_Q="$(shell_quote "${BIND_SPEC}")"
SIF_PATH_Q="$(shell_quote "${SIF_PATH}")"
COMMAND_STR_Q="$(shell_quote "${COMMAND_STR}")"

SBATCH_SCRIPT_BASE="$(mktemp /tmp/wcecoli_slurm_XXXXXX)"
SBATCH_SCRIPT="${SBATCH_SCRIPT_BASE}.sbatch"
rm -f "${SBATCH_SCRIPT_BASE}"
{
  echo "#!/bin/bash"
  echo "#SBATCH --job-name=${JOB_NAME}"
  echo "#SBATCH --time=${TIME_LIMIT}"
  echo "#SBATCH --cpus-per-task=${CPUS}"
  echo "#SBATCH --mem=${MEMORY}"
  echo "#SBATCH --output=${LOG_DIR}/%x-%j.out"
  if [[ -n "${PARTITION}" ]]; then
    echo "#SBATCH --partition=${PARTITION}"
  fi
  if [[ -n "${ACCOUNT}" ]]; then
    echo "#SBATCH --account=${ACCOUNT}"
  fi
  cat <<SCRIPT_BODY
set -euo pipefail
cd ${WORKDIR_Q}
${APPTAINER_BIN} exec --bind ${BIND_SPEC_Q} ${SIF_PATH_Q} bash -lc ${COMMAND_STR_Q}
SCRIPT_BODY
} > "${SBATCH_SCRIPT}"

chmod +x "${SBATCH_SCRIPT}"

echo "Generated sbatch script: ${SBATCH_SCRIPT}"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  cat "${SBATCH_SCRIPT}"
  exit 0
fi

sbatch "${SBATCH_SCRIPT}"
echo "Submitted. Logs will appear in ${LOG_DIR}"
