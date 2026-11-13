import type { RepositoryRecord, Store } from "./db.ts";
import type {
  CommentSummary,
  GitHub,
  GitHubClient,
  ReviewSummary,
} from "./github.ts";
import { canWriteRepository, WRITE_PERMISSIONS } from "./github.ts";
import type {
  ConversationPayload,
  FixPayload,
  ReviewPayload,
} from "./jobs.ts";
import { redactText, type Logger } from "./log.ts";
import type { DiffFile } from "./diff.ts";
import {
  findingHash,
  indexDiff,
  isValidLocation,
  normalizeRepoPath,
  resolveDiffPath,
} from "./diff.ts";
import {
  PublicationMarker,
  hasMarker,
  withMarker,
  type ReviewResult,
} from "./schemas.ts";
import { LABEL_DEFINITIONS } from "./duplicates.ts";

export class PublishError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.name = "PublishError";
    this.permanent = permanent;
  }
}

export type ReviewPublication =
  | { status: "published"; reviewId: number }
  | { status: "duplicate"; reviewId: number | null }
  | { status: "stale"; currentHead: string }
  | { status: "skipped"; reason: string };

export type PublicationOutcome =
  | { status: "published"; id: number }
  | { status: "duplicate"; id: number | null }
  | { status: "skipped"; reason: string };

export interface DuplicatePublication {
  status: "published" | "duplicate";
  id: number;
  createdAt: string;
}

export class Publisher {
  private readonly store: Store;
  private readonly github: GitHub;
  private readonly logger: Logger;
  private readonly botLogin: string;
  private readonly clock: () => string;

  constructor(options: {
    store: Store;
    github: GitHub;
    logger: Logger;
    botLogin: string;
    clock?: () => string;
  }) {
    this.store = options.store;
    this.github = options.github;
    this.logger = options.logger;
    this.botLogin = options.botLogin;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  private async writeClient(
    repo: RepositoryRecord,
    username?: string,
  ): Promise<GitHubClient> {
    const access = await this.github.verifyInstallationAccess(
      repo.installationId,
      repo.owner,
      repo.name,
    );
    if (!access.ok) {
      throw new PublishError(
        `Installation access is no longer valid: ${access.detail}`,
        true,
      );
    }
    const octokit = await this.github.installationClient(
      repo.installationId,
      WRITE_PERMISSIONS,
    );
    if (username) {
      const permission = await this.github.repositoryPermission(
        octokit,
        repo.owner,
        repo.name,
        username,
      );
      if (!canWriteRepository(permission.permission)) {
        throw new PublishError(
          `User ${username} no longer has write access`,
          true,
        );
      }
    }
    return octokit;
  }

  async publishTriage(input: {
    repo: RepositoryRecord;
    issueNumber: number;
    comment: string;
  }): Promise<PublicationOutcome> {
    assertNoCredentialMaterial(input.comment);
    const marker = PublicationMarker.triage(input.issueNumber);
    if (this.store.hasPublication(input.repo.id, marker)) {
      return { status: "duplicate", id: null };
    }
    const octokit = await this.writeClient(input.repo);
    const issue = await this.github.getIssue(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
    );
    if (issue.state !== "open") {
      return { status: "skipped", reason: `issue is ${issue.state}` };
    }
    const existing = await this.github.listIssueCommentsForMarker(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
    );
    const already = findByMarker(existing, marker, this.botLogin);
    if (already) {
      this.store.recordPublication({
        marker,
        repoId: input.repo.id,
        kind: "issue-triage",
        githubId: already,
      });
      return { status: "duplicate", id: already };
    }
    const id = await this.github.createIssueComment(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
      withMarker(limitBody(sanitizeModelText(input.comment)), marker),
    );
    this.store.recordPublication({
      marker,
      repoId: input.repo.id,
      kind: "issue-triage",
      githubId: id,
    });
    return { status: "published", id };
  }

  async publishReview(input: {
    repo: RepositoryRecord;
    payload: ReviewPayload;
    result: ReviewResult;
    diffFiles: DiffFile[];
  }): Promise<ReviewPublication> {
    const octokit = await this.writeClient(input.repo);
    const pull = await this.github.getPull(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.payload.pullNumber,
    );
    if (pull.state !== "open") {
      return { status: "skipped", reason: `pull request is ${pull.state}` };
    }
    if (pull.draft) {
      return { status: "skipped", reason: "pull request is a draft" };
    }
    if (pull.headSha !== input.payload.headSha) {
      return { status: "stale", currentHead: pull.headSha };
    }

    assertNoCredentialMaterial(
      input.result.summary,
      ...input.result.findings.map((finding) => finding.message),
    );
    const summaryText = sanitizeModelText(input.result.summary);
    const findings = input.result.findings.map((finding) => ({
      ...finding,
      message: sanitizeModelText(finding.message),
    }));
    const marker = PublicationMarker.review(input.payload.headSha);
    if (this.store.hasPublication(input.repo.id, marker)) {
      this.store.markPullReviewed(
        input.repo.id,
        input.payload.pullNumber,
        input.payload.headSha,
      );
      return { status: "duplicate", reviewId: null };
    }
    const reviews = await this.github.listReviews(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.payload.pullNumber,
    );
    const existing = findByMarkerReview(reviews, marker, this.botLogin);
    if (existing) {
      this.store.recordPublication({
        marker,
        repoId: input.repo.id,
        kind: "review",
        githubId: existing,
      });
      this.store.markPullReviewed(
        input.repo.id,
        input.payload.pullNumber,
        input.payload.headSha,
      );
      return { status: "duplicate", reviewId: existing };
    }

    const index = indexDiff(input.diffFiles);
    const resolvedFindings = findings.map((finding) => ({
      ...finding,
      path: resolveDiffPath(index, finding.path) ?? normalizeRepoPath(finding.path),
    }));
    const inline: Array<{
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
      body: string;
    }> = [];
    const summaryFindings: string[] = [];
    const publishedHashes: string[] = [];

    for (const finding of resolvedFindings) {
      const hash = findingHash(finding);
      if (this.store.hasFinding(input.repo.id, input.payload.pullNumber, hash)) {
        continue;
      }
      publishedHashes.push(hash);
      if (isValidLocation(index, finding.path, finding.line, finding.side)) {
        inline.push({
          path: normalizeRepoPath(finding.path),
          line: finding.line,
          side: finding.side,
          body: `**${finding.severity}** — ${finding.message}`,
        });
      } else {
        summaryFindings.push(
          `- **${normalizeRepoPath(finding.path)}:${finding.line}** (${finding.severity}) — ${finding.message}`,
        );
      }
    }

    const summary = buildReviewBody(summaryText, summaryFindings, marker);
    let reviewId: number;
    try {
      reviewId = await this.github.createReview(
        octokit,
        input.repo.owner,
        input.repo.name,
        input.payload.pullNumber,
        { commitId: input.payload.headSha, body: summary, comments: inline },
      );
    } catch (error) {
      if (!isUnprocessable(error)) throw error;
      this.logger.warn(
        {
          repo: input.repo.fullName,
          pull: input.payload.pullNumber,
          error: error instanceof Error ? error.message : String(error),
        },
        "inline review locations were rejected; publishing summary-level findings",
      );
      const fallbackFindings = [
        ...summaryFindings,
        ...inline.map(
          (entry) => `- **${entry.path}:${entry.line}** — ${entry.body}`,
        ),
      ];
      reviewId = await this.github.createReview(
        octokit,
        input.repo.owner,
        input.repo.name,
        input.payload.pullNumber,
        {
          commitId: input.payload.headSha,
          body: buildReviewBody(
            summaryText,
            fallbackFindings,
            marker,
          ),
          comments: [],
        },
      );
      inline.length = 0;
    }

    this.recordPublishedFindings(
      input.repo.id,
      input.payload.pullNumber,
      { summary: summaryText, findings: resolvedFindings },
      publishedHashes,
    );
    this.store.markPullReviewed(
      input.repo.id,
      input.payload.pullNumber,
      input.payload.headSha,
    );
    this.store.recordPublication({
      marker,
      repoId: input.repo.id,
      kind: "review",
      githubId: reviewId,
    });
    return { status: "published", reviewId };
  }

  private recordPublishedFindings(
    repoId: number,
    prNumber: number,
    result: ReviewResult,
    onlyHashes?: string[],
  ): void {
    for (const finding of result.findings) {
      const hash = findingHash(finding);
      if (onlyHashes && !onlyHashes.includes(hash)) continue;
      this.store.recordFinding({
        repoId,
        prNumber,
        hash,
        path: finding.path,
        line: finding.line,
        severity: finding.severity,
        message: finding.message,
      });
    }
  }

  async publishConversation(input: {
    repo: RepositoryRecord;
    payload: ConversationPayload;
    comment: string;
  }): Promise<PublicationOutcome> {
    assertNoCredentialMaterial(input.comment);
    const marker = PublicationMarker.reply(input.payload.commentId);
    if (this.store.hasPublication(input.repo.id, marker)) {
      return { status: "duplicate", id: null };
    }
    const octokit = await this.writeClient(input.repo, input.payload.author);

    if (input.payload.channel === "review") {
      const existing = await this.github.listReviewCommentsForMarker(
        octokit,
        input.repo.owner,
        input.repo.name,
        input.payload.subjectNumber,
      );
      const already = findByMarker(existing, marker, this.botLogin);
      if (already) {
        this.store.recordPublication({
          marker,
          repoId: input.repo.id,
          kind: "reply",
          githubId: already,
        });
        return { status: "duplicate", id: already };
      }
      const id = await this.github.createReviewCommentReply(
        octokit,
        input.repo.owner,
        input.repo.name,
        input.payload.subjectNumber,
        input.payload.commentId,
        withMarker(limitBody(sanitizeModelText(input.comment)), marker),
      );
      this.store.recordPublication({
        marker,
        repoId: input.repo.id,
        kind: "reply",
        githubId: id,
      });
      return { status: "published", id };
    }

    const existing = await this.github.listIssueCommentsForMarker(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.payload.subjectNumber,
    );
    const already = findByMarker(existing, marker, this.botLogin);
    if (already) {
      this.store.recordPublication({
        marker,
        repoId: input.repo.id,
        kind: "reply",
        githubId: already,
      });
      return { status: "duplicate", id: already };
    }
    const id = await this.github.createIssueComment(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.payload.subjectNumber,
      withMarker(limitBody(sanitizeModelText(input.comment)), marker),
    );
    this.store.recordPublication({
      marker,
      repoId: input.repo.id,
      kind: "reply",
      githubId: id,
    });
    return { status: "published", id };
  }

  /**
   * Publish one duplicate notice per revision. The case intent exists before
   * this call, and the marker makes retries and crash recovery idempotent.
   */
  async publishDuplicateNotice(input: {
    repo: RepositoryRecord;
    issueNumber: number;
    body: string;
    marker: string;
  }): Promise<DuplicatePublication> {
    return this.publishDuplicateComment({
      ...input,
      kind: "duplicate-notice",
    });
  }

  /**
   * Publish a lifecycle comment with a stable marker. Returns the GitHub
   * timestamp so the caller can arm a deadline only after confirmation.
   */
  async publishDuplicateComment(input: {
    repo: RepositoryRecord;
    issueNumber: number;
    body: string;
    marker: string;
    kind: string;
    requireOpen?: boolean;
  }): Promise<DuplicatePublication> {
    assertNoCredentialMaterial(input.body);
    const octokit = await this.writeClient(input.repo);
    const issue = await this.github.getIssue(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
    );
    if (input.requireOpen !== false && issue.state !== "open") {
      throw new PublishError(
        `Issue #${input.issueNumber} is ${issue.state}; the duplicate comment was not published`,
        true,
      );
    }
    const body = withMarker(
      limitBody(sanitizeModelText(input.body)),
      input.marker,
    );
    const existing = await this.github.listIssueCommentsForMarker(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
    );
    const already = findByMarker(existing, input.marker, this.botLogin);
    if (already) {
      const original = existing.find((comment) => comment.id === already);
      this.store.recordPublication({
        marker: input.marker,
        repoId: input.repo.id,
        kind: input.kind,
        githubId: already,
      });
      return {
        status: "duplicate",
        id: already,
        createdAt: original?.createdAt || this.clock(),
      };
    }
    const created = await this.github.createIssueCommentWithMetadata(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
      body,
    );
    this.store.recordPublication({
      marker: input.marker,
      repoId: input.repo.id,
      kind: input.kind,
      githubId: created.id,
    });
    return { status: "published", id: created.id, createdAt: created.createdAt };
  }

  async closeAsDuplicate(input: {
    repo: RepositoryRecord;
    issueNumber: number;
  }): Promise<void> {
    const octokit = await this.writeClient(input.repo);
    await this.github.closeIssueAsDuplicate(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
    );
  }

  async reopenIssue(input: {
    repo: RepositoryRecord;
    issueNumber: number;
  }): Promise<void> {
    const octokit = await this.writeClient(input.repo);
    await this.github.reopenIssue(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.issueNumber,
    );
  }

  /**
   * Add only the fixed duplicate labels, creating them when absent. Label
   * failure is reported to the caller and must not block the issue workflow.
   */
  async addManagedLabels(input: {
    repo: RepositoryRecord;
    issueNumber: number;
    labels: string[];
  }): Promise<{ applied: string[]; error: string | null }> {
    const applied: string[] = [];
    try {
      const octokit = await this.writeClient(input.repo);
      const issue = await this.github.getIssue(
        octokit,
        input.repo.owner,
        input.repo.name,
        input.issueNumber,
      );
      const before = new Set(issue.labels);
      const existing = new Set(
        await this.github.listRepositoryLabels(
          octokit,
          input.repo.owner,
          input.repo.name,
        ),
      );
      for (const label of input.labels) {
        const definition = LABEL_DEFINITIONS[label];
        if (!definition) continue;
        if (!existing.has(label)) {
          await this.github.createLabel(
            octokit,
            input.repo.owner,
            input.repo.name,
            { name: label, ...definition },
          );
          existing.add(label);
        }
      }
      const available = input.labels.filter((label) => existing.has(label));
      if (available.length > 0) {
        await this.github.addIssueLabels(
          octokit,
          input.repo.owner,
          input.repo.name,
          input.issueNumber,
          available,
        );
        applied.push(...available.filter((label) => !before.has(label)));
        if (applied.length > 0) {
          this.store.addDuplicateAppliedLabels(
            input.repo.id,
            input.issueNumber,
            applied,
          );
        }
      }
      return { applied, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          repo: input.repo.fullName,
          issue: input.issueNumber,
          labels: input.labels,
          error: message,
        },
        "duplicate labels could not be applied; continuing the issue workflow",
      );
      return { applied, error: message };
    }
  }

  /** Remove only labels recorded as Reviewbot-applied. */
  async removeManagedLabels(input: {
    repo: RepositoryRecord;
    issueNumber: number;
    labels: string[];
  }): Promise<{ removed: string[]; error: string | null }> {
    const removed: string[] = [];
    try {
      const octokit = await this.writeClient(input.repo);
      for (const label of input.labels) {
        if (!LABEL_DEFINITIONS[label]) continue;
        await this.github.removeIssueLabel(
          octokit,
          input.repo.owner,
          input.repo.name,
          input.issueNumber,
          label,
        );
        removed.push(label);
      }
      if (removed.length > 0) {
        const record = this.store.getDuplicateCase(
          input.repo.id,
          input.issueNumber,
        );
        if (record) {
          this.store.updateDuplicateCase(
            input.repo.id,
            input.issueNumber,
            {
              botAppliedLabels: record.botAppliedLabels.filter(
                (label) => !removed.includes(label),
              ),
            },
          );
        }
      }
      return { removed, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          repo: input.repo.fullName,
          issue: input.issueNumber,
          labels: input.labels,
          error: message,
        },
        "duplicate labels could not be removed",
      );
      return { removed, error: message };
    }
  }

  async publishFixFailure(input: {    repo: RepositoryRecord;
    payload: FixPayload;
    message: string;
  }): Promise<void> {
    const marker = PublicationMarker.fixError(input.payload.commentId);
    if (this.store.hasPublication(input.repo.id, marker)) return;
    try {
      const octokit = await this.writeClient(input.repo, input.payload.author);
      const reason = redactText(input.message).slice(0, 1500);
      const existingComments =
        input.payload.channel === "review"
          ? await this.github.listReviewCommentsForMarker(
              octokit,
              input.repo.owner,
              input.repo.name,
              input.payload.subjectNumber,
            )
          : await this.github.listIssueCommentsForMarker(
              octokit,
              input.repo.owner,
              input.repo.name,
              input.payload.subjectNumber,
            );
      const already = findByMarker(existingComments, marker, this.botLogin);
      if (already) {
        this.store.recordPublication({
          marker,
          repoId: input.repo.id,
          kind: "fix-error",
          githubId: already,
        });
        return;
      }
      const body = withMarker(
        [
          "Reviewbot could not complete the requested draft pull request workflow.",
          "",
          `Reason: ${sanitizeModelText(reason)}`,
          "",
          "No contributor branch was modified. The failure is also recorded in `reviewbot status` on the Reviewbot host.",
        ].join("\n"),
        marker,
      );
      let id: number;
      if (input.payload.channel === "review") {
        id = await this.github.createReviewCommentReply(
          octokit,
          input.repo.owner,
          input.repo.name,
          input.payload.subjectNumber,
          input.payload.commentId,
          body,
        );
      } else {
        id = await this.github.createIssueComment(
          octokit,
          input.repo.owner,
          input.repo.name,
          input.payload.subjectNumber,
          body,
        );
      }
      this.store.recordPublication({
        marker,
        repoId: input.repo.id,
        kind: "fix-error",
        githubId: id,
      });
    } catch (error) {
      this.logger.warn(
        {
          repo: input.repo.fullName,
          comment: input.payload.commentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "could not publish the implementation failure notice",
      );
    }
  }

  async publishFix(input: {
    repo: RepositoryRecord;
    payload: FixPayload;
    branch: string;
    base: string;
    title: string;
    body: string;
    note: string;
    expectedSha: string;
  }): Promise<{ status: "published" | "duplicate"; number: number; htmlUrl: string }> {
    assertNoCredentialMaterial(input.title, input.body, input.note);
    const prMarker = PublicationMarker.fixPr(input.payload.commentId);
    const octokit = await this.writeClient(
      input.repo,
      input.payload.author,
    );

    const existing = await this.github.findPullByHead(
      octokit,
      input.repo.owner,
      input.repo.name,
      input.branch,
    );
    let pull: { number: number; htmlUrl: string };
    let created = false;
    if (existing) {
      if (
        existing.author !== this.botLogin ||
        existing.headSha !== input.expectedSha
      ) {
        throw new PublishError(
          `Branch ${input.branch} does not match the expected Reviewbot commit`,
          true,
        );
      }
      pull = { number: existing.number, htmlUrl: existing.htmlUrl };
      this.store.recordPublication({
        marker: prMarker,
        repoId: input.repo.id,
        kind: "fix-pr",
        githubId: existing.number,
      });
    } else {
      pull = await this.github.createDraftPull(
        octokit,
        input.repo.owner,
        input.repo.name,
        {
          title: input.title,
          head: input.branch,
          base: input.base,
          body: withMarker(limitBody(sanitizeModelText(input.body)), prMarker),
        },
      );
      created = true;
      this.store.recordPublication({
        marker: prMarker,
        repoId: input.repo.id,
        kind: "fix-pr",
        githubId: pull.number,
      });
    }

    const publishedPull = await this.github.getPull(
      octokit,
      input.repo.owner,
      input.repo.name,
      pull.number,
    );
    if (publishedPull.headSha !== input.expectedSha) {
      throw new PublishError(
        "The draft pull request head does not match the committed change",
        true,
      );
    }

    const noteMarker = PublicationMarker.fix(input.payload.commentId);
    if (!this.store.hasPublication(input.repo.id, noteMarker)) {
      const note = withMarker(
        limitBody(`${sanitizeModelText(input.note)}\n\nDraft pull request: ${pull.htmlUrl}`),
        noteMarker,
      );
      let existingId: number | null = null;
      if (input.payload.channel === "review") {
        const comments = await this.github.listReviewCommentsForMarker(
          octokit,
          input.repo.owner,
          input.repo.name,
          input.payload.subjectNumber,
        );
        existingId = findByMarker(comments, noteMarker, this.botLogin);
        if (existingId == null) {
          existingId = await this.github.createReviewCommentReply(
            octokit,
            input.repo.owner,
            input.repo.name,
            input.payload.subjectNumber,
            input.payload.commentId,
            note,
          );
        }
      } else {
        const comments = await this.github.listIssueCommentsForMarker(
          octokit,
          input.repo.owner,
          input.repo.name,
          input.payload.subjectNumber,
        );
        existingId = findByMarker(comments, noteMarker, this.botLogin);
        if (existingId == null) {
          existingId = await this.github.createIssueComment(
            octokit,
            input.repo.owner,
            input.repo.name,
            input.payload.subjectNumber,
            note,
          );
        }
      }
      this.store.recordPublication({
        marker: noteMarker,
        repoId: input.repo.id,
        kind: "fix-note",
        githubId: existingId,
      });
    }

    return {
      status: created ? "published" : "duplicate",
      number: pull.number,
      htmlUrl: pull.htmlUrl,
    };
  }
}

function findByMarker(
  comments: CommentSummary[],
  marker: string,
  botLogin: string,
): number | null {
  const match = comments.find(
    (comment) => comment.author === botLogin && hasMarker(comment.body, marker),
  );
  return match ? match.id : null;
}

function findByMarkerReview(
  reviews: ReviewSummary[],
  marker: string,
  botLogin: string,
): number | null {
  const match = reviews.find(
    (review) => review.author === botLogin && hasMarker(review.body, marker),
  );
  return match ? match.id : null;
}

function buildReviewBody(
  summary: string,
  summaryFindings: string[],
  marker: string,
): string {
  const sections = [summary.trim()];
  if (summaryFindings.length > 0) {
    sections.push(`### Additional findings\n\n${summaryFindings.join("\n")}`);
  }
  return withMarker(limitBody(sections.join("\n\n")), marker);
}

function assertNoCredentialMaterial(...values: string[]): void {
  const pattern =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/;
  if (values.some((value) => pattern.test(value))) {
    throw new PublishError(
      "Model output contained credential material; publication blocked",
      true,
    );
  }
}

function sanitizeModelText(value: string): string {
  return value.replace(/<!--\s*reviewbot:[^>]*-->/gi, "[reviewbot marker removed]");
}

function limitBody(body: string): string {
  const max = 60_000;
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n\n[truncated by Reviewbot]`;
}

function isUnprocessable(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === 422;
}
