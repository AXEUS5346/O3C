#!/usr/bin/env bash
# End-to-end: real Claude Code -> bridge -> scripted mock upstream.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT=8990
BRIDGE_PORT=8788
MOCK_PID=""
BRIDGE_PID=""

cleanup() {
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== unit tests =="
node --test "$DIR/test/translate.test.mjs"

echo "== start mock upstream =="
MOCK_PORT=$MOCK_PORT node "$DIR/test/mock-upstream.mjs" 2>"/tmp/mock-upstream.log" &
MOCK_PID=$!

echo "== start bridge =="
OPENCODE_FREE_TRANSPORT=direct OPENCODE_FREE_PORT=$BRIDGE_PORT OPENCODE_FREE_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1" OPENCODE_FREE_SESSION_ID="ses_000000000000TEST0000000000" \
  node "$DIR/src/server.mjs" 2>"/tmp/bridge-e2e.log" &
BRIDGE_PID=$!

for _ in $(seq 1 50); do
  curl -fsS --max-time 1 "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.1
done

export ANTHROPIC_BASE_URL="http://127.0.0.1:${BRIDGE_PORT}"
export ANTHROPIC_AUTH_TOKEN="opencode-free-test"
export ANTHROPIC_MODEL="beam-free"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1

WORK="$(mktemp -d /tmp/claude-bridge-e2e.XXXXXX)"
cd "$WORK"

echo "== test 1: plain text =="
timeout 150 claude --print --model beam-free "Reply with exactly PONG" >"$WORK/text.out" 2>"$WORK/text.err"
cat "$WORK/text.out"
grep -q "PONG" "$WORK/text.out" || { echo "FAIL: no PONG"; tail -20 "$WORK/text.err"; exit 1; }

echo "== test 2: tool call round-trip =="
printf 'hello from the bridge e2e test\n' > /tmp/claude-opencode-test.txt
timeout 150 claude -p "tooltest" --model beam-free --allowedTools "Read" >"$WORK/tool.out" 2>"$WORK/tool.err"
cat "$WORK/tool.out"
grep -q "TOOL_RESULT_SEEN" "$WORK/tool.out" || { echo "FAIL: no tool round-trip"; tail -30 "$WORK/tool.err"; exit 1; }
grep -q "hello from the bridge" "$WORK/tool.out" || { echo "FAIL: tool output missing"; tail -30 "$WORK/tool.err"; exit 1; }

echo "== mock requests =="
cat /tmp/mock-upstream.log
echo "E2E OK"
