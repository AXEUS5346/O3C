import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MIN_NODE_MAJOR = 22;
export const URLS = {
  node: "https://nodejs.org/en/download",
  opencode: "https://opencode.ai/v2/docs",
  claude: "https://code.claude.com/docs/en/setup",
};

export function numericVersion(value) {
  const match = String(value || "").trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match[0] : null;
}

export function versionMajor(value) {
  const version = numericVersion(value);
  return version ? Number(version.split(".")[0]) : 0;
}

function isExecutable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) {
    const candidate = path.resolve(name);
    return isExecutable(candidate, platform) ? candidate : null;
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const names = platform === "win32" && !path.extname(name)
    ? extensions.map((extension) => `${name}${extension.toLowerCase()}`)
    : [name];
  for (const directory of String(env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const candidate of names) {
      const file = path.join(directory, candidate);
      if (isExecutable(file, platform)) return file;
    }
  }
  return null;
}

export function commandVersion(command, { platform = process.platform, timeout = 4000 } = {}) {
  try {
    const isScript = platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const result = isScript
      ? spawnSync(`"${command}" --version`, { shell: true, encoding: "utf8", timeout, windowsHide: true })
      : spawnSync(command, ["--version"], { encoding: "utf8", timeout, windowsHide: true });
    if (result.error) return null;
    const text = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    return numericVersion(text);
  } catch {
    return null;
  }
}

export function openCodeAuthCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const dataHomes = [];
  if (env.XDG_DATA_HOME) dataHomes.push(env.XDG_DATA_HOME);
  dataHomes.push(path.join(home, ".local", "share"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA) dataHomes.push(env.LOCALAPPDATA);
    if (env.APPDATA) dataHomes.push(env.APPDATA);
  }
  if (platform === "darwin") {
    dataHomes.push(path.join(home, "Library", "Application Support"));
  }
  const candidates = [];
  for (const dataHome of dataHomes) {
    for (const name of ["auth.json", "account.json"]) {
      candidates.push(path.join(dataHome, "opencode", name));
    }
  }
  const o3cData = env.OPENCODE_FREE_DATA_DIR || env.OPENCODE_FREE_BRIDGE_DIR;
  if (o3cData) {
    for (const name of ["auth.json", "account.json"]) {
      candidates.push(path.join(o3cData, "opencode-home", ".local", "share", "opencode", name));
    }
  }
  return [...new Set(candidates)];
}

export function findOpenCodeAuth(options = {}) {
  return openCodeAuthCandidates(options).find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

export function installGuidance(id, { platform = process.platform, arch = process.arch } = {}) {
  if (id === "node") {
    const lines = [`Install Node.js 22 or newer: ${URLS.node}`];
    if (platform === "win32") lines.push("Or run: winget install OpenJS.NodeJS.LTS");
    else if (platform === "darwin") lines.push("Or run: brew install node");
    else lines.push("Or use nvm/fnm, or your distribution's Node 22+ package.");
    return lines;
  }
  if (id === "opencode") {
    const lines = [`O3C needs OpenCode 2.x: ${URLS.opencode}`];
    if (platform === "win32") {
      const artifact = arch === "arm64" ? "opencode-windows-arm64.zip" : "opencode-windows-x64.zip";
      lines.push(`Download: https://opencode.ai/update/api/latest/cli/opencode/${artifact}`);
      lines.push("Add the extracted folder to PATH, or install OpenCode inside WSL.");
    } else {
      lines.push("Install: curl -fsSL https://opencode.ai/v2/install | bash");
      if (platform === "darwin") lines.push("Or run: brew install anomalyco/tap/opencode-v2");
      else lines.push("Or run: npm install -g @opencode/cli");
      lines.push("Verify with: opencode --version");
    }
    return lines;
  }
  if (id === "claude") {
    const lines = [`Install Claude Code: ${URLS.claude}`];
    if (platform === "win32") {
      lines.push("PowerShell: irm https://claude.ai/install.ps1 | iex");
      lines.push("Or run: winget install Anthropic.ClaudeCode");
    } else {
      lines.push("Install: curl -fsSL https://claude.ai/install.sh | bash");
      if (platform === "darwin") lines.push("Or run: brew install --cask claude-code");
      else lines.push("Or run: npm install -g @anthropic-ai/claude-code");
    }
    return lines;
  }
  if (id === "opencode-auth") {
    return [
      "Sign in to OpenCode Zen before using free models:",
      "Run: opencode auth login",
      "Or run `opencode` and use /connect, then complete the browser sign-in.",
      "Verify with: opencode auth list",
    ];
  }
  return [];
}

export function checkPrerequisites({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  home = os.homedir(),
  needOpenCode = true,
  needClaude = true,
  detailed = false,
  versionOf = commandVersion,
} = {}) {
  const checks = [];
  const major = versionMajor(nodeVersion);
  checks.push({
    id: "node",
    label: "Node.js 22+",
    required: true,
    ok: major >= MIN_NODE_MAJOR,
    detail: `v${String(nodeVersion).replace(/^v/i, "")}`,
    fix: major >= MIN_NODE_MAJOR ? [] : installGuidance("node", { platform, arch }),
  });

  if (needOpenCode) {
    const command = env.OPENCODE_BIN || "opencode";
    const executable = findExecutable(command, { env, platform });
    let ok = !!executable;
    let detail = executable || `not found (${command})`;
    if (executable) {
      const version = versionOf(executable, { platform });
      if (version) {
        detail = `${executable} (v${version})`;
        if (versionMajor(version) < 2) {
          ok = false;
          detail = `${executable} (v${version}) - O3C requires OpenCode 2.x`;
        }
      } else {
        detail = `${executable} (version unknown)`;
      }
    }
    checks.push({
      id: "opencode",
      label: "OpenCode 2.x",
      required: true,
      ok,
      detail,
      fix: ok ? [] : installGuidance("opencode", { platform, arch }),
    });
  }

  if (needClaude) {
    const command = env.CLAUDE_BIN || "claude";
    const executable = findExecutable(command, { env, platform });
    let detail = executable || `not found (${command})`;
    if (executable && detailed) {
      const version = versionOf(executable, { platform });
      if (version) detail = `${executable} (v${version})`;
    }
    checks.push({
      id: "claude",
      label: "Claude Code",
      required: true,
      ok: !!executable,
      detail,
      fix: executable ? [] : installGuidance("claude", { platform }),
    });
  }

  if (needOpenCode) {
    const auth = findOpenCodeAuth({ env, platform, home });
    checks.push({
      id: "opencode-auth",
      label: "OpenCode login",
      required: false,
      ok: !!auth,
      detail: auth || "not found (run opencode auth login)",
      fix: auth ? [] : installGuidance("opencode-auth", { platform }),
    });
  }

  return checks;
}

export function formatPrerequisites(checks) {
  const lines = ["Prerequisite check:"];
  for (const check of checks) {
    const status = check.ok ? "OK" : check.required ? "MISSING" : "WARN";
    lines.push(`[${status.padEnd(7)}] ${check.label} - ${check.detail || ""}`.trimEnd());
    if (!check.ok) {
      for (const line of check.fix || []) lines.push(`          ${line}`);
    }
  }
  const missing = checks.filter((check) => check.required && !check.ok);
  if (missing.length) {
    lines.push("", "Install the MISSING items above, then run: o3c --doctor");
  } else {
    lines.push("", "All required prerequisites are available.");
  }
  return lines.join("\n");
}

export function missingRequired(checks) {
  return checks.filter((check) => check.required && !check.ok);
}
