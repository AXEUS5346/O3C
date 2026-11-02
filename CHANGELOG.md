# Changelog

## 0.3.6

- Continue stalled opening turns: when the request asks for an action and the
  model answers with prose and no tool call, one continuation turn now recovers
  it. Measured 3/3 tool calls delivered versus 1/3 before.
- Detect third-person planning ("The user wants to install… I should first
  check…"), not just first-person "I'll …", which is how these models narrate.
- Trace every turn end to end in the bridge log: `request`, `attempt`,
  `decision`, `response` and `failed` lines share a request id and carry a
  90-character reply preview, so a stall that was not continued is explainable
  from one line instead of a guess.
- Report `connect`, `ttft` and `gen` milliseconds per attempt, and stop resending
  the whole flattened prompt on retry turns: continuations are now one sentence
  against the existing session, cutting a retried turn's upstream payload from
  about 126,000 characters to a line.

## 0.3.4

- Continue the turn when a free model narrates a next step instead of calling a
  tool: one silent continuation on the same session, only after a tool result.
  Measured 3/3 tool calls delivered versus 1/3 before.
- Attach a next-action directive to the newest tool result and forbid announcing
  a step without calling it, so tool output no longer reads like user chatter.
- Reject calls for tools that were never offered, with one bounded re-ask, so
  Claude Code cannot be handed a nonexistent tool.
- Never report `tool_use` when no call actually parsed, and pad empty streamed
  replies so Claude Code always receives a content block.

## 0.3.3

- Give the model explicit Claude Code workflow rules: exact tool names only,
  tools execute in Claude Code, settings/statusline changes use Read/Write/Edit/
  Bash, and tool errors must be corrected rather than narrated as bridge faults.

## 0.3.2

- Forward prompt-cache read/creation usage and keep the cacheable prefix stable.
- Persist the last main model across launches and route background requests to it.
- Ban provider-native tool calls and fix multi-tool streaming.
- Add `o3c update`/`--check`, localhost proxy bypass, bridge settings override,
  and Claude Code model-picker version guidance.
- Require `O3C_ALLOW_LIVE=1` before quota-consuming live tests.

## 0.3.1

- Require Claude Code 2.1.242+ for custom model-picker rows and show update
  guidance when an older version is installed.
- Regenerate `claude-settings.json` on `o3c --list` and report the picker row
  count in `--doctor`; warn about a conflicting user-settings `modelPicker`.
- Use `claude-opus-4-6` as the default `behavesAs` profile for wider
  compatibility.
- Tell free models explicitly that listed Claude Code tools (including Bash)
  are available and that successful tool results are authoritative.
- Fix streaming of multiple tool calls: each call now gets its own block instead
  of being merged into one malformed input.
- Clarify that Claude Code tools are allowed while OpenCode's internal tools are
  not, so models stop treating Bash as forbidden.
- Add `o3c update` and `o3c update --check` for npm, GitHub and source installs.
- Remember the last main model, reuse it for new launches, and route background
  requests to it so `/model` selection is consistent and does not silently keep
  using the launch-time model.
- Forward prompt-cache read/creation token usage from OpenCode into Anthropic
  responses and keep the cacheable prefix stable.
- Require `O3C_ALLOW_LIVE=1` before live quota-consuming tests run.
- Exclude localhost from proxies for bridge and Claude Code child processes and
  warn about proxy settings in `--doctor`.
- Put the bridge URL/auth in the generated `--settings` file so stale Claude
  Code gateway settings cannot override O3C, and remove `ANTHROPIC_API_KEY`
  from the child environment.

## 0.3.0

- Rename the command from `claude-opencode` to `o3c`; the installer migrates an
  old shim automatically.
- Add `o3c --doctor` and launch preflight checks for Node 22+, OpenCode 2.x,
  OpenCode login and Claude Code.
- Print OS-specific install commands when a prerequisite is missing, including
  Windows, macOS and Linux guidance.
- Add friendly installer and startup errors for permissions, busy ports, login
  and quota failures.
- Publish to the npm registry as `@axeus/o3c` (the unscoped `o3c` name is
  rejected by npm as too similar to existing packages); the command remains
  `o3c`.

## 0.2.0

- Cross-platform Node launcher for Linux, macOS and Windows, with cmd.exe
  quoting and process-tree cleanup.
- `npm run install:o3c` installer with `--bin-dir`, `--data-dir`,
  `--state-dir`, `--force` and `--uninstall`.
- Windows `.cmd`, `.ps1` and POSIX sh shims; Unix symlink with wrapper fallback.
- Platform-aware data/state paths in `src/paths.mjs` (XDG, Application Support,
  LOCALAPPDATA).
- Installer tests and a CI matrix on Ubuntu, macOS and Windows.
- Installed-shim end-to-end test against the mock OpenCode service.
- Public source repository, npm package metadata, and global/npx install docs.

## 0.1.0

- Anthropic Messages <-> OpenCode service bridge for Claude Code.
- Dynamic free-model catalog from the running OpenCode service.
- Automatic aliases, `[new]` markers and removed-model tracking.
- Real context/input/output limits from the runtime catalog.
- True token streaming via `session.prompt` + `/api/event`.
- Full Claude Code tool protocol (Read, Bash, Edit, Task, MCP tools, ...).
- `modelPicker`/`behavesAs` settings for Claude harness capability mapping.
- Local daily request budget with usage in `--status`.
- Unit tests, direct-transport mock E2E, service-transport mock E2E, live smoke.
