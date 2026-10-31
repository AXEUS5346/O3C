import os from "node:os";
import path from "node:path";

export function dataDir(env = process.env) {
  if (env.OPENCODE_FREE_DATA_DIR) return path.resolve(env.OPENCODE_FREE_DATA_DIR);
  if (env.OPENCODE_FREE_BRIDGE_DIR) return path.resolve(env.OPENCODE_FREE_BRIDGE_DIR);
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode-free-bridge");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode-free-bridge");
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode-free-bridge");
}

export function stateDir(env = process.env) {
  if (env.OPENCODE_FREE_STATE_DIR) return path.resolve(env.OPENCODE_FREE_STATE_DIR);
  if (process.platform === "win32" || process.platform === "darwin") {
    return path.join(dataDir(env), "state");
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode-free-bridge");
}

export function settingsPath(env = process.env) {
  return path.join(dataDir(env), "claude-settings.json");
}

export function logPath(env = process.env) {
  return path.join(stateDir(env), "bridge.log");
}

export function port(env = process.env) {
  return Number(env.OPENCODE_FREE_PORT || 8787);
}

export function bridgeUrl(env = process.env) {
  return `http://127.0.0.1:${port(env)}`;
}
