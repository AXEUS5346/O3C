# REA findings (OpenCode 2.1.4)

Reverse engineering used REA `open_binary` and string analysis of the Bun
executable, the embedded `/$bunfs/root/*.js` sources, the models.dev runtime
catalog, OpenCode's HTTP API, and live instrumentation through the plugin hooks
`session.http.request`, `session.model.request` and `/api/event`.

## Provider and endpoint

- Provider: `opencode` (OpenCode Zen), npm `@ai-sdk/openai-compatible`.
- Endpoint: `https://opencode.ai/inference/openai/v1/chat/completions`.
- Auth used by the free tier: the literal `Authorization: Bearer public`.
- Client identity headers: `user-agent: opencode/latest/2.1.4/cli`,
  `x-opencode-client: cli`, `x-opencode-project`, and matching
  `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`,
  `x-session-id`.

## Session / project IDs

Session IDs: `ses_` + 12 lowercase hex chars of
`~(timestamp_ms * 4096 + counter)` truncated to 48 bits + 14 base62 random
chars. Project IDs are random 40-hex values persisted per worktree.

## The free-tier gate

Direct HTTP calls with copied headers/body and custom agents returned
`FreeUsageLimitError`. The same request from OpenCode's standard `build` agent
succeeded. Removing the standard tool set from that agent also returned the
free-limit error. Conclusion: the gateway accepts the standard OpenCode agent
context (system prompt + standard tools), not just the URL/headers.

## Service API used

- `POST /api/session` with `{location, agent:"build", model, title}`.
- `POST /api/session/:id/generate` — transient text, non-streaming.
- `POST /api/session/:id/prompt` — schedules the agent loop and streams via
  `/api/event`.
- `GET /api/event` — SSE: `session.text.started/delta/ended`,
  `session.reasoning.delta`, `session.step.ended`, `session.usage.updated`,
  `session.execution.succeeded/failed`.
- `GET /api/model` — runtime model catalog with real context/output limits.
- `DELETE /api/session/:id`.

## Streaming

`session.text.delta` carries `data.delta`; `session.text.ended` carries the
full text; `session.step.ended` carries tokens/finish. `message_start` can be
sent on prompt admission; pings keep Claude Code's connection alive while the
model reasons.

## Quota observations

- Free models are limited-time promotional access.
- The free allowance is enforced per model: a smoke run can have one model
  succeed and the next return `Free usage limit reached ... or switch models`.
  Community reports put allowances in the tens of requests per model per day.
- OpenCode generates session titles with low-cost models, which also consumes
  requests; Claude Code can produce multiple requests per turn.
- A 429 with `Retry-After` should be surfaced immediately; otherwise clients
  retry and can create a request storm.
