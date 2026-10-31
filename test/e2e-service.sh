#!/usr/bin/env bash
# Full service-transport E2E: Claude Code -> bridge -> mock OpenCode service.
# Verifies dynamic catalog, streaming, and tool round-trips without real quota.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT="${MOCK_SERVICE_PORT:-8792}"
BRIDGE_PORT="${MOCK_BRIDGE_PORT:-8790}"
STATE="$(mktemp -d /tmp/oc-mock-state.XXXXXX)"
WORK="$(mktemp -d /tmp/oc-mock-work.XXXXXX)"
MOCK_PID=""
BRIDGE_PID=""

cleanup() {
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$STATE" "$WORK" /tmp/mock-stream.out
}
trap cleanup EXIT

MOCK_SERVICE_PORT="$MOCK_PORT" node "$DIR/test/mock-opencode-service.mjs" 2>/tmp/mock-service.log &
MOCK_PID=$!

XDG_STATE_HOME="$STATE" \
OPENCODE_FREE_TRANSPORT=service \
OPENCODE_FREE_PORT="$BRIDGE_PORT" \
OPENCODE_FREE_SERVICE_URL="http://127.0.0.1:$MOCK_PORT" \
OPENCODE_FREE_SERVICE_PASSWORD=mock \
  node "$DIR/src/server.mjs" 2>/tmp/mock-bridge.log &
BRIDGE_PID=$!

BASE="http://127.0.0.1:$BRIDGE_PORT"
for _ in $(seq 1 100); do
  curl -fsS --max-time 1 "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.1
done

echo "== dynamic catalog =="
CATALOG="$(curl -fsS --max-time 60 "$BASE/v1/models?refresh=1")"
printf '%s' "$CATALOG" | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const cat = JSON.parse(s);
  const ids = new Set((cat.data || []).map((m) => m.id));
  const must = ["mock-deepseek-free", "mock-glm-free"];
  const banned = ["mock-paid", "mock-deprecated-free", "mock-go-free"];
  for (const id of must) if (!ids.has(id)) { console.error("missing " + id); process.exit(1); }
  for (const id of banned) if (ids.has(id)) { console.error("unexpected " + id); process.exit(1); }
  const glm = (cat.data || []).find((m) => m.id === "mock-glm-free");
  if (glm.context_window !== 100000 || glm.max_output_tokens !== 16000) { console.error("wrong limits"); process.exit(1); }
  if (!glm.vision) { console.error("missing vision"); process.exit(1); }
  console.log("catalog OK: " + [...ids].join(", "));
});
'

export ANTHROPIC_BASE_URL="$BASE"
export ANTHROPIC_AUTH_TOKEN="mock"
export ANTHROPIC_MODEL="mock-deepseek-free"
export ANTHROPIC_SMALL_FAST_MODEL="mock-deepseek-free"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="200000"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="32000"
unset ANTHROPIC_API_KEY
cd "$WORK"

echo "== claude text =="
timeout 120 claude -p "Reply with exactly PONG" >"$WORK/text.out" 2>"$WORK/text.err"
cat "$WORK/text.out"
grep -q "PONG" "$WORK/text.out" || { echo "FAIL text"; cat "$WORK/text.err"; exit 1; }

echo "== claude tool round-trip =="
timeout 120 claude -p "tooltest" --allowedTools Read >"$WORK/tool.out" 2>"$WORK/tool.err"
cat "$WORK/tool.out"
grep -q "TOOL_RESULT_SEEN" "$WORK/tool.out" || { echo "FAIL tool"; cat "$WORK/tool.err"; exit 1; }
grep -q "archlinux" "$WORK/tool.out" || { echo "FAIL tool content"; cat "$WORK/tool.err"; exit 1; }

echo "== streaming =="
curl -sN --max-time 60 "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"mock-deepseek-free","stream":true,"messages":[{"role":"user","content":"streamtest"}]}' > /tmp/mock-stream.out
deltas="$(grep -c 'event: content_block_delta' /tmp/mock-stream.out || true)"
echo "content_block_delta events: $deltas"
[ "$deltas" -ge 2 ] || { echo "FAIL streaming"; cat /tmp/mock-stream.out; exit 1; }

echo "== local budget counter =="
HEALTH="$(curl -fsS "$BASE/health")"
printf '%s' "$HEALTH" | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const h = JSON.parse(s);
  const u = h.usage || {};
  if (u.budget !== 40) { console.error("budget not 40: " + JSON.stringify(u)); process.exit(1); }
  if (!(u.used >= 4)) { console.error("usage not counted: " + JSON.stringify(u)); process.exit(1); }
  if (!(u.by_model && u.by_model["mock-deepseek-free"] >= 3)) { console.error("per-model usage missing: " + JSON.stringify(u)); process.exit(1); }
  console.log("usage OK: " + u.used + "/" + u.budget + " reset " + u.reset_at + " by_model " + JSON.stringify(u.by_model));
});
'

echo "E2E SERVICE OK"
