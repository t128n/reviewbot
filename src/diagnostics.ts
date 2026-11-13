import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configPath,
  credentialsPath,
  databasePath,
  workspacesDir,
} from "./paths.ts";
import {
  loadConfig,
  loadCredentials,
  type Config,
  type Credentials,
} from "./config.ts";
import { Store, nowIso } from "./db.ts";
import { GitHub } from "./github.ts";
import { OpenCodeAdapter, isCompatibleServer } from "./opencode.ts";
import { evaluateSecurityGate, gateIsOpen, type SecurityGate } from "./security.ts";
import type { Logger } from "./log.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export async function runDoctor(
  logger: Logger,
): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => {
    checks.push({ name, status, detail });
  };

  add(
    "Bun runtime",
    process.versions.bun ? "ok" : "fail",
    process.versions.bun ? `Bun ${process.versions.bun}` : "Reviewbot requires Bun",
  );

  const gitVersion = await commandVersion("git", ["--version"]);
  add(
    "Git",
    gitVersion ? "ok" : "fail",
    gitVersion ?? "git was not found on PATH",
  );

  let config: Config | null = null;
  try {
    config = loadConfig();
    add("Configuration", "ok", `${configPath()} (host ${config.github.host})`);
  } catch (error) {
    add("Configuration", "fail", message(error));
  }

  let credentials: Credentials | null = null;
  try {
    credentials = loadCredentials();
    add(
      "GitHub App credentials",
      "ok",
      `${credentialsPath()} (App ${credentials.appId}, ${credentials.slug})`,
    );
    if (process.platform !== "win32") {
      const mode = statSync(credentialsPath()).mode & 0o777;
      add(
        "Credential permissions",
        mode & 0o077 ? "fail" : "ok",
        `credentials file mode ${mode.toString(8)}`,
      );
    }
  } catch (error) {
    add("GitHub App credentials", "fail", message(error));
  }

  let store: Store | null = null;
  try {
    store = new Store(databasePath());
    store.setMeta("doctor.check", nowIso());
    const value = store.getMeta("doctor.check");
    add(
      "SQLite",
      value ? "ok" : "fail",
      `${databasePath()} (WAL, readable and writable)`,
    );
  } catch (error) {
    add("SQLite", "fail", message(error));
  }

  try {
    const probe = join(workspacesDir(), ".doctor-write-test");
    mkdirSync(workspacesDir(), { recursive: true, mode: 0o700 });
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    add("Workspace storage", "ok", workspacesDir());
  } catch (error) {
    add("Workspace storage", "fail", message(error));
  }

  let github: GitHub | null = null;
  if (credentials && config) {
    if (credentials.host !== config.github.host) {
      add(
        "GitHub host consistency",
        "fail",
        `credentials host ${credentials.host} does not match configured host ${config.github.host}`,
      );
    } else {
      github = new GitHub(credentials, logger);
      try {
        const info = await github.appInfo();
        add("GitHub App authentication", "ok", `${info.slug} (App ${credentials.appId})`);
        const installations = await github.listInstallations();
        add(
          "Installations",
          installations.length > 0 ? "ok" : "fail",
          installations.length === 0
            ? "No active installations; run reviewbot setup"
            : installations
                .map(
                  (installation) =>
                    `${installation.accountLogin}#${installation.id}${installation.suspended ? " (suspended)" : ""}`,
                )
                .join(", "),
        );
        let repositoryCount = 0;
        for (const installation of installations) {
          if (installation.suspended) continue;
          const repositories = await github.listInstallationRepositories(
            installation.id,
          );
          repositoryCount += repositories.length;
          const missing = requiredPermissions().filter(
            (permission) => installation.permissions[permission] !== "write",
          );
          add(
            `Permissions (${installation.accountLogin})`,
            missing.length === 0 ? "ok" : "fail",
            missing.length === 0
              ? "metadata:read, contents:write, issues:write, pull_requests:write"
              : `Missing write permissions: ${missing.join(", ")}`,
          );
        }
        add(
          "Repository access",
          repositoryCount > 0 ? "ok" : "fail",
          `${repositoryCount} repositories accessible`,
        );
      } catch (error) {
        add("GitHub connectivity", "fail", message(error));
      }
    }
  }

  if (config) {
    const adapter = new OpenCodeAdapter({
      url: config.opencode.url,
      model: config.opencode.model,
      logger,
    });
    try {
      const connection = await adapter.connect();
      add(
        "OpenCode service",
        "ok",
        `${connection.url} (OpenCode ${connection.version}, client 2.3.0)`,
      );
      if (config.opencode.model) {
        try {
          const available = await adapter.modelAvailable(config.opencode.model);
          add(
            "OpenCode model",
            available ? "ok" : "fail",
            available
              ? config.opencode.model
              : `${config.opencode.model} is not an enabled model available to OpenCode`,
          );
        } catch (error) {
          add("OpenCode model", "fail", message(error));
        }
      }
      add(
        "OpenCode compatibility",
        isCompatibleServer(connection.version) ? "ok" : "fail",
        isCompatibleServer(connection.version)
          ? "V2 contract supported (tested with 2.2.7)"
          : `Requires OpenCode V2 >= 2.2.0, found ${connection.version}`,
      );
      if (store) {
        const gate = await evaluateSecurityGate({
          adapter,
          store,
          logger,
          force: true,
        });
        add(
          "Permission boundary",
          gateIsOpen(gate) ? "ok" : "fail",
          `${gate.status}: ${gate.detail}`,
        );
      }
    } catch (error) {
      add("OpenCode service", "fail", message(error));
      add(
        "Read-only security boundary",
        "fail",
        "Not verified because OpenCode is unavailable; automatic processing will stay gated",
      );
    }
  }

  store?.close();
  return {
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

function requiredPermissions(): string[] {
  return ["contents", "issues", "pull_requests"];
}

export interface StatusReport {
  host: string | null;
  model: string | null;
  opencode: string;
  installations: number;
  repositories: number;
  lastPoll: string | null;
  queued: number;
  activeJob: string | null;
  recentFailures: Array<{ key: string; error: string | null }>;
  pollErrors: Array<{ repo: string; error: string }>;
  security: SecurityGate | null;
}

export async function collectStatus(logger: Logger): Promise<StatusReport> {
  let config: Config | null = null;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }
  let opencode = "not connected";
  if (config) {
    const adapter = new OpenCodeAdapter({
      url: config.opencode.url,
      model: config.opencode.model,
      logger,
    });
    try {
      const connection = await adapter.connect();
      opencode = `${connection.url} (OpenCode ${connection.version})`;
    } catch (error) {
      opencode = `unavailable: ${message(error)}`;
    }
  }

  const report: StatusReport = {
    host: config?.github.host ?? null,
    model: config?.opencode.model ?? null,
    opencode,
    installations: 0,
    repositories: 0,
    lastPoll: null,
    queued: 0,
    activeJob: null,
    recentFailures: [],
    pollErrors: [],
    security: null,
  };

  let store: Store | null = null;
  try {
    store = new Store(databasePath());
    const repositories = store.listRepositories(true);
    report.installations = store.listInstallations(true).length;
    report.repositories = repositories.length;
    const polls = repositories
      .map((repository) => repository.lastPollAt)
      .filter((value): value is string => value !== null)
      .sort();
    report.lastPoll = polls.length > 0 ? polls[polls.length - 1]! : null;
    report.queued = store.queueDepth();
    const active = store.activeJob();
    report.activeJob = active ? `${active.kind} (job ${active.id})` : null;
    report.recentFailures = store.recentFailures(5).map((job) => ({
      key: job.key,
      error: job.error,
    }));
    report.pollErrors = repositories
      .filter((repository) => repository.lastPollError)
      .map((repository) => ({
        repo: repository.fullName,
        error: repository.lastPollError!,
      }));
    const gateRaw = store.getMeta("security.gate");
    if (gateRaw) {
      try {
        report.security = JSON.parse(gateRaw) as SecurityGate;
      } catch {
        report.security = null;
      }
    }
  } catch (error) {
    logger.debug({ error: message(error) }, "status could not open the database");
  } finally {
    store?.close();
  }
  return report;
}

function commandVersion(command: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
