# Changelog

## 0.2.0

- Cross-platform Node launcher (`bin/claude-opencode.mjs`) for Linux, macOS and
  Windows, with cmd.exe quoting and process-tree cleanup.
- `npm run install:o3c` installer with `--bin-dir`, `--data-dir`,
  `--state-dir`, `--force` and `--uninstall`.
- Windows `.cmd`, `.ps1` and POSIX sh shims; Unix symlink with wrapper fallback.
- Platform-aware data/state paths in `src/paths.mjs` (XDG, Application Support,
  LOCALAPPDATA).
- Installer tests and a CI matrix on Ubuntu, macOS and Windows.
- Installed-shim end-to-end test against the mock OpenCode service.

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
