import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as v from "valibot";
import {
  configPath,
  credentialsPath,
  ensureDir,
  ensureParent,
  credentialsDir,
} from "./paths.ts";

export const REVIEWBOT_VERSION = "1.0.0";

const HostSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.check(
    (value) =>
      value === "github.com" ||
      (value.endsWith(".ghe.com") && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)),
    "GitHub host must be github.com or a *.ghe.com hostname",
  ),
);

export const ConfigSchema = v.object({
  github: v.object({
    host: HostSchema,
  }),
  polling: v.object({
    intervalSeconds: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(10),
      v.maxValue(3600),
    ),
  }),
  opencode: v.object({
    url: v.nullable(v.pipe(v.string(), v.url())),
  }),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type GitHubHost = Config["github"]["host"];

export const CredentialsSchema = v.object({
  host: v.string(),
  appId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  slug: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  privateKey: v.pipe(v.string(), v.minLength(1)),
  clientId: v.optional(v.string()),
  clientSecret: v.optional(v.string()),
  webhookSecret: v.optional(v.string()),
  organization: v.optional(v.string()),
  htmlUrl: v.optional(v.string()),
});

export type Credentials = v.InferOutput<typeof CredentialsSchema>;

export const DEFAULT_CONFIG: Config = {
  github: { host: "github.com" },
  polling: { intervalSeconds: 60 },
  opencode: { url: null },
};

/** Normalize and validate a configured GitHub host. */
export function normalizeHost(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/\/+$/, "");
  if (value.includes("/") || value.includes("?") || value.includes("#")) {
    throw new Error(`Invalid GitHub host: ${input}`);
  }
  return v.parse(HostSchema, value);
}

/** API base URL for a validated host. GHE.com is not GitHub Enterprise Server. */
export function apiBaseUrl(host: string): string {
  const normalized = normalizeHost(host);
  if (normalized === "github.com") return "https://api.github.com";
  return `https://api.${normalized}`;
}

/** Web base URL for a validated host. */
export function webBaseUrl(host: string): string {
  return `https://${normalizeHost(host)}`;
}

export function repoUrl(host: string, owner: string, name: string): string {
  return `${webBaseUrl(host)}/${owner}/${name}.git`;
}

export function loadConfig(path = configPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Reviewbot is not configured (${path}). Run "reviewbot setup" first.`,
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
  try {
    return v.parse(ConfigSchema, json);
  } catch (error) {
    throw new Error(`Invalid Reviewbot configuration in ${path}`, { cause: error });
  }
}

export function saveConfig(config: Config, path = configPath()): void {
  const parsed = v.parse(ConfigSchema, config);
  ensureParent(path);
  writeJsonAtomic(path, parsed);
}

export function loadCredentials(path = credentialsPath()): Credentials {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Reviewbot GitHub App credentials are missing (${path}). Run "reviewbot setup" first.`,
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
  try {
    return v.parse(CredentialsSchema, json);
  } catch (error) {
    throw new Error(`Invalid GitHub App credentials in ${path}`, { cause: error });
  }
}

export function saveCredentials(
  credentials: Credentials,
  path = credentialsPath(),
): { ok: boolean; detail?: string } {
  const parsed = v.parse(CredentialsSchema, credentials);
  ensureDir(credentialsDir());
  ensureParent(path);
  writeJsonAtomic(path, parsed);
  return secureFile(path);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * Restrict a file to the current user. POSIX uses 0600. Windows ACLs are
 * best-effort: inheritance is removed and the current user receives full
 * control. Failures are surfaced to the caller for diagnostics.
 */
export function secureFile(path: string): { ok: boolean; detail?: string } {
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }
  const user = process.env.USERNAME;
  if (!user) return { ok: false, detail: "USERNAME is not set" };
  const result = spawnSync(
    "icacls",
    [path, "/inheritance:r", "/grant:r", `${user}:F`],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "icacls failed").trim(),
    };
  }
  return { ok: true };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
