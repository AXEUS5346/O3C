import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkPrerequisites,
  findExecutable,
  findOpenCodeAuth,
  formatPrerequisites,
  installGuidance,
  missingRequired,
  versionMajor,
} from "../src/preflight.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "o3c-preflight-"));
const BIN = path.join(ROOT, "bin");
const HOME = path.join(ROOT, "home");
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });

function fakeCommand(name) {
  const file = path.join(BIN, process.platform === "win32" ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === "win32" ? "@echo off\r\necho 2.1.4\r\n" : "#!/bin/sh\necho 2.1.4\n", { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("parses versions and finds executables on PATH", () => {
  assert.equal(versionMajor("v2.1.4"), 2);
  assert.equal(versionMajor("20.11.0"), 20);
  assert.equal(versionMajor("unknown"), 0);

  const fake = fakeCommand("opencode");
  const env = { PATH: BIN, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(findExecutable("opencode", { env, platform: process.platform }), fake);
  assert.equal(findExecutable("missing", { env, platform: process.platform }), null);
  assert.equal(findExecutable(fake, { env, platform: process.platform }), fake);
});

test("gives OS-specific install commands", () => {
  const windows = installGuidance("opencode", { platform: "win32", arch: "x64" }).join("\n");
  assert.match(windows, /opencode-windows-x64\.zip/);
  assert.match(windows, /WSL/);

  const macos = installGuidance("opencode", { platform: "darwin" }).join("\n");
  assert.match(macos, /opencode\.ai\/v2\/install/);
  assert.match(macos, /brew install anomalyco\/tap\/opencode-v2/);

  const linux = installGuidance("claude", { platform: "linux" }).join("\n");
  assert.match(linux, /claude\.ai\/install\.sh/);
  assert.match(linux, /@anthropic-ai\/claude-code/);

  const node = installGuidance("node", { platform: "win32" }).join("\n");
  assert.match(node, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(node, /nodejs\.org/);
});

test("reports missing prerequisites with actionable fixes", () => {
  const checks = checkPrerequisites({
    env: { PATH: "", XDG_DATA_HOME: path.join(HOME, "no-auth") },
    platform: process.platform,
    home: HOME,
    nodeVersion: "22.1.0",
    versionOf: () => null,
  });
  assert.equal(checks.find((check) => check.id === "node").ok, true);
  assert.equal(missingRequired(checks).length, 2);
  const output = formatPrerequisites(checks);
  assert.match(output, /\[MISSING\] OpenCode 2\.x/);
  assert.match(output, /\[MISSING\] Claude Code/);
  assert.match(output, /https:\/\/opencode\.ai/);
  assert.match(output, /https:\/\/claude\.ai\/install|claude\.ai\/install/);
  assert.match(output, /Install the MISSING items above, then run: o3c --doctor/);
});

test("flags Node older than 22 and OpenCode 1.x", () => {
  fakeCommand("opencode");
  const oldNode = checkPrerequisites({
    env: { PATH: BIN, XDG_DATA_HOME: path.join(HOME, "no-auth") },
    platform: process.platform,
    home: HOME,
    nodeVersion: "20.11.0",
    needOpenCode: false,
    needClaude: false,
  });
  assert.equal(oldNode.find((check) => check.id === "node").ok, false);
  assert.match(formatPrerequisites(oldNode), /Node\.js 22/);

  const oldOpenCode = checkPrerequisites({
    env: { PATH: BIN, XDG_DATA_HOME: path.join(HOME, "no-auth") },
    platform: process.platform,
    home: HOME,
    nodeVersion: "22.1.0",
    needClaude: false,
    versionOf: () => "1.15.0",
  });
  const opencode = oldOpenCode.find((check) => check.id === "opencode");
  assert.equal(opencode.ok, false);
  assert.match(opencode.detail, /requires OpenCode 2\.x/);
});

test("detects an existing OpenCode login", () => {
  const data = path.join(HOME, "auth-data");
  fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
  const auth = path.join(data, "opencode", "auth.json");
  fs.writeFileSync(auth, "{}");
  assert.equal(findOpenCodeAuth({ env: { XDG_DATA_HOME: data }, home: HOME, platform: process.platform }), auth);
  assert.equal(findOpenCodeAuth({ env: { XDG_DATA_HOME: path.join(HOME, "none") }, home: HOME, platform: process.platform }), null);
});
