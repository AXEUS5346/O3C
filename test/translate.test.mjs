import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToOpenAI, openAIToAnthropic, resolveModel, makeSessionId, createSseWriter, buildServicePrompt, parseToolProtocol } from "../src/server.mjs";

test("resolves aliases and full ids; unknown Anthropic names fall back to default", () => {
  assert.equal(resolveModel("deepseek"), "deepseek-v4.1-flash-free");
  assert.equal(resolveModel("glm-5.3-flash-free"), "glm-5.3-flash-free");
  assert.equal(resolveModel("opencode/beam-free"), "beam-free");
  assert.equal(resolveModel("claude-sonnet-4-6"), "deepseek-v4.1-flash-free");
  assert.equal(resolveModel("anthropic/opencode_zen/space-bunny-free"), "deepseek-v4.1-flash-free");
});

test("session ids decode to the current timestamp window", () => {
  const now = Date.now();
  const id = makeSessionId(now);
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  const value = BigInt(`0x${id.slice(4, 16)}`);
  const raw = ~value & ((1n << 48n) - 1n);
  const decoded = Number(raw >> 12n);
  assert.ok(Math.abs(decoded - (now % 2 ** 36)) < 1000, `decoded=${decoded}`);
});

test("maps system, tools, tool use and tool results", () => {
  const payload = anthropicToOpenAI(
    {
      model: "beam-free",
      max_tokens: 200000,
      system: [
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: "Be terse." },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { file_path: { type: "string" }, offset: { type: "integer" } },
            required: ["file_path", "missing"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "auto" },
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file body" },
            { type: "text", text: "now summarize" },
          ],
        },
      ],
    },
    "beam-free",
  );

  assert.equal(payload.model, "beam-free");
  assert.equal(payload.max_completion_tokens, 131072);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[0].content, "You are Claude Code.\n\nBe terse.");
  assert.equal(payload.messages[1].content, "read the file");
  assert.equal(payload.messages[2].role, "assistant");
  assert.equal(payload.messages[2].tool_calls[0].function.name, "Read");
  assert.deepEqual(JSON.parse(payload.messages[2].tool_calls[0].function.arguments), { file_path: "/tmp/x" });
  assert.equal(payload.messages[3].role, "tool");
  assert.equal(payload.messages[3].tool_call_id, "toolu_1");
  assert.equal(payload.messages[4].role, "user");
  assert.equal(payload.messages[4].content, "now summarize");
  assert.equal(payload.tools[0].function.parameters.$schema, undefined);
  assert.deepEqual(payload.tools[0].function.parameters.required, ["file_path"]);
  assert.equal(payload.tool_choice, "auto");
});

test("drops images for text-only models and keeps them for vision models", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ],
  };
  const textOnly = anthropicToOpenAI({ model: "beam-free", messages: [message] }, "beam-free");
  assert.equal(typeof textOnly.messages.at(-1).content, "string");
  assert.match(textOnly.messages.at(-1).content, /images omitted/);
  assert.equal(textOnly.messages.at(-1).content.includes("data:image"), false);

  const vision = anthropicToOpenAI({ model: "glm", messages: [message] }, "glm-5.3-flash-free");
  const parts = vision.messages.at(-1).content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.some((part) => part.type === "image_url"), true);
});

test("maps OpenAI tool calls to Anthropic tool_use", () => {
  const message = openAIToAnthropic(
    {
      id: "chatcmpl-1",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "Using the tool.",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"/tmp/y"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    },
    "beam-free",
    10,
  );
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0].type, "text");
  assert.equal(message.content[1].type, "tool_use");
  assert.deepEqual(message.content[1].input, { file_path: "/tmp/y" });
  assert.equal(message.usage.input_tokens, 12);
  assert.equal(message.usage.output_tokens, 5);
});

function fakeResponse() {
  const events = [];
  return {
    events,
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      for (const block of String(chunk).split("\n\n")) {
        if (!block.trim()) continue;
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (event) events.push({ event, data: data ? JSON.parse(data) : null });
      }
    },
    end() { this.writableEnded = true; },
  };
}

test("emits a valid Anthropic SSE sequence for text and tool calls", () => {
  const res = fakeResponse();
  const writer = createSseWriter(res, "beam-free", 42);
  writer.start();
  writer.text("Hel");
  writer.text("lo");
  writer.toolCall({ index: 0, id: "call_9", function: { name: "Read", arguments: '{"file_path":' } });
  writer.toolCall({ index: 0, function: { arguments: '"/tmp/z"}' } });
  writer.finish("tool_calls", { prompt_tokens: 42, completion_tokens: 7 });

  const names = res.events.map((event) => event.event);
  assert.equal(names[0], "message_start");
  assert.ok(names.includes("content_block_start"));
  assert.ok(names.includes("content_block_delta"));
  assert.equal(
    res.events.filter(
      (event) => event.event === "content_block_delta" && event.data.delta.type === "input_json_delta",
    ).length,
    1,
  );
  assert.equal(names.at(-1), "message_stop");
  assert.equal(res.events.filter((event) => event.event === "content_block_stop").length, 2);
  const toolStart = res.events.find(
    (event) => event.event === "content_block_start" && event.data.content_block.type === "tool_use",
  );
  assert.equal(toolStart.data.content_block.name, "Read");
  const args = res.events
    .filter((event) => event.event === "content_block_delta" && event.data.delta.type === "input_json_delta")
    .map((event) => event.data.delta.partial_json)
    .join("");
  assert.deepEqual(JSON.parse(args), { file_path: "/tmp/z" });
  const delta = res.events.find((event) => event.event === "message_delta");
  assert.equal(delta.data.delta.stop_reason, "tool_use");
  assert.equal(delta.data.usage.output_tokens, 7);
});

test("streams multiple tool calls as separate valid blocks", () => {
  const res = fakeResponse();
  const writer = createSseWriter(res, "deepseek-v4.1-flash-free", 10);
  writer.start();
  writer.toolCall({ index: 0, id: "call_a", function: { name: "Bash", arguments: '{"command":"echo A"}' } });
  writer.toolCall({ index: 1, id: "call_b", function: { name: "Read", arguments: '{"file_path":"/tmp/x"}' } });
  writer.finish("tool_calls", { prompt_tokens: 10, completion_tokens: 4 });

  const starts = res.events.filter(
    (event) => event.event === "content_block_start" && event.data.content_block.type === "tool_use",
  );
  assert.deepEqual(starts.map((event) => event.data.content_block.name), ["Bash", "Read"]);
  const deltas = res.events.filter(
    (event) => event.event === "content_block_delta" && event.data.delta.type === "input_json_delta",
  );
  assert.equal(deltas.length, 2);
  assert.deepEqual(JSON.parse(deltas[0].data.delta.partial_json), { command: "echo A" });
  assert.deepEqual(JSON.parse(deltas[1].data.delta.partial_json), { file_path: "/tmp/x" });
});

test("text-only stream closes with end_turn", () => {
  const res = fakeResponse();
  const writer = createSseWriter(res, "glm-5.3-flash-free", 10);
  writer.start();
  writer.text("PONG");
  writer.finish("stop", { prompt_tokens: 10, completion_tokens: 1 });
  const delta = res.events.find((event) => event.event === "message_delta");
  assert.equal(delta.data.delta.stop_reason, "end_turn");
  assert.deepEqual(
    res.events.filter((event) => event.event === "content_block_start").map((event) => event.data.content_block.type),
    ["text"],
  );
});

test("tells models that listed tools are available and should be used", () => {
  const prompt = buildServicePrompt(
    {
      tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "inspect the install" }],
    },
    "deepseek-v4.1-flash-free",
  );
  assert.match(prompt, /You have these Claude Code tools available: Bash/);
  assert.match(prompt, /These listed tools are Claude Code tools and are allowed/);
  assert.match(prompt, /Bash is a real, working Claude Code tool/);
  assert.match(prompt, /Never claim that Bash or another listed tool is unavailable/);
  assert.match(prompt, /call the appropriate tool with the JSON protocol/);
  assert.match(prompt, /Example: to inspect settings with Bash/);
  assert.match(prompt, /Tool results marked without \[tool error\] are successful/);
});

test("builds the service prompt with tools, system and transcript", () => {
  const prompt = buildServicePrompt(
    {
      system: "You are Claude Code.",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
        },
      ],
      messages: [
        { role: "user", content: "read /x" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "body" }] },
      ],
    },
    "deepseek-v4.1-flash-free",
  );
  assert.match(prompt, /tool_use/);
  assert.match(prompt, /You are Claude Code/);
  assert.match(prompt, /User: read \/x/);
  assert.match(prompt, /Assistant tool call \(toolu_1\)/);
  assert.match(prompt, /Tool result \(toolu_1\):\nbody/);
  assert.match(prompt, /Do not use OpenCode's own tools/);
});

test("parses tool protocol variants", () => {
  assert.deepEqual(parseToolProtocol("hello").toolCalls, []);
  const one = parseToolProtocol('{"tool_use":{"name":"Read","input":{"file_path":"/x"}}}');
  assert.equal(one.toolCalls.length, 1);
  assert.equal(one.toolCalls[0].name, "Read");
  assert.deepEqual(one.toolCalls[0].input, { file_path: "/x" });
  const multi = parseToolProtocol(
    '{"tool_uses":[{"name":"Read","input":{"file_path":"/a"}},{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}]}',
  );
  assert.equal(multi.toolCalls.length, 2);
  assert.equal(multi.toolCalls[1].name, "Bash");
  assert.deepEqual(multi.toolCalls[1].input, { command: "ls" });
  const fenced = parseToolProtocol('I will read it.\n```json\n{"name":"Read","input":{"file_path":"/y"}}\n```');
  assert.equal(fenced.toolCalls.length, 1);
  assert.match(fenced.text, /I will read it/);
  const array = parseToolProtocol('[{"name":"Read","input":{"file_path":"/z"}}]');
  assert.equal(array.toolCalls.length, 1);
  const nonTool = parseToolProtocol('{"answer":42}');
  assert.equal(nonTool.toolCalls.length, 0);
  assert.match(nonTool.text, /answer/);
});

import { selectFreeModels, buildCatalog } from "../src/server.mjs";

test("selects only active free opencode text models from runtime data", () => {
  const runtime = [
    { id: "beam-free", providerID: "opencode", name: "Beam Free", family: "beam", enabled: true, status: "active", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 1048576, output: 131072 }, time: { released: 1 } },
    { id: "glm-5.3-flash-free", providerID: "opencode", name: "GLM-5.3-Flash Free", family: "glm-flash", enabled: true, status: "active", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text", "image"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
    { id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", family: "deepseek", enabled: true, status: "active", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
    { id: "big-pickle", providerID: "opencode", name: "Big Pickle", family: "big-pickle", enabled: true, status: "active", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
    { id: "paid-model", providerID: "opencode", name: "Paid Model", enabled: true, cost: [{ input: 1, output: 2 }], limit: { context: 1000, output: 100 } },
    { id: "old-free", providerID: "opencode", name: "Old Free", enabled: true, status: "deprecated", cost: [{ input: 0, output: 0 }] },
    { id: "local-model", providerID: "ollama", name: "Local", enabled: true, cost: [{ input: 0, output: 0 }] },
    { id: "disabled-free", providerID: "opencode", name: "Disabled Free", enabled: false, cost: [{ input: 0, output: 0 }] },
  ];
  const selected = selectFreeModels(runtime);
  assert.deepEqual(new Set(selected.map((m) => m.id)), new Set(["beam-free", "glm-5.3-flash-free", "deepseek-v4.1-flash-free", "big-pickle"]));
  const glm = selected.find((m) => m.id === "glm-5.3-flash-free");
  assert.equal(glm.vision, true);
  assert.equal(glm.context, 200000);
  assert.equal(glm.output, 32000);
});

test("builds dynamic aliases, real limits, new/removed markers", () => {
  const runtime = [
    { id: "beam-free", providerID: "opencode", name: "Beam Free", family: "beam", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 1048576, output: 131072 } },
    { id: "glm-5.3-flash-free", providerID: "opencode", name: "GLM-5.3-Flash Free", family: "glm-flash", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text", "image"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
    { id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", family: "deepseek", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
    { id: "qwen-4-code-free", providerID: "opencode", name: "Qwen 4 Code Free", family: "qwen-code", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 262144, output: 65536 } },
    { id: "big-pickle", providerID: "opencode", name: "Big Pickle", family: "big-pickle", cost: [{ input: 0, output: 0 }], capabilities: { input: ["text"], output: ["text"] }, limit: { context: 200000, output: 32000 } },
  ];
  const selected = selectFreeModels(runtime);
  const cat = buildCatalog(selected, {
    source: "service",
    newIds: ["qwen-4-code-free", "big-pickle"],
    removed: [{ id: "gone-free", at: Date.now() }],
  });
  assert.equal(cat.defaultId, "deepseek-v4.1-flash-free");
  assert.equal(cat.byId.get("glm-5.3-flash-free").alias, "glm");
  assert.equal(cat.aliases.glm, "glm-5.3-flash-free");
  assert.equal(cat.aliases.beam, "beam-free");
  assert.equal(cat.byId.get("qwen-4-code-free").alias, "qwen-4-code");
  assert.equal(cat.aliases["qwen-4-code"], "qwen-4-code-free");
  assert.equal(cat.aliases["qwen-4-code-free"], "qwen-4-code-free");
  assert.equal(cat.byId.get("qwen-4-code-free").new, true);
  assert.equal(cat.byId.get("big-pickle").new, true);
  assert.equal(cat.byId.get("beam-free").new, false);
  assert.equal(cat.byId.get("qwen-4-code-free").context, 262144);
  assert.equal(cat.byId.get("qwen-4-code-free").output, 65536);
  assert.deepEqual(cat.removed.map((r) => r.id), ["gone-free"]);
});
