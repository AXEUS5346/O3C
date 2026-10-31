#!/usr/bin/env node
// Scripted OpenAI-compatible upstream for end-to-end bridge tests.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8990);
const FILE = "/tmp/o3c-test.txt";

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseChunk(model, delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    }
  }
  return "";
}

function hasToolResult(messages) {
  return messages.some((message) => message.role === "tool");
}

function lastToolContent(messages) {
  const tool = [...messages].reverse().find((message) => message.role === "tool");
  return tool ? String(tool.content || "") : "";
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const messages = body.messages || [];
    const tools = body.tools || [];
    const model = body.model || "mock";
    console.error(`[mock] model=${model} messages=${messages.length} tools=${tools.length} stream=${!!body.stream}`);

    const prompt = lastUserText(messages);
    let wantTool = false;
    let text = "PONG";
    if (hasToolResult(messages)) {
      text = `TOOL_RESULT_SEEN: ${lastToolContent(messages).slice(0, 400)}`;
    } else if (/tooltest/i.test(prompt) && tools.some((tool) => tool.function?.name === "Read")) {
      wantTool = true;
    }

    if (!body.stream) {
      const message = wantTool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: FILE }) } }] }
        : { role: "assistant", content: text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: wantTool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 25, completion_tokens: 3 },
      }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    sse(res, baseChunk(model, { role: "assistant" }));
    if (wantTool) {
      sse(res, baseChunk(model, {
        tool_calls: [{
          index: 0,
          id: "call_mock_1",
          type: "function",
          function: { name: "Read", arguments: JSON.stringify({ file_path: FILE }) },
        }],
      }));
      sse(res, baseChunk(model, {}, "tool_calls"));
    } else {
      for (const piece of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
        if (piece) sse(res, baseChunk(model, { content: piece }));
      }
      sse(res, baseChunk(model, {}, "stop"));
    }
    sse(res, { id: "chatcmpl-mock", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 25, completion_tokens: 3 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.error(`[mock] listening on ${PORT}`));
