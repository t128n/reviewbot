import type { Store, JobRecord, RepositoryRecord } from "./db.ts";
import type { GitHub, GitHubClient, PullSummary } from "./github.ts";
import { READ_PERMISSIONS, canWriteRepository } from "./github.ts";
import type {
  ConversationPayload,
  FixPayload,
  ReviewPayload,
  TriagePayload,
} from "./jobs.ts";
import {
  ConversationPayloadSchema,
  FixPayloadSchema,
  ReviewPayloadSchema,
  TriagePayloadSchema,
  parsePayload,
  reviewKey,
} from "./jobs.ts";
import type { Logger } from "./log.ts";
import type { OpenCodeAdapter } from "./opencode.ts";
import { OpenCodeUnavailableError, TaskExecutionError } from "./opencode.ts";
import type { Publisher } from "./publish.ts";
import { PublishError } from "./publish.ts";
import {
  ConversationResultSchema,
  FixResultSchema,
  ReviewResultSchema,
  ResultValidationError,
  TriageResultSchema,
  parseStructuredResult,
} from "./schemas.ts";
import type { WorkspaceManager } from "./workspace.ts";
import { GitError, fixBranchName } from "./workspace.ts";
import { renderDiffContext, type DiffFile } from "./diff.ts";
import { selectRelatedIssues } from "./related.ts";

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

const TIMEOUTS = {
  triage: 15 * 60 * 1000,
  review: 15 * 60 * 1000,
  conversation: 15 * 60 * 1000,
  fix: 60 * 60 * 1000,
} as const;

export class Worker {
  private readonly store: Store;
  private readonly github: GitHub;
  private readonly adapter: OpenCodeAdapter;
  private readonly publisher: Publisher;
  private readonly workspace: WorkspaceManager;
  private readonly logger: Logger;
  private readonly prompt: string;
  private readonly gateOpen: () => boolean;
  private readonly host: string;
  private readonly botLogin: string;
  private readonly closeGate: (reason: string) => void;

  constructor(options: {
    store: Store;
    github: GitHub;
    adapter: OpenCodeAdapter;
    publisher: Publisher;
    workspace: WorkspaceManager;
    logger: Logger;
    prompt: string;
    gateOpen: () => boolean;
    host: string;
    botLogin: string;
    closeGate?: (reason: string) => void;
  }) {
    this.store = options.store;
    this.github = options.github;
    this.adapter = options.adapter;
    this.publisher = options.publisher;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.prompt = options.prompt;
    this.gateOpen = options.gateOpen;
    this.host = options.host;
    this.botLogin = options.botLogin;
    this.closeGate = options.closeGate ?? (() => {});
  }

  /** Process at most one job. Returns false when the queue is empty or gated. */
  async runOnce(): Promise<boolean> {
    if (!this.gateOpen()) return false;
    const job = this.store.claimNextJob();
    if (!job) return false;
    const started = Date.now();
    this.logger.info(
      { jobId: job.id, kind: job.kind, repoId: job.repoId },
      "starting job",
    );
    try {
      const result = await this.process(job);
      this.store.completeJob(job.id, result);
      this.logger.info(
        { jobId: job.id, kind: job.kind, elapsedMs: Date.now() - started },
        "job completed",
      );
    } catch (error) {
      const classification = classifyJobError(error);
      if (error instanceof OpenCodeUnavailableError) {
        this.store.requeueJob(job.id, classification.message, 60);
        this.closeGate(classification.message);
        this.logger.warn(
          { jobId: job.id, kind: job.kind, error: classification.message },
          "OpenCode unavailable; job returned to the queue and automatic work gated",
        );
        return true;
      }
      this.store.failJob(job.id, classification.message, {
        retryable: classification.retryable,
        delaySeconds: classification.delaySeconds,
      });
      if (
        job.kind === "fix" &&
        this.store.getJob(job.id)?.state === "failed"
      ) {
        const repo = this.store.getRepository(job.repoId);
        if (repo) {
          try {
            await this.publisher.publishFixFailure({
              repo,
              payload: parsePayload(FixPayloadSchema, job.payload),
              message: classification.message,
            });
          } catch {
            // Best-effort notification; the job failure is already durable.
          }
        }
      }
      this.logger.error(
        {
          jobId: job.id,
          kind: job.kind,
          error: classification.message,
          retryable: classification.retryable,
        },
        "job failed",
      );
    }
    return true;
  }

  private async process(job: JobRecord): Promise<unknown> {
    const repo = this.store.getRepository(job.repoId);
    if (!repo || !repo.active) {
      throw new PermanentJobError("Repository is no longer active or installed");
    }
    switch (job.kind) {
      case "triage":
        return this.runTriage(repo, parsePayload(TriagePayloadSchema, job.payload));
      case "review":
        return this.runReview(repo, parsePayload(ReviewPayloadSchema, job.payload));
      case "conversation":
        return this.runConversation(
          repo,
          parsePayload(ConversationPayloadSchema, job.payload),
        );
      case "fix":
        return this.runFix(repo, parsePayload(FixPayloadSchema, job.payload));
      default:
        throw new PermanentJobError(`Unknown job kind: ${job.kind}`);
    }
  }

  private async readClient(
    repo: RepositoryRecord,
  ): Promise<{ octokit: GitHubClient; token: string }> {
    const token = await this.github.installationToken(
      repo.installationId,
      READ_PERMISSIONS,
    );
    const octokit = await this.github.installationClient(
      repo.installationId,
      READ_PERMISSIONS,
    );
    return { octokit, token };
  }

  private async runTriage(
    repo: RepositoryRecord,
    payload: TriagePayload,
  ): Promise<unknown> {
    const { octokit, token } = await this.readClient(repo);
    let related: ReturnType<typeof selectRelatedIssues> = [];
    try {
      related = selectRelatedIssues(
        { number: payload.issueNumber, title: payload.title, body: payload.body },
        await this.github.listRecentIssues(octokit, repo.owner, repo.name),
      );
    } catch (error) {
      this.logger.warn(
        {
          repo: repo.fullName,
          issue: payload.issueNumber,
          error: error instanceof Error ? error.message : String(error),
        },
        "related issue context could not be retrieved",
      );
    }
    const worktree = await this.workspace.createWorktree({
      repo,
      token,
      source: "default",
      label: `triage-${payload.issueNumber}`,
    });
    try {
      const sessionId = await this.adapter.createSession({
        directory: worktree.root,
        title: `Triage ${repo.fullName}#${payload.issueNumber}`,
        mode: "read",
      });
      await this.adapter.applyInstructions(sessionId, this.prompt);
      const task = [
        `Repository: ${repo.fullName}`,
        "Repository root: ./repo (relative to this session directory).",
        `Issue #${payload.issueNumber}: ${payload.title}`,
        `Author: ${payload.author}`,
        "Issue description:",
        payload.body || "(no description)",
        "",
        related.length > 0
          ? [
              "Possibly related existing issues/PRs (context only):",
              ...related.map(
                (item) =>
                  `- ${item.isPullRequest ? "PR" : "Issue"} #${item.number} [${item.state}] ${item.title}${item.excerpt ? ` — ${item.excerpt}` : ""}`,
              ),
              "",
            ].join("\n")
          : "No closely related issue or PR was found in recent repository history.",
        "",
        "Investigate this issue against the repository. Publish one concise assessment with evidence, material uncertainty, and a specific next step or clarification question when needed.",
        'Return exactly one JSON object: {"comment": "markdown comment"}.',
      ].join("\n");
      const run = await this.adapter.runTask({
        sessionId,
        text: task,
        timeoutMs: TIMEOUTS.triage,
      });
      const result = parseStructuredResult(run.text, TriageResultSchema);
      const publication = await this.publisher.publishTriage({
        repo,
        issueNumber: payload.issueNumber,
        comment: result.comment,
      });
      if (publication.status === "skipped") {
        return { kind: "triage", skipped: publication.reason };
      }
      return { kind: "triage", publication };
    } finally {
      await this.workspace.removeWorktree(repo, worktree.root);
    }
  }

  private async runReview(
    repo: RepositoryRecord,
    payload: ReviewPayload,
  ): Promise<unknown> {
    const { octokit, token } = await this.readClient(repo);
    const pull = await this.github.getPull(
      octokit,
      repo.owner,
      repo.name,
      payload.pullNumber,
    );
    if (pull.draft) {
      return { kind: "review", skipped: "pull request is a draft" };
    }
    if (pull.state !== "open") {
      return { kind: "review", skipped: `pull request is ${pull.state}` };
    }
    if (pull.headSha !== payload.headSha) {
      this.enqueueReview(repo, pull);
      return { kind: "review", skipped: "stale head queued", head: pull.headSha };
    }

    const diffFiles = await this.loadDiff(octokit, repo, payload, pull);
    const worktree = await this.workspace.createWorktree({
      repo,
      token,
      source: "pull",
      pullNumber: payload.pullNumber,
      label: `review-${payload.pullNumber}`,
    });
    try {
      if (worktree.headSha !== payload.headSha) {
        const latest = await this.github.getPull(
          octokit,
          repo.owner,
          repo.name,
          payload.pullNumber,
        );
        this.enqueueReview(repo, latest);
        return { kind: "review", skipped: "worktree head changed", head: worktree.headSha };
      }
      const previous = this.store
        .listFindings(repo.id, payload.pullNumber)
        .slice(-10)
        .map(
          (finding) =>
            `- ${finding.path}:${finding.line} (${finding.severity}) ${finding.message.slice(0, 500)}`,
        );
      const sessionId = await this.adapter.createSession({
        directory: worktree.root,
        title: `Review ${repo.fullName}#${payload.pullNumber}@${payload.headSha.slice(0, 7)}`,
        mode: "read",
      });
      await this.adapter.applyInstructions(sessionId, this.prompt);
      const task = [
        `Repository: ${repo.fullName}`,
        "Repository root: ./repo (relative to this session directory). Findings paths must be repository-relative.",
        `Pull request #${payload.pullNumber}: ${pull.title}`,
        `Author: ${pull.author}`,
        `Base: ${pull.baseRef}; head: ${pull.headSha}`,
        `Review mode: ${payload.mode}` +
          (payload.previousReviewedSha
            ? `; changes since reviewed commit ${payload.previousReviewedSha}`
            : ""),
        "",
        "Pull request description:",
        pull.body || "(no description)",
        "",
        previous.length > 0
          ? `Previously published findings (do not repeat):\n${previous.join("\n")}`
          : "No previously published findings.",
        "",
        "Changed files and unified diff:",
        renderDiffContext(diffFiles),
        "",
        "Review the change for concrete defects introduced or exposed by it. Verify findings against the worktree when useful. Inline locations must be changed lines in this diff.",
        'Return exactly one JSON object: {"summary": "markdown summary", "findings": [{"path": "repo/relative/path", "line": 1, "side": "RIGHT", "severity": "low|medium|high", "message": "impact and failure scenario"}]}. Return an empty findings array when there is no actionable defect.',
      ].join("\n");
      const run = await this.adapter.runTask({
        sessionId,
        text: task,
        timeoutMs: TIMEOUTS.review,
      });
      const result = parseStructuredResult(run.text, ReviewResultSchema);
      const publication = await this.publisher.publishReview({
        repo,
        payload,
        result,
        diffFiles,
      });
      if (publication.status === "stale") {
        const latest = await this.github.getPull(
          octokit,
          repo.owner,
          repo.name,
          payload.pullNumber,
        );
        this.enqueueReview(repo, latest);
      }
      if (publication.status === "skipped") {
        return { kind: "review", skipped: publication.reason };
      }
      return { kind: "review", publication };
    } finally {
      await this.workspace.removeWorktree(repo, worktree.root);
    }
  }

  private async loadDiff(
    octokit: GitHubClient,
    repo: RepositoryRecord,
    payload: ReviewPayload,
    pull: PullSummary,
  ): Promise<DiffFile[]> {
    if (payload.mode === "incremental" && payload.previousReviewedSha) {
      try {
        const compared = await this.github.compare(
          octokit,
          repo.owner,
          repo.name,
          payload.previousReviewedSha,
          pull.headSha,
        );
        if (compared.length > 0) {
          if (compared.length >= 300) {
            this.logger.warn(
              {
                repo: repo.fullName,
                pull: pull.number,
              },
              "incremental comparison reached the GitHub file limit; using the full pull request diff",
            );
            return this.github.listPullFiles(
              octokit,
              repo.owner,
              repo.name,
              payload.pullNumber,
            );
          }
          return compared;
        }
      } catch (error) {
        this.logger.warn(
          {
            repo: repo.fullName,
            pull: pull.number,
            error: error instanceof Error ? error.message : String(error),
          },
          "incremental comparison failed; falling back to the full pull request diff",
        );
      }
    }
    return this.github.listPullFiles(
      octokit,
      repo.owner,
      repo.name,
      payload.pullNumber,
    );
  }

  private webBase(): string {
    return `https://${this.host}`;
  }

  private enqueueReview(repo: RepositoryRecord, pull: PullSummary): void {
    if (pull.draft || pull.state !== "open") return;
    const previous = this.store.lastReviewedHead(repo.id, pull.number);
    if (this.store.hasReviewedHead(repo.id, pull.number, pull.headSha)) return;
    this.store.enqueueJob({
      key: reviewKey(repo.id, pull.number, pull.headSha),
      kind: "review",
      repoId: repo.id,
      payload: {
        owner: repo.owner,
        repo: repo.name,
        installationId: repo.installationId,
        pullNumber: pull.number,
        headSha: pull.headSha,
        previousReviewedSha: previous,
        mode: previous ? "incremental" : "initial",
      } satisfies ReviewPayload,
    });
  }

  private async runConversation(
    repo: RepositoryRecord,
    payload: ConversationPayload,
  ): Promise<unknown> {
    const { octokit, token } = await this.readClient(repo);
    const subject =
      payload.subjectType === "pr"
        ? await this.github.getPull(
            octokit,
            repo.owner,
            repo.name,
            payload.subjectNumber,
          )
        : await this.github.getIssue(
            octokit,
            repo.owner,
            repo.name,
            payload.subjectNumber,
          );

    const worktree = await this.workspace.ensureSubjectWorktree({
      repo,
      token,
      source: payload.subjectType === "pr" ? "pull" : "default",
      pullNumber:
        payload.subjectType === "pr" ? payload.subjectNumber : undefined,
      label: `conversation-${payload.subjectType}-${payload.subjectNumber}`,
    });
    {
      let sessionId = this.store.getSessionMapping(
        repo.id,
        payload.subjectType,
        payload.subjectNumber,
      );
      let newSession = false;
      if (sessionId && !(await this.adapter.sessionExists(sessionId))) {
        sessionId = null;
      }
      if (!sessionId) {
        newSession = true;
        sessionId = await this.adapter.createSession({
          directory: worktree.root,
          title: `${payload.subjectType === "pr" ? "PR" : "Issue"} ${repo.fullName}#${payload.subjectNumber}`,
          mode: "read",
        });
        this.store.setSessionMapping(
          repo.id,
          payload.subjectType,
          payload.subjectNumber,
          sessionId,
        );
      }
      await this.adapter.applyInstructions(sessionId, this.prompt);
      const task = [
        `Repository: ${repo.fullName}`,
        "Repository root: ./repo (relative to this session directory).",
        `${payload.subjectType === "pr" ? "Pull request" : "Issue"} #${payload.subjectNumber}: ${payload.title}`,
        payload.subjectType === "pr"
          ? `The workspace is checked out at the pull request head (${(subject as PullSummary).headSha}).`
          : "The workspace is checked out at the default branch.",
        ...(newSession
          ? [
              `${payload.subjectType === "pr" ? "Pull request" : "Issue"} description:`,
              subject.body || "(no description)",
              "",
            ]
          : []),
        ...(payload.channel === "review" && payload.path
          ? [
              `Inline review location: ${payload.path}${payload.line ? `:${payload.line}` : ""}`,
              ...(payload.diffHunk
                ? ["Review diff context:", payload.diffHunk.slice(0, 4000), ""]
                : []),
              ...(payload.inReplyToId
                ? [`This mentions the App inside review thread ${payload.inReplyToId}.`, ""]
                : []),
            ]
          : []),
        `Requester: ${payload.author}`,
        "New comment:",
        payload.body || "(empty)",
        "",
        "Answer the request using the repository and this conversation's existing context. Do not modify code in this task.",
        'Return exactly one JSON object: {"comment": "markdown reply"}.',
      ].join("\n");
      const run = await this.adapter.runTask({
        sessionId,
        text: task,
        timeoutMs: TIMEOUTS.conversation,
      });
      const result = parseStructuredResult(run.text, ConversationResultSchema);
      const publication = await this.publisher.publishConversation({
        repo,
        payload,
        comment: result.comment,
      });
      return { kind: "conversation", publication };
    }
  }

  private async runFix(
    repo: RepositoryRecord,
    payload: FixPayload,
  ): Promise<unknown> {
    const { octokit, token } = await this.readClient(repo);
    const permission = await this.github.repositoryPermission(
      octokit,
      repo.owner,
      repo.name,
      payload.author,
    );
    if (!canWriteRepository(permission.permission)) {
      throw new PermanentJobError(
        `User ${payload.author} no longer has write access`,
      );
    }

    const subject =
      payload.subjectType === "pr"
        ? await this.github.getPull(
            octokit,
            repo.owner,
            repo.name,
            payload.subjectNumber,
          )
        : await this.github.getIssue(
            octokit,
            repo.owner,
            repo.name,
            payload.subjectNumber,
          );
    const base =
      payload.subjectType === "pr"
        ? (subject as PullSummary).baseRef
        : repo.defaultBranch;
    const branch = fixBranchName(
      payload.subjectType,
      payload.subjectNumber,
      payload.commentId,
    );

    if (await this.workspace.remoteBranchExists(repo, branch, token)) {
      const existing = await this.github.findPullByHead(
        await this.github.installationClient(
          repo.installationId,
          READ_PERMISSIONS,
        ),
        repo.owner,
        repo.name,
        branch,
      );
      if (existing) {
        if (existing.author !== this.botLogin) {
          throw new PermanentJobError(
            `Branch name is already used by another pull request author: ${existing.author}`,
          );
        }
        return {
          kind: "fix",
          skipped: "draft pull request already exists",
          number: existing.number,
        };
      }
      const recovered = await this.publisher.publishFix({
        repo,
        payload,
        branch,
        base,
        title: `Reviewbot: ${payload.title}`.slice(0, 120),
        body: [
          "Recovered draft pull request for an authorized implementation request.",
          "",
          "The branch was pushed before the pull request was confirmed. Review the branch diff before merging.",
        ].join("\n"),
        note: "Recovered the draft pull request from the existing branch.",
      });
      return { kind: "fix", recovered: true, publication: recovered };
    }

    const worktree = await this.workspace.createWorktree({
      repo,
      token,
      source: payload.subjectType === "pr" ? "pull" : "default",
      pullNumber:
        payload.subjectType === "pr" ? payload.subjectNumber : undefined,
      label: `fix-${payload.subjectNumber}-${payload.commentId}`,
    });
    try {
      const sessionId = await this.adapter.createSession({
        directory: worktree.root,
        title: `Fix ${repo.fullName}#${payload.subjectNumber} (${payload.commentId})`,
        mode: "implement",
      });
      await this.adapter.applyInstructions(sessionId, this.prompt);
      const task = [
        `Repository: ${repo.fullName}`,
        "Repository root: ./repo (relative to this session directory). Edit files under this directory.",
        `Target: ${payload.subjectType === "pr" ? "pull request" : "issue"} #${payload.subjectNumber} (${payload.title})`,
        ...(subject.body ? ["Target description:", subject.body, ""] : []),
        `Requester: ${payload.author}`,
        "Authorized implementation request:",
        payload.body || "(empty)",
        "",
        "Implement the requested change in the workspace. Keep it minimal and consistent with project conventions. Do not modify unrelated files. Do not run shell commands or tests; the runtime denies them. The daemon will commit the change and open a draft pull request.",
        'Return exactly one JSON object: {"summary": "what changed", "verification": "what was and was not verified", "notes": "optional risks"}.',
      ].join("\n");
      const run = await this.adapter.runTask({
        sessionId,
        text: task,
        timeoutMs: TIMEOUTS.fix,
      });
      const result = parseStructuredResult(run.text, FixResultSchema);
      await this.workspace.assertWorktreeIntegrity(worktree.path);
      const changes = await this.workspace.changedFiles(worktree.path);
      if (changes.length === 0) {
        throw new PermanentJobError(
          "The implementation task produced no workspace changes",
        );
      }
      const committed = await this.workspace.commitAll(
        worktree.path,
        `Reviewbot: ${payload.title}`.slice(0, 200),
      );
      const ciFiles = committed.files.filter(
        (file) =>
          /^\.github\/(workflows|actions)\//i.test(file) ||
          /^(\.gitlab-ci\.yml|\.circleci\/|azure-pipelines\.yml|Jenkinsfile$)/i.test(
            file,
          ),
      );
      if (
        ciFiles.length > 0 &&
        !/\b(ci|workflow|pipeline|github action|actions)\b/i.test(payload.body)
      ) {
        throw new PermanentJobError(
          `The implementation would modify CI configuration without an explicit CI request: ${ciFiles.join(", ")}`,
        );
      }
      await this.workspace.pushBranch({
        repo,
        cwd: worktree.path,
        branch,
        token: await this.github.installationToken(repo.installationId, {
          contents: "write",
          metadata: "read",
        }),
      });

      const sourceUrl =
        payload.subjectType === "pr"
          ? `${this.webBase()}/${repo.owner}/${repo.name}/pull/${payload.subjectNumber}`
          : `${this.webBase()}/${repo.owner}/${repo.name}/issues/${payload.subjectNumber}`;
      const originalPrNote =
        payload.subjectType === "pr"
          ? `\n\nThis draft includes the original pull request's changes and targets its base branch (${base}). Original pull request: ${sourceUrl}.`
          : `\n\nRequested in ${sourceUrl}.`;
      const dependencyFiles = committed.files.filter((file) =>
        /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|pyproject\.toml|uv\.lock|go\.(mod|sum))$/i.test(
          file,
        ),
      );
      const prBody = [
        result.summary,
        "",
        "### Verification",
        result.verification,
        result.notes ? `\n### Notes\n${result.notes}` : "",
        originalPrNote,
        "",
        "### Changed files",
        committed.files.map((file) => `- \`${file}\``).join("\n"),
        committed.stat ? `\n### Diff stat\n\`\`\`\n${committed.stat}\n\`\`\`` : "",
        dependencyFiles.length > 0
          ? `\n### Dependency manifests\nThis draft changes dependency files and requires explicit review: ${dependencyFiles.map((file) => `\`${file}\``).join(", ")}`
          : "",
        "\nCreated by Reviewbot after an authorized maintainer request.",
      ].join("\n");

      const publication = await this.publisher.publishFix({
        repo,
        payload,
        branch,
        base,
        title: `Reviewbot: ${payload.title}`.slice(0, 120),
        body: prBody,
        note: `Implemented the requested change in a draft pull request (${committed.files.length} changed path${committed.files.length === 1 ? "" : "s"}).`,
      });
      return {
        kind: "fix",
        publication,
        commit: committed.sha,
        changed: committed.files.length,
      };
    } finally {
      await this.workspace.removeWorktree(repo, worktree.root);
    }
  }
}

interface JobErrorClassification {
  message: string;
  retryable: boolean;
  delaySeconds?: number;
}

export function classifyJobError(error: unknown): JobErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ResultValidationError) {
    return { message, retryable: false };
  }
  if (error instanceof PermanentJobError) {
    return { message, retryable: false };
  }
  if (error instanceof PublishError) {
    return { message, retryable: !error.permanent };
  }
  if (error instanceof GitError) {
    return { message, retryable: !error.permanent };
  }
  if (error instanceof TaskExecutionError) {
    return { message, retryable: error.retryable };
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      name?: string;
      retryable?: boolean;
      rateLimited?: boolean;
      retryAfterSeconds?: number | null;
      status?: number;
    };
    if (candidate.name === "OpenCodeCompatibilityError") {
      return { message, retryable: false };
    }
    if (candidate.rateLimited) {
      return {
        message,
        retryable: true,
        delaySeconds: Math.min(
          3600,
          Math.max(60, (candidate.retryAfterSeconds ?? 60) + 5),
        ),
      };
    }
    if (typeof candidate.retryable === "boolean") {
      return { message, retryable: candidate.retryable };
    }
  }
  return { message, retryable: true };
}
