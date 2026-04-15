#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${WCECOLI_DOCKER_IMAGE:-wcecoli-local}"
DOCKERFILE="${ROOT_DIR}/docker/local/Dockerfile"
OUT_DIR="${ROOT_DIR}/out"
CACHE_DIR="${ROOT_DIR}/cache"
IN_CONTAINER=0
if [[ -f "/.dockerenv" ]]; then
  IN_CONTAINER=1
fi

usage() {
  cat <<USAGE
Usage: docker/local/run.sh <command> [args]

Commands:
  build                         Build the Docker image (${IMAGE_NAME})
  shell                         Start an interactive shell in the container
  run <command...>              Run arbitrary command in runtime
  py <script.py> [args...]      Run Python script in runtime
  parca [args...]               Run runscripts/manual/runParca.py with passthrough args
  sim [args...]                 Run runscripts/manual/runSim.py with passthrough args
  cmd <any command...>          Alias for 'run'

Examples:
  docker/local/run.sh run python -m pytest wholecell/tests/utils/test_units.py -q
  docker/local/run.sh py runscripts/manual/analysisMultigen.py sim1
  docker/local/run.sh parca sim1
  docker/local/run.sh sim --generations 5 --init-sims 10 sim1

Env vars:
  WCECOLI_DOCKER_IMAGE=<name>   Override image name (default: wcecoli-local)
  WCECOLI_BIND_SOURCE=1         Bind host repo to /wcEcoli for live code edits
  SINE_MEDIA_A=<media_id>       Base media for sinusoidal_media variant (default: MIX0-57)
  SINE_MEDIA_B=<media_id>       Second media for sinusoidal_media variant (default: MIX0-57-GLC-2mM)
USAGE
}

prepare_run_args() {
  DOCKER_RUN_ARGS=(--rm -i -v "${OUT_DIR}:/wcEcoli/out" -v "${CACHE_DIR}:/wcEcoli/cache")
  if [[ "${WCECOLI_BIND_SOURCE:-0}" == "1" ]]; then
    DOCKER_RUN_ARGS+=(-v "${ROOT_DIR}:/wcEcoli")
  fi
  if [[ -t 0 && -t 1 ]]; then
    DOCKER_RUN_ARGS+=(-t)
  fi
  if [[ "$(uname -s)" == "Linux" ]]; then
    # Rootless Podman maps container root to the host user automatically,
    # so skip --user to avoid UID remapping issues.
    _is_podman=0
    if command -v podman &>/dev/null; then
      _docker_ver="$(docker --version 2>&1 || true)"
      [[ "$_docker_ver" =~ [Pp]odman ]] && _is_podman=1
    fi
    if [[ "$_is_podman" -eq 0 ]]; then
      DOCKER_RUN_ARGS+=(--user "$(id -u):$(id -g)")
    fi
  fi
  # Forward sinusoidal media env vars if set
  if [[ -n "${SINE_MEDIA_A:-}" ]]; then
    DOCKER_RUN_ARGS+=(-e "SINE_MEDIA_A=${SINE_MEDIA_A}")
  fi
  if [[ -n "${SINE_MEDIA_B:-}" ]]; then
    DOCKER_RUN_ARGS+=(-e "SINE_MEDIA_B=${SINE_MEDIA_B}")
  fi
}

mkdir -p "${OUT_DIR}" "${CACHE_DIR}"

command="${1:-}"
if [[ -z "${command}" ]]; then
  usage
  exit 1
fi

case "${command}" in
  build)
    if [[ "${IN_CONTAINER}" -eq 1 ]]; then
      echo "build is a host-only command. Run it on your machine, not inside the container."
      exit 1
    fi
    docker build -f "${DOCKERFILE}" -t "${IMAGE_NAME}" "${ROOT_DIR}"
    ;;

  shell)
    if [[ "${IN_CONTAINER}" -eq 1 ]]; then
      exec bash
    else
      prepare_run_args
      docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_NAME}" bash
    fi
    ;;

  parca)
    shift
    if [[ "${IN_CONTAINER}" -eq 1 ]]; then
      python runscripts/manual/runParca.py "$@"
    else
      prepare_run_args
      docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_NAME}" python runscripts/manual/runParca.py "$@"
    fi
    ;;

  sim)
    shift
    if [[ "${IN_CONTAINER}" -eq 1 ]]; then
      python runscripts/manual/runSim.py "$@"
    else
      prepare_run_args
      docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_NAME}" \
        python runscripts/manual/runSim.py "$@"
    fi
    ;;

  run|cmd)
    shift
    if [[ "$#" -eq 0 ]]; then
      echo "${command} requires at least one argument"
      exit 1
    fi
    if [[ "${IN_CONTAINER}" -eq 1 ]]; then
      "$@"
    else
      prepare_run_args
      docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_NAME}" "$@"
    fi
    ;;

  py)
    shift
    if [[ "$#" -eq 0 ]]; then
      echo "py requires a script path (and optional args)"
      exit 1
    fi
    if [[ "${IN_CONTAINER}" -eq 1 ]]; then
      python "$@"
    else
      prepare_run_args
      docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_NAME}" python "$@"
    fi
    ;;

  *)
    usage
    exit 1
    ;;
esac
