#!/usr/bin/env bash
# Docker-only release entry. Credentials never enter build arguments or source.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAMILY="${1:-explorer}"
shift || true
if [[ "${1:-}" == --help || "${1:-}" == -h || $# -eq 0 ]]; then
    echo 'Explorer: bundle | fetch-data | verify | up | ps | logs | config | stop'
    echo 'Publish: prepare-update | approve | update-space | rollback-space | check | status | dataset | space'
    echo 'Options: --bundle DIR --release DIR --output-dir DIR --state-dir DIR --cache-dir DIR'
    exit 0
fi
COMMAND="${1:-}"
PROJECT="${EXPLORER_PREVIEW_PROJECT:-wcecoli-explorer}"
if [[ "$FAMILY" == explorer && ! "$PROJECT" =~ ^wcecoli-explorer(-[a-z0-9]+)?$ ]]; then
    echo 'Invalid explorer preview project name.' >&2
    exit 2
fi
SERVICE_ARGS=("$COMMAND")
skip=0
for value in "${@:2}"; do
    if [[ "$skip" == 1 ]]; then skip=0; continue; fi
    case "$value" in --state-dir|--output-dir|--cache-dir) skip=1;; *) SERVICE_ARGS+=("$value");; esac
done
# Reject service/volume arguments before touching Docker. Explorer commands own
# exactly one preview; they cannot act as an arbitrary Compose passthrough.
if [[ "$FAMILY" == explorer ]]; then
    case "$COMMAND" in bundle|fetch-data|verify|up|ps|logs|config|stop) ;;
        *) echo 'Unknown explorer command.' >&2; exit 2;; esac
    case "$COMMAND" in
        ps|stop) [[ ${#SERVICE_ARGS[@]} -eq 1 ]] || { echo 'This command takes no extra arguments.' >&2; exit 2; };;
        logs)
            for value in "${SERVICE_ARGS[@]:1}"; do
                [[ "$value" =~ ^(--tail=[0-9]+|--follow|-f|web)$ ]] || { echo 'Invalid explorer log argument.' >&2; exit 2; }
            done;;
        up|config)
            [[ "$COMMAND" != config || " $* " == *' --quiet '* ]] || { echo 'Only config --quiet is supported.' >&2; exit 2; }
            skip=0
            for value in "${@:2}"; do
                if [[ "$skip" == 1 ]]; then skip=0; continue; fi
                case "$value" in --bundle|--release|--state-dir|--output-dir|--cache-dir) skip=1;;
                    -d|--build|--quiet) ;;
                    *) echo 'Invalid explorer preview argument.' >&2; exit 2;; esac
            done;;
    esac
fi
while IFS= read -r key; do unset "$key"; done < <(compgen -v COMPOSE_ || true)
EXPLORER_STATE="$ROOT/interface/.explorer"
STATE="$EXPLORER_STATE"
[[ "$FAMILY" == publish ]] && STATE="$ROOT/interface/.publication"
OUTPUT=""
CACHE=""
ARGS=("$@")
INPUTS=()
for ((i=0;i<${#ARGS[@]};i++)); do
    case "${ARGS[i]}" in
        --state-dir) STATE="${ARGS[i+1]}";;
        --output-dir) OUTPUT="${ARGS[i+1]}";;
        --cache-dir) CACHE="${ARGS[i+1]}";;
        --bundle|--release|--authorization|--evidence)
            value="${ARGS[i+1]}"
            if [[ -d "$value" ]]; then value="$(cd "$value" && pwd -P)"
            elif [[ -f "$value" ]]; then value="$(cd "$(dirname "$value")" && pwd -P)/$(basename "$value")"
            else echo "Explicit input does not exist: ${ARGS[i]}" >&2; exit 2; fi
            ARGS[i+1]="$value"
            INPUTS+=("$value")
            ;;
    esac
done
if [[ "$FAMILY" == explorer ]]; then EXPLORER_STATE="$STATE"; fi
OUTPUT="${OUTPUT:-$EXPLORER_STATE/bundles}"
CACHE="${CACHE:-$EXPLORER_STATE/cache}"
mkdir -p "$STATE" "$OUTPUT" "$CACHE" "$EXPLORER_STATE"
STATE="$(cd "$STATE" && pwd -P)"
OUTPUT="$(cd "$OUTPUT" && pwd -P)"
CACHE="$(cd "$CACHE" && pwd -P)"
EXPLORER_STATE="$(cd "$EXPLORER_STATE" && pwd -P)"
if [[ "$FAMILY" == explorer && "$COMMAND" =~ ^(ps|logs|stop)$ ]]; then
    [[ -f "$STATE/compose.json" ]] || { echo 'No explorer preview configuration exists.' >&2; exit 2; }
    PROJECT=wcecoli-explorer
    if [[ -f "$STATE/preview-project" ]]; then
        IFS= read -r PROJECT < "$STATE/preview-project"
        [[ "$PROJECT" =~ ^wcecoli-explorer(-[a-z0-9]+)?$ ]] || { echo 'Invalid explorer preview project name.' >&2; exit 2; }
    fi
    exec docker compose --project-name "$PROJECT" --project-directory "$STATE" --env-file "$STATE/empty.env" --file "$STATE/compose.json" "${SERVICE_ARGS[@]}"
fi
if ! git -C "$ROOT" diff --quiet HEAD -- interface/explorer interface/frontend interface/backend/hf_export interface/platform.sh platform.sh LICENSE.md; then
    echo 'Commit maintained release inputs before packaging or running release tooling.' >&2
    exit 2
fi
if [[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard -- interface/explorer interface/frontend/src interface/backend/hf_export)" ]]; then
    echo 'Untracked maintained release inputs must be committed first.' >&2; exit 2
fi
REVISION="$(git -C "$ROOT" rev-parse HEAD)"
IMAGE="wcecoli-explorer-tooling:$REVISION"
# Docker orchestrates images/services on the host; tooling never gets its socket.
COMMAND="${ARGS[0]}"
if [[ "$FAMILY" == explorer && ( "$COMMAND" == up || "$COMMAND" == config ) ]]; then
    PREVIEW=1
    FILTERED=(preview-config)
    for ((i=1;i<${#ARGS[@]};i++)); do
        case "${ARGS[i]}" in -d|--build|--quiet) ;; *) FILTERED+=("${ARGS[i]}");; esac
    done
    ARGS=("${FILTERED[@]}")
else PREVIEW=0; fi
git -C "$ROOT" archive HEAD | docker build --platform linux/amd64 -t "$IMAGE" -f interface/explorer/tooling.Dockerfile - >&2
MOUNTS=()
SEEN='|'
for directory in "$STATE" "$OUTPUT" "$CACHE" "$EXPLORER_STATE"; do
    if [[ "$SEEN" != *"|$directory|"* ]]; then
        MOUNTS+=(--mount "type=bind,source=$directory,target=$directory")
        SEEN+="$directory|"
    fi
done
for directory in ${INPUTS[@]+"${INPUTS[@]}"}; do
    if [[ "$SEEN" != *"|$directory|"* ]]; then
        MOUNTS+=(--mount "type=bind,source=$directory,target=$directory,readonly")
        SEEN+="$directory|"
    fi
done
ENVIRONMENT=(-e "EXPLORER_GIT_REVISION=$REVISION" -e "EXPLORER_CALLER_ROOT=$ROOT")
if [[ "$PREVIEW" == 1 ]]; then ENVIRONMENT+=(-e "EXPLORER_PREVIEW_PROJECT=$PROJECT"); fi
if [[ "$COMMAND" != bundle ]]; then
    for key in HF_TOKEN HF_DATASET_READ_TOKEN HF_VERIFY_TOKEN HF_PUBLISH_TOKEN; do
        if [[ -n "${!key:-}" ]]; then ENVIRONMENT+=(-e "$key"); fi
    done
fi
git -C "$ROOT" archive HEAD | docker run --rm -i --platform linux/amd64 --user "$(id -u):$(id -g)" \
    "${MOUNTS[@]}" "${ENVIRONMENT[@]}" "$IMAGE" python -c '
import os,sys,tarfile
from pathlib import Path
root=Path("/tmp/source");root.mkdir()
with tarfile.open(fileobj=sys.stdin.buffer,mode="r|*") as archive:archive.extractall(root,filter="data")
os.execv(sys.executable,[sys.executable,str(root/"interface/explorer/portable.py"),*sys.argv[1:]])
' "${ARGS[@]}" --family "$FAMILY" --state-dir "$STATE" --output-dir "$OUTPUT" --cache-dir "$CACHE" --explorer-state-dir "$EXPLORER_STATE"
if [[ "$PREVIEW" == 1 && "$COMMAND" == up ]]; then
    exec docker compose --project-name "$PROJECT" --project-directory "$STATE" --env-file "$STATE/empty.env" --file "$STATE/compose.json" up -d --build
fi
