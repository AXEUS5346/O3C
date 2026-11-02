# Claude Code tool-loop compatibility

Findings from debugging "the model stops after one tool call" on 2026-11-02,
against bridge 0.3.3 with `glm-5.3-flash-free` over the service transport.

## Symptom

Claude Code runs one tool, shows the result, and then waits for the user instead
of continuing. The user has to type something ("okay") to advance each step.

## What was ruled out

The bridge's protocol layer is not dropping tool calls.

- `parseToolProtocol` runs against the **full accumulated reply**
  (`src/server.mjs:1292`), not the streamed prefix, so a reply that leads with
  prose and then emits the JSON object is still parsed and still produces
  `tool_use` blocks (`src/server.mjs:1304-1319`).
- `stop_reason` follows the parsed calls: `toolCalls.length ? "tool_use" :
  "end_turn"` (`src/server.mjs:985`), and the streaming finish mirrors it
  (`src/server.mjs:1314`, `src/server.mjs:1326`).
- Replaying the failing turn shape through the live streaming path produced the
  correct call 3/3 times, with no raw JSON leaking into visible text.

The stall is the model returning prose with no tool JSON, which the bridge
faithfully reports as `end_turn`. Claude Code then legitimately ends the turn.

## Measured reproduction

Replay a transcript that ends with a `tool_result` for a repo install task, then
count how often the model emits the next call. Runs go through a real bridge with
`glm-5.3-flash-free`; the patched side runs on a second instance
(`OPENCODE_FREE_PORT=8789`, `OPENCODE_FREE_SERVICE_PORT=8792`, isolated
`OPENCODE_FREE_DATA_DIR`/`OPENCODE_FREE_STATE_DIR`) so the live bridge is never
touched.

| build | tool call delivered | notes |
| --- | --- | --- |
| unpatched 0.3.3 | 1 of 3 | two replies announced the step in prose and ended the turn |
| prompt rules + transcript directive only | 1 of 3 | **no measurable effect** — wording alone does not fix this |
| final: + narration continuation | 3 of 3 | one of the three needed the continuation retry to produce the call |

Sample sizes are three per row; these are indications, not precise rates. What
is solid is the mechanism: the narrating replies were real
(`"I'll install the skill into Claude Code's skills directory as the README
instructs."`, `"The README says to install by cloning to
~/.claude/skills/what-if-animation, then check node/npx, then run npx"`), the
bridge reported them faithfully as `end_turn`, and a single silent continuation
turn converts them into a working call.

## Fixes applied

All of these are additive; the JSON text protocol, the service transport, and the
dynamic catalog are unchanged, so every free model keeps working the same way.

1. **Next-action directive on the newest tool result** (`formatTranscript`).
   Only the last rendered result gets it, so prompt growth is one short sentence
   rather than one per historical result.
2. **Anti-narration rules** in the protocol block and task footer: never announce
   a step without performing it, and a tool you were not given does not exist.
   Kept despite the null result above because it costs almost nothing and is what
   the continuation relies on for context.
3. **Narration continuation** (`looksLikeUnexecutedPlan` + `lastMessageHasToolResult`).
   Fires only when tools were offered, nothing parsed as a call, the inbound
   message is a `tool_result`, and the prose reads like an unexecuted plan. It
   sends one short continuation turn to the same session — not the whole
   transcript — and streams nothing to the client, so a recovered call never
   leaks raw JSON as visible text. The continuation is permissive ("if nothing is
   left to run, answer normally") so a hand-off reply is not forced into a bogus
   tool call.
4. **Invented tool names are rejected** (`filterKnownToolCalls`): one bounded
   re-ask naming the tools actually offered, then unknown calls are dropped
   instead of being forwarded to Claude Code, which would have run a nonexistent
   tool.
5. **`mapStopReason` can no longer claim `tool_use` with nothing parsed** — the
   provider `tool_calls` / `function_call` finish reason with no parsed call now
   maps to `end_turn`, which is the hang FCC explicitly guards against.
6. **Empty streamed replies get a padding text block** so Claude Code always
   receives at least one content block.

Detection is intentionally broad: a hand-off answer such as "the next step is
yours: restart Claude Code" is flagged and retried, costing one extra round trip
on a turn that was already slow. Narrowing it trades a rare wasted retry for a
missed stall recovery.


## Root causes in the compatibility layer

1. **A tool result reads like user chatter.** `formatTranscript` renders results
   as `Tool result (<id>):\n<output>` (`src/server.mjs:780`) and places them in
   the user slot (`src/server.mjs:792`) with no role marker and no statement of
   what must follow. The model's own words show the misread: *"The user said
   'okay' — proceed with the install: clone to ~/.claude/skills/..., check node
   versions, then run npx hyperframes studio"*. It answered a user message
   conversationally instead of taking its turn.
2. **The retry only catches empty replies.** `src/server.mjs:1259` re-asks when
   `!result.text.trim()`. Prose-only narration never triggers it.
3. **Invented tool names pass through.** `toToolCall` (`src/server.mjs:912`)
   accepts any `name` string without validating it against the offered
   `body.tools`. A probe reply hallucinated a `skill` tool that was never in the
   request; had it been wrapped in JSON, Claude Code would have received a call
   for a nonexistent tool.
4. **The protocol has an escape hatch and no anti-narration rule.** The prompt
   says "If no tool is needed, answer normally in plain text"
   (`src/server.mjs:827`) but never forbids announcing a next step without
   calling it, which is the exact failure shape.

## Notes

- Prompt size is not the primary cause: the stall reproduces at ~2k prompt chars
  as well as at the observed `promptChars=106173` with 13 tools.
- Reproduction calls go through the real bridge and consume free-model quota, so
  they count against the local daily budget (`OPENCODE_FREE_DAILY_BUDGET`,
  default 40; state in `~/.local/state/opencode-free-bridge/usage.json`).
- Comparison target: Free Claude Code (`Alishahryar1/free-claude-code`), a mature
  proxy for the same problem. See the next section for what transfers.

## The opening-turn gap (0.3.5)

0.3.4 only continued a turn when the inbound message was a `tool_result`. A stall
on the **first** turn of a task therefore went unrecovered, which is exactly what
was reported again at 23:43 local: the user asked to install a repo, the model
answered `"I'll look at that repo to see how it's meant to be installed, then
install it as a Claude Code skill."` and the turn ended.

Measured opening-turn rate with the seam-only trigger: **1 of 3**. The two misses
narrated in the **third person**, which the first-person intent regex never
matches:

- `"The repo is a Claude Code **skill**. The README's install steps for Claude Code are: clone into ~/..."`
- `"The user wants to install the \"what-if-animation\" skill from a GitHub repo into Claude Code. The rep..."`

The fix separates the two situations, in one exported predicate
(`shouldContinueNarration`) so it is unit-testable:

- **Tool-result seam** — continue when the reply reads like an unexecuted plan.
  Length is irrelevant here.
- **Task start, no tool activity anywhere** — an imperative request ("install",
  "set up", "fix", "run", …) with zero parsed calls is a stall by definition: the
  model cannot have done anything, so even a confident `"Installed!"` is false.
  Continue unconditionally. A non-imperative message still needs plan intent, and
  long answers to questions are left alone.

Result: **3 of 3** opening turns delivered a call, two of them through the
continuation (`narration without a tool call at task start` in the bridge log).

The cost is one extra round trip when a user asks for an action and the correct
reply was actually prose — for instance a clarifying question. The continuation
prompt is deliberately permissive ("if nothing is left to run, answer normally")
so those turns end after one retry instead of forcing a tool call.

## End-to-end tracing

Every `/v1/messages` request on the service transport gets a short id and one
line per stage, written to the bridge log (`o3c --log`) as `[trace]`:

| event | fields | what it answers |
| --- | --- | --- |
| `request` | `model asked stream tools promptChars seam atStart action` | what the bridge believed about the turn before generating |
| `attempt` | `n ok chars finish error preview` | what the model actually returned, first 90 chars |
| `decision` | `action will ...` | why a retry did or did not happen (`empty-retry`, `unknown-tool-retry`, `narration-continue`) |
| `response` | `stop blocks dropped in out stream` | what Claude Code was told the turn ended with |
| `failed` | `stage error free` | where the request died |

`seam` means the inbound message is a tool result, `atStart` means no tool has
run yet in this conversation, `action` means the request reads as imperative.
Those three plus `intent` are the whole narration-continue decision, so a stall
that was *not* continued is explainable from one line.

Worked example, a healthy turn that needed no continuation:

```text
[trace] req=b9f4b7bc event=attempt n=1 ok=true chars=185 finish=stop preview={"tool_use":{"name":"Bash"...
[trace] req=b9f4b7bc event=decision action=narration-continue will=false tools=2 calls=1 intent=false seam=false atStart=true actionRequest=true chars=185
[trace] req=b9f4b7bc event=response stop=tool_use blocks=tool_use:Bash dropped=- in=9763 out=60 stream=true
```

Reading a stall: `event=attempt` shows the prose the model returned, then
`event=decision will=false` names the reason. If `will=true` you get a second
`attempt` with `why=narration-continue` and a `response` showing whether it
recovered a call. Lines are single-line, quote-free and value-truncated by
`traceLine`, which is unit-tested so the format cannot silently drift.

## What Free Claude Code (FCC) does

Source read: `/home/axeus/.local/share/uv/tools/free-claude-code/lib/python3.14/
site-packages/free_claude_code/` (referred to as `fcc/` below).

**FCC does not have this bug, because it does not use a text protocol.** It maps
Anthropic `tools` to OpenAI `tools` (`fcc/core/anthropic/conversion.py:803-817`)
and `tool_choice` `any` → `"required"` (`:820-836`), then calls OpenCode models
over the OpenAI chat-completions transport
(`fcc/providers/opencode/provider.py:57-66`, `fcc/providers/opencode/catalog.py:159-165`).
Tool calls arrive as native `tool_calls` deltas. A grep for any narration /
prose / hallucination detector in FCC returns nothing: there is no such
mechanism, because the failure mode it would catch cannot occur.

That means FCC's structural fix is **not directly copyable**: O3C's own reverse
engineering found the free tier is gated on OpenCode's standard agent context
(system prompt + standard tools), and direct calls to
`https://opencode.ai/inference/openai/v1/chat/completions` with our own body
return `FreeUsageLimitError` (see `docs/REA-FINDINGS.md`, "The free-tier gate").
O3C's text protocol exists precisely because the service transport is the only
path the free tier accepts.

Verified closed off: `GET /openapi.json` on the local service shows
`POST /api/session/{sessionID}/prompt` accepts only `text`, `files`, `agents`,
`skills`, `metadata`, `delivery` and `resume` with `additionalProperties: false`,
and `tool_choice` appears nowhere in the schema. There is no way to hand the
service Claude Code's tool list as native tools, so the text protocol stays.

### Mechanisms that do transfer

| # | FCC mechanism | Where | Applies to the stall? |
| --- | --- | --- | --- |
| P1 | Turn-boundary filler: when a `user` message directly follows tool output, inject a synthetic `assistant` message containing one space, because "some OpenAI-compatible chat templates reject a user role directly after tool output". Adjacent user messages are then coalesced. | `fcc/core/openai_chat.py:40-52`, applied `fcc/core/anthropic/conversion.py:505-506` | **Yes — this is the same seam.** O3C's flattened transcript puts a bare `Tool result (...)` block in the user slot and then asks for the next assistant message. Rendering the tool result as part of the assistant's own turn, and closing the assistant turn before the request, is the text-protocol equivalent. |
| P2 | Bidirectional `stop_reason` repair: upgrade to `tool_use` when a tool block started even if the provider said `stop`, **and downgrade `tool_use` → `end_turn` when no tool block actually started**, because announcing `tool_use` with no call hangs Claude Code. | `fcc/providers/openai_chat/stream_output.py:284-286`, wired `:483-491`; base map `fcc/core/anthropic/streaming/emitter.py:17-29` | Partially. The service path already does both directions (`src/server.mjs:985`, `:1304-1326`). The OpenAI-native path has the gap: `mapStopReason` returns `tool_use` for a provider `finish_reason: "tool_calls"` even when nothing parsed (`src/server.mjs:1611-1613`), which is the hang FCC guards against. |
| P5 | Schema-validated tool input, then an append-only repair re-ask: validate parsed input with `jsonschema`, and on failure re-ask with "Return only the exact missing JSON suffix… Do not repeat the prefix. Do not include markdown or explanation." Bounded retry loop. | `fcc/core/anthropic/streaming/recovery.py:48-80`, `:150-176`, loop `fcc/providers/openai_chat/transport.py:1616-1670`; salvage gate `fcc/core/anthropic/streaming/ledger.py:341-349` | **Yes.** O3C accepts any `name` string without checking it against the offered tools (`src/server.mjs:912-930`), so an invented tool name is forwarded to Claude Code. Validating name and input against the request's `tools` and re-asking once is directly reusable. |
| P6 | Withhold incomplete tool calls at the public boundary: buffer from `content_block_start(tool_use)` to `content_block_stop`, and discard the group if the stream ends with calls pending, so the client never sees half-formed `input_json_delta`. | `fcc/api/tool_call_buffer.py:63-115` | Yes, as a safety net for truncated JSON. O3C's `findJsonObjects` already ignores unbalanced braces, so a truncated call yields no call and the turn ends quietly instead of hanging. |
| — | Always send `tool_choice: {"type":"auto"}` when tools exist; drop it when they don't. Empty-reply padding: if the model produced only reasoning and no visible content, emit a one-space text block. Learned per-model output cap: parse the provider's "max_tokens ≤ N" 400 error and clamp thereafter. Reversible tool-name aliasing for names outside `[A-Za-z0-9_-]{1,64}` (MCP). Strict history validation: reject tool history referencing a missing `tool_result` id. | `fcc/core/anthropic/conversion.py:51-66`, `:355-363`; `fcc/providers/openai_chat/transport.py:395-417`, `:740-744`; `fcc/core/openai_tool_names.py:12-52`; `fcc/providers/openai_chat/output_cap.py:1-11` | Independent hardening, mostly cheap. |
| — | `is_error` on a tool result is **dropped** for chat upstreams, kept only on the native Anthropic path. | `fcc/core/anthropic/request_serialization.py:35-56` | O3C keeps it as a `[tool error]` marker (`src/server.mjs:780`) and the prompt explains it — better than FCC here. |

### The one philosophical difference

FCC never injects tool-use instructions: `convert_system_prompt`
(`fcc/core/anthropic/conversion.py:839-851`) forwards Claude Code's own system
prompt verbatim as a single `system` message. O3C instead prepends a large
protocol block and rewrites the conversation into text
(`buildServicePrompt`, `src/server.mjs:798-878`) because it has no native tool
channel to rely on. O3C's prompt rules are compensation for the missing
mechanism, which is why prompt wording alone has a ceiling — the measured nudge
recovery was 1 of 2.

