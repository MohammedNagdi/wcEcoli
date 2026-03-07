#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${WCECOLI_DOCKER_IMAGE:-wcecoli-local:latest}"
SIF_PATH="${ROOT_DIR}/cluster/images/wcecoli-local.sif"
FROM_REGISTRY=0
SKIP_DOCKER_BUILD=0

usage() {
  cat <<USAGE
Usage: cluster/build_sif.sh [options]

Options:
  --image <name>       Docker image name (default: ${IMAGE_NAME})
  --sif <path>         Output .sif path (default: ${SIF_PATH})
  --from-registry      Use docker://<image> instead of local docker-daemon image
  --skip-docker-build  Do not run docker/local/run.sh build
  -h, --help           Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      IMAGE_NAME="$2"
      shift 2
      ;;
    --sif)
      SIF_PATH="$2"
      shift 2
      ;;
    --from-registry)
      FROM_REGISTRY=1
      shift
      ;;
    --skip-docker-build)
      SKIP_DOCKER_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if command -v apptainer >/dev/null 2>&1; then
  APPTAINER_BIN="apptainer"
elif command -v singularity >/dev/null 2>&1; then
  APPTAINER_BIN="singularity"
else
  echo "ERROR: apptainer/singularity not found on PATH"
  exit 1
fi

mkdir -p "$(dirname "${SIF_PATH}")"

if [[ "${FROM_REGISTRY}" -eq 0 ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required for local docker-daemon conversion"
    exit 1
  fi

  if [[ "${SKIP_DOCKER_BUILD}" -eq 0 ]]; then
    echo "Building local Docker image with docker/local/run.sh build"
    "${ROOT_DIR}/docker/local/run.sh" build
  fi

  SOURCE_URI="docker-daemon://${IMAGE_NAME}"
else
  SOURCE_URI="docker://${IMAGE_NAME}"
fi

echo "Building SIF from ${SOURCE_URI}"
echo "Output: ${SIF_PATH}"
"${APPTAINER_BIN}" build "${SIF_PATH}" "${SOURCE_URI}"

echo "Done. SIF image available at ${SIF_PATH}"
