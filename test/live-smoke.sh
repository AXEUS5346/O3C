#!/usr/bin/env bash
# One tiny request per current free model through a temporary live bridge.
# Models are read dynamically from the catalog; one free request per model.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-8789}"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

OPENCODE_FREE_TRANSPORT=service OPENCODE_FREE_PORT="$PORT" node "$DIR/src/server.mjs" 2>/tmp/opencode-free-smoke.log &
PID=$!
for _ in $(seq 1 50); do
  curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done

catalog="$(curl -fsS --max-time 180 "http://127.0.0.1:$PORT/v1/models?refresh=1")"
if [ -z "$catalog" ]; then
  echo "FAIL could not load the model catalog" >&2
  exit 1
fi
mapfile -t rows < <(printf '%s' "$catalog" | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  try {
    const cat = JSON.parse(s);
    for (const m of cat.data || []) console.log(m.id + "\t" + (m.alias || m.id));
  } catch { process.exit(1); }
});
')
if [ "${#rows[@]}" -eq 0 ]; then
  echo "FAIL empty model catalog" >&2
  exit 1
fi
ok=0
fail=0
for row in "${rows[@]}"; do
  IFS=$'\t' read -r model alias <<<"$row"
  body="{\"model\":\"$model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}"
  out="$(curl -s -w '\n%{http_code}' --max-time 180 "http://127.0.0.1:$PORT/v1/messages" -H 'content-type: application/json' -d "$body")"
  code="${out##*$'\n'}"
  payload="${out%$'\n'*}"
  if [ "$code" = "200" ]; then
    text="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join(" ").slice(0,80))}catch{console.log("unparseable")}})')"
    echo "OK   $alias ($model) -> $text"
    ok=$((ok+1))
  else
    msg="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).error.message.slice(0,160))}catch{console.log(s.slice(0,160))}})')"
    echo "FAIL $alias ($model) (HTTP $code) -> $msg"
    fail=$((fail+1))
  fi
done
echo "passed=$ok failed=$fail"
[ "$fail" -eq 0 ]
