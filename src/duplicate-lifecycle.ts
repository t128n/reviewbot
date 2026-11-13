import { addSeconds, type DuplicateCaseRecord, type RepositoryRecord, type Store } from "./db.ts";
import type {
  CommentSummary,
  GitHub,
  GitHubClient,
  IssueSummary,
} from "./github.ts";
import {
  READ_PERMISSIONS,
  canWriteRepository,
} from "./github.ts";
import type { Publisher } from "./publish.ts";
import { PublishError } from "./publish.ts";
import {
  PublicationMarker,
  type DuplicateReassessment,
  type TriageResult,
} from "./schemas.ts";
import {
  DUPLICATE_LABEL,
  DUPLICATE_WINDOW_SECONDS,
  PENDING_CLOSE_LABEL,
  classificationOf,
  decisionReference,
  duplicateCancellationBody,
  duplicateClosureBody,
  duplicateInvalidCanonicalBody,
  duplicateNoticeBody,
  duplicateReopenBody,
  duplicateRenewalBody,
  duplicateStillDuplicateBody,
  isDuplicateDecision,
  isMaintainerOverride,
  isSubstantiveComment,
  isWindowElapsed,
  readDecisionReference,
  resolveCanonical,
  resolveDuplicateDecision,
  type DecisionResolution,
} from "./duplicates.ts";
import type { Logger } from "./log.ts";

export interface ReassessmentRequest {
  repo: RepositoryRecord;
  issue: IssueSummary;
  canonical: IssueSummary;
  duplicateCase: DuplicateCaseRecord;
  newComments: CommentSummary[];
  discussion: CommentSummary[];
}

export type ReassessmentRunner = (
  request: ReassessmentRequest,
) => Promise<DuplicateReassessment>;

export type LifecycleOutcome =
  | { status: "skipped"; reason: string }
  | {
      status: "triage";
      decision: DecisionResolution["decision"]["kind"];
      downgraded: boolean;
      publication: unknown;
    }
  | { status: "notice"; canonical: number; dueAt: string }
  | { status: "closed"; canonical: number }
  | { status: "cancelled"; reason: string; canonical: number | null }
  | { status: "renewed"; canonical: number; dueAt: string }
  | { status: "reopened"; canonical: number }
  | { status: "explained"; canonical: number }
  | { status: "reconciled"; canonical: number | null; dueAt: string | null };

const MARKER_PATTERN = /<!--\s*reviewbot:/i;

export class DuplicateLifecycle {
  private readonly store: Store;
  private readonly github: GitHub;
  private readonly publisher: Publisher;
  private readonly logger: Logger;
  private readonly botLogin: string;
  private readonly reassess: ReassessmentRunner;
  private readonly clock: () => string;

  constructor(options: {
    store: Store;
    github: GitHub;
    publisher: Publisher;
    logger: Logger;
    botLogin: string;
    reassess: ReassessmentRunner;
    clock?: () => string;
  }) {
    this.store = options.store;
    this.github = options.github;
    this.publisher = options.publisher;
    this.logger = options.logger;
    this.botLogin = options.botLogin;
    this.reassess = options.reassess;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  private async readClient(repo: RepositoryRecord): Promise<GitHubClient> {
    return this.github.installationClient(
      repo.installationId,
      READ_PERMISSIONS,
    );
  }

  private async fetchIssue(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    number: number,
  ): Promise<IssueSummary | null> {
    try {
      return await this.github.getIssue(
        octokit,
        repo.owner,
        repo.name,
        number,
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) return null;
      throw error;
    }
  }

  private async commentsFor(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    number: number,
  ): Promise<CommentSummary[]> {
    return this.github.listIssueCommentsForMarker(
      octokit,
      repo.owner,
      repo.name,
      number,
    );
  }

  private humanComments(comments: CommentSummary[]): CommentSummary[] {
    return comments.filter(
      (comment) =>
        comment.author !== this.botLogin && !MARKER_PATTERN.test(comment.body),
    );
  }

  private commentsSinceNotice(
    comments: CommentSummary[],
    record: DuplicateCaseRecord,
  ): CommentSummary[] {
    const noticeAt = record.noticePostedAt ? Date.parse(record.noticePostedAt) : 0;
    const checkpoint = record.lastCheckedCommentId ?? 0;
    return this.humanComments(comments).filter((comment) => {
      const created = Date.parse(comment.createdAt);
      return (
        (!Number.isFinite(created) || created >= noticeAt) &&
        comment.id > checkpoint
      );
    });
  }

  /**
   * Publish the duplicate notice and arm the deadline. The notice text is
   * already durable in the case intent, so a retry republishes the same marker.
   */
  private async publishNoticeAndArm(input: {
    repo: RepositoryRecord;
    record: DuplicateCaseRecord;
    canonical: number;
    classification: "confirmed" | "likely";
    noticeBody: string;
    reference: string;
  }): Promise<LifecycleOutcome> {
    const { repo, record } = input;
    const marker = PublicationMarker.duplicateNotice(
      record.issueNumber,
      record.noticeRevision,
    );
    const publication = await this.publisher.publishDuplicateNotice({
      repo,
      issueNumber: record.issueNumber,
      body: input.noticeBody,
      marker,
    });
    const dueAt = addSeconds(publication.createdAt, DUPLICATE_WINDOW_SECONDS);
    this.store.updateDuplicateCase(repo.id, record.issueNumber, {
      status: "pending",
      canonicalIssueNumber: input.canonical,
      classification: input.classification,
      noticeCommentId: publication.id,
      noticePostedAt: publication.createdAt,
      dueAt,
      lastDecisionReference: input.reference,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    });
    const labels = await this.publisher.addManagedLabels({
      repo,
      issueNumber: record.issueNumber,
      labels: [PENDING_CLOSE_LABEL],
    });
    if (labels.applied.length > 0) {
      this.store.addDuplicateAppliedLabels(
        repo.id,
        record.issueNumber,
        labels.applied,
      );
    }
    if (labels.error) {
      this.store.updateDuplicateCase(repo.id, record.issueNumber, {
        lastError: `label: ${labels.error}`,
      });
    }
    this.logger.info(
      {
        repo: repo.fullName,
        issue: record.issueNumber,
        canonical: input.canonical,
        dueAt,
      },
      "duplicate notice published and closure scheduled",
    );
    return { status: "notice", canonical: input.canonical, dueAt };
  }

  /**
   * Apply a validated triage decision. Ordinary triage keeps v1.0 behavior;
   * only a verified confirmed/likely duplicate starts the lifecycle.
   */
  async completeTriage(input: {
    repo: RepositoryRecord;
    octokit: GitHubClient;
    current: IssueSummary;
    result: TriageResult;
    bodyText: string;
  }): Promise<LifecycleOutcome> {
    const { repo, octokit, current, result } = input;
    const existing = this.store.getDuplicateCase(repo.id, current.number);
    if (existing) {
      if (existing.status === "notice_pending") {
        return this.reconcileNotice(repo, existing);
      }
      return {
        status: "skipped",
        reason: `a duplicate case already exists in state ${existing.status}`,
      };
    }
    const resolved = await resolveDuplicateDecision({
      decision: result.duplicate,
      current,
      bodyText: input.bodyText,
      owner: repo.owner,
      repo: repo.name,
      lookup: {
        getIssue: (number) =>
          this.fetchIssue(repo, octokit, number),
        getCase: (number) =>
          this.store.getDuplicateCase(repo.id, number),
      },
    });

    if (!isDuplicateDecision(resolved.decision) || !resolved.canonical) {
      const comment = resolved.downgraded
        ? resolved.rationale
        : result.comment;
      const publication = await this.publisher.publishTriage({
        repo,
        issueNumber: current.number,
        comment,
      });
      return {
        status: "triage",
        decision: resolved.decision.kind,
        downgraded: resolved.downgraded,
        publication,
      };
    }

    const canonical = resolved.canonical;
    const classification = classificationOf(resolved.decision);
    const noticeBody = duplicateNoticeBody({
      comment: result.comment,
      canonical: canonical.number,
      classification,
      question:
        "distinguishingQuestion" in resolved.decision
          ? resolved.decision.distinguishingQuestion
          : undefined,
    });
    const reference = decisionReference({
      decision: resolved.decision,
      noticeComment: noticeBody,
      resolvedCanonical: canonical.number,
      revision: 1,
    });
    const record = this.store.createDuplicateCase({
      repoId: repo.id,
      issueNumber: current.number,
      canonicalIssueNumber: canonical.number,
      classification,
      lastDecisionReference: reference,
    });
    if (record.status !== "notice_pending") {
      return {
        status: "skipped",
        reason: `a duplicate case already exists in state ${record.status}`,
      };
    }
    return this.publishNoticeAndArm({
      repo,
      record,
      canonical: canonical.number,
      classification,
      noticeBody,
      reference,
    });
  }

  /** Reconcile an intent that was persisted but never confirmed as published. */
  async reconcileNotice(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
  ): Promise<LifecycleOutcome> {
    if (record.status !== "notice_pending") {
      return { status: "skipped", reason: `case is ${record.status}` };
    }
    const stored = readDecisionReference(record.lastDecisionReference);
    const canonicalNumber =
      record.canonicalIssueNumber ?? stored.canonicalIssueNumber;
    if (!stored.noticeComment || !canonicalNumber) {
      this.store.updateDuplicateCase(repo.id, record.issueNumber, {
        status: "cancelled",
        lastError: "notice intent was incomplete and could not be reconciled",
      });
      return {
        status: "cancelled",
        reason: "incomplete notice intent",
        canonical: canonicalNumber,
      };
    }
    const octokit = await this.readClient(repo);
    const issue = await this.fetchIssue(repo, octokit, record.issueNumber);
    if (!issue || issue.state !== "open") {
      this.store.updateDuplicateCase(repo.id, record.issueNumber, {
        status: "cancelled",
        lastError: "issue is no longer open",
      });
      return {
        status: "cancelled",
        reason: "issue is no longer open",
        canonical: canonicalNumber,
      };
    }
    const canonical = await this.fetchIssue(repo, octokit, canonicalNumber);
    if (!canonical || canonical.isPullRequest) {
      this.store.updateDuplicateCase(repo.id, record.issueNumber, {
        status: "cancelled",
        lastError: `canonical issue #${canonicalNumber} is unavailable`,
      });
      return {
        status: "cancelled",
        reason: "canonical issue is unavailable",
        canonical: canonicalNumber,
      };
    }
    return this.publishNoticeAndArm({
      repo,
      record,
      canonical: canonicalNumber,
      classification: record.classification,
      noticeBody: stored.noticeComment,
      reference: record.lastDecisionReference ?? "",
    });
  }

  /**
   * Deadline processing. All GitHub state is re-read; cached SQLite state alone
   * never authorizes closure.
   */
  async processDue(
    repo: RepositoryRecord,
    issueNumber: number,
    now = this.clock(),
  ): Promise<LifecycleOutcome> {
    const record = this.store.getDuplicateCase(repo.id, issueNumber);
    if (!record) return { status: "skipped", reason: "no duplicate case" };
    if (record.status === "notice_pending") {
      return this.reconcileNotice(repo, record);
    }
    if (record.status !== "pending") {
      return { status: "skipped", reason: `case is ${record.status}` };
    }
    if (!isWindowElapsed(record.dueAt, now)) {
      return { status: "skipped", reason: "the 24-hour window has not elapsed" };
    }
    const octokit = await this.readClient(repo);
    const issue = await this.fetchIssue(repo, octokit, issueNumber);
    if (!issue) {
      return this.cancelCase(repo, record, "issue is inaccessible", true);
    }
    if (issue.state !== "open") {
      if (issue.state === "closed" && issue.stateReason === "duplicate") {
        const comments = await this.commentsFor(repo, octokit, issueNumber);
        if (
          comments.some(
            (comment) =>
              comment.author === this.botLogin &&
              comment.body.includes(
                PublicationMarker.duplicateClosure(
                  issueNumber,
                  record.noticeRevision,
                ),
              ),
          )
        ) {
          return this.finalizeClosed(repo, record);
        }
      }
      return this.cancelCase(
        repo,
        record,
        `issue is ${issue.state}; a human state change invalidates the case`,
      );
    }
    const canonicalNumber = record.canonicalIssueNumber;
    if (!canonicalNumber || canonicalNumber === issueNumber) {
      return this.cancelCase(repo, record, "canonical reference is invalid", true);
    }
    const canonical = await this.fetchIssue(repo, octokit, canonicalNumber);
    if (!canonical || canonical.isPullRequest) {
      await this.publishDuplicateCommentSafely(repo, issueNumber, {
        body: duplicateInvalidCanonicalBody(),
        marker: PublicationMarker.duplicateComment(
          issueNumber,
          `invalid-canonical-${record.noticeRevision}`,
        ),
        kind: "duplicate-invalid-canonical",
      });
      return this.cancelCase(
        repo,
        record,
        `canonical issue #${canonicalNumber} is unavailable`,
        true,
      );
    }

    // The canonical relationship may have changed since the notice. Re-resolve
    // verified chains; never close onto a stale duplicate placeholder.
    const resolved = await resolveCanonical({
      currentNumber: issueNumber,
      proposedNumber: canonicalNumber,
      lookup: {
        getIssue: (number) => this.fetchIssue(repo, octokit, number),
        getCase: (number) => this.store.getDuplicateCase(repo.id, number),
      },
    });
    if (!resolved.canonical) {
      return this.cancelCase(
        repo,
        record,
        resolved.error ?? "canonical relationship could not be verified",
        true,
      );
    }
    if (resolved.canonical.number !== canonicalNumber) {
      return this.renewCanonicalReference(
        repo,
        record,
        resolved.canonical.number,
      );
    }

    const comments = await this.commentsFor(repo, octokit, issueNumber);
    const fresh = this.commentsSinceNotice(comments, record);
    const newest = fresh.reduce(
      (max, comment) => Math.max(max, comment.id),
      record.lastCheckedCommentId ?? 0,
    );

    const override = await this.findMaintainerOverride(
      repo,
      octokit,
      fresh,
    );
    if (override) {
      return this.cancelCase(
        repo,
        record,
        `maintainer override in comment ${override.id}`,
      );
    }

    const substantive = await this.filterSubstantive(
      repo,
      octokit,
      issue,
      fresh,
    );
    if (substantive.length > 0) {
      const reassessment = await this.reassess({
        repo,
        issue,
        canonical,
        duplicateCase: record,
        newComments: substantive,
        discussion: this.humanComments(comments),
      });
      return this.applyReassessment({
        repo,
        record,
        issue,
        canonical,
        reassessment,
        newestCommentId: newest,
        recentComments: comments,
      });
    }

    await this.publishDuplicateCommentSafely(repo, issueNumber, {
      body: duplicateClosureBody(canonicalNumber),
      marker: PublicationMarker.duplicateClosure(
        issueNumber,
        record.noticeRevision,
      ),
      kind: "duplicate-close",
    });
    await this.publisher.closeAsDuplicate({ repo, issueNumber });

    const confirmed = await this.fetchIssue(repo, octokit, issueNumber);
    if (
      !confirmed ||
      confirmed.state !== "closed" ||
      confirmed.stateReason !== "duplicate"
    ) {
      throw new PublishError(
        `Issue #${issueNumber} did not close with the duplicate state reason`,
        false,
      );
    }

    const removal = await this.publisher.removeManagedLabels({
      repo,
      issueNumber,
      labels: record.botAppliedLabels.includes(PENDING_CLOSE_LABEL)
        ? [PENDING_CLOSE_LABEL]
        : [],
    });
    const addition = await this.publisher.addManagedLabels({
      repo,
      issueNumber,
      labels: [DUPLICATE_LABEL],
    });
    const applied = [
      ...record.botAppliedLabels.filter(
        (label) => !removal.removed.includes(label),
      ),
      ...addition.applied,
    ];
    this.store.updateDuplicateCase(repo.id, issueNumber, {
      status: "closed",
      botClosed: true,
      botAppliedLabels: applied,
      lastCheckedCommentId: newest,
      lastError: removal.error ?? addition.error ?? null,
    });
    this.logger.info(
      { repo: repo.fullName, issue: issueNumber, canonical: canonicalNumber },
      "duplicate issue closed",
    );
    return { status: "closed", canonical: canonicalNumber };
  }

  /**
   * React to a duplicate-only follow-up comment without requiring a command.
   * Authorization is checked here again; the poller's check is advisory.
   */
  async processComment(input: {
    repo: RepositoryRecord;
    issueNumber: number;
    commentId: number;
    author: string;
    body: string;
    now?: string;
  }): Promise<LifecycleOutcome> {
    const { repo, issueNumber, author, body } = input;
    const record = this.store.getDuplicateCase(repo.id, issueNumber);
    if (!record) return { status: "skipped", reason: "no duplicate case" };
    if (record.status === "notice_pending") {
      return this.reconcileNotice(repo, record);
    }
    if (record.status !== "pending" && record.status !== "closed") {
      return { status: "skipped", reason: `case is ${record.status}` };
    }
    if (record.status === "closed" && !record.botClosed) {
      return {
        status: "skipped",
        reason: "the issue was not closed by Reviewbot",
      };
    }
    const octokit = await this.readClient(repo);
    const issue = await this.fetchIssue(repo, octokit, issueNumber);
    if (!issue) return { status: "skipped", reason: "issue is inaccessible" };
    const comments = await this.commentsFor(repo, octokit, issueNumber);

    // Recover an interrupted transition before trusting the comment checkpoint.
    if (record.status === "closed" && record.botClosed) {
      if (this.hasReopenMarker(comments, issueNumber)) {
        if (issue.state === "open") {
          return this.finalizeReopened(repo, record);
        }
        if (issue.stateReason !== "duplicate") {
          this.store.updateDuplicateCase(repo.id, issueNumber, {
            status: "cancelled",
            botClosed: false,
            lastError: "the issue is no longer a bot-closed duplicate",
          });
          return {
            status: "cancelled",
            reason: "the issue is no longer a bot-closed duplicate",
            canonical: record.canonicalIssueNumber,
          };
        }
        await this.publisher.reopenIssue({ repo, issueNumber });
        const reopened = await this.fetchIssue(repo, octokit, issueNumber);
        if (!reopened || reopened.state !== "open") {
          throw new PublishError(
            `Issue #${issueNumber} could not be reopened`,
            false,
          );
        }
        this.logger.info(
          { repo: repo.fullName, issue: issueNumber },
          "completed a recovered duplicate reopen",
        );
        return this.finalizeReopened(repo, record);
      }
      if (issue.state === "open") {
        this.store.updateDuplicateCase(repo.id, issueNumber, {
          status: "cancelled",
          botClosed: false,
          lastError: "a human reopened the issue",
        });
        return {
          status: "cancelled",
          reason: "a human reopened the issue",
          canonical: record.canonicalIssueNumber,
        };
      }
      if (issue.stateReason !== "duplicate") {
        this.store.updateDuplicateCase(repo.id, issueNumber, {
          status: "cancelled",
          botClosed: false,
          lastError: "the issue is no longer a bot-closed duplicate",
        });
        return {
          status: "cancelled",
          reason: "the issue is no longer a bot-closed duplicate",
          canonical: record.canonicalIssueNumber,
        };
      }
    }

    if (record.status === "pending") {
      if (issue.state !== "open") {
        if (
          issue.state === "closed" &&
          issue.stateReason === "duplicate" &&
          this.hasClosureMarker(comments, issueNumber, record.noticeRevision)
        ) {
          return this.finalizeClosed(repo, record);
        }
        return this.cancelCase(
          repo,
          record,
          `issue is ${issue.state}; a human state change invalidates the case`,
        );
      }
      if (this.hasCancelMarker(comments, issueNumber)) {
        return this.cancelCase(
          repo,
          record,
          "recovered an interrupted duplicate cancellation",
        );
      }
    }

    if (record.lastCheckedCommentId != null && input.commentId <= record.lastCheckedCommentId) {
      return { status: "skipped", reason: "comment already assessed" };
    }

    const permission = (
      await this.github.repositoryPermission(
        octokit,
        repo.owner,
        repo.name,
        author,
      )
    ).permission;
    const collaborator = canWriteRepository(permission);
    if (author !== issue.author && !collaborator) {
      return {
        status: "skipped",
        reason: "the commenter is neither the reporter nor a write-access collaborator",
      };
    }

    if (record.status === "closed" && collaborator && isMaintainerOverride(body)) {
      return this.reopenAfterOverride(
        repo,
        record,
        issue,
        input.commentId,
      );
    }

    if (!isSubstantiveComment(body) && !isMaintainerOverride(body)) {
      this.store.updateDuplicateCase(repo.id, issueNumber, {
        lastCheckedCommentId: input.commentId,
      });
      return { status: "skipped", reason: "comment is not substantive" };
    }

    const canonicalNumber = record.canonicalIssueNumber;
    if (!canonicalNumber) {
      return this.cancelCase(repo, record, "canonical reference is missing", true);
    }
    const canonical = await this.fetchIssue(repo, octokit, canonicalNumber);
    if (!canonical || canonical.isPullRequest) {
      return this.cancelCase(
        repo,
        record,
        `canonical issue #${canonicalNumber} is unavailable`,
        true,
      );
    }

    const newComments = this.humanComments(
      comments.filter(
        (comment) =>
          comment.id >= input.commentId &&
          (!record.noticePostedAt ||
            Date.parse(comment.createdAt) >= Date.parse(record.noticePostedAt)),
      ),
    );
    const newest = newComments.reduce(
      (max, comment) => Math.max(max, comment.id),
      input.commentId,
    );

    if (isMaintainerOverride(body)) {
      return this.cancelCase(
        repo,
        record,
        `maintainer override in comment ${input.commentId}`,
      );
    }

    const reassessment = await this.reassess({
      repo,
      issue,
      canonical,
      duplicateCase: record,
      newComments:
        newComments.length > 0
          ? newComments
          : [
              {
                id: input.commentId,
                body,
                author,
                authorType: "User",
                createdAt: this.clock(),
                updatedAt: this.clock(),
                issueNumber,
                htmlUrl: "",
                path: null,
                line: null,
                originalLine: null,
                diffHunk: null,
                inReplyToId: null,
              },
            ],
      discussion: this.humanComments(comments),
    });
    return this.applyReassessment({
      repo,
      record,
      issue,
      canonical,
      reassessment,
      newestCommentId: newest,
      recentComments: comments,
    });
  }

  private async applyReassessment(input: {
    repo: RepositoryRecord;
    record: DuplicateCaseRecord;
    issue: IssueSummary;
    canonical: IssueSummary;
    reassessment: DuplicateReassessment;
    newestCommentId: number;
    recentComments: CommentSummary[];
  }): Promise<LifecycleOutcome> {
    const { repo, record, issue, canonical, reassessment } = input;
    const canonicalNumber = canonical.number;

    if (record.status === "pending") {
      if (reassessment.outcome === "distinct" || reassessment.outcome === "uncertain") {
        await this.publishDuplicateCommentSafely(repo, issue.number, {
          body: duplicateCancellationBody({
            comment: reassessment.comment,
            canonical: canonicalNumber,
          }),
          marker: PublicationMarker.duplicateComment(
            issue.number,
            `cancel-${input.newestCommentId}`,
          ),
          kind: "duplicate-cancel",
        });
        const outcome = await this.cancelCase(
          repo,
          record,
          reassessment.outcome === "distinct"
            ? reassessment.reason
            : `reassessment was uncertain: ${reassessment.reason}`,
        );
        this.store.updateDuplicateCase(repo.id, issue.number, {
          lastCheckedCommentId: input.newestCommentId,
        });
        return outcome;
      }
      return this.renewDeadline(
        repo,
        record,
        canonicalNumber,
        reassessment,
        input.newestCommentId,
      );
    }

    if (record.status === "closed") {
      if (issue.state === "open") {
        if (this.hasReopenMarker(input.recentComments, issue.number)) {
          return this.finalizeReopened(repo, record);
        }
        this.store.updateDuplicateCase(repo.id, issue.number, {
          status: "cancelled",
          botClosed: false,
          lastCheckedCommentId: input.newestCommentId,
          lastError: "a human reopened the issue",
        });
        return {
          status: "cancelled",
          reason: "a human reopened the issue",
          canonical: canonicalNumber,
        };
      }
      if (issue.stateReason !== "duplicate") {
        this.store.updateDuplicateCase(repo.id, issue.number, {
          status: "cancelled",
          botClosed: false,
          lastCheckedCommentId: input.newestCommentId,
          lastError: "the issue is no longer a bot-closed duplicate",
        });
        return {
          status: "cancelled",
          reason: "the issue is no longer a bot-closed duplicate",
          canonical: canonicalNumber,
        };
      }
      if (reassessment.outcome === "distinct") {
        const fresh = await this.fetchIssue(
          repo,
          await this.readClient(repo),
          issue.number,
        );
        if (
          !fresh ||
          fresh.state !== "closed" ||
          fresh.stateReason !== "duplicate"
        ) {
          this.store.updateDuplicateCase(repo.id, issue.number, {
            status: "cancelled",
            botClosed: false,
            lastCheckedCommentId: input.newestCommentId,
            lastError: "the issue is no longer a bot-closed duplicate",
          });
          return {
            status: "cancelled",
            reason: "the issue is no longer a bot-closed duplicate",
            canonical: canonicalNumber,
          };
        }
        await this.publishDuplicateCommentSafely(repo, issue.number, {
          body: duplicateReopenBody({
            comment: reassessment.comment,
            canonical: canonicalNumber,
          }),
          marker: PublicationMarker.duplicateComment(
            issue.number,
            `reopen-${input.newestCommentId}`,
          ),
          kind: "duplicate-reopen",
        });
        await this.publisher.reopenIssue({
          repo,
          issueNumber: issue.number,
        });
        const reopened = await this.fetchIssue(
          repo,
          await this.readClient(repo),
          issue.number,
        );
        if (!reopened || reopened.state !== "open") {
          throw new PublishError(
            `Issue #${issue.number} could not be reopened`,
            false,
          );
        }
        const removal = await this.publisher.removeManagedLabels({
          repo,
          issueNumber: issue.number,
          labels: record.botAppliedLabels.filter(
            (label) => label === DUPLICATE_LABEL,
          ),
        });
        this.store.updateDuplicateCase(repo.id, issue.number, {
          status: "reopened",
          botClosed: false,
          botAppliedLabels: record.botAppliedLabels.filter(
            (label) => !removal.removed.includes(label),
          ),
          lastCheckedCommentId: input.newestCommentId,
          lastError: removal.error ?? null,
        });
        this.logger.info(
          { repo: repo.fullName, issue: issue.number, canonical: canonicalNumber },
          "bot-closed duplicate reopened after distinguishing evidence",
        );
        return { status: "reopened", canonical: canonicalNumber };
      }
      if (reassessment.outcome === "still_duplicate") {
        if (record.followupExplained) {
          this.store.updateDuplicateCase(repo.id, issue.number, {
            lastCheckedCommentId: input.newestCommentId,
          });
          return {
            status: "explained",
            canonical: canonicalNumber,
          };
        }
        await this.publishDuplicateCommentSafely(repo, issue.number, {
          body: duplicateStillDuplicateBody({
            comment: reassessment.comment,
            canonical: canonicalNumber,
          }),
          marker: PublicationMarker.duplicateComment(
            issue.number,
            "followup",
          ),
          kind: "duplicate-followup",
        });
        this.store.updateDuplicateCase(repo.id, issue.number, {
          followupExplained: true,
          lastCheckedCommentId: input.newestCommentId,
        });
        return { status: "explained", canonical: canonicalNumber };
      }
      this.store.updateDuplicateCase(repo.id, issue.number, {
        lastCheckedCommentId: input.newestCommentId,
      });
      return { status: "skipped", reason: "reassessment was uncertain" };
    }

    return { status: "skipped", reason: `case is ${record.status}` };
  }

  /**
   * The verified original moved. Publish a fresh notice and give the reporter a
   * new window instead of closing against the old target.
   */
  private async renewCanonicalReference(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
    canonical: number,
  ): Promise<LifecycleOutcome> {
    const revision = record.noticeRevision + 1;
    const noticeBody = [
      `The original report now points to #${canonical}, so I'm updating the duplicate reference.`,
      "",
      `I'll close this as a duplicate of #${canonical} in 24 hours unless you reply with a material difference. Please follow #${canonical} for updates.`,
    ].join("\n");
    this.store.updateDuplicateCase(repo.id, record.issueNumber, {
      status: "notice_pending",
      canonicalIssueNumber: canonical,
      noticeRevision: revision,
      lastDecisionReference: JSON.stringify({
        kind: `${record.classification}_duplicate`,
        reason: "the verified duplicate chain moved to a different original",
        canonicalIssueNumber: canonical,
        noticeComment: noticeBody,
        revision,
      }),
      lastError: null,
    });
    const updated = this.store.getDuplicateCase(repo.id, record.issueNumber)!;
    return this.publishNoticeAndArm({
      repo,
      record: updated,
      canonical,
      classification: record.classification,
      noticeBody,
      reference: updated.lastDecisionReference ?? "",
    });
  }

  private async renewDeadline(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
    canonical: number,
    reassessment: DuplicateReassessment,
    newestCommentId: number,
  ): Promise<LifecycleOutcome> {
    const revision = record.noticeRevision + 1;
    const noticeBody = duplicateRenewalBody({
      comment: reassessment.comment,
      canonical,
      classification: record.classification,
    });
    this.store.updateDuplicateCase(repo.id, record.issueNumber, {
      status: "notice_pending",
      noticeRevision: revision,
      lastCheckedCommentId: newestCommentId,
      lastDecisionReference: JSON.stringify({
        kind: `${record.classification}_duplicate`,
        reason: reassessment.reason,
        canonicalIssueNumber: canonical,
        noticeComment: noticeBody,
        revision,
      }),
      lastError: null,
    });
    const updated = this.store.getDuplicateCase(repo.id, record.issueNumber)!;
    return this.publishNoticeAndArm({
      repo,
      record: updated,
      canonical,
      classification: record.classification,
      noticeBody,
      reference: updated.lastDecisionReference ?? "",
    });
  }

  /** Cancel the workflow conservatively and leave the issue open. */
  private async cancelCase(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
    reason: string,
    diagnostic = false,
  ): Promise<LifecycleOutcome> {
    const removal = await this.publisher.removeManagedLabels({
      repo,
      issueNumber: record.issueNumber,
      labels: record.botAppliedLabels.includes(PENDING_CLOSE_LABEL)
        ? [PENDING_CLOSE_LABEL]
        : [],
    });
    this.store.updateDuplicateCase(repo.id, record.issueNumber, {
      status: "cancelled",
      botClosed: false,
      botAppliedLabels: record.botAppliedLabels.filter(
        (label) => !removal.removed.includes(label),
      ),
      ...(diagnostic ? { lastError: reason } : {}),
    });
    this.logger.info(
      { repo: repo.fullName, issue: record.issueNumber, reason },
      "duplicate case cancelled",
    );
    return {
      status: "cancelled",
      reason,
      canonical: record.canonicalIssueNumber,
    };
  }

  private async publishDuplicateCommentSafely(
    repo: RepositoryRecord,
    issueNumber: number,
    input: { body: string; marker: string; kind: string },
  ): Promise<void> {
    try {
      await this.publisher.publishDuplicateComment({
        repo,
        issueNumber,
        body: input.body,
        marker: input.marker,
        kind: input.kind,
        requireOpen:
          input.kind === "duplicate-notice" ||
          input.kind === "duplicate-close" ||
          input.kind === "duplicate-cancel",
      });
    } catch (error) {
      this.logger.warn(
        {
          repo: repo.fullName,
          issue: issueNumber,
          error: error instanceof Error ? error.message : String(error),
        },
        "duplicate lifecycle comment could not be published",
      );
      throw error;
    }
  }

  private hasReopenMarker(
    comments: CommentSummary[],
    issueNumber: number,
  ): boolean {
    const prefix = `<!-- reviewbot:duplicate-comment:${issueNumber}:`;
    return comments.some(
      (comment) =>
        comment.author === this.botLogin &&
        (comment.body.includes(`${prefix}reopen-`) ||
          comment.body.includes(`${prefix}override-reopen-`)),
    );
  }

  private hasCancelMarker(
    comments: CommentSummary[],
    issueNumber: number,
  ): boolean {
    const marker = `<!-- reviewbot:duplicate-comment:${issueNumber}:cancel-`;
    return comments.some(
      (comment) =>
        comment.author === this.botLogin && comment.body.includes(marker),
    );
  }

  private hasClosureMarker(
    comments: CommentSummary[],
    issueNumber: number,
    revision: number,
  ): boolean {
    const marker = PublicationMarker.duplicateClosure(issueNumber, revision);
    return comments.some(
      (comment) =>
        comment.author === this.botLogin && comment.body.includes(marker),
    );
  }

  private async finalizeClosed(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
  ): Promise<LifecycleOutcome> {
    const removal = await this.publisher.removeManagedLabels({
      repo,
      issueNumber: record.issueNumber,
      labels: record.botAppliedLabels.includes(PENDING_CLOSE_LABEL)
        ? [PENDING_CLOSE_LABEL]
        : [],
    });
    const addition = await this.publisher.addManagedLabels({
      repo,
      issueNumber: record.issueNumber,
      labels: [DUPLICATE_LABEL],
    });
    const applied = [
      ...record.botAppliedLabels.filter(
        (label) => !removal.removed.includes(label),
      ),
      ...addition.applied,
    ];
    this.store.updateDuplicateCase(repo.id, record.issueNumber, {
      status: "closed",
      botClosed: true,
      botAppliedLabels: applied,
      lastError: removal.error ?? addition.error ?? null,
    });
    return {
      status: "closed",
      canonical: record.canonicalIssueNumber ?? 0,
    };
  }

  /** A maintainer override on a bot-closed duplicate wins: reopen once. */
  private async reopenAfterOverride(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
    issue: IssueSummary,
    commentId: number,
  ): Promise<LifecycleOutcome> {
    await this.publishDuplicateCommentSafely(repo, issue.number, {
      body: `A maintainer asked to keep this issue open.\n\nI've reopened it and removed the duplicate classification.`,
      marker: PublicationMarker.duplicateComment(
        issue.number,
        `override-reopen-${commentId}`,
      ),
      kind: "duplicate-override-reopen",
    });
    const fresh = await this.fetchIssue(
      repo,
      await this.readClient(repo),
      issue.number,
    );
    if (!fresh) {
      return { status: "skipped", reason: "issue is inaccessible" };
    }
    if (fresh.state !== "open") {
      await this.publisher.reopenIssue({
        repo,
        issueNumber: issue.number,
      });
      const reopened = await this.fetchIssue(
        repo,
        await this.readClient(repo),
        issue.number,
      );
      if (!reopened || reopened.state !== "open") {
        throw new PublishError(
          `Issue #${issue.number} could not be reopened`,
          false,
        );
      }
    }
    const removal = await this.publisher.removeManagedLabels({
      repo,
      issueNumber: issue.number,
      labels: record.botAppliedLabels.filter(
        (label) => label === DUPLICATE_LABEL,
      ),
    });
    this.store.updateDuplicateCase(repo.id, issue.number, {
      status: "reopened",
      botClosed: false,
      botAppliedLabels: record.botAppliedLabels.filter(
        (label) => !removal.removed.includes(label),
      ),
      lastCheckedCommentId: commentId,
      lastError: removal.error ?? null,
    });
    this.logger.info(
      { repo: repo.fullName, issue: issue.number },
      "duplicate reopened after a maintainer override",
    );
    return {
      status: "reopened",
      canonical: record.canonicalIssueNumber ?? 0,
    };
  }

  private async finalizeReopened(
    repo: RepositoryRecord,
    record: DuplicateCaseRecord,
  ): Promise<LifecycleOutcome> {    const removal = await this.publisher.removeManagedLabels({
      repo,
      issueNumber: record.issueNumber,
      labels: record.botAppliedLabels.filter(
        (label) => label === DUPLICATE_LABEL,
      ),
    });
    this.store.updateDuplicateCase(repo.id, record.issueNumber, {
      status: "reopened",
      botClosed: false,
      botAppliedLabels: record.botAppliedLabels.filter(
        (label) => !removal.removed.includes(label),
      ),
      lastError: removal.error ?? null,
    });
    return {
      status: "reopened",
      canonical: record.canonicalIssueNumber ?? 0,
    };
  }

  private async findMaintainerOverride(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    comments: CommentSummary[],
  ): Promise<CommentSummary | null> {
    for (const comment of comments) {
      if (!isMaintainerOverride(comment.body)) continue;
      const permission = await this.github.repositoryPermission(
        octokit,
        repo.owner,
        repo.name,
        comment.author,
      );
      if (canWriteRepository(permission.permission)) return comment;
    }
    return null;
  }

  private async filterSubstantive(
    repo: RepositoryRecord,
    octokit: GitHubClient,
    issue: IssueSummary,
    comments: CommentSummary[],
  ): Promise<CommentSummary[]> {
    const selected: CommentSummary[] = [];
    for (const comment of comments) {
      if (!isSubstantiveComment(comment.body) && !isMaintainerOverride(comment.body)) {
        continue;
      }
      if (comment.author === issue.author) {
        selected.push(comment);
        continue;
      }
      const permission = await this.github.repositoryPermission(
        octokit,
        repo.owner,
        repo.name,
        comment.author,
      );
      if (canWriteRepository(permission.permission)) selected.push(comment);
    }
    return selected;
  }
}
