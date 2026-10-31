import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install.mjs");
const LAUNCHER = path.join(REPO_ROOT, "bin", "claude-opencode.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "o3c-install-"));
const BIN = path.join(ROOT, "bin");
const DATA = path.join(ROOT, "data");
const STATE = path.join(ROOT, "state");
const shimName = process.platform === "win32" ? "claude-opencode.cmd" : "claude-opencode";
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
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", `"${line}"`], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
  }
  return spawnSync(shim, args, { encoding: "utf8", env, windowsHide: true });
}

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("installer is idempotent and creates a working launcher", () => {
  const first = install();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /O3C \d+\.\d+\.\d+ installed/);
  assert.match(first.stdout, /launcher:/);
  assert.ok(fs.existsSync(DATA));
  assert.ok(fs.existsSync(STATE));

  if (process.platform === "win32") {
    assert.ok(fs.existsSync(shim));
    assert.ok(fs.existsSync(path.join(BIN, "claude-opencode.ps1")));
    assert.match(fs.readFileSync(shim, "utf8"), /O3C claude-opencode shim/);
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
  assert.match(help.stdout, /Usage: claude-opencode/);
  assert.match(help.stdout, /dynamic/);

  const log = runShim(["--log"]);
  assert.equal(log.status, 0, log.stderr);
  assert.equal(log.stdout.trim(), path.join(STATE, "bridge.log"));
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
    assert.ok(!fs.existsSync(path.join(BIN, "claude-opencode.ps1")));
  }
  assert.ok(fs.existsSync(DATA));
  assert.ok(fs.existsSync(STATE));
});
