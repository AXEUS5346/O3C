# Changelog

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
