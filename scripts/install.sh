#!/usr/bin/env bash
# Install O3C into the user's environment. Idempotent; does not touch
# ~/.claude/settings.json or ~/.config/opencode.
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_DIR="${OPENCODE_FREE_DATA_DIR:-$HOME/.local/share/opencode-free-bridge}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-free-bridge"

mkdir -p "$BIN_DIR" "$DATA_DIR" "$STATE_DIR"
chmod +x "$REPO_ROOT/bin/claude-opencode"

if ! command -v node >/dev/null 2>&1; then
  echo "install: Node.js >= 22 is required" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "install: Node.js >= 22 is required (found $(node --version))" >&2
  exit 1
fi
command -v claude >/dev/null 2>&1 || echo "install: warning: 'claude' (Claude Code) not found on PATH" >&2
command -v opencode >/dev/null 2>&1 || echo "install: warning: 'opencode' not found on PATH" >&2

ln -sfn "$REPO_ROOT/bin/claude-opencode" "$BIN_DIR/claude-opencode"

cat <<EOF
Installed claude-opencode -> $BIN_DIR/claude-opencode
Source:  $REPO_ROOT
Data:    $DATA_DIR
State:   $STATE_DIR

Next:
  claude-opencode --list
  claude-opencode -m deepseek -p "Reply with exactly OK"

The bridge copies your OpenCode auth into $DATA_DIR/opencode-home at runtime
(mode 0600) and never edits your OpenCode or Claude Code configuration.

EOF
