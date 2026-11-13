import type {
  GitHub,
  GitHubClient,
  PullSummary,
  CommentSummary,
  InstallationSummary,
} from "./github.ts";
import { canWriteRepository } from "./github.ts";
import type { RepositoryRecord, Store } from "./db.ts";
import { addSeconds, nowIso } from "./db.ts";
import {
  conversationKey,
  duplicateCommentKey,
  duplicateDueKey,
  fixKey,
  reviewKey,
  triageKey,
  truncateBody,
  type ConversationPayload,
  type DuplicateCommentPayload,
  type DuplicateDuePayload,
  type FixPayload,
  type ReviewPayload,
  type TriagePayload,
} from "./jobs.ts";
import { hasCommand, isFixRequest, stripCommand } from "./commands.ts";
import { isMaintainerOverride, isSubstantiveComment } from "./duplicates.ts";
import type { Logger } from "./log.ts";

const OVERLAP_SECONDS = 120;

export interface PollResult {
  repositories: number;
  enqueued: number;
  initialized: number;
}

export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class Poller {
  private readonly store: Store;
  private readonly github: GitHub;
  private readonly logger: Logger;
  private readonly botSlug: string;

  constructor(options: {
    store: Store;
    github: GitHub;
    logger: Logger;
    botSlug: string;
  }) {
    this.store = options.store;
    this.github = options.github;
    this.logger = options.logger;
    this.botSlug = options.botSlug;
  }

  get botLogin(): string {
    return `${this.botSlug}[bot]`;
  }

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { repositories: 0, enqueued: 0, initialized: 0 };
    const installations = await this.github.listInstallations();
    const activeIds = new Set<number>();

    for (const installation of installations) {
      if (installation.suspended) {
        this.store.deactivateInstallation(installation.id);
        this.logger.warn(
          { installationId: installation.id },
          "installation suspended; repository processing halted",
        );
        continue;
      }
      activeIds.add(installation.id);
      this.store.upsertInstallation(installation);
      const enqueued = await this.pollInstallation(installation, result);
      result.enqueued += enqueued;
    }

    for (const known of this.store.listInstallations(false)) {
      if (!activeIds.has(known.id) && !known.suspended) {
        this.store.deactivateInstallation(known.id);
      }
    }
    return result;
  }

  private async pollInstallation(
    installation: InstallationSummary,
    result: PollResult,
  ): Promise<number> {
    const octokit = await this.github.installationClient(installation.id, {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
    });
    const repositories = await this.github.listInstallationRepositories(
      installation.id,
    );
    const activeRepoNames = new Set(repositories.map((repo) => repo.fullName));
    for (const known of this.store.listRepositories(true)) {
      if (
        known.installationId === installation.id &&
        !activeRepoNames.has(known.fullName)
      ) {
        this.store.setActive(known.id, false);
      }
    }

    let enqueued = 0;
    for (const repo of repositories) {
      result.repositories += 1;
      const baseline = nowIso();
      const created = this.store.upsertRepository({
        id: repo.id,
        installationId: installation.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        baseline,
      });
      if (created) {
        result.initialized += 1;
        await this.initializeBaseline(repo.id, octokit);
        continue;
      }
      try {
        enqueued += await this.pollRepository(
          this.store.getRepositoryByFullName(repo.fullName)!,
          octokit,
        );
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.store.setPollError(repo.id, message);
        this.logger.error(
          { repo: repo.fullName, error: message },
          "repository poll failed; checkpoints retained",
        );
      }
    }
    return enqueued;
  }

  /** Record existing PR heads without processing historical work. */
  private async initializeBaseline(
    repoId: number,
    octokit: GitHubClient,
  ): Promise<void> {
    const repo = this.store.getRepository(repoId);
    if (!repo) return;
    try {
      const { pulls } = await this.github.listOpenPulls(
        octokit,
        repo.owner,
        repo.name,
      );
      for (const pull of pulls) {
        this.store.upsertPullState({
          repoId,
          number: pull.number,
          draft: pull.draft,
          headSha: pull.headSha,
        });
      }
    } catch (error) {
      this.logger.warn(
        { repo: repo.fullName, error: error instanceof Error ? error.message : String(error) },
        "baseline PR state could not be recorded; it will be recorded on the next poll",
      );
    }
  }

  private async pollRepository(
    repo: RepositoryRecord,
    octokit: GitHubClient,
  ): Promise<number> {
    const pollStart = nowIso();
    let enqueued = 0;
    let sourceFailed = false;

    // Issues created after the repository baseline.
    try {
      const issues = await this.github.listIssues(
        octokit,
        repo.owner,
        repo.name,
        addSeconds(repo.issuesCursor, -OVERLAP_SECONDS),
      );
      for (const issue of issues) {
        if (this.isSelf(issue.author, issue.authorType)) continue;
        if (!isAfter(issue.createdAt, repo.initializedAt)) continue;
        const payload: TriagePayload = {
          owner: repo.owner,
          repo: repo.name,
          installationId: repo.installationId,
          issueNumber: issue.number,
          title: issue.title,
          body: truncateBody(issue.body ?? ""),
          author: issue.author,
        };
        if (
          this.store.enqueueJob({
            key: triageKey(repo.id, issue.number),
            kind: "triage",
            repoId: repo.id,
            payload,
          })
        ) {
          enqueued += 1;
          this.logger.info(
            { repo: repo.fullName, issue: issue.number },
            "queued issue triage",
          );
        }
      }
      this.store.setCursor(repo.id, "issues", pollStart);
    } catch (error) {
      sourceFailed = true;
      this.handleSourceError(repo, "issues", error);
    }

    // Pull requests: initial, incremental, and draft-ready reviews.
    try {
      enqueued += await this.pollPulls(repo, octokit, pollStart);
    } catch (error) {
      sourceFailed = true;
      this.handleSourceError(repo, "pulls", error);
    }

    // Conversation comments (issues and PR conversation).
    try {
      const comments = await this.github.listIssueComments(
        octokit,
        repo.owner,
        repo.name,
        addSeconds(repo.commentsCursor, -OVERLAP_SECONDS),
      );
      for (const comment of comments) {
        if (this.isSelf(comment.author, comment.authorType)) continue;
        if (!isAfter(comment.createdAt, repo.initializedAt)) continue;
        if (comment.issueNumber == null) continue;
        let commentEnqueued = 0;
        if (hasCommand(comment.body)) {
          const commandEnqueued = await this.handleCommandSafely(
            repo,
            octokit,
            comment,
            "issue",
            comment.issueNumber,
          );
          commentEnqueued += commandEnqueued;
        }
        commentEnqueued += await this.handleDuplicateCommentSafely(
          repo,
          octokit,
          comment,
          comment.issueNumber,
        );
        enqueued += commentEnqueued;
      }
      this.store.setCursor(repo.id, "comments", pollStart);
    } catch (error) {
      sourceFailed = true;
      this.handleSourceError(repo, "comments", error);
    }

    // Duplicate lifecycle deadlines and interrupted notice intents.
    try {
      enqueued += this.pollDuplicateCases(repo);
    } catch (error) {
      sourceFailed = true;
      this.handleSourceError(repo, "duplicates", error);
    }

    // Inline review comments and replies.
    try {
      const comments = await this.github.listReviewComments(
        octokit,
        repo.owner,
        repo.name,
        addSeconds(repo.reviewCommentsCursor, -OVERLAP_SECONDS),
      );
      for (const comment of comments) {
        if (this.isSelf(comment.author, comment.authorType)) continue;
        if (!isAfter(comment.createdAt, repo.initializedAt)) continue;
        if (!hasCommand(comment.body)) continue;
        if (comment.issueNumber == null) continue;
        enqueued += await this.handleCommandSafely(
          repo,
          octokit,
          comment,
          "review",
          comment.issueNumber,
        );
      }
      this.store.setCursor(repo.id, "reviewComments", pollStart);
    } catch (error) {
      sourceFailed = true;
      this.handleSourceError(repo, "reviewComments", error);
    }

    if (!sourceFailed) {
      this.store.markPollSuccess(repo.id, pollStart);
    }
    return enqueued;
  }

  private async pollPulls(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    pollStart: string,
  ): Promise<number> {
    let enqueued = 0;
    const result = await this.github.listOpenPulls(
      octokit,
      repo.owner,
      repo.name,
      repo.pullsEtag,
    );
    if (result.notModified) {
      this.store.setPullsCheckpoint(repo.id, pollStart, result.etag);
      return 0;
    }
    const pulls = result.pulls;
    for (const pull of pulls) {
      if (this.isSelf(pull.author, pull.authorType)) continue;
      const state = this.store.getPullState(repo.id, pull.number);
      if (!state) {
        this.store.upsertPullState({
          repoId: repo.id,
          number: pull.number,
          draft: pull.draft,
          headSha: pull.headSha,
        });
        if (isAfter(pull.createdAt, repo.initializedAt) && !pull.draft) {
          enqueued += this.enqueueReview(repo, pull, null);
        }
        continue;
      }
      const becameReady = state.draft && !pull.draft;
      const headChanged = state.headSha !== pull.headSha;
      this.store.upsertPullState({
        repoId: repo.id,
        number: pull.number,
        draft: pull.draft,
        headSha: pull.headSha,
      });
      if (pull.draft) continue;
      if (!becameReady && !headChanged) continue;
      if (state.lastReviewedSha === pull.headSha) continue;
      if (this.store.hasReviewedHead(repo.id, pull.number, pull.headSha)) continue;
      enqueued += this.enqueueReview(repo, pull, state.lastReviewedSha);
    }
    this.store.setPullsCheckpoint(repo.id, pollStart, result.etag);
    return enqueued;
  }

  private enqueueReview(
    repo: RepositoryRecord,
    pull: PullSummary,
    previousReviewedSha: string | null,
  ): number {
    const payload: ReviewPayload = {
      owner: repo.owner,
      repo: repo.name,
      installationId: repo.installationId,
      pullNumber: pull.number,
      headSha: pull.headSha,
      previousReviewedSha,
      mode: previousReviewedSha ? "incremental" : "initial",
    };
    const inserted = this.store.enqueueJob({
      key: reviewKey(repo.id, pull.number, pull.headSha),
      kind: "review",
      repoId: repo.id,
      payload,
    });
    if (inserted) {
      this.logger.info(
        { repo: repo.fullName, pull: pull.number, mode: payload.mode },
        "queued pull request review",
      );
      return 1;
    }
    return 0;
  }

  /** Enqueue due deadlines and reconcile unconfirmed notice intents. */
  private pollDuplicateCases(repo: RepositoryRecord): number {
    let enqueued = 0;
    for (const record of this.store.listNoticePendingDuplicateCases(repo.id)) {
      const stamp = `notice:${record.updatedAt}`;
      const payload: DuplicateDuePayload = {
        owner: repo.owner,
        repo: repo.name,
        installationId: repo.installationId,
        issueNumber: record.issueNumber,
        dueAt: stamp,
      };
      if (
        this.store.enqueueJob({
          key: duplicateDueKey(repo.id, record.issueNumber, stamp),
          kind: "duplicate-due",
          repoId: repo.id,
          payload,
        })
      ) {
        enqueued += 1;
        this.logger.info(
          { repo: repo.fullName, issue: record.issueNumber },
          "queued duplicate notice reconciliation",
        );
      }
    }
    for (const record of this.store.listDueDuplicateCases(nowIso(), repo.id)) {
      if (!record.dueAt) continue;
      const payload: DuplicateDuePayload = {
        owner: repo.owner,
        repo: repo.name,
        installationId: repo.installationId,
        issueNumber: record.issueNumber,
        dueAt: record.dueAt,
      };
      if (
        this.store.enqueueJob({
          key: duplicateDueKey(repo.id, record.issueNumber, record.dueAt),
          kind: "duplicate-due",
          repoId: repo.id,
          payload,
        })
      ) {
        enqueued += 1;
        this.logger.info(
          { repo: repo.fullName, issue: record.issueNumber, dueAt: record.dueAt },
          "queued duplicate closure check",
        );
      }
    }
    return enqueued;
  }

  private async handleDuplicateCommentSafely(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    comment: CommentSummary,
    issueNumber: number,
  ): Promise<number> {
    try {
      return await this.handleDuplicateComment(
        repo,
        octokit,
        comment,
        issueNumber,
      );
    } catch (error) {
      const candidate = error as { retryable?: boolean; rateLimited?: boolean };
      if (candidate.rateLimited || candidate.retryable) throw error;
      this.logger.warn(
        {
          repo: repo.fullName,
          comment: comment.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "skipping an unprocessable duplicate follow-up",
      );
      return 0;
    }
  }

  /**
   * Duplicate-only follow-up monitoring. A substantive comment from the
   * reporter or a write-access collaborator can trigger reassessment without an
   * explicit command; it never grants execution authority.
   */
  private async handleDuplicateComment(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    comment: CommentSummary,
    issueNumber: number,
  ): Promise<number> {
    const record = this.store.getDuplicateCase(repo.id, issueNumber);
    if (!record) return 0;
    if (record.status !== "pending" && record.status !== "closed") return 0;
    if (!record.noticePostedAt) return 0;
    if (record.lastCheckedCommentId != null && comment.id <= record.lastCheckedCommentId) {
      return 0;
    }
    if (Date.parse(comment.createdAt) < Date.parse(record.noticePostedAt)) {
      return 0;
    }
    if (
      !isSubstantiveComment(comment.body) &&
      !isMaintainerOverride(comment.body)
    ) {
      return 0;
    }
    const issue = await this.github.getIssue(
      octokit,
      repo.owner,
      repo.name,
      issueNumber,
    );
    if (issue.isPullRequest) return 0;
    if (comment.author !== issue.author) {
      const permission = await this.github.repositoryPermission(
        octokit,
        repo.owner,
        repo.name,
        comment.author,
      );
      if (!canWriteRepository(permission.permission)) {
        this.logger.info(
          {
            repo: repo.fullName,
            issue: issueNumber,
            author: comment.author,
            permission: permission.permission,
          },
          "duplicate follow-up ignored: commenter is not the reporter or a collaborator",
        );
        return 0;
      }
    }
    const payload: DuplicateCommentPayload = {
      owner: repo.owner,
      repo: repo.name,
      installationId: repo.installationId,
      issueNumber,
      commentId: comment.id,
      author: comment.author,
      body: truncateBody(comment.body),
      createdAt: comment.createdAt,
    };
    const key = duplicateCommentKey(repo.id, comment.id);
    if (this.store.hasFailedJob(key)) {
      this.logger.debug(
        { repo: repo.fullName, issue: issueNumber, comment: comment.id },
        "duplicate reassessment already failed permanently for this comment",
      );
      return 0;
    }
    const inserted = this.store.enqueueJob({
      key,
      kind: "duplicate-comment",
      repoId: repo.id,
      payload,
    });
    if (inserted) {
      this.logger.info(
        { repo: repo.fullName, issue: issueNumber, comment: comment.id },
        "queued duplicate reassessment",
      );
      return 1;
    }
    return 0;
  }

  private async handleCommandSafely(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    comment: CommentSummary,
    channel: "issue" | "review",
    subjectNumber: number,
  ): Promise<number> {
    try {
      return await this.handleCommand(
        repo,
        octokit,
        comment,
        channel,
        subjectNumber,
      );
    } catch (error) {
      const candidate = error as { retryable?: boolean; rateLimited?: boolean };
      if (candidate.rateLimited || candidate.retryable) throw error;
      this.logger.warn(
        {
          repo: repo.fullName,
          comment: comment.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "skipping an unprocessable command; checkpoint will advance",
      );
      return 0;
    }
  }

  private async handleCommand(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    comment: CommentSummary,
    channel: "issue" | "review",
    subjectNumber: number,
  ): Promise<number> {
    const permission = await this.github.repositoryPermission(
      octokit,
      repo.owner,
      repo.name,
      comment.author,
    );
    if (!canWriteRepository(permission.permission)) {
      this.logger.info(
        {
          repo: repo.fullName,
          author: comment.author,
          permission: permission.permission,
        },
        "command denied: requester lacks write access",
      );
      return 0;
    }

    const subjectType = await this.subjectType(repo, octokit, channel, subjectNumber);
    const title = await this.subjectTitle(repo, octokit, subjectType, subjectNumber);
    const instruction = stripCommand(comment.body);
    if (isFixRequest(instruction)) {
      const payload: FixPayload = {
        owner: repo.owner,
        repo: repo.name,
        installationId: repo.installationId,
        subjectType,
        subjectNumber,
        commentId: comment.id,
        channel,
        body: truncateBody(instruction),
        author: comment.author,
        title,
      };
      const inserted = this.store.enqueueJob({
        key: fixKey(repo.id, comment.id),
        kind: "fix",
        repoId: repo.id,
        payload,
      });
      if (inserted) {
        this.logger.info(
          { repo: repo.fullName, comment: comment.id, author: comment.author },
          "queued explicit implementation request",
        );
      }
      return inserted ? 1 : 0;
    }

    const payload: ConversationPayload = {
      owner: repo.owner,
      repo: repo.name,
      installationId: repo.installationId,
      subjectType,
      subjectNumber,
      commentId: comment.id,
      channel,
      body: truncateBody(instruction),
      author: comment.author,
      title,
      path: channel === "review" ? comment.path : null,
      line: channel === "review" ? comment.line : null,
      originalLine: channel === "review" ? comment.originalLine : null,
      diffHunk: channel === "review" ? comment.diffHunk : null,
      inReplyToId: channel === "review" ? comment.inReplyToId : null,
    };
    const inserted = this.store.enqueueJob({
      key: conversationKey(repo.id, comment.id),
      kind: "conversation",
      repoId: repo.id,
      payload,
    });
    if (inserted) {
      this.logger.info(
        { repo: repo.fullName, comment: comment.id, channel },
        "queued conversational task",
      );
    }
    return inserted ? 1 : 0;
  }

  private async subjectType(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    channel: "issue" | "review",
    number: number,
  ): Promise<"issue" | "pr"> {
    if (channel === "review") return "pr";
    const issue = await this.github.getIssue(octokit, repo.owner, repo.name, number);
    return issue.isPullRequest ? "pr" : "issue";
  }

  private async subjectTitle(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    subjectType: "issue" | "pr",
    number: number,
  ): Promise<string> {
    if (subjectType === "pr") {
      const pull = await this.github.getPull(octokit, repo.owner, repo.name, number);
      return pull.title;
    }
    const issue = await this.github.getIssue(octokit, repo.owner, repo.name, number);
    return issue.title;
  }

  private isSelf(author: string, authorType: string): boolean {
    return author === this.botLogin || (authorType === "Bot" && author === this.botLogin);
  }

  private handleSourceError(
    repo: RepositoryRecord,
    source: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.setPollError(repo.id, `${source}: ${message}`);
    this.logger.error(
      { repo: repo.fullName, source, error: message },
      "poll source failed; its checkpoint was not advanced",
    );
    if (error instanceof RateLimitedError) throw error;
    const candidate = error as { rateLimited?: boolean; retryAfterSeconds?: number | null };
    if (candidate.rateLimited) {
      throw new RateLimitedError(message, candidate.retryAfterSeconds ?? 60);
    }
  }
}

function isAfter(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a > b;
}
