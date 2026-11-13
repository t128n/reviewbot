import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager, fixBranchName, gitAuthEnv, runGit } from "../src/workspace.ts";
import { reposDir } from "../src/paths.ts";
import type { Credentials } from "../src/config.ts";
import type { Logger } from "../src/log.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const credentials: Credentials = {
  host: "github.com",
  appId: 1,
  slug: "reviewbot",
  name: "Reviewbot",
  privateKey: "key",
};

describe("local git operations", () => {
  test("commits all changes and reports the staged file set and stat", async () => {
    mkdirSync(reposDir(), { recursive: true });
    const dir = mkdtempSync(join(reposDir(), "reviewbot-git-"));
    try {
      await runGit(["init", "-q"], { cwd: dir, host: "github.com" });
      writeFileSync(join(dir, "a.txt"), "one\n");
      await runGit(["add", "."], { cwd: dir, host: "github.com" });
      await runGit(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "initial",
        ],
        { cwd: dir, host: "github.com" },
      );

      writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
      writeFileSync(join(dir, "b.txt"), "new\n");
      const manager = new WorkspaceManager({ credentials, logger });
      const committed = await manager.commitAll(dir, "reviewbot change");
      expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(committed.files.sort()).toEqual(["a.txt", "b.txt"]);
      expect(committed.stat).toContain("a.txt");
      expect(committed.stat).toContain("b.txt");
      expect(await manager.changedFiles(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worktree integrity guard", () => {
  test("rejects Git metadata outside Reviewbot repository storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewbot-outside-"));
    try {
      await runGit(["init", "-q"], { cwd: dir, host: "github.com" });
      const manager = new WorkspaceManager({ credentials, logger });
      await expect(manager.assertWorktreeIntegrity(dir)).rejects.toThrow(
        /outside Reviewbot/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("branch and credential helpers", () => {
  test("builds deterministic isolated fix branch names", () => {
    expect(fixBranchName("issue", 12, 99)).toBe("reviewbot/fix-issue-12-99");
    expect(fixBranchName("pr", 3, 4)).toBe("reviewbot/fix-pr-3-4");
  });

  test("does not place the installation token in arguments or remote URLs", () => {
    const env = gitAuthEnv("acme.ghe.com", "token-value");
    expect(env.GIT_CONFIG_KEY_0).toContain("http.https://acme.ghe.com/");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("token-value");
  });
});
