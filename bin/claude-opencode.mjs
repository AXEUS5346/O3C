#!/usr/bin/env node
// Cross-platform launcher for the O3C bridge. Starts the bridge, resolves the
// live free-model catalog, then hands the terminal to Claude Code.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDir, stateDir, settingsPath, logPath, bridgeUrl, port } from "../src/paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO_ROOT, "src", "server.mjs");
const DATA_DIR = dataDir();
const STATE_DIR = stateDir();
const LOG = logPath();
const BASE = bridgeUrl();
const PORT = port();
const SETTINGS_FILE = settingsPath();
const PID_FILE = path.join(STATE_DIR, "bridge.pid");
const SERVICE_STATE = path.join(STATE_DIR, "opencode-service.json");
const DEFAULT_BEHAVES_AS = process.env.OPENCODE_FREE_BEHAVES_AS || "claude-opus-4-8";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(`Usage: claude-opencode [options] [--] [claude args...]

Options:
  -m, --model <name>   Model alias or full ID (default: bridge default)
  -l, --list           Refresh and list current free OpenCode models
      --status         Show bridge, transport and catalog status
      --stop           Stop the bridge and its dedicated OpenCode service
      --log            Print the bridge log path
  -h, --help           Show this help

The model list is dynamic and comes from the running OpenCode service.
Run --list to see current aliases, real context windows and new/removed models.
Anything after -- (or any unrecognized leading arg) is passed to Claude Code.`);
}

function fail(message, code = 1) {
  console.error(`claude-opencode: ${message}`);
  process.exit(code);
}

async function getJson(url, timeout = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function bridgeHealthy(timeout = 1000) {
  try {
    await getJson(`${BASE}/health`, timeout);
    return true;
  } catch {
    return false;
  }
}

function logTail(lines = 20) {
  try {
    const text = fs.readFileSync(LOG, "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function startBridge() {
  if (await bridgeHealthy()) return;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {}
  const fd = fs.openSync(LOG, "a", 0o600);
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_FREE_DATA_DIR: DATA_DIR,
      OPENCODE_FREE_BRIDGE_DIR: DATA_DIR,
      OPENCODE_FREE_STATE_DIR: STATE_DIR,
    },
  });
  fs.closeSync(fd);
  child.unref();
  try {
    fs.chmodSync(LOG, 0o600);
  } catch {}
  fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
  try {
    fs.chmodSync(PID_FILE, 0o600);
  } catch {}
  for (let i = 0; i < 100; i += 1) {
    if (await bridgeHealthy(1000)) return;
    await sleep(100);
  }
  const tail = logTail();
  fail(`bridge failed to start on port ${PORT}; see ${LOG}${tail ? `\n${tail}` : ""}`);
}

async function fetchCatalog(force) {
  const expectService = (process.env.OPENCODE_FREE_TRANSPORT || "service").toLowerCase() === "service";
  let last = null;
  if (force) {
    try {
      last = await getJson(`${BASE}/v1/models?refresh=1`, 90000);
    } catch {}
  }
  for (let i = 0; i < 40; i += 1) {
    if (!last || last.source !== "service") {
      try {
        last = await getJson(`${BASE}/v1/models`, 90000);
      } catch {}
    }
    if (!expectService && last) return last;
    if (last && last.source === "service") return last;
    await sleep(500);
  }
  return last;
}

function requireCatalog(catalog) {
  if (!catalog) fail(`could not read the model catalog; see --status and ${LOG}`);
  return catalog;
}

function formatInt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function printCatalog(catalog) {
  console.log(`source: ${catalog.source || "?"}   updated: ${catalog.updated_at || "pending"}   default: ${catalog.default || "?"}`);
  for (const model of catalog.data || []) {
    const marker = model.new ? "[new]" : "     ";
    const alias = String(model.alias || "").padEnd(14);
    const id = String(model.id || "").padEnd(34);
    const kind = model.vision ? "vision" : "text";
    console.log(`${marker} ${alias} ${id} ctx ${formatInt(model.context_window).padStart(10)}  out ${formatInt(model.max_output_tokens).padStart(9)}  ${kind}`);
  }
  if (catalog.removed && catalog.removed.length) {
    console.log(`removed: ${catalog.removed.map((entry) => entry.id).join(", ")}`);
  }
  if (catalog.source !== "service") {
    console.log("note: live catalog was not ready; showing the fallback list.");
  }
}

function resolveRequested(catalog, requested) {
  const wanted = String(requested || "").trim().toLowerCase();
  const data = catalog.data || [];
  let model;
  if (!wanted) {
    model = data.find((entry) => entry.id === catalog.default) || data[0];
  } else {
    model = data.find((entry) =>
      String(entry.id).toLowerCase() === wanted ||
      String(entry.alias || "").toLowerCase() === wanted ||
      (entry.aliases || []).some((alias) => String(alias).toLowerCase() === wanted));
  }
  if (!model) {
    console.error(`claude-opencode: model "${requested}" is not in the current free catalog.`);
    console.error(`Available: ${data.map((entry) => `${entry.alias || entry.id} (${entry.id})`).join(", ")}`);
    console.error("Run: claude-opencode --list");
    process.exit(2);
  }
  return model;
}

function writeSettings(catalog) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const options = (catalog.data || []).map((model) => ({
    model: model.id,
    label: `${model.alias || model.id} · ${model.display_name || model.id}`,
    description: `OpenCode free · ${formatInt(model.context_window)} ctx · ${formatInt(model.max_output_tokens)} out${model.vision ? " · vision" : ""}`,
    behavesAs: DEFAULT_BEHAVES_AS,
  }));
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify({ modelPicker: { replaceBuiltInOptions: false, options } }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {}
}

function commandLineOf(pid) {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    }
    if (process.platform === "darwin") {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      return result.status === 0 ? result.stdout : null;
    }
  } catch {}
  return null;
}

function ownsPid(pid, expected) {
  const command = commandLineOf(pid);
  if (command === null) return process.platform === "win32";
  return expected.every((part) => command.includes(part));
}

async function killPid(pid) {
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

function servicePid() {
  try {
    const value = JSON.parse(fs.readFileSync(SERVICE_STATE, "utf8"));
    return Number(value && value.pid) || null;
  } catch {
    return null;
  }
}

async function stopAll() {
  let bridgePid = null;
  try {
    bridgePid = Number(fs.readFileSync(PID_FILE, "utf8").trim()) || null;
  } catch {}
  const service = servicePid();
  if (bridgePid && ownsPid(bridgePid, ["server.mjs"])) await killPid(bridgePid);
  if (service && ownsPid(service, ["serve"])) await killPid(service);
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(SERVICE_STATE, { force: true });
  console.log("claude-opencode stopped");
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (text === "") return '""';
  if (!/[\s"&|<>^()%!]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

function findOnWindows(name) {
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = path.extname(name) ? [name] : extensions.map((extension) => `${name}${extension.toLowerCase()}`);
  for (const dir of (process.env.PATH || "").split(";")) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

function claudeSpawnSpec(args) {
  if (process.platform !== "win32") return { command: "claude", args };
  const command = findOnWindows("claude");
  if (!command) fail("'claude' (Claude Code) was not found on PATH", 127);
  if (/\.(exe|com)$/i.test(command)) return { command, args };
  const line = `"${command}" ${args.map(quoteWindowsArg).join(" ")}`;
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/v:off", "/s", "/c", `"${line}"`] };
}

async function launchClaude(model, args) {
  const spec = claudeSpawnSpec(args);
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: BASE,
      ANTHROPIC_AUTH_TOKEN: "opencode-free",
      ANTHROPIC_MODEL: model.id,
      ANTHROPIC_SMALL_FAST_MODEL: model.id,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model.id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model.id,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model.id,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.context_window || 200000),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.max_output_tokens || 32000),
    },
  });
  child.on("error", (error) => fail(`could not start claude: ${error.message}`, 127));
  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  process.exit(code);
}

async function main() {
  let requested = process.env.OPENCODE_FREE_MODEL || "";
  const passthrough = [];
  const argv = process.argv.slice(2);
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-m" || arg === "--model") {
      if (index + 1 >= argv.length) fail(`${arg} needs a value`, 2);
      requested = argv[index + 1];
      index += 2;
      continue;
    }
    if (arg.startsWith("--model=") || arg.startsWith("-m=")) {
      requested = arg.slice(arg.indexOf("=") + 1);
      index += 1;
      continue;
    }
    if (arg === "-l" || arg === "--list") {
      await startBridge();
      printCatalog(requireCatalog(await fetchCatalog(true)));
      return;
    }
    if (arg === "--log") {
      console.log(LOG);
      return;
    }
    if (arg === "--stop") {
      await stopAll();
      return;
    }
    if (arg === "--status") {
      try {
        const health = await getJson(`${BASE}/health`, 2000);
        console.log(JSON.stringify(health, null, 2));
        console.log(`log: ${LOG}`);
        return;
      } catch {
        console.error(`bridge not running on port ${PORT}`);
        console.error(`log: ${LOG}`);
        process.exit(1);
      }
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      return;
    }
    passthrough.push(...argv.slice(index));
    break;
  }

  await startBridge();
  const catalog = requireCatalog(await fetchCatalog(true));
  const model = resolveRequested(catalog, requested);
  writeSettings(catalog);
  console.error(`[claude-opencode] model=${model.alias || model.id} (${model.id}) ctx=${model.context_window} out=${model.max_output_tokens} bridge=${BASE}`);
  await launchClaude(model, ["--settings", SETTINGS_FILE, "--model", model.id, ...passthrough]);
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
