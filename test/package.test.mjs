import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "o3c-package-"));
const PREFIX = path.join(ROOT, "prefix");
const DATA = path.join(ROOT, "data");
const STATE = path.join(ROOT, "state");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args) {
  return spawnSync(npm, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("the packed npm tarball installs globally and runs", () => {
  const pack = runNpm(["pack", "--json", "--pack-destination", ROOT]);
  assert.equal(pack.status, 0, pack.stderr);
  const packed = JSON.parse(pack.stdout)[0];
  const tarball = path.resolve(ROOT, packed.filename);
  assert.ok(fs.existsSync(tarball));

  const install = runNpm(["install", "-g", tarball, "--prefix", PREFIX, "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(install.status, 0, install.stderr);

  const shim = process.platform === "win32"
    ? path.join(PREFIX, "o3c.cmd")
    : path.join(PREFIX, "bin", "o3c");
  assert.ok(fs.existsSync(shim), `missing shim: ${shim}`);

  const env = {
    ...process.env,
    OPENCODE_FREE_DATA_DIR: DATA,
    OPENCODE_FREE_STATE_DIR: STATE,
  };
  const help = process.platform === "win32"
    ? spawnSync(`"${shim}" --help`, { shell: true, encoding: "utf8", env, windowsHide: true })
    : spawnSync(shim, ["--help"], { encoding: "utf8", env, windowsHide: true });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: o3c/);

  const packageRoot = [
    path.join(PREFIX, "node_modules", "@axeus", "o3c"),
    path.join(PREFIX, "lib", "node_modules", "@axeus", "o3c"),
  ].find((candidate) => fs.existsSync(path.join(candidate, "src", "server.mjs")));
  assert.ok(packageRoot, "packed package is missing src/server.mjs");
});
