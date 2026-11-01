#!/usr/bin/env node
// Anthropic Messages API <-> OpenCode Zen free-tier (OpenAI-compatible) bridge.
// Reverse-engineered with REA from opencode v2.1.4: see README.md.
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dataDir as defaultDataDir, stateDir as defaultStateDir } from "./paths.mjs";

export const MODELS = [
  { id: "beam-free", name: "Beam Free", family: "beam", context: 1048576, input: 1048576, output: 131072 },
  { id: "flint-40b-free", name: "Flint 40B Free", family: "flint", context: 262144, input: 262144, output: 65536 },
  { id: "glm-5.3-flash-free", name: "GLM-5.3-Flash Free", family: "glm-flash", context: 200000, input: 200000, output: 32000, vision: true },
  { id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", family: "mimo-flash", context: 200000, input: 200000, output: 32000, vision: true },
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", family: "deepseek-v4.1-flash", context: 200000, input: 200000, output: 32000, vision: true },
  { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", family: "nemotron-super", context: 1048576, input: 1048576, output: 131072, vision: true },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", family: "nemotron-lightning", context: 262144, input: 262144, output: 262144 },
];

const MANUAL_ALIASES = {
  "beam-free": ["beam"],
  "flint-40b-free": ["flint", "flint-40b"],
  "glm-5.3-flash-free": ["glm", "glm-5.3"],
  "mimo-v2.6-flash-free": ["mimo", "mimo-2.6"],
  "deepseek-v4.1-flash-free": ["deepseek", "ds", "deepseek-4.1"],
  "nemotron-3.5-super-vl-free": ["super", "nemotron-super"],
  "nemotron-3.5-lightning-free": ["lightning", "nemotron-lightning"],
};

export const ALIASES = Object.fromEntries(
  Object.entries(MANUAL_ALIASES).flatMap(([id, aliases]) => aliases.map((alias) => [alias, id])),
);

const DEFAULT_MODEL = process.env.OPENCODE_FREE_DEFAULT_MODEL || "deepseek-v4.1-flash-free";
const FALLBACK_IDS = MODELS.map((model) => model.id);
const PORT = Number(process.env.OPENCODE_FREE_PORT || 8787);
const BASE_URL = process.env.OPENCODE_FREE_BASE_URL || "https://opencode.ai/inference/openai/v1";
const UA = process.env.OPENCODE_FREE_UA || "opencode/latest/2.1.4/cli";
const CLIENT = process.env.OPENCODE_FREE_CLIENT || "cli";
const API_KEY = process.env.OPENCODE_FREE_API_KEY || "public";
const VERBOSE = !!process.env.OPENCODE_FREE_VERBOSE;

const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastSessionMs = 0;
let sessionCounter = 0;

export function makeSessionId(now = Date.now()) {
  if (now !== lastSessionMs) {
    lastSessionMs = now;
    sessionCounter = 0;
  }
  sessionCounter += 1;
  const raw = BigInt(now) * 0x1000n + BigInt(sessionCounter);
  const inverted = ~raw;
  let hex = "";
  for (let i = 0; i < 6; i += 1) {
    hex += Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let suffix = "";
  for (const byte of bytes) suffix += ALPHA[byte % 62];
  return `ses_${hex}${suffix}`;
}

function stateDir() {
  return defaultStateDir();
}

const DAILY_BUDGET = (() => {
  const value = Number(process.env.OPENCODE_FREE_DAILY_BUDGET ?? 40);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 40;
})();
const USAGE_FILE = path.join(stateDir(), "usage.json");

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnight(date = new Date()) {
  const current = new Date(date);
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1));
}

function readUsage() {
  const date = utcDayKey();
  try {
    const value = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (value && value.date === date) {
      const models = value.models && typeof value.models === "object" ? { ...value.models } : {};
      return { date, count: Number(value.count) || 0, models };
    }
  } catch {}
  return { date, count: 0, models: {} };
}

function writeUsage(value) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(value), { mode: 0o600 });
  } catch (error) {
    logError(`usage: could not write usage file: ${error.message}`);
  }
}

function usageInfo() {
  const usage = readUsage();
  const reset = nextUtcMidnight();
  return {
    date: usage.date,
    used: usage.count,
    budget: DAILY_BUDGET > 0 ? DAILY_BUDGET : null,
    remaining: DAILY_BUDGET > 0 ? Math.max(0, DAILY_BUDGET - usage.count) : null,
    by_model: usage.models,
    reset_at: reset.toISOString(),
  };
}

function takeBudget(modelId) {
  if (DAILY_BUDGET <= 0) return { ok: true };
  const usage = readUsage();
  if (usage.count >= DAILY_BUDGET) {
    const reset = nextUtcMidnight();
    return {
      ok: false,
      used: usage.count,
      budget: DAILY_BUDGET,
      reset: reset.toISOString(),
      retryAfter: Math.max(60, Math.ceil((reset.getTime() - Date.now()) / 1000)),
    };
  }
  usage.count += 1;
  if (modelId) usage.models[modelId] = (Number(usage.models[modelId]) || 0) + 1;
  writeUsage(usage);
  return { ok: true, usage: { ...usage, budget: DAILY_BUDGET } };
}

function loadProjectId() {
  if (process.env.OPENCODE_FREE_PROJECT_ID) return process.env.OPENCODE_FREE_PROJECT_ID;
  const dir = stateDir();
  const file = path.join(dir, "project-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(existing)) return existing;
  } catch {}
  const id = crypto.randomBytes(20).toString("hex");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {}
  return id;
}

const PROJECT_ID = loadProjectId();
let sessionId = process.env.OPENCODE_FREE_SESSION_ID || makeSessionId();
let sessionGeneratedAt = Date.now();

function currentSessionId() {
  if (!process.env.OPENCODE_FREE_SESSION_ID && Date.now() - sessionGeneratedAt > 3600000) {
    sessionId = makeSessionId();
    sessionGeneratedAt = Date.now();
  }
  return sessionId;
}

const NEW_MODEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REMOVED_MODEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The runtime catalog is the source of truth: provider "opencode", cost 0,
// active/enabled, text output. It includes the real context/output limits.
export function selectFreeModels(runtimeModels) {
  const out = [];
  const seen = new Set();
  for (const model of runtimeModels || []) {
    if (!model || model.providerID !== "opencode") continue;
    if (model.enabled === false) continue;
    if (model.status === "deprecated") continue;
    const outputs = model.capabilities?.output || ["text"];
    if (!outputs.includes("text")) continue;
    const id = model.id || model.modelID;
    if (!id || seen.has(id)) continue;
    const costs = Array.isArray(model.cost) ? model.cost : model.cost ? [model.cost] : [];
    const free = costs.length
      ? costs.every((cost) => (cost.input || 0) === 0 && (cost.output || 0) === 0)
      : /free/i.test(`${id} ${model.name || ""}`);
    if (!free) continue;
    seen.add(id);
    const context = Number(model.limit?.context ?? 200000);
    out.push({
      id,
      name: model.name || id,
      family: model.family || id.replace(/-free$/, ""),
      provider: "opencode",
      context,
      input: Number(model.limit?.input ?? context),
      output: Number(model.limit?.output ?? 32000),
      vision: Array.isArray(model.capabilities?.input) && model.capabilities.input.includes("image"),
      released: Number(model.time?.released ?? 0),
      variants: Array.isArray(model.variants) ? model.variants : [],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function buildCatalog(models, meta = {}) {
  const normalized = (models || []).map((model) => ({
    ...model,
    id: model.id,
    name: model.name || model.id,
    family: model.family || model.id,
    context: Number(model.context ?? 200000),
    input: Number(model.input ?? model.context ?? 200000),
    output: Number(model.output ?? 32000),
    vision: !!model.vision,
  }));
  const byId = new Map(normalized.map((model) => [model.id, model]));
  const aliases = {};
  for (const model of normalized) {
    const manual = MANUAL_ALIASES[model.id] || [];
    const base = model.id.replace(/-free$/, "").replace(/-preview$/, "");
    const family = model.family || "";
    const first = base.split("-")[0];
    const candidates = [...manual, model.id, base, family, first].filter(Boolean);
    const accepted = [];
    for (const alias of candidates) {
      if (!alias || accepted.includes(alias)) continue;
      const collision = normalized.some((other) => other.id !== model.id && (
        other.id === alias ||
        (MANUAL_ALIASES[other.id] || []).includes(alias) ||
        (other.family || "") === alias ||
        other.id.replace(/-free$/, "").replace(/-preview$/, "") === alias ||
        other.id.split("-")[0] === alias
      ));
      if (collision && !manual.includes(alias)) continue;
      accepted.push(alias);
    }
    model.alias = manual[0] || base || model.id;
    model.aliases = accepted;
    for (const alias of accepted) {
      if (!aliases[alias]) aliases[alias] = model.id;
      else if (aliases[alias] !== model.id) aliases[alias] = undefined;
    }
  }
  for (const model of normalized) {
    if (!aliases[model.id]) aliases[model.id] = model.id;
  }
  for (const [alias, id] of Object.entries(aliases)) {
    if (!id) delete aliases[alias];
  }
  const newIds = new Set(meta.newIds || []);
  for (const model of normalized) model.new = newIds.has(model.id);
  let defaultId = meta.defaultId || process.env.OPENCODE_FREE_DEFAULT_MODEL || DEFAULT_MODEL;
  if (!byId.has(defaultId)) {
    defaultId = byId.has("deepseek-v4.1-flash-free") ? "deepseek-v4.1-flash-free" : normalized[0]?.id || DEFAULT_MODEL;
  }
  return {
    models: normalized,
    byId,
    aliases,
    defaultId,
    source: meta.source || "fallback",
    updatedAt: meta.updatedAt || null,
    newIds,
    removed: meta.removed || [],
  };
}

let catalog = buildCatalog(MODELS, { source: "fallback", defaultId: DEFAULT_MODEL });

function getCatalogModel(id) {
  return catalog.byId.get(id);
}

function outputLimitFor(id) {
  return getCatalogModel(id)?.output || 16384;
}

function contextLimitFor(id) {
  const model = getCatalogModel(id);
  return model
    ? { context: model.context, input: model.input, output: model.output }
    : { context: 200000, input: 200000, output: 32000 };
}

function modelSupportsVision(id) {
  return !!getCatalogModel(id)?.vision;
}

// The free tier only serves requests that come from OpenCode's standard
// "build" agent context; direct HTTP calls and custom agents get 429.
// The default transport therefore asks a dedicated OpenCode service to run
// a transient generation (POST /api/session/:id/generate) and speaks a text
// tool protocol on top of it. OPENCODE_FREE_TRANSPORT=direct keeps the old
// OpenAI-compatible path for tests/mocks.
const TRANSPORT = (process.env.OPENCODE_FREE_TRANSPORT || "service").toLowerCase();
const SERVICE_PORT = Number(process.env.OPENCODE_FREE_SERVICE_PORT || 8791);
const SERVICE_AGENT = process.env.OPENCODE_FREE_SERVICE_AGENT || "build";
const BRIDGE_ROOT = process.env.OPENCODE_FREE_BRIDGE_DIR || defaultDataDir();
const OC_HOME = process.env.OPENCODE_FREE_HOME || path.join(BRIDGE_ROOT, "opencode-home");
const OC_WORKDIR = process.env.OPENCODE_FREE_WORKDIR || path.join(stateDir(), "workdir");
const OC_SERVICE_STATE = path.join(stateDir(), "opencode-service.json");
const OC_SERVICE_LOG = path.join(stateDir(), "opencode-service.log");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

let serviceState = null;
let serviceStarting = null;
let activeGenerations = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readServiceState() {
  try {
    const value = JSON.parse(fs.readFileSync(OC_SERVICE_STATE, "utf8"));
    if (value && value.port && value.password) return value;
  } catch {}
  return null;
}

function writeServiceState(value) {
  fs.mkdirSync(path.dirname(OC_SERVICE_STATE), { recursive: true });
  fs.writeFileSync(OC_SERVICE_STATE, JSON.stringify(value), { mode: 0o600 });
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

function prepareServiceHome() {
  fs.mkdirSync(OC_WORKDIR, { recursive: true });
  fs.mkdirSync(path.join(OC_HOME, ".config", "opencode"), { recursive: true });
  fs.mkdirSync(path.join(OC_HOME, ".local", "share", "opencode"), { recursive: true });
  fs.mkdirSync(path.join(OC_HOME, ".local", "state", "opencode"), { recursive: true });
  const config = path.join(OC_HOME, ".config", "opencode", "opencode.jsonc");
  if (!fs.existsSync(config)) {
    fs.writeFileSync(config, `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`);
  }
  for (const name of ["auth.json", "account.json"]) {
    const source = path.join(os.homedir(), ".local", "share", "opencode", name);
    const destination = path.join(OC_HOME, ".local", "share", "opencode", name);
    try {
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, destination);
        fs.chmodSync(destination, 0o600);
      }
    } catch (error) {
      logError(`could not copy ${name}: ${error.message}`);
    }
  }
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (text === "") return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

function serviceSpawnSpec() {
  const args = ["serve", "--port", String(SERVICE_PORT)];
  if (process.platform === "win32") {
    const commandLine = `"${OPENCODE_BIN}" ${args.map(quoteWindowsArg).join(" ")}`;
    return { command: commandLine, args: [], shell: true };
  }
  return { command: OPENCODE_BIN, args, shell: false };
}

async function stopProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await sleep(400);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(100);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

async function startServiceProcess() {
  fs.mkdirSync(stateDir(), { recursive: true });
  try {
    fs.chmodSync(OC_SERVICE_LOG, 0o600);
  } catch {}
  const offset = fs.existsSync(OC_SERVICE_LOG) ? fs.statSync(OC_SERVICE_LOG).size : 0;
  const fd = fs.openSync(OC_SERVICE_LOG, "a");
  const env = {
    ...process.env,
    HOME: OC_HOME,
    XDG_CONFIG_HOME: path.join(OC_HOME, ".config"),
    XDG_DATA_HOME: path.join(OC_HOME, ".local", "share"),
    XDG_STATE_HOME: path.join(OC_HOME, ".local", "state"),
    XDG_CACHE_HOME: path.join(OC_HOME, ".cache"),
    ...(process.platform === "win32" ? { USERPROFILE: OC_HOME } : {}),
  };
  let child;
  const spec = serviceSpawnSpec();
  try {
    child = spawn(spec.command, spec.args, {
      env,
      cwd: OC_WORKDIR,
      detached: true,
      shell: spec.shell,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  let spawnFailure = null;
  child.on("error", (error) => {
    spawnFailure = error;
  });
  const deadline = Date.now() + 30000;
  let password = null;
  let listening = false;
  let failure = null;
  while (Date.now() < deadline) {
    if (spawnFailure) {
      failure = `could not start ${OPENCODE_BIN}: ${spawnFailure.message}`;
      break;
    }
    if (child.exitCode !== null) {
      failure = `opencode serve exited with code ${child.exitCode}`;
      break;
    }
    let tail = "";
    try {
      const size = fs.statSync(OC_SERVICE_LOG).size;
      const start = Math.min(offset, size);
      tail = fs.readFileSync(OC_SERVICE_LOG).subarray(start, size).toString("utf8");
    } catch {}
    const passwordMatch = tail.match(/server password (\S+)/);
    if (passwordMatch) password = passwordMatch[1];
    if (/server listening on/.test(tail)) listening = true;
    if (/is already in use|EADDRINUSE/i.test(tail)) {
      failure = `port ${SERVICE_PORT} is already in use`;
      break;
    }
    if (password && listening) return { password, pid: child.pid };
    await sleep(100);
  }
  await stopProcessTree(child.pid);
  throw new Error(`${failure || "opencode serve did not start"} (log: ${OC_SERVICE_LOG})`);
}

async function serviceHealthy(state) {
  try {
    const response = await fetch(`${state.url}/api/info`, {
      headers: { authorization: basicAuth(state.password) },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitServiceReady(state) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await serviceHealthy(state)) return;
    await sleep(150);
  }
  throw new Error(`opencode service on ${state.url} did not become ready`);
}

async function ensureService() {
  const overrideUrl = process.env.OPENCODE_FREE_SERVICE_URL;
  const overridePassword = process.env.OPENCODE_FREE_SERVICE_PASSWORD;
  if (overrideUrl && overridePassword) {
    const state = { url: overrideUrl.replace(/\/+$/, ""), password: overridePassword, pid: null };
    if (await serviceHealthy(state)) {
      serviceState = state;
      return state;
    }
    throw new Error(`configured opencode service ${state.url} is not reachable`);
  }
  if (serviceState) {
    if (await serviceHealthy(serviceState)) return serviceState;
    serviceState = null;
  }
  if (serviceStarting) return serviceStarting;
  serviceStarting = (async () => {
    const saved = readServiceState();
    if (saved && (await serviceHealthy(saved))) {
      serviceState = saved;
      return saved;
    }
    prepareServiceHome();
    const started = await startServiceProcess();
    const state = {
      port: SERVICE_PORT,
      url: `http://127.0.0.1:${SERVICE_PORT}`,
      password: started.password,
      pid: started.pid,
    };
    writeServiceState(state);
    await waitServiceReady(state);
    serviceState = state;
    logError(`opencode service ready on ${state.url} (pid ${state.pid})`);
    return state;
  })().finally(() => {
    serviceStarting = null;
  });
  return serviceStarting;
}

class ServiceError extends Error {
  constructor(status, body, message) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function serviceRequest(state, pathname, options = {}) {
  const { method = "GET", body, timeout = 600000, signal, directory = OC_WORKDIR } = options;
  const headers = {
    "x-opencode-directory": directory,
    authorization: basicAuth(state.password),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  const response = await fetch(`${state.url}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any(signals),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const message = json?.message || json?.error?.message || json?.data?.message || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new ServiceError(response.status, json, message);
  }
  return json;
}

let catalogRefreshing = null;
let catalogTimersStarted = false;
let lastDriftRestart = 0;

function catalogSnapshotPath() {
  return path.join(stateDir(), "catalog.json");
}

function readCatalogSnapshot() {
  try {
    const value = JSON.parse(fs.readFileSync(catalogSnapshotPath(), "utf8"));
    if (value && Array.isArray(value.ids)) return value;
  } catch {}
  return null;
}

function writeCatalogSnapshot(value) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(catalogSnapshotPath(), JSON.stringify(value), { mode: 0o600 });
  } catch (error) {
    logError(`catalog: could not write snapshot: ${error.message}`);
  }
}

async function restartService() {
  const state = serviceState || readServiceState();
  if (state?.pid) {
    await stopProcessTree(state.pid);
  }
  try {
    fs.rmSync(OC_SERVICE_STATE, { force: true });
  } catch {}
  serviceState = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await ensureService();
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`could not restart opencode service on port ${SERVICE_PORT}`);
}

async function refreshCatalog({ restart = false } = {}) {
  if (TRANSPORT !== "service") return catalog;
  if (catalogRefreshing) return catalogRefreshing;
  catalogRefreshing = (async () => {
    let state;
    try {
      state = restart && activeGenerations === 0 ? await restartService() : await ensureService();
    } catch (error) {
      logError(`catalog: service unavailable: ${error.message}`);
      return catalog;
    }
    let runtime;
    try {
      runtime = await serviceRequest(state, "/api/model", { timeout: 20000 });
    } catch (error) {
      logError(`catalog: /api/model failed: ${error.message}`);
      return catalog;
    }
    const models = selectFreeModels(runtime?.data || []);
    if (!models.length) {
      logError("catalog: runtime returned no free models");
      return catalog;
    }
    const snapshot = readCatalogSnapshot();
    const now = Date.now();
    const previousIds = Array.isArray(snapshot?.ids) && snapshot.ids.length ? snapshot.ids : FALLBACK_IDS;
    const newUntil = { ...(snapshot?.newUntil || {}) };
    for (const model of models) {
      if (!previousIds.includes(model.id)) newUntil[model.id] = now + NEW_MODEL_TTL_MS;
    }
    for (const [id, until] of Object.entries(newUntil)) {
      if (!Number.isFinite(until) || until <= now) delete newUntil[id];
    }
    const removed = Array.isArray(snapshot?.removed)
      ? snapshot.removed.filter((entry) => entry && entry.id && now - Number(entry.at || 0) < REMOVED_MODEL_TTL_MS)
      : [];
    for (const id of previousIds) {
      if (!models.some((model) => model.id === id) && !removed.some((entry) => entry.id === id)) {
        removed.push({ id, at: now });
      }
    }
    const newIds = Object.keys(newUntil);
    catalog = buildCatalog(models, {
      source: "service",
      defaultId: process.env.OPENCODE_FREE_DEFAULT_MODEL,
      newIds,
      removed,
      updatedAt: new Date(now).toISOString(),
    });
    writeCatalogSnapshot({ ids: models.map((model) => model.id), newUntil, removed });
    logError(
      `catalog: ${models.length} free models; new=${newIds.join(",") || "-"}; removed=${removed.map((entry) => entry.id).join(",") || "-"}`,
    );
    return catalog;
  })().finally(() => {
    catalogRefreshing = null;
  });
  return catalogRefreshing;
}

async function modelsDevFreeIds() {
  try {
    const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const data = await response.json();
    const provider = data?.opencode;
    if (!provider?.models) return null;
    return Object.entries(provider.models)
      .filter(([id, model]) => {
        if (!model || model.status === "deprecated") return false;
        const cost = model.cost || {};
        return (cost.input || 0) === 0 && (cost.output || 0) === 0 || /free/i.test(id);
      })
      .map(([id]) => id);
  } catch {
    return null;
  }
}

async function autoRefreshOnDrift() {
  if (TRANSPORT !== "service" || activeGenerations > 0) return;
  if (Date.now() - lastDriftRestart < 30 * 60 * 1000) return;
  const remote = await modelsDevFreeIds();
  if (!remote) return;
  const local = new Set(catalog.models.map((model) => model.id));
  const remoteSet = new Set(remote);
  const missing = [...remoteSet].filter((id) => !local.has(id));
  const stale = [...local].filter((id) => !remoteSet.has(id));
  if (!missing.length && !stale.length) return;
  lastDriftRestart = Date.now();
  logError(
    `catalog: drift vs models.dev; restarting transport (new: ${missing.join(",") || "-"}; removed: ${stale.join(",") || "-"})`,
  );
  try {
    await refreshCatalog({ restart: true });
  } catch (error) {
    logError(`catalog: drift refresh failed: ${error.message}`);
  }
}

function startCatalogTimers() {
  if (catalogTimersStarted) return;
  catalogTimersStarted = true;
  setInterval(() => {
    refreshCatalog().catch((error) => logError(`catalog: periodic refresh failed: ${error.message}`));
  }, 5 * 60 * 1000).unref();
  setInterval(() => {
    autoRefreshOnDrift().catch((error) => logError(`catalog: drift check failed: ${error.message}`));
  }, 15 * 60 * 1000).unref();
}

function formatTranscript(messages) {
  const out = [];
  for (const message of messages || []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const content = message.content;
    if (typeof content === "string") {
      out.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts = [];
    const calls = [];
    const results = [];
    for (const block of content) {
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "tool_use") {
        calls.push(
          `Assistant tool call (${block.id || "unknown"}): ${JSON.stringify({
            name: block.name,
            input: block.input || {},
          })}`,
        );
      } else if (block.type === "tool_result") {
        const text = toolResultText(block.content);
        results.push(`Tool result (${block.tool_use_id || "unknown"})${block.is_error ? " [tool error]" : ""}:\n${text}`);
      } else if (block.type === "image") {
        texts.push("[image input omitted: this bridge sends text only]");
      } else if (block.type === "document") {
        texts.push(`[document: ${block.title || block.source?.file_name || "document"}]`);
      }
    }
    if (message.role === "assistant") {
      if (texts.length) out.push(`Assistant: ${texts.join("\n")}`);
      out.push(...calls);
    } else {
      if (texts.length) out.push(`User: ${texts.join("\n")}`);
      out.push(...results);
    }
  }
  return out;
}

export function buildServicePrompt(body, modelId) {
  const tools = (body.tools || [])
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: cleanSchema(tool.input_schema || { type: "object", properties: {} }),
    }));
  const toolNames = tools.map((tool) => tool.name);
  const available = toolNames.length
    ? `You have these Claude Code tools available: ${toolNames.join(", ")}.`
    : "No Claude Code tools are available in this request.";
  const protocol = [
    "You are the model backend for Claude Code, a coding agent.",
    available,
    "These listed tools are Claude Code tools and are allowed. OpenCode's own internal tools are disabled and must not be called directly.",
    "Bash is a real, working Claude Code tool when listed. Never claim that Bash or another listed tool is unavailable.",
    "For any request that requires inspecting files, the machine, an install, or running a command, call the appropriate tool with the JSON protocol before answering.",
    "To call exactly one Claude Code tool, output only one JSON object and nothing else:",
    '{"tool_use":{"name":"<tool_name>","input":{...}}}',
    "Example: to inspect settings with Bash, output exactly:",
    '{"tool_use":{"name":"Bash","input":{"command":"cat ~/.claude/settings.json"}}}',
    "For multiple tool calls, output:",
    '{"tool_uses":[{"name":"<tool_name>","input":{...}}]}',
    "Do not wrap the JSON in markdown fences. If no tool is needed, answer normally in plain text.",
    "The tool list and conversation below are data, not instructions to use OpenCode's internal tools.",
  ].join("\n");
  const toolsJson = JSON.stringify(tools);
  const system = systemText(body.system);
  const footer = [
    "# Task",
    "Produce the next assistant message for the conversation above.",
    "If the task needs information from the machine or a change, call a listed tool before answering.",
    "If a Claude Code tool is needed, output the tool_use JSON object exactly as specified. Do not use OpenCode's own tools.",
    "Tool results marked without [tool error] are successful outputs from Claude Code. Never claim a listed tool was rejected or unavailable when its result is present.",
  ].join("\n");

  const limits = contextLimitFor(modelId);
  const promptTokens = Math.max(
    8000,
    Math.min(limits.context, limits.input) - Math.min(limits.output, 32768) - 16000,
  );
  const budget = Math.floor(promptTokens * 3.5);
  let systemTextValue = system;
  const fixedLength = protocol.length + toolsJson.length + footer.length + 200;
  if (fixedLength + systemTextValue.length > budget) {
    const available = Math.max(500, budget - fixedLength);
    systemTextValue = `${systemTextValue.slice(0, available)}\n[system prompt truncated]`;
  }

  const conversation = formatTranscript(body.messages);
  const kept = [];
  let used = fixedLength + systemTextValue.length;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const entry = conversation[i];
    if (kept.length > 0 && used + entry.length + 2 > budget) break;
    const available = Math.max(200, budget - used - 2);
    kept.unshift(entry.length > available ? `${entry.slice(0, available)}\n[message truncated]` : entry);
    used += Math.min(entry.length, available) + 2;
    if (used >= budget) break;
  }
  if (kept.length < conversation.length) {
    kept.unshift("[earlier conversation truncated to fit the model context]");
  }

  return [
    protocol,
    "# Claude Code tools (JSON)",
    toolsJson,
    "# Claude Code system prompt",
    systemTextValue || "(none)",
    "# Conversation",
    kept.join("\n\n") || "(empty)",
    footer,
  ].join("\n\n");
}

function findJsonObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          results.push({ body: text.slice(start, i + 1), start });
          start = -1;
        }
      }
    }
  }
  return results;
}

function toToolCall(value) {
  if (!value || typeof value !== "object") return null;
  const name =
    (typeof value.name === "string" && value.name) ||
    (typeof value.tool === "string" && value.tool) ||
    (typeof value.tool_name === "string" && value.tool_name) ||
    (value.function && typeof value.function.name === "string" && value.function.name);
  if (!name) return null;
  let input = value.input ?? value.arguments ?? value.parameters ?? value.args ?? (value.function && value.function.arguments) ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = {};
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  return { id: value.id || `toolu_${randomHex(12)}`, name, input };
}

function normalizeToolCalls(value) {
  let list;
  if (Array.isArray(value)) list = value;
  else if (value && typeof value === "object") {
    if (Array.isArray(value.tool_uses)) list = value.tool_uses;
    else if (value.tool_use) list = [value.tool_use];
    else if (value.function_call) list = [value.function_call];
    else list = [value];
  } else {
    return [];
  }
  return list.map(toToolCall).filter(Boolean);
}

export function parseToolProtocol(raw) {
  const text = String(raw || "").trim();
  if (!text) return { text: "", toolCalls: [] };
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const start = text.indexOf(fence[0]);
    candidates.push({ body: fence[1].trim(), start, end: start + fence[0].length });
  }
  candidates.push({ body: text, start: 0, end: text.length });
  for (const object of findJsonObjects(text)) candidates.push(object);
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.body);
    } catch {
      continue;
    }
    const toolCalls = normalizeToolCalls(parsed);
    if (toolCalls.length) {
      return { text: text.slice(0, candidate.start).trim(), toolCalls };
    }
  }
  return { text, toolCalls: [] };
}

function buildAnthropicMessage(text, toolCalls, modelId, estimateInput) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: `msg_${randomHex(12)}`,
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: estimateInput,
      output_tokens: estimateTokens(text || ""),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

async function runServicePrompt(state, { sessionID, prompt, signal, onDelta, onAdmitted }) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const response = await fetch(`${state.url}/api/event`, {
    headers: {
      "x-opencode-directory": OC_WORKDIR,
      authorization: basicAuth(state.password),
      accept: "text/event-stream",
    },
    signal: AbortSignal.any([combined, AbortSignal.timeout(15 * 60 * 1000)]),
  });
  if (!response.ok || !response.body) {
    throw new ServiceError(response.status, null, `event stream failed (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;
  let fullText = "";
  let endedText = "";
  let usage = null;
  let finishReason = null;
  let nativeTool = false;
  let resolveConnected;
  const connected = new Promise((resolve) => {
    resolveConnected = resolve;
  });
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const settle = (value) => {
    if (settled) return;
    settled = true;
    resolveDone(value);
  };

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    const type = event.type || "";
    const data = event.data || {};
    if (type === "server.connected") {
      resolveConnected();
      return;
    }
    if (!data.sessionID || data.sessionID !== sessionID) return;
    if (type === "session.text.delta" && typeof data.delta === "string") {
      fullText += data.delta;
      onDelta?.(data.delta);
    } else if (type === "session.text.ended" && typeof data.text === "string") {
      endedText = data.text;
    } else if (type === "session.step.ended") {
      if (data.tokens) usage = data.tokens;
      if (data.finish) finishReason = data.finish;
    } else if (type === "session.usage.updated" && data.tokens) {
      usage = data.tokens;
    } else if (type.includes("tool") && type.includes("call")) {
      nativeTool = true;
    } else if (type === "session.execution.succeeded") {
      settle({ ok: true });
    } else if (
      type === "session.execution.failed" ||
      type === "session.execution.interrupted" ||
      type === "session.error"
    ) {
      settle({ ok: false, error: data.error?.message || data.message || data.error || type });
    }
  };

  const readerLoop = (async () => {
    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            handleEvent(JSON.parse(payload));
          } catch {}
        }
      }
    } catch (error) {
      if (!settled) settle({ ok: false, error: `event stream: ${error.message}` });
    } finally {
      if (!settled) settle({ ok: false, error: "event stream closed before completion" });
    }
  })();

  await Promise.race([connected, sleep(8000)]);
  try {
    await serviceRequest(state, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: { text: prompt },
      timeout: 30000,
      signal: combined,
    });
    onAdmitted?.();
  } catch (error) {
    settle({ ok: false, error: error.message });
  }

  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ ok: false, error: "generation timed out" }), 15 * 60 * 1000);
    timeoutId.unref?.();
  });
  const result = await Promise.race([done, timeout]);
  clearTimeout(timeoutId);
  controller.abort();
  try {
    await reader.cancel();
  } catch {}
  await readerLoop.catch(() => {});
  return { ...result, text: fullText || endedText, usage, finishReason, nativeTool };
}

async function handleServiceMessages(body, res) {
  const modelId = resolveModel(body.model);
  const prompt = buildServicePrompt(body, modelId);
  const estimateInput = estimateTokens(prompt);
  const stream = !!body.stream;
  logError(
    `service model=${body.model} -> ${modelId} stream=${stream} tools=${body.tools?.length || 0} promptChars=${prompt.length}`,
  );

  let state;
  try {
    state = await ensureService();
  } catch (error) {
    sendAnthError(res, 503, `OpenCode service unavailable: ${error.message}`);
    return;
  }

  const budget = takeBudget(modelId);
  if (!budget.ok) {
    logError(`local daily request budget reached (${budget.used}/${budget.budget})`);
    sendAnthError(
      res,
      429,
      `Local bridge daily request budget reached (${budget.used}/${budget.budget}). No upstream request was made. Increase OPENCODE_FREE_DAILY_BUDGET or wait until ${budget.reset}.`,
      "rate_limit_error",
      { "retry-after": String(budget.retryAfter) },
    );
    return;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let sessionID = null;
  let writer = null;
  let keepAlive = null;
  let textMode = null;
  let prefix = "";
  let streamed = false;

  const ensureWriter = () => {
    if (!writer && !res.writableEnded) {
      res.writeHead(200, sseHeaders());
      writer = createSseWriter(res, modelId, estimateInput);
      writer.start();
      keepAlive = setInterval(() => {
        try {
          if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n');
        } catch {}
      }, 15000);
      keepAlive.unref?.();
    }
    return writer;
  };
  const stopKeepAlive = () => {
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };

  const onDelta = stream
    ? (delta) => {
        if (!delta) return;
        if (textMode === true) {
          ensureWriter().text(delta);
          streamed = true;
          return;
        }
        if (textMode === false) return;
        prefix += delta;
        const trimmed = prefix.trimStart();
        if (!trimmed) return;
        const first = trimmed[0];
        if (first === "{" || first === "[" || first === "`") {
          textMode = false;
          return;
        }
        if (prefix.length >= 16 || delta.includes("\n")) {
          textMode = true;
          const out = prefix;
          prefix = "";
          ensureWriter().text(out);
          streamed = true;
        }
      }
    : null;
  const onAdmitted = stream
    ? () => {
        ensureWriter();
      }
    : null;

  const fail = (status, message, type = "api_error", headers = {}) => {
    stopKeepAlive();
    if (writer) writer.error(status, message, type);
    else if (!res.writableEnded) sendAnthError(res, status, message, type, headers);
  };

  activeGenerations += 1;
  try {
    const created = await serviceRequest(state, "/api/session", {
      method: "POST",
      body: {
        location: { directory: OC_WORKDIR },
        agent: SERVICE_AGENT,
        model: { providerID: "opencode", id: modelId },
        title: "Claude Code",
      },
      timeout: 20000,
      signal: controller.signal,
    });
    sessionID = created?.data?.id;
    if (!sessionID) throw new Error("session creation returned no id");

    let result = await runServicePrompt(state, {
      sessionID,
      prompt,
      signal: controller.signal,
      onDelta,
      onAdmitted,
    });
    if (result.ok && (body.tools || []).length && !result.text.trim()) {
      result = await runServicePrompt(state, {
        sessionID,
        prompt: `${prompt}\n\nIMPORTANT: your previous reply was empty. Output either a normal answer or the tool_use JSON object now.`,
        signal: controller.signal,
        onDelta,
        onAdmitted,
      });
    }

    const tokens = result.usage || {};
    const inputTokens = tokens.input || estimateInput;
    const outputTokens = tokens.output || estimateTokens(result.text || "");

    if (!result.ok) {
      const message = String(result.error || "generation failed");
      const isFree = /FreeUsageLimit|Free usage limit/i.test(message);
      logError(`service prompt failed model=${modelId}: ${message}`);
      if (isFree) {
        fail(
          429,
          `OpenCode free limit reached for ${modelId}: ${message} Try another free model or wait for the allowance to reset.`,
          "rate_limit_error",
          { "retry-after": "3600" },
        );
      } else {
        fail(503, `OpenCode service error: ${message}`);
      }
      return;
    }

    const text = result.text || "";
    const parsed = parseToolProtocol(text);
    if (!stream) {
      const message = buildAnthropicMessage(parsed.text, parsed.toolCalls, modelId, estimateInput);
      message.usage.input_tokens = inputTokens;
      message.usage.output_tokens = outputTokens;
      sendJson(res, 200, message);
      return;
    }

    const activeWriter = ensureWriter();
    if (parsed.toolCalls.length) {
      if (textMode !== true && !streamed && parsed.text) activeWriter.text(parsed.text);
      parsed.toolCalls.forEach((call, index) => {
        activeWriter.toolCall({
          index,
          id: call.id,
          function: { name: call.name, arguments: JSON.stringify(call.input || {}) },
        });
      });
      stopKeepAlive();
      activeWriter.finish("tool_calls", { prompt_tokens: inputTokens, completion_tokens: outputTokens });
    } else {
      if (textMode !== true) {
        const out = parsed.text || text;
        if (out) activeWriter.text(out);
      }
      stopKeepAlive();
      activeWriter.finish(result.finishReason === "length" ? "length" : "stop", {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
      });
    }
  } catch (error) {
    const message = String(error?.message || error);
    const isFree = /FreeUsageLimit|Free usage limit/i.test(message);
    logError(`service request failed model=${modelId}: ${message}`);
    if (res.writableEnded || controller.signal.aborted) return;
    if (isFree) {
      fail(
        429,
        `OpenCode free limit reached for ${modelId}: ${message} Try another free model or wait for the allowance to reset.`,
        "rate_limit_error",
        { "retry-after": "3600" },
      );
    } else {
      fail(503, `OpenCode service error: ${message}`);
    }
  } finally {
    activeGenerations -= 1;
    stopKeepAlive();
    if (sessionID) {
      serviceRequest(state, `/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE", timeout: 5000 }).catch(() => {});
    }
  }
}

function log(...args) {
  if (VERBOSE) console.error(new Date().toISOString(), "[bridge]", ...args);
}

function logError(...args) {
  console.error(new Date().toISOString(), "[bridge]", ...args);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function stripAnthropicModelName(name) {
  return String(name || "")
    .trim()
    .replace(/^anthropic\//i, "")
    .replace(/^opencode\//i, "")
    .replace(/\[[^\]]*\]$/g, "")
    .trim();
}

export function resolveModel(requested) {
  const normalized = stripAnthropicModelName(requested).toLowerCase();
  if (!normalized) return catalog.defaultId;
  if (catalog.byId.has(normalized)) return normalized;
  const byLowerId = catalog.models.find((model) => model.id.toLowerCase() === normalized);
  if (byLowerId) return byLowerId.id;
  const aliasTarget = catalog.aliases[normalized];
  if (aliasTarget && catalog.byId.has(aliasTarget)) return aliasTarget;
  return catalog.defaultId;
}

function upstreamUrl() {
  const url = new URL(BASE_URL);
  if (!/\/chat\/completions$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  }
  return url;
}

function upstreamHeaders(stream) {
  const sid = currentSessionId();
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${API_KEY}`,
    "user-agent": UA,
    "x-opencode-client": CLIENT,
    "x-opencode-project": PROJECT_ID,
    "x-opencode-session": sid,
    "x-opencode-session-id": sid,
    "x-session-affinity": sid,
    "x-session-id": sid,
  };
  if (stream) headers.accept = "text/event-stream";
  if (process.env.OPENCODE_FREE_EXTRA_HEADERS) {
    try {
      Object.assign(headers, JSON.parse(process.env.OPENCODE_FREE_EXTRA_HEADERS));
    } catch {}
  }
  return headers;
}

function cleanSchema(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 12) return Array.isArray(value) ? [] : { type: "object", additionalProperties: true };
  if (Array.isArray(value)) return value.map((entry) => cleanSchema(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["$schema", "$id", "$defs", "definitions", "$comment", "examples", "default", "const"].includes(key)) continue;
    if (key === "$ref") {
      out.type = "object";
      out.additionalProperties = true;
      continue;
    }
    if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      out.properties = {};
      for (const [name, schema] of Object.entries(entry)) out.properties[name] = cleanSchema(schema, depth + 1);
      continue;
    }
    if (["items", "additionalProperties", "contains", "not", "if", "then", "else", "anyOf", "oneOf", "allOf"].includes(key)) {
      out[key] = cleanSchema(entry, depth + 1);
      continue;
    }
    out[key] = entry;
  }
  if (!out.type && out.properties) out.type = "object";
  if (Array.isArray(out.required) && out.properties) {
    out.required = out.required.filter((name) => name in out.properties);
    if (!out.required.length) delete out.required;
  }
  return out;
}

function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n\n");
  }
  return "";
}

function imagePart(source) {
  if (!source) return null;
  if (source.type === "base64" && source.data) {
    return { type: "image_url", image_url: { url: `data:${source.media_type || "image/png"};base64,${source.data}` } };
  }
  if (source.type === "url" && source.url) return { type: "image_url", image_url: { url: source.url } };
  return null;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return "";
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "image") return "[image result omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function mapToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

export function anthropicToOpenAI(body, modelId) {
  const messages = [];
  const textOnlyModel = !modelSupportsVision(modelId);
  let imagesDropped = false;
  const system = systemText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages || []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const role = message.role;
    if (typeof message.content === "string") {
      messages.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    if (role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text) textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${randomHex(8)}`,
            type: "function",
            function: { name: block.name || "tool", arguments: JSON.stringify(block.input || {}) },
          });
        }
      }
      const text = textParts.join("\n");
      if (toolCalls.length) {
        messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
      continue;
    }

    const textParts = [];
    const parts = [];
    const toolMessages = [];
    for (const block of message.content) {
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text) {
          textParts.push(block.text);
          parts.push({ type: "text", text: block.text });
        }
      } else if (block.type === "image") {
        if (textOnlyModel) {
          imagesDropped = true;
          continue;
        }
        const part = imagePart(block.source);
        if (part) parts.push(part);
      } else if (block.type === "tool_result") {
        let text = toolResultText(block.content);
        if (block.is_error) text = `[tool error]\n${text}`;
        toolMessages.push({ role: "tool", tool_call_id: block.tool_use_id || "", content: text || "(no output)" });
      } else if (block.type === "document") {
        const title = block.title || block.source?.file_name || "document";
        textParts.push(`[document: ${title}]`);
        parts.push({ type: "text", text: `[document: ${title}]` });
      }
    }
    if (imagesDropped) {
      const note = "[images omitted: this model does not accept image input]";
      textParts.push(note);
      parts.push({ type: "text", text: note });
      imagesDropped = false;
    }
    for (const toolMessage of toolMessages) messages.push(toolMessage);
    if (parts.length) {
      const hasImage = parts.some((part) => part.type === "image_url");
      messages.push({ role: "user", content: hasImage ? parts : textParts.join("\n") });
    }
  }

  const payload = { model: modelId, messages, stream: !!body.stream };
  const tools = (body.tools || [])
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: cleanSchema(tool.input_schema || { type: "object", properties: {} }),
      },
    }));
  if (tools.length) payload.tools = tools;
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  const maxTokens = Number(body.max_tokens || body.max_completion_tokens || 0);
  const limit = outputLimitFor(modelId);
  if (maxTokens > 0) payload.max_completion_tokens = Math.min(maxTokens, limit);
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;
  if (payload.stream) payload.stream_options = { include_usage: true };
  return payload;
}

function mapStopReason(reason, hasToolCalls) {
  if (hasToolCalls) return "tool_use";
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
    case "stop":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function openAIToAnthropic(json, modelId, estimateInput = 0) {
  const choice = (json.choices || [])[0] || {};
  const message = choice.message || {};
  const content = [];
  const text = extractText(message.content);
  if (text) content.push({ type: "text", text });
  const toolCalls = message.tool_calls || message.function_call ? message.tool_calls || [{ function: message.function_call }] : [];
  for (const call of toolCalls) {
    let input = {};
    const rawArgs = call.function?.arguments;
    if (typeof rawArgs === "string" && rawArgs) {
      try {
        input = JSON.parse(rawArgs);
      } catch {
        input = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      input = rawArgs;
    }
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${randomHex(10)}`,
      name: call.function?.name || "tool",
      input,
    });
  }
  if (!content.length && message.reasoning_content) content.push({ type: "text", text: String(message.reasoning_content) });
  if (!content.length) content.push({ type: "text", text: "" });
  const usage = json.usage || {};
  return {
    id: json.id || `msg_${randomHex(12)}`,
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || estimateInput,
      output_tokens: usage.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function estimateTokens(value) {
  try {
    return Math.ceil(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)) / 4);
  } catch {
    return 0;
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function upstreamErrorInfo(status, bodyText, headers) {
  let detail = bodyText || "";
  let type = "";
  try {
    const parsed = JSON.parse(bodyText);
    type = parsed?.error?.type || parsed?.type || "";
    detail = parsed?.error?.message || parsed?.message || parsed?.error?.type || bodyText;
  } catch {}
  const retryAfter = Number(headers?.["retry-after"] || 0);
  const isFreeLimit = status === 429 || /FreeUsageLimit/i.test(bodyText || "");
  let message;
  if (isFreeLimit) {
    const parts = [`OpenCode free quota is exhausted for this account/IP: ${detail || "free usage limit reached"}`];
    if (retryAfter > 0) {
      parts.push(`Retry in about ${formatDuration(retryAfter)} (reset at ${new Date(Date.now() + retryAfter * 1000).toLocaleString()}).`);
    }
    parts.push("Free limits can be enforced per model; try another free model or wait for the reset. OpenCode Go models are not used by this bridge.");
    message = parts.join(" ");
  } else {
    message = `OpenCode upstream error (HTTP ${status})${type ? ` [${type}]` : ""}: ${detail || "request failed"}`;
  }
  return { status: isFreeLimit ? 429 : status >= 400 ? status : 502, retryAfter, message, isFreeLimit };
}

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function sendAnthError(res, status, message, type = "api_error", extraHeaders = {}) {
  sendJson(res, status, { type: "error", error: { type, message } }, extraHeaders);
}

export function createSseWriter(res, modelId, estimateInput) {
  let closed = false;
  let messageStarted = false;
  let nextIndex = 0;
  let textBlock = null;
  const toolBlocks = new Map();
  let reasoning = "";
  let outputChars = 0;
  let sawContent = false;

  const write = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const start = () => {
    if (messageStarted) return;
    messageStarted = true;
    write("message_start", {
      type: "message_start",
      message: {
        id: `msg_${randomHex(12)}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimateInput, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  };

  const ensureTextBlock = () => {
    if (!textBlock) {
      textBlock = { index: nextIndex++ };
      write("content_block_start", {
        type: "content_block_start",
        index: textBlock.index,
        content_block: { type: "text", text: "" },
      });
    }
    return textBlock;
  };

  const closeTextBlock = () => {
    if (!textBlock) return;
    write("content_block_stop", { type: "content_block_stop", index: textBlock.index });
    textBlock = null;
  };

  const startToolBlock = (block) => {
    closeTextBlock();
    block.index = nextIndex++;
    write("content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: { type: "tool_use", id: block.id, name: block.name || "tool", input: {} },
    });
  };

  return {
    start() {
      start();
    },
    text(delta) {
      if (!delta) return;
      start();
      sawContent = true;
      outputChars += delta.length;
      const block = ensureTextBlock();
      write("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "text_delta", text: delta },
      });
    },
    reasoning(delta) {
      if (delta) reasoning += delta;
    },
    toolCall(call) {
      start();
      sawContent = true;
      const key = call.index ?? 0;
      let block = toolBlocks.get(key);
      if (!block) {
        block = { id: call.id || `toolu_${randomHex(10)}`, name: "", args: "", index: null };
        toolBlocks.set(key, block);
      }
      if (call.id) block.id = call.id;
      if (call.function?.name) block.name = call.function.name;
      if (typeof call.function?.arguments === "string") block.args += call.function.arguments;
      if (block.name && block.index === null) startToolBlock(block);
    },
    finish(finishReason, usage = {}) {
      start();
      closeTextBlock();
      if (!sawContent && reasoning) {
        start();
        sawContent = true;
        outputChars += reasoning.length;
        const block = ensureTextBlock();
        write("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "text_delta", text: reasoning },
        });
        closeTextBlock();
      }
      for (const block of toolBlocks.values()) {
        if (block.index === null) startToolBlock(block);
        if (block.args) {
          write("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: block.args },
          });
        }
        write("content_block_stop", { type: "content_block_stop", index: block.index });
      }
      const stopReason = mapStopReason(finishReason, toolBlocks.size > 0);
      const inputTokens = usage.prompt_tokens || estimateInput;
      const outputTokens = usage.completion_tokens || Math.ceil(outputChars / 4);
      write("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
      write("message_stop", { type: "message_stop" });
      closed = true;
      if (!res.writableEnded) res.end();
    },
    error(status, message, type = "api_error") {
      if (closed || res.writableEnded) return;
      if (!messageStarted) {
        sendAnthError(res, status, message, type);
        closed = true;
        return;
      }
      write("error", { type: "error", error: { type, message } });
      closed = true;
      if (!res.writableEnded) res.end();
    },
  };
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMessages(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    sendAnthError(res, 413, `Could not read request: ${error.message}`);
    return;
  }
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    sendAnthError(res, 400, "Request body is not valid JSON.");
    return;
  }
  if (TRANSPORT === "service") {
    await handleServiceMessages(body, res);
    return;
  }
  await handleDirectMessages(body, res);
}

async function handleDirectMessages(body, res) {
  const modelId = resolveModel(body.model);
  const payload = anthropicToOpenAI(body, modelId);
  const estimateInput = estimateTokens(payload);
  const stream = !!body.stream;
  const target = upstreamUrl();
  const requestBody = Buffer.from(JSON.stringify(payload));
  const headers = upstreamHeaders(stream);
  headers["content-length"] = String(requestBody.length);

  log(`POST ${target.href} model=${body.model} -> ${modelId} stream=${stream} tools=${payload.tools?.length || 0} max=${payload.max_completion_tokens || "-"}`);

  const transport = target.protocol === "https:" ? https : http;
  let upstreamDone = false;
  const upstreamReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      if (status < 200 || status >= 300) {
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          upstreamDone = true;
          const text = Buffer.concat(chunks).toString("utf8");
          const info = upstreamErrorInfo(status, text, upstreamRes.headers);
          logError(`upstream ${status} model=${modelId}${info.retryAfter ? ` retry-after=${info.retryAfter}s` : ""}: ${info.message}`);
          const extra = info.retryAfter ? { "retry-after": String(info.retryAfter) } : {};
          sendAnthError(res, info.status, info.message, info.isFreeLimit ? "rate_limit_error" : "api_error", extra);
        });
        return;
      }

      const contentType = String(upstreamRes.headers["content-type"] || "");
      if (!contentType.includes("text/event-stream")) {
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          upstreamDone = true;
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            sendAnthError(res, 502, `Upstream returned non-JSON response: ${text.slice(0, 300)}`);
            return;
          }
          if (json.error) {
            const info = upstreamErrorInfo(status, text, upstreamRes.headers);
            sendAnthError(res, info.status, info.message, info.isFreeLimit ? "rate_limit_error" : "api_error");
            return;
          }
          const message = openAIToAnthropic(json, modelId, estimateInput);
          if (!stream) {
            sendJson(res, 200, message);
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const writer = createSseWriter(res, modelId, estimateInput);
          writer.start();
          let toolIndex = 0;
          for (const block of message.content) {
            if (block.type === "text") writer.text(block.text);
            else if (block.type === "tool_use") {
              writer.toolCall({ index: toolIndex++, id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
            }
          }
          writer.finish(message.stop_reason === "tool_use" ? "tool_calls" : message.stop_reason, {
            prompt_tokens: message.usage.input_tokens,
            completion_tokens: message.usage.output_tokens,
          });
        });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const writer = createSseWriter(res, modelId, estimateInput);
      writer.start();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = {};
      let finishReason = null;

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) return;
        let data = trimmed;
        if (trimmed.startsWith("data:")) data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        if (json.error) {
          const info = upstreamErrorInfo(status, JSON.stringify(json), upstreamRes.headers);
          writer.error(info.status, info.message, info.isFreeLimit ? "rate_limit_error" : "api_error");
          upstreamReq.destroy();
          return;
        }
        if (json.usage) usage = { ...usage, ...json.usage };
        const choice = (json.choices || [])[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === "string") writer.text(delta.content);
        else if (Array.isArray(delta.content)) {
          for (const part of delta.content) if (part && typeof part.text === "string") writer.text(part.text);
        }
        if (typeof delta.reasoning_content === "string") writer.reasoning(delta.reasoning_content);
        else if (typeof delta.reasoning === "string") writer.reasoning(delta.reasoning);
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) writer.toolCall(call);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      };

      upstreamRes.on("data", (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          handleLine(line);
        }
      });
      upstreamRes.on("end", () => {
        upstreamDone = true;
        if (buffer) handleLine(buffer.replace(/\r$/, ""));
        writer.finish(finishReason, usage);
      });
      upstreamRes.on("error", (error) => {
        writer.error(502, `Upstream stream error: ${error.message}`);
      });
    },
  );

  upstreamReq.setTimeout(600000, () => upstreamReq.destroy(new Error("upstream timeout")));
  upstreamReq.on("error", (error) => {
    if (upstreamDone) return;
    logError(`upstream request failed model=${modelId}: ${error.message}`);
    sendAnthError(res, 502, `Could not reach OpenCode inference: ${error.message}`);
  });
  res.on("close", () => {
    if (!upstreamDone) upstreamReq.destroy();
  });
  upstreamReq.end(requestBody);
}

function modelsPayload() {
  return {
    object: "list",
    default: catalog.defaultId,
    source: catalog.source,
    updated_at: catalog.updatedAt,
    new: [...catalog.newIds],
    removed: catalog.removed,
    data: catalog.models.map((model) => ({
      id: model.id,
      type: "model",
      object: "model",
      display_name: model.name,
      alias: model.alias,
      aliases: model.aliases,
      owned_by: "opencode",
      provider: "opencode",
      created_at: model.released ? new Date(model.released).toISOString() : null,
      context_window: model.context,
      max_input_tokens: model.input,
      max_output_tokens: model.output,
      vision: !!model.vision,
      new: catalog.newIds.has(model.id),
    })),
    has_more: false,
  };
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
      sendJson(res, 200, {
        ok: true,
        service: "opencode-free-claude-bridge",
        transport: TRANSPORT,
        opencode: TRANSPORT === "service" ? (serviceState ? "ready" : "starting") : "direct",
        models: catalog.models.map((model) => model.id),
        default: catalog.defaultId,
        catalog: {
          source: catalog.source,
          updated_at: catalog.updatedAt,
          new: [...catalog.newIds],
          removed: catalog.removed,
        },
        usage: usageInfo(),
        session: currentSessionId(),
        project: PROJECT_ID,
      });
      return;
    }
    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      if (url.searchParams.get("refresh") === "1" && TRANSPORT === "service") {
        try {
          await refreshCatalog();
        } catch (error) {
          logError(`catalog refresh failed: ${error.message}`);
        }
      }
      sendJson(res, 200, modelsPayload());
      return;
    }
    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {}
      sendJson(res, 200, { input_tokens: estimateTokens(body.messages || body) });
      return;
    }
    if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/messages")) {
      await handleMessages(req, res);
      return;
    }
    if (/oauth|\/token$|\/auth\b|\/login\b/i.test(pathname)) {
      sendJson(res, 200, { access_token: "opencode-free", token_type: "bearer", expires_in: 86400 });
      return;
    }
    sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `No route for ${req.method} ${pathname}` } });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => {
    logError(`listening on http://127.0.0.1:${PORT} transport=${TRANSPORT}`);
    logError(`models: ${catalog.models.map((model) => model.id).join(", ")}`);
    if (TRANSPORT === "service") {
      ensureService()
        .then(async () => {
          logError(`opencode transport ready on port ${SERVICE_PORT}`);
          await refreshCatalog();
          startCatalogTimers();
        })
        .catch((error) => logError(`opencode transport failed to start: ${error.message}`));
    } else {
      logError(`direct upstream: ${upstreamUrl().href}`);
    }
  });
}
