import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

/** Per-user configuration directory. Windows uses %APPDATA%. */
export function configDir(): string {
  if (process.platform === "win32") {
    const appData = envPath("APPDATA");
    if (appData) return join(appData, "reviewbot");
    return join(homedir(), "AppData", "Roaming", "reviewbot");
  }
  const base = envPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return join(base, "reviewbot");
}

/** Per-user data directory. Windows uses %LOCALAPPDATA%. */
export function dataDir(): string {
  if (process.platform === "win32") {
    const local = envPath("LOCALAPPDATA");
    if (local) return join(local, "reviewbot");
    return join(homedir(), "AppData", "Local", "reviewbot");
  }
  const base = envPath("XDG_DATA_HOME") ?? join(homedir(), ".local", "share");
  return join(base, "reviewbot");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function credentialsDir(): string {
  return join(dataDir(), "credentials");
}

export function credentialsPath(): string {
  return join(credentialsDir(), "app.json");
}

export function databasePath(): string {
  return join(dataDir(), "reviewbot.db");
}

export function workspacesDir(): string {
  return join(dataDir(), "workspaces");
}

export function reposDir(): string {
  return join(workspacesDir(), "repos");
}

export function worktreesDir(): string {
  return join(workspacesDir(), "worktrees");
}

export function ensureDir(dir: string, mode = 0o700): string {
  mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}
