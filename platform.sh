#!/usr/bin/env bash
# Delegate to the single launcher implementation, regardless of the caller's cwd.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/interface/platform.sh" "$@"
