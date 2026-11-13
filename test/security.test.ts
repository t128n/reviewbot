import { describe, expect, test } from "bun:test";
import {
  IMPLEMENT_RULES,
  READ_ONLY_RULES,
  isCompatibleServer,
  parseModelRef,
  parseVersion,
  sessionRules,
  sessionTurnComplete,
} from "../src/opencode.ts";
import { dataDir } from "../src/paths.ts";
import { join } from "node:path";
import { gateIsOpen, rulesHash } from "../src/security.ts";
import { classifyJobError } from "../src/worker.ts";
import { PublishError } from "../src/publish.ts";
import { GitError } from "../src/workspace.ts";
import { ResultValidationError } from "../src/schemas.ts";

function effectFor(
  rules: typeof READ_ONLY_RULES,
  action: string,
  resource = "*",
): string | null {
  let effect: string | null = null;
  for (const rule of rules) {
    if (matches(rule.action, action) && matches(rule.resource, resource)) {
      effect = rule.effect;
    }
  }
  return effect;
}

function matches(pattern: string, value: string): boolean {
  const normalizedValue = value.replace(/\\/g, "/");
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalizedValue);
}

describe("OpenCode permissions", () => {
  test("read-only rules are a default-deny allowlist", () => {
    for (const action of ["read", "glob", "grep"]) {
      expect(effectFor(READ_ONLY_RULES, action)).toBe("allow");
    }
    expect(effectFor(READ_ONLY_RULES, "read", ".env")).toBe("deny");
    expect(effectFor(READ_ONLY_RULES, "read", ".env.local")).toBe("deny");
    expect(effectFor(READ_ONLY_RULES, "read", "src/environment.ts")).toBe("allow");
    expect(effectFor(READ_ONLY_RULES, "edit", "src/a.ts")).toBe("deny");
    expect(
      effectFor(
        sessionRules("read"),
        "read",
        join(dataDir(), "credentials", "app.json"),
      ),
    ).toBe("deny");
    for (const action of [
      "edit",
      "shell",
      "execute",
      "external_directory",
      "webfetch",
      "websearch",
      "subagent",
      "skill",
      "question",
      "some_server_tool",
    ]) {
      expect(effectFor(READ_ONLY_RULES, action)).toBe("deny");
    }
  });

  test("implementation rules add edit only", () => {
    expect(effectFor(IMPLEMENT_RULES, "edit")).toBe("allow");
    expect(effectFor(IMPLEMENT_RULES, "shell")).toBe("deny");
    expect(effectFor(IMPLEMENT_RULES, "execute")).toBe("deny");
    expect(effectFor(IMPLEMENT_RULES, "external_directory")).toBe("deny");
    expect(effectFor(IMPLEMENT_RULES, "read")).toBe("allow");
    expect(effectFor(sessionRules("implement"), "edit", "repo/src/a.ts")).toBe("allow");
    expect(
      effectFor(
        sessionRules("implement"),
        "edit",
        join(dataDir(), "credentials", "app.json"),
      ),
    ).toBe("deny");
  });

  test("rules hash and gate status are deterministic", () => {
    expect(rulesHash()).toHaveLength(16);
    expect(gateIsOpen(null)).toBe(false);
    expect(gateIsOpen({ status: "inconclusive" } as never)).toBe(false);
    expect(gateIsOpen({ status: "not-enforced" } as never)).toBe(false);
    expect(gateIsOpen({ status: "enforced" } as never)).toBe(true);
  });
});

describe("model reference parsing", () => {
  test("splits provider and model at the first slash", () => {
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude",
    });
    expect(parseModelRef("missing-slash")).toBeNull();
    expect(parseModelRef("/missing-provider")).toBeNull();
    expect(parseModelRef("provider/")).toBeNull();
    expect(parseModelRef("provider/model with space")).toBeNull();
  });
});

describe("session turn completion", () => {
  test("does not treat a previous run's outcome or idle time as completion", () => {
    expect(sessionTurnComplete(undefined, 1_000)).toBe(false);
    expect(sessionTurnComplete(900, 1_000)).toBe(false);
    expect(sessionTurnComplete(900, 1_000, 900)).toBe(false);
    expect(sessionTurnComplete(1_100, 1_000, 900)).toBe(true);
    expect(sessionTurnComplete(1_100, 1_000)).toBe(true);
  });
});

describe("OpenCode compatibility", () => {
  test("accepts V2 at or above the tested minimum", () => {
    expect(parseVersion("2.2.7")).toEqual([2, 2, 7]);
    expect(isCompatibleServer("2.2.7")).toBe(true);
    expect(isCompatibleServer("2.3.0")).toBe(true);
    expect(isCompatibleServer("2.10.1")).toBe(true);
    expect(isCompatibleServer("2.2.0")).toBe(true);
    expect(isCompatibleServer("2.1.9")).toBe(false);
    expect(isCompatibleServer("1.99.0")).toBe(false);
    expect(isCompatibleServer("3.0.0")).toBe(false);
    expect(isCompatibleServer("not-a-version")).toBe(false);
  });
});

describe("job error classification", () => {
  test("validation and permanent publication failures are not retried", () => {
    expect(classifyJobError(new ResultValidationError("bad")).retryable).toBe(false);
    expect(classifyJobError(new PublishError("forbidden", true)).retryable).toBe(false);
    expect(classifyJobError(new GitError("not fast forward", true)).retryable).toBe(false);
  });

  test("transient failures are retried", () => {
    expect(classifyJobError(new PublishError("network", false)).retryable).toBe(true);
    expect(classifyJobError(new GitError("network", false)).retryable).toBe(true);
    expect(classifyJobError(new Error("unknown")).retryable).toBe(true);
  });

  test("rate limits carry an explicit delay", () => {
    const classified = classifyJobError({
      name: "GitHubError",
      message: "rate limited",
      retryable: true,
      rateLimited: true,
      retryAfterSeconds: 90,
    });
    expect(classified.retryable).toBe(true);
    expect(classified.delaySeconds).toBe(95);
  });
});
