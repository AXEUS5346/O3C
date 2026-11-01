# Changelog

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
