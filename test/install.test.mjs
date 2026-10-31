import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install.mjs");
const LAUNCHER = path.join(REPO_ROOT, "bin", "o3c.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "o3c-install-"));
const BIN = path.join(ROOT, "bin");
const DATA = path.join(ROOT, "data");
const STATE = path.join(ROOT, "state");
const EMPTY = path.join(ROOT, "empty");
const HOME = path.join(ROOT, "home");
const shimName = process.platform === "win32" ? "o3c.cmd" : "o3c";
const shim = path.join(BIN, shimName);

function install(args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [INSTALLER, "--bin-dir", BIN, "--data-dir", DATA, "--state-dir", STATE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
}

function runShim(args) {
  const env = { ...process.env, OPENCODE_FREE_DATA_DIR: DATA, OPENCODE_FREE_STATE_DIR: STATE };
  if (process.platform === "win32") {
    const line = `"${shim}" ${args.map((arg) => `"${arg}"`).join(" ")}`;
    return spawnSync(line, { shell: true, encoding: "utf8", env, windowsHide: true });
  }
  return spawnSync(shim, args, { encoding: "utf8", env, windowsHide: true });
}

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("installer is idempotent, migrates the old command, and works", () => {
  fs.mkdirSync(BIN, { recursive: true });
  const legacy = path.join(BIN, process.platform === "win32" ? "claude-opencode.cmd" : "claude-opencode");
  if (process.platform === "win32") {
    fs.writeFileSync(legacy, "@echo off\r\nrem O3C claude-opencode shim\r\n\"node\" \"claude-opencode.mjs\" %*\r\n");
  } else {
    fs.symlinkSync(LAUNCHER, legacy, "file");
  }

  const first = install();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /O3C \d+\.\d+\.\d+ installed/);
  assert.match(first.stdout, /launcher:/);
  assert.match(first.stdout, /Prerequisite check:/);
  assert.ok(fs.existsSync(DATA));
  assert.ok(fs.existsSync(STATE));
  assert.ok(!fs.existsSync(legacy), "legacy claude-opencode shim was not removed");

  if (process.platform === "win32") {
    assert.ok(fs.existsSync(shim));
    assert.ok(fs.existsSync(path.join(BIN, "o3c.ps1")));
    assert.match(fs.readFileSync(shim, "utf8"), /O3C o3c shim/);
  } else {
    const stat = fs.lstatSync(shim);
    assert.ok(stat.isSymbolicLink());
    assert.equal(fs.realpathSync(shim), fs.realpathSync(LAUNCHER));
    fs.accessSync(shim, fs.constants.X_OK);
    assert.equal(fs.statSync(DATA).mode & 0o777, 0o700);
    assert.equal(fs.statSync(STATE).mode & 0o777, 0o700);
  }

  const second = install();
  assert.equal(second.status, 0, second.stderr);
});

test("installed shim runs the launcher without starting the bridge", () => {
  const help = runShim(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: o3c/);
  assert.match(help.stdout, /--doctor/);

  const log = runShim(["--log"]);
  assert.equal(log.status, 0, log.stderr);
  assert.equal(log.stdout.trim(), path.join(STATE, "bridge.log"));
});

test("doctor explains missing prerequisites and how to install them", () => {
  fs.mkdirSync(EMPTY, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  const env = {
    ...process.env,
    PATH: EMPTY,
    HOME,
    USERPROFILE: HOME,
    XDG_DATA_HOME: path.join(HOME, ".local", "share"),
    LOCALAPPDATA: path.join(HOME, "local-app-data"),
    APPDATA: path.join(HOME, "app-data"),
    OPENCODE_FREE_DATA_DIR: DATA,
    OPENCODE_FREE_STATE_DIR: STATE,
    OPENCODE_FREE_PORT: "8799",
  };
  delete env.OPENCODE_BIN;
  delete env.CLAUDE_BIN;

  const result = spawnSync(process.execPath, [LAUNCHER, "--doctor"], { encoding: "utf8", env, windowsHide: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /\[OK\s*\] Node\.js 22\+/);
  assert.match(output, /\[MISSING\] OpenCode 2\.x/);
  assert.match(output, /\[MISSING\] Claude Code/);
  assert.match(output, /https:\/\/opencode\.ai/);
  assert.match(output, /claude\.ai\/install/);
  assert.match(output, /opencode auth login/);
  assert.match(output, /o3c --doctor/);

  const list = spawnSync(process.execPath, [LAUNCHER, "--list"], { encoding: "utf8", env, windowsHide: true });
  assert.equal(list.status, 1, list.stdout);
  assert.match(`${list.stdout}\n${list.stderr}`, /\[MISSING\] OpenCode 2\.x/);
});

test("installer prints the same guidance but still installs the shim", () => {
  fs.mkdirSync(EMPTY, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  const binDir = path.join(ROOT, "guided-bin");
  const env = {
    ...process.env,
    PATH: EMPTY,
    HOME,
    USERPROFILE: HOME,
    XDG_DATA_HOME: path.join(HOME, ".local", "share"),
    LOCALAPPDATA: path.join(HOME, "local-app-data"),
    APPDATA: path.join(HOME, "app-data"),
  };
  delete env.OPENCODE_BIN;
  delete env.CLAUDE_BIN;

  const result = spawnSync(process.execPath, [
    INSTALLER,
    "--bin-dir", binDir,
    "--data-dir", path.join(ROOT, "guided-data"),
    "--state-dir", path.join(ROOT, "guided-state"),
  ], { encoding: "utf8", env, windowsHide: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /\[MISSING\] OpenCode 2\.x/);
  assert.match(output, /\[MISSING\] Claude Code/);
  assert.match(output, /https:\/\/opencode\.ai/);
  assert.match(output, /claude\.ai\/install/);
  assert.match(output, /o3c --doctor/);
  assert.ok(fs.existsSync(path.join(binDir, process.platform === "win32" ? "o3c.cmd" : "o3c")));
});

test("doctor reports a complete environment and next step", () => {
  const tools = path.join(ROOT, "tools");
  const authData = path.join(ROOT, "auth-data");
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(path.join(authData, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(authData, "opencode", "auth.json"), "{}");
  for (const [name, version] of [["opencode", "2.1.4"], ["claude", "2.1.284"]]) {
    const file = path.join(tools, process.platform === "win32" ? `${name}.cmd` : name);
    fs.writeFileSync(file, process.platform === "win32" ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  const env = {
    ...process.env,
    PATH: tools,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    HOME,
    USERPROFILE: HOME,
    XDG_DATA_HOME: authData,
    LOCALAPPDATA: path.join(HOME, "local-app-data"),
    APPDATA: path.join(HOME, "app-data"),
    OPENCODE_FREE_DATA_DIR: DATA,
    OPENCODE_FREE_STATE_DIR: STATE,
    OPENCODE_FREE_PORT: "8799",
  };
  delete env.OPENCODE_BIN;
  delete env.CLAUDE_BIN;

  const result = spawnSync(process.execPath, [LAUNCHER, "--doctor"], { encoding: "utf8", env, windowsHide: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /\[OK\s*\] OpenCode 2\.x/);
  assert.match(output, /\(v2\.1\.4\)/);
  assert.match(output, /\[OK\s*\] Claude Code/);
  assert.match(output, /\(v2\.1\.284\)/);
  assert.match(output, /\[OK\s*\] OpenCode login/);
  assert.match(output, /Next: o3c --list/);
});

test("installer refuses an unknown launcher unless forced, then backs it up", () => {
  fs.mkdirSync(BIN, { recursive: true });
  fs.rmSync(shim, { force: true });
  fs.writeFileSync(shim, "#!/bin/sh\necho user-owned\n", { mode: 0o755 });

  const refused = install();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not look like an O3C launcher/);

  const forced = install(["--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /backed up/);
  const backups = fs.readdirSync(BIN).filter((name) => name.includes(".bak-"));
  assert.equal(backups.length, 1);
});

test("uninstall removes the shim and keeps runtime data", () => {
  const removed = install(["--uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /launcher removed/);
  assert.ok(!fs.existsSync(shim));
  if (process.platform === "win32") {
    assert.ok(!fs.existsSync(path.join(BIN, "o3c.ps1")));
  }
  assert.ok(fs.existsSync(DATA));
  assert.ok(fs.existsSync(STATE));
});
