import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import type { Store } from "./db.ts";
import { nowIso } from "./db.ts";
import {
  OPENCODE_CLIENT_VERSION,
  sessionRules,
  type OpenCodeAdapter,
} from "./opencode.ts";
import type { Logger } from "./log.ts";

export type GateStatus = "enforced" | "not-enforced" | "inconclusive";

export interface SecurityGate {
  status: GateStatus;
  detail: string;
  checkedAt: string;
  serverVersion: string;
  clientVersion: string;
  rulesHash: string;
}

interface PolicyCheck {
  action: string;
  resource: string;
  expected: "allow" | "deny";
}

const GATE_META_KEY = "security.gate";
const ENFORCED_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 10 * 60 * 1000;

export function rulesHash(): string {
  return createHash("sha256")
    .update(
      JSON.stringify([sessionRules("read"), sessionRules("implement")]),
    )
    .digest("hex")
    .slice(0, 16);
}

export function gateIsOpen(gate: SecurityGate | null): boolean {
  return gate?.status === "enforced";
}

/** Required permission decisions for a session mode. */
export function policyChecks(
  workspace: string,
  mode: "read" | "implement" = "read",
): PolicyCheck[] {
  const inside = join(workspace, "reviewbot-probe.txt");
  const outside = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts";
  const checks: PolicyCheck[] = [
    { action: "read", resource: inside, expected: "allow" },
    { action: "read", resource: join(workspace, ".env"), expected: "deny" },
    {
      action: "read",
      resource: join(dataDir(), "credentials", "app.json"),
      expected: "deny",
    },
    {
      action: "read",
      resource: join(dataDir(), "reviewbot.db"),
      expected: "deny",
    },
    { action: "glob", resource: "**/*", expected: "allow" },
    { action: "grep", resource: "TODO", expected: "allow" },
    {
      action: "edit",
      resource: inside,
      expected: mode === "implement" ? "allow" : "deny",
    },
    { action: "shell", resource: "echo probe", expected: "deny" },
    { action: "execute", resource: "*", expected: "deny" },
    { action: "external_directory", resource: outside, expected: "deny" },
    { action: "webfetch", resource: "https://example.invalid/", expected: "deny" },
    { action: "websearch", resource: "reviewbot probe", expected: "deny" },
    { action: "browser", resource: "*", expected: "deny" },
    { action: "experimental_image_generate", resource: "*", expected: "deny" },
    { action: "subagent", resource: "*", expected: "deny" },
    { action: "skill", resource: "*", expected: "deny" },
    { action: "question", resource: "*", expected: "deny" },
    { action: "reviewbot_probe_mcp_tool", resource: "*", expected: "deny" },
  ];
  if (mode === "implement") {
    checks.push({
      action: "edit",
      resource: join(dataDir(), "credentials", "app.json"),
      expected: "deny",
    });
  }
  return checks;
}

/**
 * Verify that the installed OpenCode server resolves both Reviewbot rulesets as
 * intended. This uses the same permission decision path as tool execution and
 * therefore does not depend on a model, prompt compliance, or quota.
 */
export async function evaluateSecurityGate(options: {
  adapter: OpenCodeAdapter;
  store: Store;
  logger: Logger;
  force?: boolean;
}): Promise<SecurityGate> {
  const { adapter, store, logger } = options;
  let serverVersion = "unknown";
  try {
    const connection = await adapter.connect();
    serverVersion = connection.version;
  } catch (error) {
    return recordGate(store, {
      status: "inconclusive",
      detail: `OpenCode unavailable: ${error instanceof Error ? error.message : String(error)}`,
      serverVersion,
    });
  }

  const hash = rulesHash();
  if (!options.force) {
    const cached = readCachedGate(store, serverVersion, hash);
    if (cached) return cached;
  }

  const probeDir = mkdtempSync(join(tmpdir(), "reviewbot-security-"));
  let readSession: string | null = null;
  let implementSession: string | null = null;
  try {
    readSession = await adapter.createSession({
      directory: probeDir,
      title: "reviewbot read-only policy probe",
      mode: "read",
    });
    const mismatches = [
      ...(await checkPolicy(adapter, readSession, probeDir, "read")),
    ];
    implementSession = await adapter.createSession({
      directory: probeDir,
      title: "reviewbot implementation policy probe",
      mode: "implement",
    });
    mismatches.push(
      ...(await checkPolicy(adapter, implementSession, probeDir, "implement")),
    );
    if (mismatches.length > 0) {
      return recordGate(store, {
        status: "not-enforced",
        detail: `Ruleset resolved unexpectedly: ${mismatches.join(", ")}`,
        serverVersion,
      });
    }
    logger.info("read-only and implementation permission decisions verified");
    return recordGate(store, {
      status: "enforced",
      detail:
        "Read-only sessions allow repository reads and deny credential-shaped reads, edit, shell, execute, external access, network, subagents, skills, questions, and MCP tools; implementation sessions add workspace edit and keep execution/credential access denied",
      serverVersion,
    });
  } catch (error) {
    return recordGate(store, {
      status: "inconclusive",
      detail: `Security policy probe could not complete: ${error instanceof Error ? error.message : String(error)}`,
      serverVersion,
    });
  } finally {
    if (readSession) await adapter.removeSession(readSession);
    if (implementSession) await adapter.removeSession(implementSession);
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {
      // OpenCode may briefly retain the session directory on Windows.
    }
  }
}

async function checkPolicy(
  adapter: OpenCodeAdapter,
  sessionId: string,
  workspace: string,
  mode: "read" | "implement",
): Promise<string[]> {
  const mismatches: string[] = [];
  for (const check of policyChecks(workspace, mode)) {
    const effect = await adapter.permissionDecision(
      sessionId,
      check.action,
      check.resource,
    );
    if (effect !== check.expected) {
      mismatches.push(
        `${mode}:${check.action}=${effect} (expected ${check.expected})`,
      );
    }
  }
  return mismatches;
}

function recordGate(
  store: Store,
  input: { status: GateStatus; detail: string; serverVersion: string },
): SecurityGate {
  const gate: SecurityGate = {
    status: input.status,
    detail: input.detail,
    checkedAt: nowIso(),
    serverVersion: input.serverVersion,
    clientVersion: OPENCODE_CLIENT_VERSION,
    rulesHash: rulesHash(),
  };
  store.setMeta(GATE_META_KEY, JSON.stringify(gate));
  return gate;
}

function readCachedGate(
  store: Store,
  serverVersion: string,
  hash: string,
): SecurityGate | null {
  const raw = store.getMeta(GATE_META_KEY);
  if (!raw) return null;
  let gate: SecurityGate;
  try {
    gate = JSON.parse(raw) as SecurityGate;
  } catch {
    return null;
  }
  if (gate.serverVersion !== serverVersion || gate.rulesHash !== hash) return null;
  if (
    gate.status !== "enforced" &&
    gate.status !== "not-enforced" &&
    gate.status !== "inconclusive"
  ) {
    return null;
  }
  const age = Date.now() - Date.parse(gate.checkedAt);
  const ttl = gate.status === "enforced" ? ENFORCED_TTL_MS : FAILED_TTL_MS;
  return Number.isFinite(age) && age >= 0 && age < ttl ? gate : null;
}
