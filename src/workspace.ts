import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { repoUrl, webBaseUrl, type Credentials } from "./config.ts";
import type { RepositoryRecord } from "./db.ts";
import { redactText, type Logger } from "./log.ts";
import { reposDir, worktreesDir } from "./paths.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly permanent: boolean;
  readonly detail: string;
  constructor(message: string, permanent = false) {
    super(redactText(message));
    this.name = "GitError";
    this.permanent = permanent;
    this.detail = redactText(message);
  }
}

export function gitAuthEnv(
  host: string,
  token: string | null,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
  };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${webBaseUrl(host)}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

export async function runGit(
  args: string[],
  options: {
    cwd?: string;
    token?: string | null;
    host: string;
    timeoutMs?: number;
    allowFailure?: boolean;
  },
): Promise<GitResult> {
  const hooksPath = join(worktreesDir(), ".nohooks");
  mkdirSync(hooksPath, { recursive: true, mode: 0o700 });
  const proc = Bun.spawn(["git", "-c", `core.hooksPath=${hooksPath}`, ...args], {
    cwd: options.cwd,
    env: gitAuthEnv(options.host, options.token ?? null),
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? 10 * 60 * 1000,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const result = { code, stdout, stderr: redactText(stderr) };
  if (code !== 0 && !options.allowFailure) {
    throw new GitError(
      `git ${args[0]} failed (${code}): ${redactText(stderr || stdout).trim().slice(0, 2000)}`,
      /protected branch|non-fast-forward|permission denied|authentication failed|could not read Username/i.test(
        stderr,
      ),
    );
  }
  return result;
}

export function sanitizeBranchPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class WorkspaceManager {
  private readonly credentials: Credentials;
  private readonly logger: Logger;

  constructor(options: { credentials: Credentials; logger: Logger }) {
    this.credentials = options.credentials;
    this.logger = options.logger;
  }

  private get host(): string {
    return this.credentials.host;
  }

  mirrorPath(repo: RepositoryRecord): string {
    const safeOwner = repo.owner.replace(/[^A-Za-z0-9._-]/g, "_");
    const safeName = repo.name.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(reposDir(), `${repo.id}-${safeOwner}__${safeName}.git`);
  }

  async ensureMirror(
    repo: RepositoryRecord,
    token: string,
  ): Promise<string> {
    const path = this.mirrorPath(repo);
    mkdirSync(reposDir(), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      this.logger.info({ repo: repo.fullName }, "cloning repository mirror");
      await runGit(["clone", "--bare", repoUrl(this.host, repo.owner, repo.name), path], {
        token,
        host: this.host,
      });
    } else {
      await runGit(["remote", "set-url", "origin", repoUrl(this.host, repo.owner, repo.name)], {
        cwd: path,
        host: this.host,
      });
    }
    await runGit(
      [
        "fetch",
        "--force",
        "origin",
        `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
      ],
      { cwd: path, token, host: this.host },
    );
    return path;
  }

  async fetchPull(
    repo: RepositoryRecord,
    pullNumber: number,
    token: string,
  ): Promise<string> {
    const path = await this.ensureMirror(repo, token);
    await runGit(
      [
        "fetch",
        "--force",
        "origin",
        `refs/pull/${pullNumber}/head:refs/reviewbot/pr/${pullNumber}`,
      ],
      { cwd: path, token, host: this.host },
    );
    return path;
  }

  /**
   * Create a disposable detached worktree for the default branch or a PR head.
   * A worktree is not a security sandbox; OpenCode's permission ruleset is the
   * execution boundary.
   */
  async createWorktree(options: {
    repo: RepositoryRecord;
    token: string;
    source: "default" | "pull";
    pullNumber?: number;
    label: string;
  }): Promise<{ path: string; root: string; headSha: string }> {
    const mirror =
      options.source === "pull" && options.pullNumber
        ? await this.fetchPull(options.repo, options.pullNumber, options.token)
        : await this.ensureMirror(options.repo, options.token);
    const ref =
      options.source === "pull" && options.pullNumber
        ? `refs/reviewbot/pr/${options.pullNumber}`
        : `refs/remotes/origin/${options.repo.defaultBranch}`;
    mkdirSync(worktreesDir(), { recursive: true, mode: 0o700 });
    const root = join(
      worktreesDir(),
      `${options.repo.id}-${sanitizeBranchPart(options.label)}-${randomBytes(4).toString("hex")}`,
    );
    const path = join(root, "repo");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      await runGit(["worktree", "add", "--detach", path, ref], {
        cwd: mirror,
        host: this.host,
      });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    const head = await this.revParse(path);
    return { path, root, headSha: head };
  }

  async removeWorktree(repo: RepositoryRecord, root: string): Promise<void> {
    const mirror = this.mirrorPath(repo);
    try {
      if (existsSync(mirror)) {
        await runGit(["worktree", "remove", "--force", join(root, "repo")], {
          cwd: mirror,
          host: this.host,
          allowFailure: true,
        });
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // OpenCode may briefly retain the session directory on Windows.
      }
    }
  }

  /**
   * Stable worktree for a conversational issue/PR session. OpenCode sessions
   * are bound to a directory, so follow-ups must keep the same path.
   */
  async ensureSubjectWorktree(options: {
    repo: RepositoryRecord;
    token: string;
    source: "default" | "pull";
    pullNumber?: number;
    label: string;
  }): Promise<{ path: string; root: string; headSha: string }> {
    const mirror =
      options.source === "pull" && options.pullNumber
        ? await this.fetchPull(options.repo, options.pullNumber, options.token)
        : await this.ensureMirror(options.repo, options.token);
    const ref =
      options.source === "pull" && options.pullNumber
        ? `refs/reviewbot/pr/${options.pullNumber}`
        : `refs/remotes/origin/${options.repo.defaultBranch}`;
    const head = (
      await runGit(["rev-parse", ref], { cwd: mirror, host: this.host })
    ).stdout.trim();
    mkdirSync(worktreesDir(), { recursive: true });
    const root = join(
      worktreesDir(),
      `subject-${options.repo.id}-${sanitizeBranchPart(options.label)}`,
    );
    const path = join(root, "repo");
    if (existsSync(join(path, ".git"))) {
      await runGit(["checkout", "--detach", "--force", head], {
        cwd: path,
        host: this.host,
      });
      await runGit(["clean", "-fdx"], {
        cwd: path,
        host: this.host,
        allowFailure: true,
      });
    } else {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true, mode: 0o700 });
      await runGit(["worktree", "add", "--detach", path, head], {
        cwd: mirror,
        host: this.host,
      });
    }
    return { path, root, headSha: head };
  }

  async revParse(cwd: string): Promise<string> {
    const result = await runGit(["rev-parse", "HEAD"], { cwd, host: this.host });
    return result.stdout.trim();
  }

  async changedFiles(cwd: string): Promise<string[]> {
    const result = await runGit(["status", "--porcelain"], { cwd, host: this.host });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async commitAll(
    cwd: string,
    message: string,
  ): Promise<{ sha: string; files: string[]; stat: string }> {
    await this.assertWorktreeIntegrity(cwd);
    await runGit(["add", "-A"], { cwd, host: this.host });
    const names = await runGit(["diff", "--cached", "--name-only"], {
      cwd,
      host: this.host,
    });
    const stat = await runGit(["diff", "--cached", "--stat"], {
      cwd,
      host: this.host,
    });
    const name = `${this.credentials.slug}[bot]`;
    const email = `${this.credentials.appId}+${this.credentials.slug}[bot]@users.noreply.github.com`;
    await runGit(
      [
        "-c",
        `user.name=${name}`,
        "-c",
        `user.email=${email}`,
        "commit",
        "-m",
        message,
      ],
      { cwd, host: this.host },
    );
    return {
      sha: await this.revParse(cwd),
      files: names.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      stat: stat.stdout.trim(),
    };
  }

  async pushBranch(options: {
    repo: RepositoryRecord;
    cwd: string;
    branch: string;
    token: string;
  }): Promise<void> {
    await this.assertWorktreeIntegrity(options.cwd);
    if (!/^[A-Za-z0-9._/-]+$/.test(options.branch) || options.branch.includes("..")) {
      throw new GitError(`Invalid branch name: ${options.branch}`, true);
    }
    await runGit(
      [
        "push",
        repoUrl(this.host, options.repo.owner, options.repo.name),
        `HEAD:refs/heads/${options.branch}`,
      ],
      { cwd: options.cwd, token: options.token, host: this.host, timeoutMs: 5 * 60 * 1000 },
    );
  }

  /**
   * Reject a worktree whose Git metadata was redirected outside Reviewbot's
   * repository storage. OpenCode may edit files but must not turn the daemon's
   * Git commands into a bridge to another local repository.
   */
  async assertWorktreeIntegrity(cwd: string): Promise<void> {
    let gitDir: string;
    let commonDir: string;
    try {
      gitDir = (
        await runGit(["rev-parse", "--absolute-git-dir"], {
          cwd,
          host: this.host,
        })
      ).stdout.trim();
      commonDir = (
        await runGit(["rev-parse", "--git-common-dir"], {
          cwd,
          host: this.host,
        })
      ).stdout.trim();
    } catch (error) {
      throw new GitError(
        `Workspace Git metadata is not usable: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    let resolvedGit: string;
    let resolvedCommon: string;
    let mirrors: string;
    try {
      resolvedGit = realpathSync(gitDir);
      resolvedCommon = realpathSync(
        commonDir.startsWith("/") || /^[A-Za-z]:/.test(commonDir)
          ? commonDir
          : join(cwd, commonDir),
      );
      mirrors = realpathSync(reposDir());
    } catch (error) {
      throw new GitError(
        `Workspace Git metadata could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (!isInside(resolvedGit, mirrors) || !isInside(resolvedCommon, mirrors)) {
      throw new GitError(
        "Workspace Git metadata points outside Reviewbot's repository storage",
        true,
      );
    }
  }

  async remoteBranchExists(
    repo: RepositoryRecord,
    branch: string,
    token: string,
  ): Promise<boolean> {
    const result = await runGit(
      ["ls-remote", "--heads", repoUrl(this.host, repo.owner, repo.name), branch],
      { token, host: this.host },
    );
    return result.stdout.trim().length > 0;
  }
}

function isInside(path: string, root: string): boolean {
  const normalize = (value: string) =>
    (process.platform === "win32" ? value.toLowerCase() : value).replace(/[\\/]+/g, "/").replace(/\/$/, "");
  const child = normalize(path);
  const parent = normalize(root);
  return child === parent || child.startsWith(`${parent}/`);
}

export function fixBranchName(
  subjectType: "issue" | "pr",
  subjectNumber: number,
  commentId: number,
): string {
  return `reviewbot/fix-${subjectType}-${subjectNumber}-${commentId}`;
}
