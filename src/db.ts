import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { ensureParent } from "./paths.ts";

export type JobKind =
  | "triage"
  | "review"
  | "conversation"
  | "fix"
  | "duplicate-due"
  | "duplicate-comment";
export type JobState = "queued" | "running" | "completed" | "failed";

export type DuplicateCaseStatus =
  | "notice_pending"
  | "pending"
  | "closed"
  | "cancelled"
  | "reopened";
export type DuplicateClassification = "confirmed" | "likely";

export interface DuplicateCaseRecord {
  repoId: number;
  issueNumber: number;
  canonicalIssueNumber: number | null;
  classification: DuplicateClassification;
  status: DuplicateCaseStatus;
  noticeCommentId: number | null;
  noticeRevision: number;
  noticePostedAt: string | null;
  dueAt: string | null;
  lastCheckedCommentId: number | null;
  lastDecisionReference: string | null;
  botClosed: boolean;
  botAppliedLabels: string[];
  followupExplained: boolean;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface DuplicateCasePatch {
  canonicalIssueNumber?: number | null;
  classification?: DuplicateClassification;
  status?: DuplicateCaseStatus;
  noticeCommentId?: number | null;
  noticeRevision?: number;
  noticePostedAt?: string | null;
  dueAt?: string | null;
  lastCheckedCommentId?: number | null;
  lastDecisionReference?: string | null;
  botClosed?: boolean;
  botAppliedLabels?: string[];
  followupExplained?: boolean;
  attempts?: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
}

export interface InstallationRecord {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  updatedAt: string;
}

export interface RepositoryRecord {
  id: number;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  initializedAt: string;
  issuesCursor: string;
  pullsCursor: string;
  pullsEtag: string | null;
  commentsCursor: string;
  reviewCommentsCursor: string;
  active: boolean;
  lastPollAt: string | null;
  lastPollError: string | null;
}

export interface PullStateRecord {
  repoId: number;
  number: number;
  draft: boolean;
  headSha: string;
  lastReviewedSha: string | null;
  updatedAt: string;
}

export interface JobRecord {
  id: number;
  key: string;
  kind: JobKind;
  repoId: number;
  payload: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: string | null;
}

export interface EnqueueJobInput {
  key: string;
  kind: JobKind;
  repoId: number;
  payload: unknown;
  runAfter?: string;
  maxAttempts?: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") ensureParent(path);
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows ACLs are managed separately; the data directory is user-local.
      }
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS installations (
        id INTEGER PRIMARY KEY,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL,
        suspended INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id INTEGER PRIMARY KEY,
        installation_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        initialized_at TEXT NOT NULL,
        issues_cursor TEXT NOT NULL,
        pulls_cursor TEXT NOT NULL,
        pulls_etag TEXT,
        comments_cursor TEXT NOT NULL,
        review_comments_cursor TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_poll_at TEXT,
        last_poll_error TEXT
      );

      CREATE TABLE IF NOT EXISTS pull_state (
        repo_id INTEGER NOT NULL,
        number INTEGER NOT NULL,
        draft INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        last_reviewed_sha TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, number)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        repo_id INTEGER NOT NULL,
        subject_type TEXT NOT NULL,
        subject_number INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, subject_type, subject_number)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        repo_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (state, run_after);

      CREATE TABLE IF NOT EXISTS reviewed_heads (
        repo_id INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, pr_number, head_sha)
      );

      CREATE TABLE IF NOT EXISTS publications (
        repo_id INTEGER NOT NULL,
        marker TEXT NOT NULL,
        kind TEXT NOT NULL,
        github_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, marker)
      );

      CREATE TABLE IF NOT EXISTS fix_branches (
        repo_id INTEGER NOT NULL,
        branch TEXT NOT NULL,
        sha TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, branch)
      );

      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        hash TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (repo_id, pr_number, hash)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS duplicate_cases (
        repo_id INTEGER NOT NULL,
        issue_number INTEGER NOT NULL,
        canonical_issue_number INTEGER,
        classification TEXT NOT NULL,
        status TEXT NOT NULL,
        notice_comment_id INTEGER,
        notice_revision INTEGER NOT NULL DEFAULT 1,
        notice_posted_at TEXT,
        due_at TEXT,
        last_checked_comment_id INTEGER,
        last_decision_reference TEXT,
        bot_closed INTEGER NOT NULL DEFAULT 0,
        bot_applied_labels TEXT NOT NULL DEFAULT '[]',
        followup_explained INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, issue_number)
      );

      CREATE INDEX IF NOT EXISTS duplicate_cases_due_idx
        ON duplicate_cases (status, due_at);
    `);
    this.applySchemaPatches();
    this.db.exec("PRAGMA user_version = 3;");
  }

  /** Bring databases created by earlier development builds up to the current schema. */
  private applySchemaPatches(): void {
    const columns = (table: string) =>
      this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        pk: number;
      }>;

    const repositoryColumns = columns("repositories");
    if (!repositoryColumns.some((column) => column.name === "pulls_etag")) {
      this.db.exec("ALTER TABLE repositories ADD COLUMN pulls_etag TEXT;");
    }

    const findingColumns = columns("findings");
    if (!findingColumns.some((column) => column.name === "id")) {
      this.db.exec(
        `ALTER TABLE findings RENAME TO findings_legacy;
         CREATE TABLE findings (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           repo_id INTEGER NOT NULL,
           pr_number INTEGER NOT NULL,
           hash TEXT NOT NULL,
           path TEXT NOT NULL,
           line INTEGER NOT NULL,
           severity TEXT NOT NULL,
           message TEXT NOT NULL,
           created_at TEXT NOT NULL,
           UNIQUE (repo_id, pr_number, hash)
         );
         INSERT INTO findings (repo_id, pr_number, hash, path, line, severity, message, created_at)
           SELECT repo_id, pr_number, hash, path, line, severity, message, created_at FROM findings_legacy;
         DROP TABLE findings_legacy;`,
      );
    }

    const publicationColumns = columns("publications");
    const composite = publicationColumns.some(
      (column) => column.name === "repo_id" && column.pk > 0,
    );
    if (!composite) {
      this.db.exec(
        `ALTER TABLE publications RENAME TO publications_legacy;
         CREATE TABLE publications (
           repo_id INTEGER NOT NULL,
           marker TEXT NOT NULL,
           kind TEXT NOT NULL,
           github_id TEXT,
           created_at TEXT NOT NULL,
           PRIMARY KEY (repo_id, marker)
         );
         INSERT INTO publications (repo_id, marker, kind, github_id, created_at)
           SELECT repo_id, marker, kind, github_id, created_at FROM publications_legacy;
         DROP TABLE publications_legacy;`,
      );
    }

    const duplicateColumns = columns("duplicate_cases");
    if (
      duplicateColumns.length > 0 &&
      !duplicateColumns.some((column) => column.name === "attempts")
    ) {
      this.db.exec(
        "ALTER TABLE duplicate_cases ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;",
      );
    }
    if (
      duplicateColumns.length > 0 &&
      !duplicateColumns.some((column) => column.name === "next_attempt_at")
    ) {
      this.db.exec("ALTER TABLE duplicate_cases ADD COLUMN next_attempt_at TEXT;");
    }
  }

  // Installations

  upsertInstallation(input: {
    id: number;
    accountLogin: string;
    accountType: string;
    suspended: boolean;
  }): void {
    this.db
      .query(
        `INSERT INTO installations (id, account_login, account_type, suspended, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_login = excluded.account_login,
           account_type = excluded.account_type,
           suspended = excluded.suspended,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.accountLogin,
        input.accountType,
        input.suspended ? 1 : 0,
        nowIso(),
      );
  }

  getInstallation(id: number): InstallationRecord | null {
    const row = this.db
      .query("SELECT * FROM installations WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapInstallation(row) : null;
  }

  listInstallations(activeOnly = true): InstallationRecord[] {
    const rows = this.db
      .query(
        activeOnly
          ? "SELECT * FROM installations WHERE suspended = 0 ORDER BY id"
          : "SELECT * FROM installations ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapInstallation);
  }

  deactivateInstallation(id: number): void {
    this.db
      .query("UPDATE installations SET suspended = 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
    this.db
      .query("UPDATE repositories SET active = 0 WHERE installation_id = ?")
      .run(id);
  }

  // Repositories

  /**
   * Insert a repository with an observation baseline, or update its metadata.
   * Returns true when the repository was newly discovered.
   */
  upsertRepository(input: {
    id: number;
    installationId: number;
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
    baseline: string;
  }): boolean {
    const byName = this.getRepositoryByFullName(input.fullName);
    const byId = this.getRepository(input.id);
    if (byName && byName.id === input.id) {
      this.db
        .query(
          `UPDATE repositories SET
             installation_id = ?, owner = ?, name = ?, full_name = ?,
             default_branch = ?, active = 1
           WHERE id = ?`,
        )
        .run(
          input.installationId,
          input.owner,
          input.name,
          input.fullName,
          input.defaultBranch,
          byName.id,
        );
      return false;
    }

    if (byName && byName.id !== input.id) {
      // A repository was deleted and recreated under the same name. Preserve
      // the dead row for history but free the unique name and start a fresh
      // baseline for the new repository id.
      this.db
        .query(
          "UPDATE repositories SET active = 0, full_name = full_name || '#stale-' || id WHERE id = ?",
        )
        .run(byName.id);
      if (byId) {
        this.db
          .query(
            `UPDATE repositories SET
               installation_id = ?, owner = ?, name = ?, full_name = ?,
               default_branch = ?, active = 1, pulls_etag = NULL
             WHERE id = ?`,
          )
          .run(
            input.installationId,
            input.owner,
            input.name,
            input.fullName,
            input.defaultBranch,
            byId.id,
          );
        return false;
      }
    } else if (byId) {
      this.db
        .query(
          `UPDATE repositories SET
             installation_id = ?, owner = ?, name = ?, full_name = ?,
             default_branch = ?, active = 1, pulls_etag = NULL
           WHERE id = ?`,
        )
        .run(
          input.installationId,
          input.owner,
          input.name,
          input.fullName,
          input.defaultBranch,
          byId.id,
        );
      return false;
    }

    this.db
      .query(
        `INSERT INTO repositories (
           id, installation_id, owner, name, full_name, default_branch, initialized_at,
           issues_cursor, pulls_cursor, comments_cursor, review_comments_cursor, active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.id,
        input.installationId,
        input.owner,
        input.name,
        input.fullName,
        input.defaultBranch,
        input.baseline,
        input.baseline,
        input.baseline,
        input.baseline,
        input.baseline,
      );
    return true;
  }

  getRepository(id: number): RepositoryRecord | null {
    const row = this.db
      .query("SELECT * FROM repositories WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapRepository(row) : null;
  }

  getRepositoryByFullName(fullName: string): RepositoryRecord | null {
    const row = this.db
      .query("SELECT * FROM repositories WHERE full_name = ?")
      .get(fullName) as Record<string, unknown> | null;
    return row ? mapRepository(row) : null;
  }

  listRepositories(activeOnly = true): RepositoryRecord[] {
    const rows = this.db
      .query(
        activeOnly
          ? "SELECT * FROM repositories WHERE active = 1 ORDER BY full_name"
          : "SELECT * FROM repositories ORDER BY full_name",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapRepository);
  }

  setActive(repoId: number, active: boolean): void {
    this.db
      .query("UPDATE repositories SET active = ? WHERE id = ?")
      .run(active ? 1 : 0, repoId);
  }

  /** Advance one source checkpoint. Other sources keep their own progress. */
  setCursor(
    repoId: number,
    source: "issues" | "pulls" | "comments" | "reviewComments",
    value: string,
  ): void {
    const column =
      source === "issues"
        ? "issues_cursor"
        : source === "pulls"
          ? "pulls_cursor"
          : source === "comments"
            ? "comments_cursor"
            : "review_comments_cursor";
    this.db
      .query(`UPDATE repositories SET ${column} = ? WHERE id = ?`)
      .run(value, repoId);
  }

  /** Commit the pull checkpoint and its ETag together after a successful pass. */
  setPullsCheckpoint(
    repoId: number,
    cursor: string,
    etag: string | null,
  ): void {
    this.db
      .query(
        "UPDATE repositories SET pulls_cursor = ?, pulls_etag = ? WHERE id = ?",
      )
      .run(cursor, etag, repoId);
  }

  markPollSuccess(repoId: number, polledAt: string): void {
    this.db
      .query(
        "UPDATE repositories SET last_poll_at = ?, last_poll_error = NULL WHERE id = ?",
      )
      .run(polledAt, repoId);
  }

  setPollError(repoId: number, message: string): void {
    this.db
      .query("UPDATE repositories SET last_poll_error = ? WHERE id = ?")
      .run(message.slice(0, 2000), repoId);
  }

  // Pull request observation state

  getPullState(repoId: number, number: number): PullStateRecord | null {
    const row = this.db
      .query("SELECT * FROM pull_state WHERE repo_id = ? AND number = ?")
      .get(repoId, number) as Record<string, unknown> | null;
    return row ? mapPullState(row) : null;
  }

  upsertPullState(input: {
    repoId: number;
    number: number;
    draft: boolean;
    headSha: string;
    lastReviewedSha?: string | null;
  }): void {
    this.db
      .query(
        `INSERT INTO pull_state (repo_id, number, draft, head_sha, last_reviewed_sha, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, number) DO UPDATE SET
           draft = excluded.draft,
           head_sha = excluded.head_sha,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.repoId,
        input.number,
        input.draft ? 1 : 0,
        input.headSha,
        input.lastReviewedSha ?? null,
        nowIso(),
      );
  }

  markPullReviewed(repoId: number, number: number, headSha: string): void {
    this.db
      .query(
        `INSERT INTO reviewed_heads (repo_id, pr_number, head_sha, reviewed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(repoId, number, headSha, nowIso());
    this.db
      .query(
        `UPDATE pull_state SET last_reviewed_sha = ?, updated_at = ?
         WHERE repo_id = ? AND number = ?`,
      )
      .run(headSha, nowIso(), repoId, number);
  }

  hasReviewedHead(repoId: number, number: number, headSha: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS present FROM reviewed_heads WHERE repo_id = ? AND pr_number = ? AND head_sha = ?",
      )
      .get(repoId, number, headSha) as { present: number } | null;
    return row !== null;
  }

  lastReviewedHead(repoId: number, number: number): string | null {
    const row = this.db
      .query("SELECT last_reviewed_sha FROM pull_state WHERE repo_id = ? AND number = ?")
      .get(repoId, number) as { last_reviewed_sha: string | null } | null;
    return row?.last_reviewed_sha ?? null;
  }

  // Session continuity

  getSessionMapping(
    repoId: number,
    subjectType: "issue" | "pr",
    subjectNumber: number,
  ): string | null {
    const row = this.db
      .query(
        "SELECT session_id FROM sessions WHERE repo_id = ? AND subject_type = ? AND subject_number = ?",
      )
      .get(repoId, subjectType, subjectNumber) as { session_id: string } | null;
    return row?.session_id ?? null;
  }

  setSessionMapping(
    repoId: number,
    subjectType: "issue" | "pr",
    subjectNumber: number,
    sessionId: string,
  ): void {
    this.db
      .query(
        `INSERT INTO sessions (repo_id, subject_type, subject_number, session_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, subject_type, subject_number) DO UPDATE SET
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run(repoId, subjectType, subjectNumber, sessionId, nowIso());
  }

  // Jobs

  enqueueJob(input: EnqueueJobInput): boolean {
    const result = this.db
      .query(
        `INSERT INTO jobs (
           key, kind, repo_id, payload, state, attempts, max_attempts, run_after, created_at
         ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           payload = excluded.payload,
           state = 'queued',
           attempts = 0,
           run_after = excluded.run_after,
           started_at = NULL,
           finished_at = NULL,
           error = NULL
         WHERE jobs.state = 'failed'`,
      )
      .run(
        input.key,
        input.kind,
        input.repoId,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 3,
        input.runAfter ?? nowIso(),
        nowIso(),
      );
    return result.changes > 0;
  }

  /** Claim a single queued job. The caller is the only worker process in v1. */
  claimNextJob(now = nowIso()): JobRecord | null {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM jobs
           WHERE state = 'queued' AND run_after <= ?
           ORDER BY id LIMIT 1`,
        )
        .get(now) as Record<string, unknown> | null;
      if (!row) return null;
      const updated = this.db
        .query(
          "UPDATE jobs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'",
        )
        .run(now, row.id as number);
      if (updated.changes === 0) return null;
      return this.getJob(row.id as number);
    })();
  }

  getJob(id: number): JobRecord | null {
    const row = this.db
      .query("SELECT * FROM jobs WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapJob(row) : null;
  }

  completeJob(id: number, result: unknown): void {
    this.db
      .query(
        "UPDATE jobs SET state = 'completed', finished_at = ?, error = NULL, result = ?, payload = '{}' WHERE id = ?",
      )
      .run(nowIso(), result === undefined ? null : JSON.stringify(result), id);
  }

  /**
   * Record a failure. Transient failures are retried while attempts remain
   * (initial attempt plus at most two retries). Permanent failures stop.
   */
  failJob(
    id: number,
    error: string,
    options: { retryable: boolean; delaySeconds?: number },
  ): void {
    const job = this.getJob(id);
    if (!job) return;
    const attempts = job.attempts + 1;
    const retry = options.retryable && attempts < job.maxAttempts;
    if (retry) {
      this.db
        .query(
          `UPDATE jobs SET state = 'queued', attempts = ?, error = ?, run_after = ?, started_at = NULL
           WHERE id = ?`,
        )
        .run(
          attempts,
          error.slice(0, 4000),
          addSeconds(nowIso(), options.delaySeconds ?? retryDelaySeconds(attempts)),
          id,
        );
    } else {
      this.db
        .query(
          "UPDATE jobs SET state = 'failed', attempts = ?, error = ?, finished_at = ?, payload = '{}' WHERE id = ?",
        )
        .run(attempts, error.slice(0, 4000), nowIso(), id);
    }
  }

  /** Return an interrupted or unavailable-dependency job to the queue without consuming a retry. */
  requeueJob(id: number, message: string, delaySeconds = 60): void {
    this.db
      .query(
        `UPDATE jobs SET state = 'queued', started_at = NULL, error = ?, run_after = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(message.slice(0, 4000), addSeconds(nowIso(), delaySeconds), id);
  }

  /** Return interrupted jobs to the queue after a daemon restart. */
  recoverRunningJobs(): number {
    const result = this.db
      .query(
        `UPDATE jobs SET state = 'queued', started_at = NULL, error = 'recovered after restart'
         WHERE state = 'running'`,
      )
      .run();
    return result.changes;
  }

  queueDepth(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM jobs WHERE state = 'queued'")
      .get() as { count: number };
    return row.count;
  }

  activeJob(): JobRecord | null {
    const row = this.db
      .query("SELECT * FROM jobs WHERE state = 'running' ORDER BY id LIMIT 1")
      .get() as Record<string, unknown> | null;
    return row ? mapJob(row) : null;
  }

  recentFailures(limit = 5): JobRecord[] {
    const rows = this.db
      .query("SELECT * FROM jobs WHERE state = 'failed' ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapJob);
  }

  publicationCount(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM publications")
      .get() as { count: number };
    return row.count;
  }

  // Publications and duplicate suppression

  hasPublication(repoId: number, marker: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS present FROM publications WHERE repo_id = ? AND marker = ?",
      )
      .get(repoId, marker) as { present: number } | null;
    return row !== null;
  }

  recordPublication(input: {
    marker: string;
    repoId: number;
    kind: string;
    githubId?: string | number | null;
  }): void {
    this.db
      .query(
        `INSERT INTO publications (repo_id, marker, kind, github_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, marker) DO UPDATE SET
           kind = excluded.kind,
           github_id = excluded.github_id`,
      )
      .run(
        input.repoId,
        input.marker,
        input.kind,
        input.githubId == null ? null : String(input.githubId),
        nowIso(),
      );
  }

  /** Returns true when the finding hash was not previously published. */
  recordFinding(input: {
    repoId: number;
    prNumber: number;
    hash: string;
    path: string;
    line: number;
    severity: string;
    message: string;
  }): boolean {
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO findings (repo_id, pr_number, hash, path, line, severity, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.repoId,
        input.prNumber,
        input.hash,
        input.path,
        input.line,
        input.severity,
        input.message.slice(0, 4000),
        nowIso(),
      );
    return result.changes > 0;
  }

  hasFinding(repoId: number, prNumber: number, hash: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS present FROM findings WHERE repo_id = ? AND pr_number = ? AND hash = ?",
      )
      .get(repoId, prNumber, hash) as { present: number } | null;
    return row !== null;
  }

  listFindings(
    repoId: number,
    prNumber: number,
  ): Array<{ path: string; line: number; severity: string; message: string }> {
    return this.db
      .query(
        `SELECT path, line, severity, message FROM findings
         WHERE repo_id = ? AND pr_number = ? ORDER BY id`,
      )
      .all(repoId, prNumber) as Array<{
      path: string;
      line: number;
      severity: string;
      message: string;
    }>;
  }

  // Fix branch commit binding

  recordFixBranch(repoId: number, branch: string, sha: string): void {
    this.db
      .query(
        `INSERT INTO fix_branches (repo_id, branch, sha, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, branch) DO UPDATE SET
           sha = excluded.sha,
           updated_at = excluded.updated_at`,
      )
      .run(repoId, branch, sha, nowIso());
  }

  getFixBranch(repoId: number, branch: string): string | null {
    const row = this.db
      .query("SELECT sha FROM fix_branches WHERE repo_id = ? AND branch = ?")
      .get(repoId, branch) as { sha: string } | null;
    return row?.sha ?? null;
  }

  // Duplicate lifecycle cases

  /**
   * Persist a duplicate-case intent. An existing case is never overwritten: the
   * first durable intent owns the lifecycle for this issue.
   */
  createDuplicateCase(input: {
    repoId: number;
    issueNumber: number;
    canonicalIssueNumber: number;
    classification: DuplicateClassification;
    lastDecisionReference: string;
  }): DuplicateCaseRecord {
    this.db
      .query(
        `INSERT OR IGNORE INTO duplicate_cases (
           repo_id, issue_number, canonical_issue_number, classification, status,
           notice_revision, last_decision_reference, updated_at
         ) VALUES (?, ?, ?, ?, 'notice_pending', 1, ?, ?)`,
      )
      .run(
        input.repoId,
        input.issueNumber,
        input.canonicalIssueNumber,
        input.classification,
        input.lastDecisionReference,
        nowIso(),
      );
    return this.getDuplicateCase(input.repoId, input.issueNumber)!;
  }

  getDuplicateCase(
    repoId: number,
    issueNumber: number,
  ): DuplicateCaseRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM duplicate_cases WHERE repo_id = ? AND issue_number = ?",
      )
      .get(repoId, issueNumber) as Record<string, unknown> | null;
    return row ? mapDuplicateCase(row) : null;
  }

  listDuplicateCases(
    repoId: number,
    statuses?: DuplicateCaseStatus[],
  ): DuplicateCaseRecord[] {
    const rows = statuses && statuses.length > 0
      ? (this.db
          .query(
            `SELECT * FROM duplicate_cases WHERE repo_id = ?
             AND status IN (${statuses.map(() => "?").join(", ")})
             ORDER BY issue_number`,
          )
          .all(repoId, ...statuses) as Array<Record<string, unknown>>)
      : (this.db
          .query(
            "SELECT * FROM duplicate_cases WHERE repo_id = ? ORDER BY issue_number",
          )
          .all(repoId) as Array<Record<string, unknown>>);
    return rows.map(mapDuplicateCase);
  }

  listDueDuplicateCases(now: string, repoId?: number): DuplicateCaseRecord[] {
    const rows = repoId == null
      ? (this.db
          .query(
            `SELECT * FROM duplicate_cases
             WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?
               AND attempts < 3
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY due_at`,
          )
          .all(now, now) as Array<Record<string, unknown>>)
      : (this.db
          .query(
            `SELECT * FROM duplicate_cases
             WHERE repo_id = ? AND status = 'pending'
               AND due_at IS NOT NULL AND due_at <= ?
               AND attempts < 3
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY due_at`,
          )
          .all(repoId, now, now) as Array<Record<string, unknown>>);
    return rows.map(mapDuplicateCase);
  }

  /**
   * Cases whose notice intent has not been confirmed by GitHub. Used by the
   * poll loop to reconcile a crash between intent and publication.
   */
  listNoticePendingDuplicateCases(repoId?: number): DuplicateCaseRecord[] {
    const now = nowIso();
    const rows = repoId == null
      ? (this.db
          .query(
            `SELECT * FROM duplicate_cases
             WHERE status = 'notice_pending' AND attempts < 3
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY updated_at`,
          )
          .all(now) as Array<Record<string, unknown>>)
      : (this.db
          .query(
            `SELECT * FROM duplicate_cases
             WHERE repo_id = ? AND status = 'notice_pending' AND attempts < 3
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY updated_at`,
          )
          .all(repoId, now) as Array<Record<string, unknown>>);
    return rows.map(mapDuplicateCase);
  }

  updateDuplicateCase(
    repoId: number,
    issueNumber: number,
    patch: DuplicateCasePatch,
  ): void {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.canonicalIssueNumber !== undefined) {
      set("canonical_issue_number", patch.canonicalIssueNumber);
    }
    if (patch.classification !== undefined) {
      set("classification", patch.classification);
    }
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.noticeCommentId !== undefined) {
      set("notice_comment_id", patch.noticeCommentId);
    }
    if (patch.noticeRevision !== undefined) {
      set("notice_revision", patch.noticeRevision);
    }
    if (patch.noticePostedAt !== undefined) {
      set("notice_posted_at", patch.noticePostedAt);
    }
    if (patch.dueAt !== undefined) set("due_at", patch.dueAt);
    if (patch.lastCheckedCommentId !== undefined) {
      set("last_checked_comment_id", patch.lastCheckedCommentId);
    }
    if (patch.lastDecisionReference !== undefined) {
      set("last_decision_reference", patch.lastDecisionReference);
    }
    if (patch.botClosed !== undefined) {
      set("bot_closed", patch.botClosed ? 1 : 0);
    }
    if (patch.botAppliedLabels !== undefined) {
      set("bot_applied_labels", JSON.stringify(patch.botAppliedLabels));
    }
    if (patch.followupExplained !== undefined) {
      set("followup_explained", patch.followupExplained ? 1 : 0);
    }
    if (patch.attempts !== undefined) set("attempts", patch.attempts);
    if (patch.nextAttemptAt !== undefined) {
      set("next_attempt_at", patch.nextAttemptAt);
    }
    if (patch.lastError !== undefined) set("last_error", patch.lastError);
    set("updated_at", nowIso());
    this.db
      .query(
        `UPDATE duplicate_cases SET ${assignments.join(", ")}
         WHERE repo_id = ? AND issue_number = ?`,
      )
      .run(...values, repoId, issueNumber);
  }

  addDuplicateAppliedLabels(
    repoId: number,
    issueNumber: number,
    labels: string[],
  ): void {
    const record = this.getDuplicateCase(repoId, issueNumber);
    if (!record) return;
    const merged = [...new Set([...record.botAppliedLabels, ...labels])];
    this.updateDuplicateCase(repoId, issueNumber, { botAppliedLabels: merged });
  }

  duplicateCaseCounts(): Record<DuplicateCaseStatus, number> {
    const counts: Record<DuplicateCaseStatus, number> = {
      notice_pending: 0,
      pending: 0,
      closed: 0,
      cancelled: 0,
      reopened: 0,
    };
    const rows = this.db
      .query(
        "SELECT status, COUNT(*) AS count FROM duplicate_cases GROUP BY status",
      )
      .all() as Array<{ status: DuplicateCaseStatus; count: number }>;
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = row.count;
    }
    return counts;
  }

  /**
   * Record a failed lifecycle attempt and back off. Three failed attempts stop
   * automatic deadline retries; a new comment or operator investigation can
   * still move the case forward.
   */
  markDuplicateCheckFailure(
    repoId: number,
    issueNumber: number,
    message: string,
    now = nowIso(),
  ): void {
    const record = this.getDuplicateCase(repoId, issueNumber);
    if (!record) return;
    const attempts = record.attempts + 1;
    const delay = Math.min(3_600, 30 * Math.pow(2, attempts));
    this.updateDuplicateCase(repoId, issueNumber, {
      attempts,
      nextAttemptAt: addSeconds(now, delay),
      lastError: message.slice(0, 2_000),
    });
  }

  markDuplicateCheckSuccess(repoId: number, issueNumber: number): void {
    this.updateDuplicateCase(repoId, issueNumber, {
      attempts: 0,
      nextAttemptAt: null,
    });
  }

  /** Record a comment-reassessment failure without consuming the deadline budget. */
  recordDuplicateError(
    repoId: number,
    issueNumber: number,
    message: string,
  ): void {
    this.updateDuplicateCase(repoId, issueNumber, {
      lastError: message.slice(0, 2_000),
    });
  }

  recentDuplicateErrors(
    limit = 5,
  ): Array<{ repo: string; issueNumber: number; error: string }> {
    return this.db
      .query(
        `SELECT COALESCE(r.full_name, CAST(d.repo_id AS TEXT)) AS repo,
                d.issue_number AS issueNumber, d.last_error AS error
         FROM duplicate_cases d
         LEFT JOIN repositories r ON r.id = d.repo_id
         WHERE d.last_error IS NOT NULL
         ORDER BY d.updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      repo: string;
      issueNumber: number;
      error: string;
    }>;
  }

  /** True when a job with this stable key already failed permanently. */
  hasFailedJob(key: string): boolean {
    const row = this.db
      .query("SELECT 1 AS present FROM jobs WHERE key = ? AND state = 'failed'")
      .get(key) as { present: number } | null;
    return row !== null;
  }

  // Metadata

  getMeta(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  deleteMeta(key: string): void {
    this.db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

export function retryDelaySeconds(attempt: number): number {
  const base = Math.min(300, 15 * Math.pow(2, Math.max(0, attempt - 1)));
  return base + Math.floor(Math.random() * 5);
}

function mapInstallation(row: Record<string, unknown>): InstallationRecord {
  return {
    id: row.id as number,
    accountLogin: row.account_login as string,
    accountType: row.account_type as string,
    suspended: (row.suspended as number) === 1,
    updatedAt: row.updated_at as string,
  };
}

function mapRepository(row: Record<string, unknown>): RepositoryRecord {
  return {
    id: row.id as number,
    installationId: row.installation_id as number,
    owner: row.owner as string,
    name: row.name as string,
    fullName: row.full_name as string,
    defaultBranch: row.default_branch as string,
    initializedAt: row.initialized_at as string,
    issuesCursor: row.issues_cursor as string,
    pullsCursor: row.pulls_cursor as string,
    pullsEtag: (row.pulls_etag as string | null) ?? null,
    commentsCursor: row.comments_cursor as string,
    reviewCommentsCursor: row.review_comments_cursor as string,
    active: (row.active as number) === 1,
    lastPollAt: (row.last_poll_at as string | null) ?? null,
    lastPollError: (row.last_poll_error as string | null) ?? null,
  };
}

function mapPullState(row: Record<string, unknown>): PullStateRecord {
  return {
    repoId: row.repo_id as number,
    number: row.number as number,
    draft: (row.draft as number) === 1,
    headSha: row.head_sha as string,
    lastReviewedSha: (row.last_reviewed_sha as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as number,
    key: row.key as string,
    kind: row.kind as JobKind,
    repoId: row.repo_id as number,
    payload: row.payload as string,
    state: row.state as JobState,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    runAfter: row.run_after as string,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    result: (row.result as string | null) ?? null,
  };
}

function mapDuplicateCase(row: Record<string, unknown>): DuplicateCaseRecord {
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(String(row.bot_applied_labels ?? "[]"));
    if (Array.isArray(parsed)) {
      labels = parsed.filter(
        (value): value is string => typeof value === "string",
      );
    }
  } catch {
    labels = [];
  }
  return {
    repoId: row.repo_id as number,
    issueNumber: row.issue_number as number,
    canonicalIssueNumber:
      (row.canonical_issue_number as number | null) ?? null,
    classification: row.classification as DuplicateClassification,
    status: row.status as DuplicateCaseStatus,
    noticeCommentId: (row.notice_comment_id as number | null) ?? null,
    noticeRevision: (row.notice_revision as number | null) ?? 1,
    noticePostedAt: (row.notice_posted_at as string | null) ?? null,
    dueAt: (row.due_at as string | null) ?? null,
    lastCheckedCommentId:
      (row.last_checked_comment_id as number | null) ?? null,
    lastDecisionReference:
      (row.last_decision_reference as string | null) ?? null,
    botClosed: (row.bot_closed as number) === 1,
    botAppliedLabels: labels,
    followupExplained: (row.followup_explained as number) === 1,
    attempts: (row.attempts as number | null) ?? 0,
    nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}
