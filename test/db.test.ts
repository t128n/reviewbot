import { describe, expect, test } from "bun:test";
import { Store, addSeconds, nowIso } from "../src/db.ts";

function repo(store: Store): number {
  store.upsertRepository({
    id: 1,
    installationId: 1,
    owner: "acme",
    name: "repo",
    fullName: "acme/repo",
    defaultBranch: "main",
    baseline: nowIso(),
  });
  return 1;
}

describe("repository baselines", () => {
  test("reports new repositories once and preserves cursors", () => {
    const store = new Store(":memory:");
    try {
      const baseline = "2026-01-01T00:00:00.000Z";
      expect(
        store.upsertRepository({
          id: 1,
          installationId: 1,
          owner: "acme",
          name: "repo",
          fullName: "acme/repo",
          defaultBranch: "main",
          baseline,
        }),
      ).toBe(true);
      store.setCursor(1, "issues", "2026-01-02T00:00:00.000Z");
      expect(
        store.upsertRepository({
          id: 1,
          installationId: 1,
          owner: "acme",
          name: "repo",
          fullName: "acme/repo",
          defaultBranch: "trunk",
          baseline: "2026-02-01T00:00:00.000Z",
        }),
      ).toBe(false);
      const record = store.getRepository(1)!;
      expect(record.issuesCursor).toBe("2026-01-02T00:00:00.000Z");
      expect(record.defaultBranch).toBe("trunk");
    } finally {
      store.close();
    }
  });
});

describe("repository identity", () => {
  test("handles a rename and a recreated repository name", () => {
    const store = new Store(":memory:");
    const baseline = "2026-01-01T00:00:00.000Z";
    expect(
      store.upsertRepository({
        id: 1,
        installationId: 1,
        owner: "acme",
        name: "old",
        fullName: "acme/old",
        defaultBranch: "main",
        baseline,
      }),
    ).toBe(true);
    expect(
      store.upsertRepository({
        id: 1,
        installationId: 1,
        owner: "acme",
        name: "new",
        fullName: "acme/new",
        defaultBranch: "trunk",
        baseline,
      }),
    ).toBe(false);
    expect(store.getRepository(1)!.fullName).toBe("acme/new");
    expect(
      store.upsertRepository({
        id: 2,
        installationId: 1,
        owner: "acme",
        name: "old",
        fullName: "acme/old",
        defaultBranch: "main",
        baseline,
      }),
    ).toBe(true);
    expect(store.listRepositories().length).toBe(2);
    store.close();
  });

  test("starts a fresh baseline when a recreated repository takes an old name", () => {
    const store = new Store(":memory:");
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline: "2026-01-01T00:00:00.000Z",
    });
    expect(
      store.upsertRepository({
        id: 2,
        installationId: 1,
        owner: "acme",
        name: "repo",
        fullName: "acme/repo",
        defaultBranch: "main",
        baseline: "2026-06-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(store.getRepositoryByFullName("acme/repo")!.id).toBe(2);
    expect(store.getRepository(1)!.active).toBe(false);
    expect(store.listRepositories().length).toBe(1);
    store.close();
  });
});

describe("job lifecycle", () => {
  test("deduplicates by stable key", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    const input = {
      key: "triage:1:5",
      kind: "triage" as const,
      repoId,
      payload: { issueNumber: 5 },
    };
    expect(store.enqueueJob(input)).toBe(true);
    expect(store.enqueueJob(input)).toBe(false);
    expect(store.queueDepth()).toBe(1);
    store.close();
  });

  test("runs, retries transient failures twice, then fails", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.enqueueJob({ key: "k", kind: "triage", repoId, payload: {} });

    let job = store.claimNextJob()!;
    expect(job.state).toBe("running");
    store.failJob(job.id, "transient", { retryable: true });
    job = store.getJob(job.id)!;
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(1);

    job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    store.failJob(job.id, "transient", { retryable: true });
    job = store.getJob(job.id)!;
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(2);

    job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    store.failJob(job.id, "transient", { retryable: true });
    job = store.getJob(job.id)!;
    expect(job.state).toBe("failed");
    expect(job.attempts).toBe(3);
    store.close();
  });

  test("does not retry permanent failures", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.enqueueJob({ key: "k", kind: "review", repoId, payload: {} });
    const job = store.claimNextJob()!;
    store.failJob(job.id, "unauthorized", { retryable: false });
    expect(store.getJob(job.id)!.state).toBe("failed");
    store.close();
  });

  test("requeues a job without consuming a retry when a dependency is unavailable", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.enqueueJob({ key: "k", kind: "triage", repoId, payload: {} });
    const job = store.claimNextJob()!;
    store.requeueJob(job.id, "OpenCode unavailable", 60);
    const requeued = store.getJob(job.id)!;
    expect(requeued.state).toBe("queued");
    expect(requeued.attempts).toBe(0);
    expect(requeued.error).toContain("OpenCode unavailable");
    store.close();
  });

  test("re-enqueues a permanently failed job when its trigger repeats", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    const input = {
      key: "k",
      kind: "triage" as const,
      repoId,
      payload: { issueNumber: 5 },
    };
    store.enqueueJob(input);
    let job = store.claimNextJob()!;
    store.failJob(job.id, "permanent", { retryable: false });
    expect(store.getJob(job.id)!.state).toBe("failed");
    expect(store.enqueueJob(input)).toBe(true);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(JSON.parse(job.payload).issueNumber).toBe(5);
    store.close();
  });

  test("recovers interrupted running jobs", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.enqueueJob({ key: "k", kind: "triage", repoId, payload: {} });
    store.claimNextJob();
    expect(store.recoverRunningJobs()).toBe(1);
    expect(store.queueDepth()).toBe(1);
    expect(store.getJob(1)!.error).toContain("recovered");
    store.close();
  });

  test("completes with a result", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.enqueueJob({ key: "k", kind: "triage", repoId, payload: {} });
    const job = store.claimNextJob()!;
    store.completeJob(job.id, { ok: true });
    const completed = store.getJob(job.id)!;
    expect(completed.state).toBe("completed");
    expect(completed.result).toContain('"ok":true');
    store.close();
  });
});

describe("duplicate cases", () => {
  test("persists an intent, arms a deadline, and records label provenance", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    const created = store.createDuplicateCase({
      repoId,
      issueNumber: 2,
      canonicalIssueNumber: 1,
      classification: "likely",
      lastDecisionReference: '{"noticeComment":"notice"}',
    });
    expect(created.status).toBe("notice_pending");
    expect(created.dueAt).toBeNull();
    expect(store.listDueDuplicateCases(addSeconds(nowIso(), 48 * 3600))).toEqual(
      [],
    );
    store.updateDuplicateCase(repoId, 2, {
      status: "pending",
      noticeCommentId: 55,
      noticePostedAt: "2026-01-01T00:00:00.000Z",
      dueAt: "2026-01-02T00:00:00.000Z",
      lastCheckedCommentId: 10,
    });
    expect(
      store.listDueDuplicateCases("2026-01-02T00:00:01.000Z").map(
        (record) => record.issueNumber,
      ),
    ).toEqual([2]);
    store.addDuplicateAppliedLabels(repoId, 2, ["pending close"]);
    store.addDuplicateAppliedLabels(repoId, 2, ["pending close", "duplicate"]);
    expect(store.getDuplicateCase(repoId, 2)!.botAppliedLabels).toEqual([
      "pending close",
      "duplicate",
    ]);
    store.updateDuplicateCase(repoId, 2, {
      status: "closed",
      botClosed: true,
      botAppliedLabels: ["duplicate"],
    });
    const closed = store.getDuplicateCase(repoId, 2)!;
    expect(closed.status).toBe("closed");
    expect(closed.botClosed).toBe(true);
    expect(closed.lastCheckedCommentId).toBe(10);
    expect(store.duplicateCaseCounts().closed).toBe(1);
    store.close();
  });

  test("never overwrites an existing lifecycle intent", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.createDuplicateCase({
      repoId,
      issueNumber: 3,
      canonicalIssueNumber: 1,
      classification: "confirmed",
      lastDecisionReference: "first",
    });
    store.updateDuplicateCase(repoId, 3, { status: "cancelled" });
    const second = store.createDuplicateCase({
      repoId,
      issueNumber: 3,
      canonicalIssueNumber: 2,
      classification: "likely",
      lastDecisionReference: "second",
    });
    expect(second.status).toBe("cancelled");
    expect(second.canonicalIssueNumber).toBe(1);
    expect(second.lastDecisionReference).toBe("first");
    store.close();
  });

  test("backs off failed deadline checks and stops automatic retries", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.createDuplicateCase({
      repoId,
      issueNumber: 4,
      canonicalIssueNumber: 1,
      classification: "confirmed",
      lastDecisionReference: "{}",
    });
    store.updateDuplicateCase(repoId, 4, {
      status: "pending",
      dueAt: "2026-01-01T00:00:00.000Z",
    });
    const now = "2026-01-02T00:00:00.000Z";
    expect(store.listDueDuplicateCases(now)).toHaveLength(1);
    store.markDuplicateCheckFailure(repoId, 4, "GitHub 502", now);
    let record = store.getDuplicateCase(repoId, 4)!;
    expect(record.attempts).toBe(1);
    expect(record.nextAttemptAt).toBe(addSeconds(now, 60));
    expect(store.listDueDuplicateCases(now)).toHaveLength(0);
    store.markDuplicateCheckFailure(
      repoId,
      4,
      "GitHub 502",
      addSeconds(now, 120),
    );
    store.markDuplicateCheckFailure(
      repoId,
      4,
      "GitHub 502",
      addSeconds(now, 3600),
    );
    expect(store.getDuplicateCase(repoId, 4)!.attempts).toBe(3);
    expect(
      store.listDueDuplicateCases(addSeconds(now, 7 * 24 * 3600)),
    ).toHaveLength(0);
    store.markDuplicateCheckSuccess(repoId, 4);
    record = store.getDuplicateCase(repoId, 4)!;
    expect(record.attempts).toBe(0);
    expect(record.nextAttemptAt).toBeNull();
    expect(store.listDueDuplicateCases(addSeconds(now, 7 * 24 * 3600))).toHaveLength(
      1,
    );
    store.close();
  });

  test("detects a permanently failed stable job key", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.enqueueJob({
      key: "duplicate-comment:1:9",
      kind: "duplicate-comment",
      repoId,
      payload: {},
    });
    const job = store.claimNextJob()!;
    store.failJob(job.id, "permanent", { retryable: false });
    expect(store.hasFailedJob("duplicate-comment:1:9")).toBe(true);
    expect(store.hasFailedJob("duplicate-comment:1:10")).toBe(false);
    store.close();
  });
});

describe("observation and idempotency state", () => {
  test("tracks pull heads and reviewed commits", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.upsertPullState({
      repoId,
      number: 7,
      draft: true,
      headSha: "a",
    });
    expect(store.getPullState(repoId, 7)!.draft).toBe(true);
    store.upsertPullState({
      repoId,
      number: 7,
      draft: false,
      headSha: "b",
    });
    expect(store.getPullState(repoId, 7)!.headSha).toBe("b");
    expect(store.hasReviewedHead(repoId, 7, "b")).toBe(false);
    store.markPullReviewed(repoId, 7, "b");
    expect(store.hasReviewedHead(repoId, 7, "b")).toBe(true);
    expect(store.lastReviewedHead(repoId, 7)).toBe("b");
    store.close();
  });

  test("binds a fix branch to the pushed commit", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    expect(store.getFixBranch(repoId, "reviewbot/fix-issue-1-2")).toBeNull();
    store.recordFixBranch(repoId, "reviewbot/fix-issue-1-2", "a".repeat(40));
    expect(store.getFixBranch(repoId, "reviewbot/fix-issue-1-2")).toBe(
      "a".repeat(40),
    );
    store.close();
  });

  test("persists session mappings", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    store.setSessionMapping(repoId, "issue", 3, "ses_1");
    expect(store.getSessionMapping(repoId, "issue", 3)).toBe("ses_1");
    store.setSessionMapping(repoId, "issue", 3, "ses_2");
    expect(store.getSessionMapping(repoId, "issue", 3)).toBe("ses_2");
    store.close();
  });

  test("records publications and suppresses duplicate findings", () => {
    const store = new Store(":memory:");
    const repoId = repo(store);
    expect(store.hasPublication(repoId, "m")).toBe(false);
    store.recordPublication({ marker: "m", repoId, kind: "review", githubId: 9 });
    expect(store.hasPublication(repoId, "m")).toBe(true);
    expect(store.publicationCount()).toBe(1);

    const finding = {
      repoId,
      prNumber: 4,
      hash: "h",
      path: "src/a.ts",
      line: 2,
      severity: "high",
      message: "problem",
    };
    expect(store.hasFinding(repoId, 4, "h")).toBe(false);
    expect(store.recordFinding(finding)).toBe(true);
    expect(store.recordFinding(finding)).toBe(false);
    expect(store.hasFinding(repoId, 4, "h")).toBe(true);
    expect(store.listFindings(repoId, 4)).toHaveLength(1);
    store.close();
  });
});
