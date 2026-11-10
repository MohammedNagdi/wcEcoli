#!/usr/bin/env bash
# Canonical local platform launcher. Environment files are parsed by Compose, not Bash.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<'USAGE'
Usage: ./platform.sh demo <prepare|run|status|cleanup|preview|stop>
       ./platform.sh pilot <prepare|run|status|preview|stop>
       ./platform.sh local <docker compose arguments...>
       ./platform.sh explorer <bundle|up|ps|logs|config|stop>
       ./platform.sh publish <check|dataset|space|update-space|status>

Examples (from the repository root or interface directory):
  ./platform.sh local up -d --build             # full local platform
  ./platform.sh local up -d --build api web     # website only
  ./platform.sh local ps
  ./platform.sh local logs --tail=50 api
  ./platform.sh local build sim-runner
  ./platform.sh local config --quiet
  ./platform.sh local stop
USAGE
}

MODE="${1:-}"
case "$MODE" in
    publish)
        shift
        PYTHON="$SCRIPT_DIR/.explorer/venv/bin/python"
        if [[ ! -x "$PYTHON" ]]; then
            echo "Publication requires the isolated HF-07 Python environment; see the HF-08 guide." >&2
            exit 2
        fi
        exec "$PYTHON" "$SCRIPT_DIR/explorer/publish.py" "$@"
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    explorer)
        shift
        exec python3 "$SCRIPT_DIR/explorer/host.py" "$@"
        ;;
    pilot)
        shift
        exec python3 "$SCRIPT_DIR/pilot/host.py" "$@"
        ;;
    demo)
        shift
        exec python3 "$SCRIPT_DIR/pilot/demo_host.py" "$@"
        ;;
    local)
        shift
        if [[ "$#" -eq 0 ]]; then
            usage >&2
            exit 2
        fi
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

ENV_FILE="$SCRIPT_DIR/.env.example"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    ENV_FILE="$SCRIPT_DIR/.env"
fi

# Explicit paths prevent cwd-based configuration/environment discovery. Compose
# still honors shell variables and intentional --project-name/-p overrides.
exec docker compose \
    --project-directory "$SCRIPT_DIR" \
    --file "$SCRIPT_DIR/docker-compose.yml" \
    --env-file "$ENV_FILE" \
    "$@"
