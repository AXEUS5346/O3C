# O3C — OpenCode free models in Claude Code

A local Anthropic-compatible bridge that lets Claude Code use OpenCode's free
models with:

- a **dynamic model catalog** (new free models appear, removed ones disappear),
- **real context/output limits** from the running OpenCode service,
- **true token streaming**,
- the full **Claude Code tool harness**, and
- a Claude capability profile (`modelPicker` + `behavesAs`) so the harness
  treats the free models as first-class coding models.

O3C is a developer tool. It is not affiliated with OpenCode or Anthropic.

## Requirements

- Linux
- Node.js **>= 22**
- `opencode` (v2.1.x) with a logged-in OpenCode account
- Claude Code (`claude`)

## Install

```bash
git clone <private-repo-url> ~/O3C
~/O3C/scripts/install.sh
```

The installer symlinks `claude-opencode` into `~/.local/bin` and creates the
runtime data/state directories. It does **not** modify `~/.claude/settings.json`
or `~/.config/opencode`.

## Quick start

```bash
claude-opencode --list                    # refresh + list current free models
claude-opencode -m deepseek -p "hello"    # one-shot
claude-opencode -m glm                    # interactive
claude-opencode --status                  # bridge, transport, catalog, usage
claude-opencode --stop
```

The first launch starts a dedicated OpenCode service in the background. Your
own OpenCode TUI/config is untouched.

## Dynamic catalog

The catalog is read from the running OpenCode service (`/api/model`), filtered
to provider `opencode`, active/enabled, free (cost 0) and text output. Example:

```text
source: service   updated: 2026-11-01T...   default: deepseek-v4.1-flash-free
      beam           beam-free                          ctx  1,048,576  out   131,072  text
[new] big-pickle     big-pickle                         ctx    200,000  out    32,000  text
      deepseek       deepseek-v4.1-flash-free           ctx    200,000  out    32,000  vision
      flint          flint-40b-free                     ctx    262,144  out    65,536  text
      glm            glm-5.3-flash-free                 ctx    200,000  out    32,000  vision
      mimo           mimo-v2.6-flash-free               ctx    200,000  out    32,000  vision
      lightning      nemotron-3.5-lightning-free        ctx    262,144  out   262,144  text
      super          nemotron-3.5-super-vl-free         ctx  1,048,576  out   131,072  vision
```

- Aliases are generated automatically; full IDs always work.
- New models are marked `[new]` for seven days.
- Removed models disappear and are listed under `removed:`.
- Refresh every 5 minutes; a models.dev drift check every 15 minutes; `--list`
  forces a refresh (it may briefly restart the transport).
- Real `limit.context/input/output` and vision capability come from the runtime.

## Free-tier reality (read this)

OpenCode's free models are **limited-time promotional access**, not an unlimited
or high daily allowance. In practice the free allowance is enforced
**per model**: one model can return `Free usage limit reached` while another
still serves (the upstream message says “or switch models”). Community reports
put allowances in the tens of requests per model per day (some accounts report
higher); OpenCode itself uses low-cost models for session titles, and Claude
Code can generate several requests per turn (main, small/fast, title, retries).
A few dozen real harness turns can exhaust a model's allowance.

O3C includes a local **daily request budget** (default **40** bridge requests,
UTC day) so tests and agent loops cannot silently drain the account. Usage is
shown in `--status`:

```json
"usage": { "date": "2026-11-01", "used": 4, "budget": 40, "remaining": 36,
           "by_model": { "deepseek-v4.1-flash-free": 3, "beam-free": 1 },
           "reset_at": "..." }
```

When the budget is hit, the bridge returns a local 429 with `Retry-After` and
does **not** call upstream. `OPENCODE_FREE_DAILY_BUDGET=0` disables the guard.
The guard counts bridge traffic only (total and per model); your OpenCode TUI
usage is not visible to it, so keep headroom. A model can still hit its own
upstream free limit while the total bridge budget has room.

If the upstream returns `FreeUsageLimitError`, Claude Code now shows the API
error immediately instead of retrying/hanging. The allowance resets on
OpenCode's daily schedule. OpenCode Go is a separate paid plan with higher
limits; O3C does not use it.

## How it works

**The gate.** The free tier only accepts requests from OpenCode's standard
`build` agent context — its system prompt and standard tool set. Direct HTTP
calls, custom agents, or the build agent with tools stripped return 429. O3C
runs a dedicated OpenCode server and uses its own model pipeline.

**Transport.** `src/server.mjs` starts/reuses a dedicated `opencode serve`
instance (default port 8791) with a 0600 copy of your auth. Each Claude Code
request creates one OpenCode session and calls
`POST /api/session/:id/prompt`, consuming `GET /api/event`.

**Streaming.** `session.text.delta` events become Anthropic
`content_block_delta` SSE events; `message_start` is sent on admission, pings
keep the connection alive during reasoning, and tool-call JSON is buffered so it
is not shown as text.

**Tools.** Claude Code's full tool set is included in the prompt. The model
answers with the text protocol:

```json
{"tool_use":{"name":"Read","input":{"file_path":"..."}}}
{"tool_uses":[{"name":"Bash","input":{"command":"..."}}]}
```

O3C converts this to Anthropic `tool_use` blocks; Claude Code executes its own
tools (Read, Bash, Edit, Task, TodoWrite, MCP, ...) and returns results in the
next request. OpenCode's tools are not used.

**Real limits.** The prompt budget uses the runtime `limit.context/input/output`.
The launcher exports `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the catalog.

**Harness mapping.** The launcher writes `claude-settings.json` with a
`modelPicker` row per free model and `behavesAs: "claude-opus-4-8"` (override
with `OPENCODE_FREE_BEHAVES_AS`). This gives the harness a known Claude prompt
profile/capability handling for the free model IDs; the actual ID sent is
unchanged.

## Configuration

| env | default | purpose |
|---|---|---|
| `OPENCODE_FREE_PORT` | `8787` | Anthropic bridge port |
| `OPENCODE_FREE_TRANSPORT` | `service` | `service` or `direct` (tests/mocks) |
| `OPENCODE_FREE_SERVICE_PORT` | `8791` | dedicated OpenCode server port |
| `OPENCODE_FREE_SERVICE_AGENT` | `build` | gate-required agent context |
| `OPENCODE_FREE_SERVICE_URL` | unset | reuse an existing OpenCode service (tests) |
| `OPENCODE_FREE_SERVICE_PASSWORD` | unset | password for that service |
| `OPENCODE_FREE_DAILY_BUDGET` | `40` | local bridge requests/day; `0` disables |
| `OPENCODE_FREE_DEFAULT_MODEL` | `deepseek-v4.1-flash-free` | default/fallback |
| `OPENCODE_FREE_BEHAVES_AS` | `claude-opus-4-8` | Claude profile for picker rows |
| `OPENCODE_FREE_DATA_DIR` | `~/.local/share/opencode-free-bridge` | data/dedicated home |
| `OPENCODE_FREE_HOME` | `$DATA_DIR/opencode-home` | dedicated OpenCode HOME |
| `OPENCODE_FREE_WORKDIR` | `.../state/.../workdir` | session workdir |
| `OPENCODE_BIN` | `opencode` | OpenCode binary |
| `OPENCODE_FREE_VERBOSE` | off | request logging |

## Tests

```bash
npm test                 # unit tests (no quota)
npm run test:direct      # Claude Code <-> bridge <-> OpenAI mock (no quota)
npm run test:service     # Claude Code <-> bridge <-> mock OpenCode service (no quota)
npm run test:live        # one request per current free model (uses quota!)
```

The mock service tests exercise the dynamic catalog, real limits, streaming,
and a real Read tool round-trip. Use them for code verification; use the live
smoke sparingly after a quota reset.

## Repo layout

```text
bin/claude-opencode          launcher (repo-aware; symlinked on install)
src/server.mjs               bridge, transport, streaming, catalog, budget
scripts/install.sh           installer/symlink
test/translate.test.mjs      unit tests
test/mock-upstream.mjs       OpenAI-compatible mock (direct transport)
test/mock-opencode-service.mjs  OpenCode service mock
test/e2e.sh                  direct-transport E2E
test/e2e-service.sh          full service-transport E2E
test/live-smoke.sh           live one-shot per current model
docs/ARCHITECTURE.md         request flow and state
docs/REA-FINDINGS.md         reverse-engineering notes
```

Runtime state:

- `~/.local/share/opencode-free-bridge/` — dedicated OpenCode home, auth copy,
  generated `claude-settings.json`
- `~/.local/state/opencode-free-bridge/` — bridge/service logs, catalog snapshot,
  usage counter, project/session state

## Security

See `SECURITY.md`. The bridge binds to `127.0.0.1`; credentials are copied at
runtime with mode 0600; no secrets belong in the repository.

## Limitations

- Tool calls use a JSON text protocol, not provider-native function calling;
  arguments arrive as one block.
- Images/audio are not forwarded.
- Streaming is text-only; reasoning is not exposed.
- The catalog follows OpenCode's runtime view; a legacy cost-0 model may appear
  even if its free allowance is unavailable on the account.
- The free tier is limited-time, request-capped and shared; O3C does not bypass
  it.

## Uninstall

```bash
claude-opencode --stop
rm ~/.local/bin/claude-opencode
rm -rf ~/.local/share/opencode-free-bridge ~/.local/state/opencode-free-bridge
```

## Free-tier references

- <https://opencode.ai/v2/docs/console/models/>
- <https://opencode.ai/v2/docs/console/go/>
- <https://github.com/anomalyco/opencode/issues/33495>
