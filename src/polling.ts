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
  fixKey,
  reviewKey,
  triageKey,
  truncateBody,
  type ConversationPayload,
  type FixPayload,
  type ReviewPayload,
  type TriagePayload,
} from "./jobs.ts";
import { hasMention, isFixRequest, stripMention } from "./mentions.ts";
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
      const previous = this.store.getInstallation(installation.id);
      this.store.upsertInstallation(installation);
      const reactivated = previous?.suspended === true;
      const enqueued = await this.pollInstallation(installation, result, reactivated);
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
    reactivated: boolean,
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
      if (reactivated && !created) {
        this.store.resetBaseline(repo.id, baseline);
      }
      if (created || reactivated) {
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
        if (!hasMention(comment.body, this.botSlug)) continue;
        if (comment.issueNumber == null) continue;
        enqueued += await this.handleMentionSafely(
          repo,
          octokit,
          comment,
          "issue",
          comment.issueNumber,
        );
      }
      this.store.setCursor(repo.id, "comments", pollStart);
    } catch (error) {
      sourceFailed = true;
      this.handleSourceError(repo, "comments", error);
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
        if (!hasMention(comment.body, this.botSlug)) continue;
        if (comment.issueNumber == null) continue;
        enqueued += await this.handleMentionSafely(
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
      this.store.setCursor(repo.id, "pulls", pollStart);
      return 0;
    }
    this.store.setPullsEtag(repo.id, result.etag);
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
    this.store.setCursor(repo.id, "pulls", pollStart);
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

  private async handleMentionSafely(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    comment: CommentSummary,
    channel: "issue" | "review",
    subjectNumber: number,
  ): Promise<number> {
    try {
      return await this.handleMention(
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
        "skipping an unprocessable mention; checkpoint will advance",
      );
      return 0;
    }
  }

  private async handleMention(
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
        "mention denied: requester lacks write access",
      );
      return 0;
    }

    const subjectType = await this.subjectType(repo, octokit, channel, subjectNumber);
    const title = await this.subjectTitle(repo, octokit, subjectType, subjectNumber);
    const instruction = stripMention(comment.body, this.botSlug);
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
