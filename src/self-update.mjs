import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareVersions } from "./preflight.mjs";

export const NPM_PACKAGE = "@axeus/o3c";
export const GITHUB_SPEC = "github:AXEUS5346/O3C";

export function parseUpdateArgs(argv) {
  const options = { check: false, force: false, help: false };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else return { error: `unknown update option: ${arg}` };
  }
  return options;
}

export function detectInstallKind({ repoRoot, npmResolved = null } = {}) {
  if (repoRoot && fs.existsSync(path.join(repoRoot, ".git"))) return "source";
  if (npmResolved && /(?:git\+|github\.com[:/]|git@)/i.test(npmResolved)) return "github";
  return "npm";
}

export function decideUpdate({ kind, current, latest = null, force = false, check = false }) {
  if (check) return "check";
  if (kind === "source" || kind === "github") return "refresh";
  if (force || !latest || compareVersions(current, latest) < 0) return "install";
  return "current";
}

export function readVersion(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

export function updateUsage() {
  return `Usage: o3c update [--check] [--force]

Update O3C in place:
  - npm installs: install @axeus/o3c@latest
  - GitHub installs: refresh github:AXEUS5346/O3C
  - source checkouts: git pull --ff-only, refusing if the tree is dirty

Options:
  --check   Only report whether an update is available
  --force   Reinstall even when the current version is already latest
  -h, --help  Show this help

Examples:
  o3c update --check
  o3c update

Restart running sessions after updating:
  o3c --stop && o3c`;
}

function npmCommand(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, { stdio = "inherit", encoding, platform } = {}) {
  return spawnSync(command, args, {
    stdio,
    encoding,
    shell: platform === "win32",
    windowsHide: true,
  });
}

function npmGlobal() {
  const command = npmCommand(process.platform);
  const result = run(command, ["ls", "-g", NPM_PACKAGE, "--json", "--depth=0"], {
    encoding: "utf8",
    platform: process.platform,
  });
  try {
    return JSON.parse(result.stdout)?.dependencies?.[NPM_PACKAGE]?.resolved || null;
  } catch {
    return null;
  }
}

function npmLatest(error) {
  const result = run(npmCommand(process.platform), ["view", NPM_PACKAGE, "version"], {
    encoding: "utf8",
    platform: process.platform,
  });
  if (result.status !== 0) {
    error(`Could not read the npm registry version: ${(result.stderr || result.stdout || "").trim()}`);
    return null;
  }
  return (result.stdout || "").trim() || null;
}

function git(repoRoot, args, options = {}) {
  return run("git", ["-C", repoRoot, ...args], options);
}

export async function updateSelf({ repoRoot, args = [], print = console.log, error = console.error } = {}) {
  const options = parseUpdateArgs(args);
  if (options.error) {
    error(options.error);
    return 2;
  }
  if (options.help) {
    print(updateUsage());
    return 0;
  }

  const current = readVersion(repoRoot);
  if (!current) {
    error(`Could not read the O3C version from ${path.join(repoRoot, "package.json")}.`);
    return 1;
  }
  const kind = detectInstallKind({
    repoRoot,
    npmResolved: fs.existsSync(path.join(repoRoot, ".git")) ? null : npmGlobal(),
  });
  print(`O3C ${current} (${kind} install)`);

  if (options.check) {
    if (kind === "source") {
      const fetched = git(repoRoot, ["fetch", "--quiet"], { encoding: "utf8" });
      if (fetched.status !== 0) {
        error(`Could not check the source repository: ${(fetched.stderr || fetched.stdout || "").trim()}`);
        return 1;
      }
      const behind = git(repoRoot, ["rev-list", "--count", "HEAD..@{u}"], { encoding: "utf8" });
      if (behind.status !== 0) {
        print("Source checkout has no upstream branch; fetch/pull manually.");
        return 0;
      }
      const count = Number((behind.stdout || "0").trim()) || 0;
      print(count ? `Update available: ${count} commit(s) behind upstream.` : "O3C source is up to date.");
      return 0;
    }
    if (kind === "github") {
      print("GitHub install. Run `o3c update` to refresh github:AXEUS5346/O3C.");
      return 0;
    }
    const latest = npmLatest(error);
    if (!latest) return 1;
    if (compareVersions(current, latest) < 0) print(`Update available: ${current} -> ${latest}.`);
    else if (compareVersions(current, latest) > 0) print(`Installed ${current} is newer than the registry (${latest}).`);
    else print(`O3C ${current} is up to date.`);
    return 0;
  }

  if (kind === "source") {
    const status = git(repoRoot, ["status", "--porcelain"], { encoding: "utf8" });
    if (status.status !== 0) {
      error(`Could not inspect the source checkout: ${(status.stderr || status.stdout || "").trim()}`);
      return 1;
    }
    if ((status.stdout || "").trim()) {
      error("Source checkout has uncommitted changes; commit or stash them before running `o3c update`.");
      return 1;
    }
    const pulled = git(repoRoot, ["pull", "--ff-only"]);
    if (pulled.status !== 0) {
      error("Source update failed. Resolve any branch/upstream issue, then retry `o3c update`.");
      return 1;
    }
    print("O3C source updated. Restart with: o3c --stop && o3c");
    return 0;
  }

  if (kind === "github") {
    const installed = run(npmCommand(process.platform), ["install", "-g", GITHUB_SPEC, "--no-audit", "--no-fund"], {
      platform: process.platform,
    });
    if (installed.status !== 0) {
      error("GitHub update failed. Check npm permissions and network, then retry `o3c update`.");
      return 1;
    }
    print("O3C updated from GitHub. Restart with: o3c --stop && o3c");
    return 0;
  }

  const latest = npmLatest(error);
  if (!latest) return 1;
  const action = decideUpdate({ kind, current, latest, force: options.force });
  if (action === "current") {
    print(`O3C ${current} is already the latest npm release.`);
    return 0;
  }
  if (compareVersions(current, latest) > 0 && !options.force) {
    print(`Installed ${current} is newer than the registry (${latest}); not downgrading.`);
    return 0;
  }
  const installed = run(
    npmCommand(process.platform),
    ["install", "-g", `${NPM_PACKAGE}@latest`, "--no-audit", "--no-fund"],
    { platform: process.platform },
  );
  if (installed.status !== 0) {
    error("npm update failed. Check npm permissions and network, then retry `o3c update`.");
    return 1;
  }
  print(`O3C updated to ${latest}. Restart with: o3c --stop && o3c`);
  return 0;
}
