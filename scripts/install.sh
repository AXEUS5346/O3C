#!/usr/bin/env bash
# Compatibility wrapper: the cross-platform installer is scripts/install.mjs.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/install.mjs" "$@"
