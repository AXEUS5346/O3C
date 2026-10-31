#!/usr/bin/env node
// Cross-platform installer: creates a launcher shim, runtime directories, and
// checks Node/OpenCode/Claude Code availability without touching their config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDir, stateDir } from "../src/paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(REPO_ROOT, "bin", "claude-opencode.mjs");
const MARKER = "O3C claude-opencode shim";
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;

function usage() {
  console.log(`O3C installer ${VERSION}

Usage: node scripts/install.mjs [options]

Options:
  --bin-dir <dir>    Where to create the launcher (default: platform bin dir)
  --data-dir <dir>   Runtime data directory (auth copy, generated settings)
  --state-dir <dir>  Runtime state directory (logs, pid, usage)
  --force            Replace an unrecognized launcher file (backs it up first)
  --uninstall        Remove the launcher shim (keeps data and state)
      --version      Print the version
  -h, --help         Show this help

Environment:
  OPENCODE_FREE_BIN_DIR, OPENCODE_FREE_DATA_DIR, OPENCODE_FREE_STATE_DIR
  behave like the matching options.`);
}

function fail(message, code = 1) {
  console.error(`install: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { force: false, uninstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (index + 1 >= argv.length) fail(`${name} needs a value`, 2);
      index += 1;
      return argv[index];
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version") options.version = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--bin-dir") options.binDir = take(arg);
    else if (arg.startsWith("--bin-dir=")) options.binDir = arg.slice("--bin-dir=".length);
    else if (arg === "--data-dir") options.dataDir = take(arg);
    else if (arg.startsWith("--data-dir=")) options.dataDir = arg.slice("--data-dir=".length);
    else if (arg === "--state-dir") options.stateDir = take(arg);
    else if (arg.startsWith("--state-dir=")) options.stateDir = arg.slice("--state-dir=".length);
    else fail(`unknown option: ${arg}`, 2);
  }
  return options;
}

function npmGlobalPrefix() {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["prefix", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return null;
}

function defaultBinDir() {
  if (process.env.OPENCODE_FREE_BIN_DIR) return path.resolve(process.env.OPENCODE_FREE_BIN_DIR);
  if (process.platform === "win32") {
    const prefix = npmGlobalPrefix();
    if (prefix) return prefix;
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm");
  }
  return path.join(process.env.XDG_BIN_HOME || path.join(os.homedir(), ".local", "bin"));
}

function isOurLauncher(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = fs.realpathSync(file);
      } catch {
        target = path.resolve(path.dirname(file), fs.readlinkSync(file));
      }
      return target === LAUNCHER || target.startsWith(`${REPO_ROOT}${path.sep}`) || path.basename(target) === "claude-opencode.mjs";
    }
    if (!stat.isFile()) return false;
    const text = fs.readFileSync(file, "utf8").slice(0, 8192);
    return text.includes(MARKER) || text.includes("claude-opencode.mjs") || text.includes("OpenCode Zen's free models");
  } catch {
    return false;
  }
}

function backup(file) {
  const destination = `${file}.bak-${Date.now()}`;
  fs.renameSync(file, destination);
  return destination;
}

function prepareTarget(file, options) {
  if (!fs.existsSync(file) && !isDanglingLink(file)) return;
  if (isOurLauncher(file)) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!options.force) {
    fail(`${file} exists and does not look like an O3C launcher; use --force to replace it or --bin-dir to install elsewhere`);
  }
  console.log(`install: backed up ${file} -> ${backup(file)}`);
}

function isDanglingLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeAtomic(file, content, mode) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(temp, content, { mode });
  fs.rmSync(file, { force: true });
  fs.renameSync(temp, file);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function installUnix(binDir, options) {
  const target = path.join(binDir, "claude-opencode");
  prepareTarget(target, options);
  fs.chmodSync(LAUNCHER, 0o755);
  try {
    fs.symlinkSync(LAUNCHER, target, "file");
  } catch {
    writeAtomic(target, `#!/bin/sh\n# ${MARKER}\nexec ${shQuote(process.execPath)} ${shQuote(LAUNCHER)} "$@"\n`, 0o755);
  }
  return target;
}

function installWindows(binDir, options) {
  const node = process.execPath;
  const files = {
    "claude-opencode.cmd": `@echo off\r\nrem ${MARKER}\r\n"${node}" "${LAUNCHER}" %*\r\n`,
    "claude-opencode.ps1": `# ${MARKER}\r\n& "${node}" "${LAUNCHER}" @args\r\nexit $LASTEXITCODE\r\n`,
    "claude-opencode": `#!/bin/sh\n# ${MARKER}\nexec "${node.replace(/\\/g, "/")}" "${LAUNCHER.replace(/\\/g, "/")}" "$@"\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(binDir, name);
    prepareTarget(target, options);
    const mode = name === "claude-opencode" ? 0o755 : 0o644;
    writeAtomic(target, content, mode);
  }
  return path.join(binDir, "claude-opencode.cmd");
}

function removeIfOurs(file) {
  if (!fs.existsSync(file) && !isDanglingLink(file)) return false;
  if (!isOurLauncher(file)) {
    console.error(`install: keeping ${file} (not an O3C launcher)`);
    return false;
  }
  fs.rmSync(file, { force: true });
  console.log(`removed ${file}`);
  return true;
}

function uninstall(options) {
  const binDir = path.resolve(options.binDir || defaultBinDir());
  const names = process.platform === "win32"
    ? ["claude-opencode", "claude-opencode.cmd", "claude-opencode.ps1"]
    : ["claude-opencode"];
  for (const name of names) removeIfOurs(path.join(binDir, name));
  console.log(`O3C launcher removed from ${binDir}`);
  console.log("Data and state directories were kept:");
  console.log(`  data:  ${dataDir()}`);
  console.log(`  state: ${stateDir()}`);
}

function onPath(dir) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const target = normalize(dir);
  return (process.env.PATH || "").split(path.delimiter).some((entry) => entry && normalize(entry) === target);
}

function findExecutable(name) {
  let names = [name];
  if (process.platform === "win32") {
    const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    names = path.extname(name) ? [name] : extensions.map((ext) => `${name}${ext.toLowerCase()}`);
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      try {
        if (fs.statSync(path.join(dir, candidate)).isFile()) return path.join(dir, candidate);
      } catch {}
    }
  }
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (options.version) return console.log(VERSION);

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail(`Node.js >= 22 is required (found ${process.version})`);

  if (options.dataDir) process.env.OPENCODE_FREE_DATA_DIR = path.resolve(options.dataDir);
  if (options.stateDir) process.env.OPENCODE_FREE_STATE_DIR = path.resolve(options.stateDir);

  const binDir = path.resolve(options.binDir || defaultBinDir());
  if (options.uninstall) return uninstall({ ...options, binDir });

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dataDir(), 0o700);
      fs.chmodSync(stateDir(), 0o700);
    } catch {}
  }

  if (!fs.existsSync(path.join(REPO_ROOT, "src", "server.mjs"))) {
    fail(`bridge source is missing at ${REPO_ROOT}/src/server.mjs`);
  }

  const shim = process.platform === "win32" ? installWindows(binDir, options) : installUnix(binDir, options);

  const missing = [];
  if (!findExecutable("opencode")) missing.push("opencode (OpenCode CLI)");
  if (!findExecutable("claude")) missing.push("claude (Claude Code)");
  if (missing.length) console.error(`install: warning: not found on PATH: ${missing.join(", ")}`);

  console.log(`O3C ${VERSION} installed`);
  console.log(`  launcher: ${shim}`);
  console.log(`  source:   ${REPO_ROOT}`);
  console.log(`  data:     ${dataDir()}`);
  console.log(`  state:    ${stateDir()}`);
  if (!onPath(binDir)) {
    console.log(`\nAdd ${binDir} to PATH:`);
    if (process.platform === "win32") {
      console.log(`  PowerShell: [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${binDir}", "User")`);
    } else {
      console.log(`  export PATH="${binDir}:$PATH"   (add to your shell profile)`);
    }
  }
  console.log(`
Next:
  claude-opencode --list
  claude-opencode -m deepseek -p "Reply with exactly OK"
`);
}

main();
