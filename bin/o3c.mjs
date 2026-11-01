#!/usr/bin/env node
// Cross-platform launcher for the O3C bridge. Starts the bridge, resolves the
// live free-model catalog, then hands the terminal to Claude Code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDir, stateDir, settingsPath, logPath, bridgeUrl, port } from "../src/paths.mjs";
import {
  checkPrerequisites,
  findExecutable,
  formatPrerequisites,
  installGuidance,
  missingRequired,
} from "../src/preflight.mjs";

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
const DEFAULT_BEHAVES_AS = process.env.OPENCODE_FREE_BEHAVES_AS || "claude-opus-4-6";
const PREFIX = "o3c";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(`Usage: o3c [options] [--] [claude args...]

Options:
  -m, --model <name>   Model alias or full ID (default: bridge default)
  -l, --list           Refresh and list current free OpenCode models
      --doctor         Check Node, OpenCode, login and Claude Code, with fixes
      --status         Show bridge, transport and catalog status
      --stop           Stop the bridge and its dedicated OpenCode service
      --log            Print the bridge log path
  -h, --help           Show this help

The model list is dynamic and comes from the running OpenCode service.
Run --list to see current aliases, real context windows and new/removed models.
Anything after -- (or any unrecognized leading arg) is passed to Claude Code.`);
}

function fail(message, code = 1) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(code);
}

function needsOpenCode() {
  return (process.env.OPENCODE_FREE_TRANSPORT || "service").toLowerCase() !== "direct";
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

function bridgeHints(tail) {
  const hints = [];
  if (/already in use|EADDRINUSE/i.test(tail)) {
    hints.push(`Port ${PORT} is busy. Run: o3c --stop, or set OPENCODE_FREE_PORT to another port.`);
  }
  if (/auth|login|unauthorized|forbidden|401|403/i.test(tail)) {
    hints.push("OpenCode may not be logged in. Run: opencode auth login, then: o3c --doctor");
  }
  if (/FreeUsageLimit|free usage limit/i.test(tail)) {
    hints.push("The OpenCode free allowance is exhausted. Try another free model or wait for the reset.");
  }
  if (!hints.length) hints.push("Run: o3c --doctor");
  return hints;
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
  const hints = bridgeHints(tail);
  fail(`bridge failed to start on port ${PORT}; see ${LOG}${tail ? `\n\n${tail}` : ""}\n\n${hints.join("\n")}`);
}

async function fetchCatalog(force) {
  const expectService = needsOpenCode();
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
  if ((catalog.data || []).length === 1) {
    console.log("note: this OpenCode account currently exposes only one free model.");
    console.log("      Run: o3c --doctor");
  }
  if (catalog.source !== "service") {
    console.log("note: live catalog was not ready; showing the fallback list.");
    console.log("      Run: o3c --doctor");
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
    console.error(`${PREFIX}: model "${requested}" is not in the current free catalog.`);
    console.error(`Available: ${data.map((entry) => `${entry.alias || entry.id} (${entry.id})`).join(", ")}`);
    console.error("Run: o3c --list");
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
  return options.length;
}

function pickerInfo() {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    const options = value?.modelPicker?.options;
    return { count: Array.isArray(options) ? options.length : 0 };
  } catch {
    return { count: 0 };
  }
}

function userPickerPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const file = path.join(base, "settings.json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && value.modelPicker ? file : null;
  } catch {
    return null;
  }
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
  console.log(`${PREFIX} stopped`);
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (text === "") return '""';
  if (!/[\s"&|<>^()%!]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

function claudeSpawnSpec(args) {
  if (process.platform !== "win32") return { command: "claude", args, shell: false };
  const command = findExecutable(process.env.CLAUDE_BIN || "claude", { env: process.env, platform: process.platform });
  if (!command) {
    fail(`Claude Code was not found on PATH.\n${installGuidance("claude", { platform: process.platform }).join("\n")}`, 127);
  }
  if (/\.(exe|com)$/i.test(command)) return { command, args, shell: false };
  const line = `"${command}" ${args.map(quoteWindowsArg).join(" ")}`;
  return { command: line, args: [], shell: true };
}

async function launchClaude(model, args) {
  const spec = claudeSpawnSpec(args);
  const child = spawn(spec.command, spec.args, {
    shell: spec.shell,
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
  child.on("error", (error) => {
    const fix = installGuidance("claude", { platform: process.platform }).join("\n");
    fail(`could not start Claude Code: ${error.message}\n${fix}`, 127);
  });
  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  process.exit(code);
}

function preflight({ needClaude }) {
  const checks = checkPrerequisites({
    needOpenCode: needsOpenCode(),
    needClaude,
  });
  if (missingRequired(checks).length || checks.some((check) => !check.required && !check.ok)) {
    console.error(formatPrerequisites(checks));
  }
  if (missingRequired(checks).length) process.exit(1);
}

async function doctor() {
  const checks = checkPrerequisites({
    needOpenCode: needsOpenCode(),
    needClaude: true,
  });
  const picker = pickerInfo();
  const conflicting = userPickerPath();
  console.log("O3C doctor");
  console.log(`  platform: ${process.platform} ${process.arch}`);
  console.log(`  node:     ${process.version}`);
  console.log(`  data:     ${DATA_DIR}`);
  console.log(`  state:    ${STATE_DIR}`);
  console.log(`  picker:   ${SETTINGS_FILE} (${picker.count} models)`);
  if (conflicting) {
    console.log(`  warning:  ${conflicting} also defines modelPicker and may override O3C.`);
  }
  console.log("");
  console.log(formatPrerequisites(checks));
  const running = await bridgeHealthy(2000);
  console.log("");
  console.log(running ? `Bridge: running at ${BASE}` : "Bridge: not running (starts on first launch)");
  if (running) console.log(`Log:    ${LOG}`);
  if (!missingRequired(checks).length) {
    console.log("\nNext: o3c --list");
  }
  return missingRequired(checks).length ? 1 : 0;
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
      preflight({ needClaude: false });
      await startBridge();
      const catalog = requireCatalog(await fetchCatalog(true));
      printCatalog(catalog);
      const count = writeSettings(catalog);
      console.log(`settings: ${SETTINGS_FILE} (${count} models)`);
      return;
    }
    if (arg === "--doctor") {
      process.exit(await doctor());
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
        console.error("Run: o3c --doctor");
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

  preflight({ needClaude: true });
  await startBridge();
  const catalog = requireCatalog(await fetchCatalog(true));
  const model = resolveRequested(catalog, requested);
  const count = writeSettings(catalog);
  console.error(`[${PREFIX}] model=${model.alias || model.id} (${model.id}) ctx=${model.context_window} out=${model.max_output_tokens} picker=${count} bridge=${BASE}`);
  await launchClaude(model, ["--settings", SETTINGS_FILE, "--model", model.id, ...passthrough]);
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`${PREFIX}: ${message}`);
  if (/EACCES|EPERM/.test(message)) {
    console.error("Check permissions for the data/state directories, or set OPENCODE_FREE_DATA_DIR and OPENCODE_FREE_STATE_DIR.");
  } else {
    console.error("Run: o3c --doctor");
  }
  process.exit(1);
});
