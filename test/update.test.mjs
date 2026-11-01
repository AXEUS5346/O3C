import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideUpdate,
  detectInstallKind,
  parseUpdateArgs,
  updateUsage,
} from "../src/self-update.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "o3c-update-"));

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test("parses update options and rejects unknown flags", () => {
  assert.deepEqual(parseUpdateArgs([]), { check: false, force: false, help: false });
  assert.deepEqual(parseUpdateArgs(["--check"]), { check: true, force: false, help: false });
  assert.deepEqual(parseUpdateArgs(["--force", "--help"]), { check: false, force: true, help: true });
  assert.match(parseUpdateArgs(["--bogus"]).error, /unknown update option/);
});

test("detects source, GitHub, and npm installs", () => {
  const source = path.join(ROOT, "source");
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  assert.equal(detectInstallKind({ repoRoot: source }), "source");
  assert.equal(detectInstallKind({ repoRoot: source, npmResolved: "git+https://github.com/x/y" }), "source");
  assert.equal(detectInstallKind({ repoRoot: ROOT, npmResolved: "git+https://github.com/AXEUS5346/O3C.git" }), "github");
  assert.equal(detectInstallKind({ repoRoot: ROOT, npmResolved: "https://registry.npmjs.org/@axeus/o3c/-/o3c-0.3.0.tgz" }), "npm");
});

test("chooses safe update actions", () => {
  assert.equal(decideUpdate({ kind: "npm", current: "0.3.0", latest: "0.3.1" }), "install");
  assert.equal(decideUpdate({ kind: "npm", current: "0.3.1", latest: "0.3.1" }), "current");
  assert.equal(decideUpdate({ kind: "npm", current: "0.3.2", latest: "0.3.1" }), "current");
  assert.equal(decideUpdate({ kind: "npm", current: "0.3.1", latest: "0.3.1", force: true }), "install");
  assert.equal(decideUpdate({ kind: "source", current: "0.3.1" }), "refresh");
  assert.equal(decideUpdate({ kind: "github", current: "0.3.1" }), "refresh");
  assert.equal(decideUpdate({ kind: "npm", current: "0.3.1", latest: "0.3.2", check: true }), "check");
});

test("update help documents check and restart", () => {
  const help = updateUsage();
  assert.match(help, /o3c update --check/);
  assert.match(help, /git pull --ff-only/);
  assert.match(help, /o3c --stop && o3c/);
});
