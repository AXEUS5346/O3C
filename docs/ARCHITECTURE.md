# Architecture

```text
Claude Code (Anthropic Messages API)
        |
        v
bin/claude-opencode.mjs  (env: base URL, auth token, model, context/output, settings)
        |
        v
src/server.mjs  :8787
  - Anthropic /v1/messages, /v1/models, count_tokens
  - dynamic catalog + daily budget
        |
        v
dedicated OpenCode service :8791  (build agent, auth copy, workdir)
  - POST /api/session
  - POST /api/session/:id/prompt
  - GET  /api/event  (SSE)
        |
        v
OpenCode Zen free models (opencode.ai inference)
```

## Request path

1. Claude Code sends an Anthropic request with its full system prompt, tools and
   conversation.
2. The bridge resolves the model against the dynamic catalog, enforces the local
   daily budget, and builds one text prompt containing the protocol, tools,
   system prompt and transcript.
3. The bridge creates a session with the `build` agent and the free model,
   subscribes to `/api/event`, then prompts.
4. OpenCode streams `session.text.delta` events. The bridge converts them to
   Anthropic SSE deltas. Tool JSON is buffered until classified.
5. If the model emits the tool JSON, the bridge returns `tool_use` blocks to
   Claude Code. Claude Code executes its own tools and sends results in the next
   request. The session is deleted after each request.

## Why a dedicated service?

The free tier rejects requests that do not come from the standard OpenCode
`build` agent context. The bridge therefore uses OpenCode's own pipeline rather
than calling the inference URL directly. It copies the user's OpenCode auth into
a dedicated home (0600) at runtime, so the user's TUI/config is independent.

## Dynamic catalog

`GET /api/model` is filtered to provider `opencode`, active/enabled, cost 0,
text output. The catalog stores real limits, vision, aliases, new/removed IDs
and a default. A snapshot in state tracks `[new]` (7 days) and `removed`.
Every launcher invocation and every `--list` re-reads `/api/model`, so model
updates and context/output changes are picked up immediately. Background
refresh runs every 5 minutes; a models.dev drift check every 15 minutes may
restart the transport. The runtime catalog is authoritative.

## Budget

`usage.json` tracks bridge requests per UTC day (default 40). The guard returns
a local 429 with `Retry-After` without touching upstream when exhausted. It is a
runaway-loop guard, not a quota bypass, and does not see TUI/CLI usage.

## State

Paths come from `src/paths.mjs`; `OPENCODE_FREE_DATA_DIR` and
`OPENCODE_FREE_STATE_DIR` override them.

- `<data>/opencode-home/` — dedicated OpenCode home/DB/auth copy
- `<data>/claude-settings.json` — generated picker
- `<state>/` — bridge.log, opencode-service.log/json, catalog.json, usage.json,
  bridge.pid, workdir

Linux defaults to XDG paths, macOS to `~/Library/Application Support`, and
Windows to `%LOCALAPPDATA%`. The state directory is under the data directory on
macOS and Windows.

## Failure modes

- Upstream free limit: 429 with `Retry-After`, shown immediately by Claude Code.
- Local budget: 429 without upstream call.
- Service down: 503; `--stop` then relaunch.
- Auth refresh/login: restart to refresh the auth copy.
- Removed model: disappears from the catalog and aliases; the default falls back.
- Client disconnect: the event stream/session is aborted/deleted.
