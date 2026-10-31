#!/usr/bin/env node
// Mock OpenCode service for end-to-end tests of the service transport.
import http from "node:http";

const PORT = Number(process.env.MOCK_SERVICE_PORT || 8792);
const WORKDIR = "/tmp";
const sessions = new Map();
const clients = new Set();
let sessionCounter = 0;
let contextBump = 0;
const extraModels = [];

const MODELS = [
  {
    id: "mock-deepseek-free",
    modelID: "mock-deepseek-free",
    providerID: "opencode",
    family: "mock-deepseek",
    name: "Mock DeepSeek Free",
    enabled: true,
    status: "active",
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200000, output: 32000 },
    variants: [],
    time: { released: Date.now() },
  },
  {
    id: "mock-glm-free",
    modelID: "mock-glm-free",
    providerID: "opencode",
    family: "mock-glm",
    name: "Mock GLM Free",
    enabled: true,
    status: "active",
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 100000, output: 16000 },
    variants: [],
    time: { released: Date.now() },
  },
  {
    id: "mock-paid",
    providerID: "opencode",
    name: "Mock Paid",
    enabled: true,
    status: "active",
    cost: [{ input: 1, output: 1 }],
    capabilities: { input: ["text"], output: ["text"] },
    limit: { context: 1000, output: 100 },
  },
  {
    id: "mock-deprecated-free",
    providerID: "opencode",
    name: "Mock Deprecated Free",
    enabled: true,
    status: "deprecated",
    cost: [{ input: 0, output: 0 }],
    capabilities: { input: ["text"], output: ["text"] },
    limit: { context: 1000, output: 100 },
  },
  {
    id: "mock-go-free",
    providerID: "opencode-go",
    name: "Mock Go Free",
    enabled: true,
    status: "active",
    cost: [{ input: 0, output: 0 }],
    capabilities: { input: ["text"], output: ["text"] },
    limit: { context: 1000, output: 100 },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify({ id: `evt_mock_${Date.now()}`, created: Date.now(), ...event })}\n\n`);
}

function broadcast(event) {
  for (const response of clients) {
    try {
      sendEvent(response, event);
    } catch {}
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function replyText(prompt) {
  const transcriptToolResult = /Tool result \([^)]*\)[^\n]*:\s*\n/.test(prompt);
  if (/tooltest/i.test(prompt) && !transcriptToolResult) {
    return JSON.stringify({ tool_use: { name: "Read", input: { file_path: "/etc/hostname" } } });
  }
  if (transcriptToolResult) {
    const match = prompt.match(/Tool result \([^)]*\)[^\n]*:\s*\n?([^\n]+)/i);
    return `TOOL_RESULT_SEEN: ${match ? match[1].trim() : "missing"}`;
  }
  if (/streamtest/i.test(prompt)) {
    return "This is a streamed mock response. ".repeat(20).trim();
  }
  return "PONG";
}

function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 18) out.push(text.slice(i, i + 18));
  return out;
}

async function emitPrompt(sessionID, text) {
  const isTool = text.trimStart().startsWith("{");
  await sleep(120);
  for (const chunk of chunks(text)) {
    broadcast({ type: "session.text.delta", data: { sessionID, delta: chunk } });
    await sleep(35);
  }
  broadcast({ type: "session.text.ended", data: { sessionID, text } });
  broadcast({
    type: "session.step.ended",
    data: {
      sessionID,
      finish: isTool ? "tool_calls" : "stop",
      tokens: { input: 120, output: Math.ceil(text.length / 4), reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  broadcast({ type: "session.usage.updated", data: { sessionID, tokens: { input: 120, output: Math.ceil(text.length / 4) } } });
  broadcast({ type: "session.execution.succeeded", data: { sessionID } });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/info") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "mock", pid: process.pid, urls: [`http://127.0.0.1:${PORT}`], capabilities: {} }));
    return;
  }

  if (request.method === "GET" && pathname === "/api/model") {
    const models = [...MODELS, ...extraModels].map((model) =>
      model.id === "mock-glm-free" && contextBump
        ? { ...model, limit: { ...model.limit, context: model.limit.context + contextBump } }
        : model);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ location: { directory: WORKDIR }, data: models }));
    return;
  }

  if (request.method === "GET" && pathname === "/control/add-model") {
    if (!extraModels.some((model) => model.id === "mock-new-free")) {
      extraModels.push({
        id: "mock-new-free",
        modelID: "mock-new-free",
        providerID: "opencode",
        family: "mock-new",
        name: "Mock New Free",
        enabled: true,
        status: "active",
        cost: [{ input: 0, output: 0 }],
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 111111, output: 22222 },
        variants: [],
        time: { released: Date.now() },
      });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "GET" && pathname === "/control/bump-context") {
    contextBump += 23000;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ context: 100000 + contextBump }));
    return;
  }

  if (request.method === "GET" && pathname === "/api/event") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(response);
    sendEvent(response, { type: "server.connected", data: {} });
    const heartbeat = setInterval(() => {
      try { response.write(": heartbeat\n\n"); } catch {}
    }, 15000);
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/session") {
    const body = await readBody(request);
    sessionCounter += 1;
    const id = `ses_mock_${sessionCounter}`;
    sessions.set(id, { model: body.model?.id, agent: body.agent || "build", title: body.title });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { id, projectID: "mock-project", agent: body.agent || "build", model: body.model, location: { directory: WORKDIR } } }));
    return;
  }

  const promptMatch = pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
  if (request.method === "POST" && promptMatch) {
    const sessionID = decodeURIComponent(promptMatch[1]);
    const body = await readBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { id: `msg_mock_${Date.now()}`, sessionID, type: "user", payload: { text: body.text || "" }, delivery: "steer" } }));
    const text = replyText(String(body.text || ""));
    emitPrompt(sessionID, text).catch(() => {});
    return;
  }

  const generateMatch = pathname.match(/^\/api\/session\/([^/]+)\/generate$/);
  if (request.method === "POST" && generateMatch) {
    const body = await readBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { text: replyText(String(body.prompt || "")) } }));
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/session\/([^/]+)$/);
  if (request.method === "DELETE" && deleteMatch) {
    sessions.delete(decodeURIComponent(deleteMatch[1]));
    response.writeHead(204).end();
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: `No route for ${request.method} ${pathname}` }));
});

server.listen(PORT, "127.0.0.1", () => console.error(`[mock-service] listening on ${PORT}`));
