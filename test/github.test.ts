import { describe, expect, test } from "bun:test";
import {
  GitHub,
  GitHubError,
  buildManifest,
  canWriteRepository,
  classifyGitHubError,
  numberFromIssueUrl,
  numberFromPullUrl,
} from "../src/github.ts";
import { gitAuthEnv } from "../src/workspace.ts";
import { isValidLocation } from "../src/diff.ts";

describe("installation repository pagination", () => {
  test("reads the repositories collection rather than the wrapper object", async () => {
    const calls: string[] = [];
    const fakeThis = {
      installationClient: async () => ({
        request: async (route: string) => {
          calls.push(route);
          return {
            data: {
              total_count: 1,
              repositories: [
                {
                  id: 7,
                  name: "repo",
                  full_name: "acme/repo",
                  default_branch: "main",
                  owner: { login: "acme" },
                  private: true,
                  archived: false,
                },
              ],
            },
            headers: {},
          };
        },
      }),
    };
    const repositories = await GitHub.prototype.listInstallationRepositories.call(
      fakeThis as never,
      1,
    );
    expect(calls).toEqual(["GET /installation/repositories"]);
    expect(repositories).toHaveLength(1);
    expect(repositories[0]!.fullName).toBe("acme/repo");
  });
});

describe("GitHub error classification", () => {
  test("recognizes primary rate limits and reset time", () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const error = classifyGitHubError({
      status: 403,
      message: "API rate limit exceeded",
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
        data: { message: "API rate limit exceeded for installation" },
      },
    });
    expect(error.rateLimited).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBeGreaterThan(60);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  test("honors Retry-After for secondary limits", () => {
    const error = classifyGitHubError({
      status: 429,
      message: "You have exceeded a secondary rate limit",
      response: { headers: { "retry-after": "30" }, data: { message: "slow down" } },
    });
    expect(error.rateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBe(30);
  });

  test("does not retry permanent authorization and validation failures", () => {
    expect(classifyGitHubError({ status: 401, message: "Bad credentials" }).retryable).toBe(false);
    expect(classifyGitHubError({ status: 403, message: "Resource not accessible" }).retryable).toBe(false);
    expect(classifyGitHubError({ status: 404, message: "Not Found" }).retryable).toBe(false);
    expect(classifyGitHubError({ status: 422, message: "Validation Failed" }).retryable).toBe(false);
    expect(classifyGitHubError({ status: 500, message: "Server Error" }).retryable).toBe(true);
    expect(classifyGitHubError(new GitHubError("custom", { retryable: true })).retryable).toBe(true);
  });
});

describe("authorization", () => {
  test("requires write or higher", () => {
    expect(canWriteRepository("admin")).toBe(true);
    expect(canWriteRepository("maintain")).toBe(true);
    expect(canWriteRepository("write")).toBe(true);
    expect(canWriteRepository("triage")).toBe(false);
    expect(canWriteRepository("read")).toBe(false);
    expect(canWriteRepository(null)).toBe(false);
  });
});

describe("GitHub URL parsing", () => {
  test("extracts issue and pull request numbers", () => {
    expect(numberFromIssueUrl("https://acme.ghe.com/acme/repo/issues/12")).toBe(12);
    expect(numberFromIssueUrl("https://api.acme.ghe.com/repos/acme/repo/issues/13")).toBe(13);
    expect(numberFromPullUrl("https://acme.ghe.com/acme/repo/pull/44#discussion_r1")).toBe(44);
    expect(numberFromIssueUrl("https://acme.ghe.com/acme/repo/pulls/9")).toBeNull();
  });
});

describe("manifest", () => {
  test("uses an inactive webhook and least-privilege defaults", () => {
    const manifest = buildManifest({
      name: "reviewbot-acme",
      homepageUrl: "https://acme.ghe.com",
      redirectUrl: "http://127.0.0.1:9999/callback",
    });
    expect(manifest.public).toBe(false);
    expect(manifest.default_events).toEqual([]);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(manifest.hook_attributes).toEqual({
      url: "https://example.invalid/reviewbot/webhook",
      active: false,
    });
    expect(manifest.default_permissions).toEqual({
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    });
    expect(manifest.redirect_url).toBe("http://127.0.0.1:9999/callback");
  });
});

describe("git credential isolation", () => {
  test("passes the token only through a host-scoped header environment", () => {
    const token = "secret-installation-token";
    const env = gitAuthEnv("acme.ghe.com", token);
    const header = env.GIT_CONFIG_VALUE_0 ?? "";
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://acme.ghe.com/.extraheader");
    expect(header.startsWith("Authorization: Basic ")).toBe(true);
    expect(header).not.toContain(token);
    expect(Buffer.from(header.split(" ").pop()!, "base64").toString()).toBe(
      `x-access-token:${token}`,
    );
    for (const value of Object.values(env)) {
      if (typeof value === "string") expect(value).not.toContain(token);
    }
    const anonymous = gitAuthEnv("acme.ghe.com", null);
    expect(anonymous.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});

describe("diff location guard", () => {
  test("rejects attempts to comment outside the changed patch", () => {
    expect(
      isValidLocation(new Map(), "src/a.ts", 1, "RIGHT"),
    ).toBe(false);
  });
});
