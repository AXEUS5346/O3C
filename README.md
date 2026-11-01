# O3C — OpenCode free models in Claude Code

[Source](https://github.com/AXEUS5346/O3C) · [npm](https://www.npmjs.com/package/@axeus/o3c) · MIT

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

- Linux, macOS, or Windows 10/11
- Node.js **>= 22**
- OpenCode **2.x** (`opencode` v2.1.4 verified) with a logged-in OpenCode account
- Claude Code **2.1.242+** (2.1.257+ recommended) — older versions cannot show
  the custom model picker and only list the active model

## Check prerequisites

```bash
o3c --doctor
```

The doctor checks Node, OpenCode 2.x, your OpenCode login and Claude Code,
including the Claude Code version required for the custom model picker. It
prints the exact install/update command for your OS and exits non-zero while a
required item is missing. Every normal launch runs the same preflight: it stops
with the same instructions instead of failing later inside the bridge. A missing
OpenCode login is shown as a warning with `opencode auth login` guidance.

Older Claude Code versions show only the active custom model in `/model`, even
though the bridge catalog has more. If that happens, run `claude --version` and
update to at least 2.1.242 (`claude update` for native installs). `o3c --doctor`
also reports the generated picker count and warns if `~/.claude/settings.json`
defines a conflicting `modelPicker`.

## Install

Install globally from npm (Linux, macOS, Windows). The package is scoped as
`@axeus/o3c`; the command it installs is `o3c`.

```bash
npm install -g @axeus/o3c
o3c --doctor
o3c --list
```

No clone or extra installer step is needed: npm creates the `o3c` command, and
the launcher creates its data/state directories on first use.

Alternatives:

```bash
# Install from the public GitHub repository
npm install -g github:AXEUS5346/O3C

# Run without a global install
npx --yes --package @axeus/o3c o3c --list

# Source checkout (development or custom bin/data/state directories)
git clone https://github.com/AXEUS5346/O3C.git
cd O3C
npm run install:o3c
```

The source installer is a Node script, so the same command works in bash, zsh,
PowerShell and cmd.exe. It creates a launcher shim in the platform bin directory:

| OS | default bin dir | shim |
|---|---|---|
| Linux | `${XDG_BIN_HOME:-~/.local/bin}` | symlink to `bin/o3c.mjs` |
| macOS | `${XDG_BIN_HOME:-~/.local/bin}` | symlink to `bin/o3c.mjs` |
| Windows | `npm prefix -g` (usually `%APPDATA%\npm`) | `.cmd`, `.ps1` and POSIX sh shims |

Options:

```bash
npm run install:o3c -- --bin-dir /custom/bin
npm run install:o3c -- --data-dir /custom/data --state-dir /custom/state
npm run install:o3c -- --uninstall          # keeps data and state
npm run install:o3c -- --force              # replace an unrecognized shim (backs it up)
```

`scripts/install.sh` remains as a thin compatibility wrapper for Unix users.
The source installer creates the runtime directories and prints a PATH hint if
the bin directory is not on PATH. It does **not** modify
`~/.claude/settings.json` or `~/.config/opencode`.

Keep O3C current with:

```bash
o3c update --check
o3c update
```

It detects npm, GitHub and source installs, updates in place, and refuses to
pull a source checkout with uncommitted changes. Restart sessions afterward with
`o3c --stop && o3c`. An existing `claude-opencode` shim from an older release is
migrated automatically by the source installer.

Platform data locations:

| OS | data | state |
|---|---|---|
| Linux | `${XDG_DATA_HOME:-~/.local/share}/opencode-free-bridge` | `${XDG_STATE_HOME:-~/.local/state}/opencode-free-bridge` |
| macOS | `~/Library/Application Support/opencode-free-bridge` | `<data>/state` |
| Windows | `%LOCALAPPDATA%\opencode-free-bridge` | `<data>\state` |

## Quick start

```bash
o3c --doctor                              # check prerequisites and get fixes
o3c --list                                # refresh + list current free models
o3c -m deepseek -p "hello"                # one-shot
o3c -m glm                                # interactive
o3c --status                              # bridge, transport, catalog, usage
o3c update --check                        # check for an O3C update
o3c update                                # update O3C itself
o3c --stop
```

The first launch starts a dedicated OpenCode service in the background. Your
own OpenCode TUI/config is untouched.

## Troubleshooting

- **Only the active model appears in `/model`**: Claude Code older than 2.1.242
  ignores `modelPicker`. Run `claude update` (or reinstall Claude Code), then
  relaunch `o3c`. `o3c --doctor` now reports the version and picker row count.
- **`API Error: Connection refused`**: Claude Code cannot reach the local
  bridge. Launch through `o3c`, then check `o3c --status` and `o3c --log`. If
  the bridge is not running, run `o3c --stop` and `o3c --list` and inspect the
  reported error. Do not run plain `claude` with a stale `ANTHROPIC_BASE_URL`.
  In WSL, a container, or a sandbox, run O3C in the same network namespace as
  Claude Code; `127.0.0.1` is not shared across namespaces. If a proxy is set,
  keep `127.0.0.1` and `localhost` in `NO_PROXY` (O3C adds them automatically
  to its own child processes). O3C also writes the bridge URL/auth into the
  generated `--settings` file, so a stale Claude Code gateway URL cannot
  override it; `o3c --doctor` warns if it finds one.
- **A model says the Bash tool is unavailable**: O3C forwards the complete
  Claude Code tool set. Verify the session was launched with `o3c` and that
  Bash is not denied by Claude Code permissions. Test with
  `o3c -p "Use the Bash tool to run echo HARNESS_OK" --allowedTools Bash`.

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
- **Every launch and every `--list` re-reads the live catalog**, including
  context/output limits and vision capability.
- The last main model you use is remembered in `<state>/last-model.json`; new
  launches reuse it, and Claude Code’s background requests follow it.
- Background refresh every 5 minutes; a models.dev drift check every 15 minutes.
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

**Prompt cache.** O3C accepts Claude Code’s cacheable requests and forwards the
cache-read/cache-creation token counts reported by OpenCode into Anthropic
`usage.cache_*` fields. The static tool/system prefix is kept stable at the top
of the prompt to maximize provider-side cache hits. Actual caching depends on
the upstream model; free models may not support prompt caching.

**Harness mapping.** The launcher writes `claude-settings.json` with a
`modelPicker` row per free model and `behavesAs: "claude-opus-4-6"` (override
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
| `OPENCODE_FREE_BEHAVES_AS` | `claude-opus-4-6` | Claude profile for picker rows |
| `OPENCODE_FREE_DATA_DIR` | platform data dir | data/dedicated home |
| `OPENCODE_FREE_STATE_DIR` | platform state dir | logs, pid, catalog, usage |
| `OPENCODE_FREE_BIN_DIR` | platform bin dir | installer target |
| `OPENCODE_FREE_HOME` | `$DATA_DIR/opencode-home` | dedicated OpenCode HOME |
| `OPENCODE_FREE_WORKDIR` | `.../state/.../workdir` | session workdir |
| `OPENCODE_BIN` | `opencode` | OpenCode binary |
| `OPENCODE_FREE_VERBOSE` | off | request logging |

## Tests

```bash
npm test                 # unit + installer tests (no quota)
npm run test:install     # cross-platform installer tests only
npm run test:direct      # Claude Code <-> bridge <-> OpenAI mock (no quota)
npm run test:service     # Claude Code <-> bridge <-> mock OpenCode service (no quota)
npm run test:launcher    # installed shim + mock service + Claude Code (no quota)
O3C_ALLOW_LIVE=1 npm run test:live   # real quota; opt-in only
```

Live smoke is blocked unless `O3C_ALLOW_LIVE=1` is set. Use the mock tests for
routine verification; they do not consume free-model quota.

`test:launcher` installs into a temporary bin directory, starts the bridge
through that shim against a mock OpenCode service, then verifies the dynamic
catalog, a Claude text reply, a real Read tool round-trip, streaming deltas,
usage accounting and `--stop`. It requires `claude` on PATH and a Unix-like
shell; CI runs installer tests on Ubuntu, macOS and Windows.

The mock service tests exercise the dynamic catalog, real limits, streaming,
and a real Read tool round-trip. Use them for code verification; use the live
smoke sparingly after a quota reset.

## Repo layout

```text
bin/o3c.mjs                  cross-platform launcher + preflight
src/server.mjs               bridge, transport, streaming, catalog, budget
src/paths.mjs                platform data/state/bin path resolution
src/preflight.mjs            prerequisite checks and OS install guidance
src/self-update.mjs          o3c update detection and execution
scripts/install.mjs          npm installer and shim generator
scripts/install.sh           Unix compatibility wrapper
test/preflight.test.mjs      prerequisite and guidance tests
test/update.test.mjs         self-update action tests
test/translate.test.mjs      unit tests
test/install.test.mjs        installer and doctor tests (all OSes)
test/mock-upstream.mjs       OpenAI-compatible mock (direct transport)
test/mock-opencode-service.mjs  OpenCode service mock
test/e2e.sh                  direct-transport E2E
test/e2e-service.sh          full service-transport E2E
test/e2e-launcher.sh         installed-shim E2E
test/live-smoke.sh           live one-shot per current model
docs/ARCHITECTURE.md         request flow and state
docs/REA-FINDINGS.md         reverse-engineering notes
```

Runtime state:

- data dir — dedicated OpenCode home, auth copy, generated `claude-settings.json`
- state dir — bridge/service logs, catalog snapshot, usage counter, pid files,
  project/session state

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
- The free tier is limited-time and subject to OpenCode's per-model/account
  limits; O3C does not bypass it.

## Uninstall

```bash
o3c --stop
npm uninstall -g @axeus/o3c               # global install
npm run install:o3c -- --uninstall        # source checkout shim
```

Then delete the data/state directories printed by the uninstaller if you also
want to remove the auth copy, logs and usage history.

## Free-tier references

- <https://opencode.ai/v2/docs/console/models/>
- <https://opencode.ai/v2/docs/console/go/>
- <https://github.com/anomalyco/opencode/issues/33495>
