#!/usr/bin/env bash
# End-to-end: npm-installed launcher -> bridge -> mock OpenCode service -> Claude Code.
# Verifies the installed shim on this OS without spending real free-model quota.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/o3c-launcher.XXXXXX")"
BIN="$ROOT/bin"
DATA="$ROOT/data"
STATE="$ROOT/state"
WORK="$ROOT/work"
BRIDGE_PORT="${MOCK_BRIDGE_PORT:-8796}"
MOCK_PORT="${MOCK_SERVICE_PORT:-8797}"
MOCK_PID=""
LAUNCHER="${O3C_LAUNCHER_BIN:-$BIN/o3c}"
mkdir -p "$WORK"

export OPENCODE_FREE_DATA_DIR="$DATA"
export OPENCODE_FREE_STATE_DIR="$STATE"
export OPENCODE_FREE_TRANSPORT=service
export OPENCODE_FREE_PORT="$BRIDGE_PORT"
export OPENCODE_FREE_SERVICE_URL="http://127.0.0.1:$MOCK_PORT"
export OPENCODE_FREE_SERVICE_PASSWORD=mock
export OPENCODE_FREE_DAILY_BUDGET=40

stop_bridge() {
  if [ -x "$LAUNCHER" ] || [ -f "$LAUNCHER.cmd" ]; then
    "$LAUNCHER" --stop >/dev/null 2>&1 || true
  fi
}

cleanup() {
  stop_bridge
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

echo "== install =="
if [ -z "${O3C_LAUNCHER_BIN:-}" ]; then
  node "$DIR/scripts/install.mjs" --bin-dir "$BIN" --data-dir "$DATA" --state-dir "$STATE"
else
  echo "using external launcher: $LAUNCHER"
fi

MOCK_SERVICE_PORT="$MOCK_PORT" node "$DIR/test/mock-opencode-service.mjs" 2>"$ROOT/mock.log" &
MOCK_PID=$!
for _ in $(seq 1 100); do
  curl -fsS --max-time 1 "http://127.0.0.1:$MOCK_PORT/api/info" >/dev/null 2>&1 && break
  sleep 0.1
done

echo "== launcher dynamic catalog =="
"$LAUNCHER" --list >"$ROOT/list.out" 2>"$ROOT/list.err"
cat "$ROOT/list.out"
grep -q "mock-deepseek-free" "$ROOT/list.out"
grep -q "mock-glm-free" "$ROOT/list.out"
grep -q "100,000" "$ROOT/list.out"
grep -q "settings: .* (2 models)" "$ROOT/list.out"
if grep -Eq "mock-paid|mock-deprecated-free|mock-go-free" "$ROOT/list.out"; then
  echo "FAIL: non-free model leaked into catalog"
  exit 1
fi
node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if ((value.modelPicker.options || []).length !== 2) {
  console.error("settings modelPicker does not match catalog");
  process.exit(1);
}
if (value.env?.ANTHROPIC_BASE_URL !== process.argv[2]) {
  console.error("settings bridge URL mismatch: " + JSON.stringify(value.env));
  process.exit(1);
}
' "$DATA/claude-settings.json" "http://127.0.0.1:$BRIDGE_PORT"

echo "== catalog updates every invocation =="
curl -fsS "http://127.0.0.1:$MOCK_PORT/control/add-model" >/dev/null
curl -fsS "http://127.0.0.1:$MOCK_PORT/control/bump-context" >/dev/null
"$LAUNCHER" --list >"$ROOT/list2.out" 2>"$ROOT/list2.err"
cat "$ROOT/list2.out"
grep -q "mock-new-free" "$ROOT/list2.out"
grep -q "111,111" "$ROOT/list2.out"
grep -q "123,000" "$ROOT/list2.out"

cd "$WORK"
echo "== claude text through installed launcher =="
timeout 120 "$LAUNCHER" -m mock-glm-free -p "Reply with exactly PONG" >"$ROOT/text.out" 2>"$ROOT/text.err"
cat "$ROOT/text.out"
grep -q "PONG" "$ROOT/text.out" || { echo "FAIL text"; cat "$ROOT/text.err"; exit 1; }
grep -q "ctx=123000" "$ROOT/text.err" || { echo "FAIL: launch did not refresh catalog context"; cat "$ROOT/text.err"; exit 1; }

echo "== model memory =="
node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (value.model !== "mock-glm-free") {
  console.error("last model was not recorded: " + JSON.stringify(value));
  process.exit(1);
}
' "$STATE/last-model.json"
timeout 120 "$LAUNCHER" -p "Reply with exactly PONG" >"$ROOT/memory.out" 2>"$ROOT/memory.err"
grep -q "PONG" "$ROOT/memory.out" || { echo "FAIL: remembered-model call"; cat "$ROOT/memory.err"; exit 1; }
grep -q "model=mock-glm" "$ROOT/memory.err" || { echo "FAIL: launcher did not reuse last model"; cat "$ROOT/memory.err"; exit 1; }

echo "== claude tool round-trip through installed launcher =="
timeout 120 "$LAUNCHER" -m mock-deepseek-free -p tooltest --allowedTools Read >"$ROOT/tool.out" 2>"$ROOT/tool.err"
cat "$ROOT/tool.out"
grep -q "TOOL_RESULT_SEEN" "$ROOT/tool.out" || { echo "FAIL tool"; cat "$ROOT/tool.err"; exit 1; }
grep -q "archlinux" "$ROOT/tool.out" || { echo "FAIL tool content"; cat "$ROOT/tool.err"; exit 1; }
node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (value.model !== "mock-deepseek-free") {
  console.error("last model was not updated: " + JSON.stringify(value));
  process.exit(1);
}
' "$STATE/last-model.json"

echo "== background requests follow the main model =="
curl -sS --max-time 60 "http://127.0.0.1:$BRIDGE_PORT/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"mock-glm-free","messages":[{"role":"user","content":"background"}]}' >"$ROOT/background.out"
cat "$ROOT/background.out"
grep -q "PONG" "$ROOT/background.out" || { echo "FAIL background request"; cat "$ROOT/background.out"; exit 1; }
node -e '
const fs = require("fs");
const message = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (message.usage?.cache_read_input_tokens !== 80 || message.usage?.cache_creation_input_tokens !== 20) {
  console.error("prompt cache usage missing: " + JSON.stringify(message.usage));
  process.exit(1);
}
' "$ROOT/background.out"
grep -q "service model=mock-glm-free -> mock-deepseek-free .*tools=0" "$STATE/bridge.log" || {
  echo "FAIL: background model did not follow last main model"
  tail -n 20 "$STATE/bridge.log"
  exit 1
}

echo "== streaming =="
curl -sN --max-time 60 "http://127.0.0.1:$BRIDGE_PORT/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"mock-deepseek-free","stream":true,"messages":[{"role":"user","content":"streamtest"}]}' >"$ROOT/stream.out"
deltas="$(grep -c 'event: content_block_delta' "$ROOT/stream.out" || true)"
echo "content_block_delta events: $deltas"
[ "$deltas" -ge 2 ] || { echo "FAIL streaming"; cat "$ROOT/stream.out"; exit 1; }
grep -q '"cache_read_input_tokens":80' "$ROOT/stream.out" || { echo "FAIL streaming cache usage"; cat "$ROOT/stream.out"; exit 1; }

echo "== usage =="
curl -fsS "http://127.0.0.1:$BRIDGE_PORT/health" | node -e '
let s = "";
process.stdin.on("data", (d) => s += d).on("end", () => {
  const health = JSON.parse(s);
  const usage = health.usage || {};
  if (usage.budget !== 40) { console.error("budget not 40: " + JSON.stringify(usage)); process.exit(1); }
  if (!(usage.used >= 6)) { console.error("usage not counted: " + JSON.stringify(usage)); process.exit(1); }
  if (!(usage.by_model && usage.by_model["mock-deepseek-free"] >= 3 && usage.by_model["mock-glm-free"] >= 2)) {
    console.error("per-model usage missing: " + JSON.stringify(usage));
    process.exit(1);
  }
  console.log("usage OK: " + usage.used + "/" + usage.budget + " by_model " + JSON.stringify(usage.by_model));
});
'

echo "== stop =="
"$LAUNCHER" --stop
for _ in $(seq 1 50); do
  if ! curl -fsS --max-time 1 "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if curl -fsS --max-time 1 "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1; then
  echo "FAIL: bridge still running after --stop"
  exit 1
fi
if "$LAUNCHER" --status >/dev/null 2>&1; then
  echo "FAIL: --status succeeded after --stop"
  exit 1
fi

echo "E2E LAUNCHER OK"
