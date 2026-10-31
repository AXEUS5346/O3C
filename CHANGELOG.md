# Changelog

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
