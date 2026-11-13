import { describe, expect, test } from "bun:test";
import { Store, addSeconds, nowIso } from "../src/db.ts";
import type {
  CommentSummary,
  GitHub,
  IssueSummary,
  PullSummary,
  RepositorySummary,
} from "../src/github.ts";
import { Poller, RateLimitedError } from "../src/polling.ts";
import type { Logger } from "../src/log.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface FakeState {
  issues: IssueSummary[];
  pulls: PullSummary[];
  issueComments: CommentSummary[];
  reviewComments: CommentSummary[];
  permission: string | null;
  failIssues?: boolean;
  permissionErrorFor?: string;
  notModified?: boolean;
}

class FakeGitHub {
  state: FakeState = {
    issues: [],
    pulls: [],
    issueComments: [],
    reviewComments: [],
    permission: "write",
  };
  repository: RepositorySummary = {
    id: 1,
    owner: "acme",
    name: "repo",
    fullName: "acme/repo",
    defaultBranch: "main",
    private: true,
    archived: false,
  };

  async listInstallations() {
    return [
      {
        id: 1,
        accountLogin: "acme",
        accountType: "Organization",
        suspended: false,
        permissions: { contents: "write" },
      },
    ];
  }

  async listInstallationRepositories() {
    return [this.repository];
  }

  async installationClient() {
    return {} as never;
  }

  async listOpenPulls(): Promise<{
    pulls: PullSummary[];
    etag: string | null;
    notModified: boolean;
  }> {
    return {
      pulls: this.state.notModified ? [] : this.state.pulls,
      etag: this.state.notModified ? "etag" : null,
      notModified: this.state.notModified === true,
    };
  }

  async listIssues(): Promise<IssueSummary[]> {
    if (this.state.failIssues) {
      const error = new Error("API rate limit exceeded") as Error & {
        rateLimited: boolean;
        retryAfterSeconds: number;
      };
      error.rateLimited = true;
      error.retryAfterSeconds = 42;
      throw error;
    }
    return this.state.issues;
  }

  async listIssueComments(): Promise<CommentSummary[]> {
    return this.state.issueComments;
  }

  async listReviewComments(): Promise<CommentSummary[]> {
    return this.state.reviewComments;
  }

  async repositoryPermission(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    username: string,
  ) {
    if (username === this.state.permissionErrorFor) {
      throw Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
        retryable: false,
      });
    }
    return { permission: this.state.permission, roleName: null };
  }

  async getIssue(_octokit: unknown, _owner: string, _repo: string, number: number) {
    return {
      number,
      title: `Issue ${number}`,
      body: "",
      author: "alice",
      authorType: "User",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      isPullRequest: false,
      state: "open",
      htmlUrl: `https://acme.ghe.com/acme/repo/issues/${number}`,
    } satisfies IssueSummary;
  }

  async getPull(_octokit: unknown, _owner: string, _repo: string, number: number) {
    return {
      number,
      title: `PR ${number}`,
      body: "",
      draft: false,
      state: "open",
      headSha: "head",
      headRef: "feature",
      baseRef: "main",
      author: "alice",
      authorType: "User",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      htmlUrl: `https://acme.ghe.com/acme/repo/pull/${number}`,
    } satisfies PullSummary;
  }
}

function issue(number: number, created: string): IssueSummary {
  return {
    number,
    title: `Issue ${number}`,
    body: "body",
    author: "alice",
    authorType: "User",
    createdAt: created,
    updatedAt: created,
    isPullRequest: false,
    state: "open",
    htmlUrl: `https://acme.ghe.com/acme/repo/issues/${number}`,
  };
}

function pull(number: number, head: string, draft: boolean, created: string, updated: string): PullSummary {
  return {
    number,
    title: `PR ${number}`,
    body: "body",
    draft,
    state: "open",
    headSha: head,
    headRef: "feature",
    baseRef: "main",
    author: "alice",
    authorType: "User",
    createdAt: created,
    updatedAt: updated,
    htmlUrl: `https://acme.ghe.com/acme/repo/pull/${number}`,
  };
}

function comment(
  id: number,
  body: string,
  created: string,
  issueNumber = 1,
  author = "alice",
): CommentSummary {
  return {
    id,
    body,
    author,
    authorType: "User",
    createdAt: created,
    updatedAt: created,
    issueNumber,
    htmlUrl: `https://acme.ghe.com/acme/repo/issues/${issueNumber}#issuecomment-${id}`,
    pullRequestReviewId: null,
    path: null,
    line: null,
    originalLine: null,
    diffHunk: null,
    inReplyToId: null,
  };
}

function makePoller(
  store: Store,
  fake: FakeGitHub,
): Poller {
  return new Poller({
    store,
    github: fake as unknown as GitHub,
    logger,
    botSlug: "reviewbot",
  });
}

describe("polling baselines", () => {
  test("initializes new repositories without processing history", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    fake.state.pulls = [
      pull(1, "existing", false, addSeconds(nowIso(), -3600), addSeconds(nowIso(), -3600)),
    ];
    fake.state.issues = [
      issue(1, addSeconds(nowIso(), -3600)),
      issue(2, addSeconds(nowIso(), -1800)),
    ];
    const poller = makePoller(store, fake);
    const result = await poller.pollOnce();
    expect(result.initialized).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(store.queueDepth()).toBe(0);
    expect(store.getPullState(1, 1)!.headSha).toBe("existing");
    store.close();
  });

  test("processes issues created after the baseline only", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.issues = [
      issue(1, addSeconds(nowIso(), -7200)),
      issue(2, addSeconds(nowIso(), 5)),
    ];
    const poller = makePoller(store, fake);
    const result = await poller.pollOnce();
    expect(result.enqueued).toBe(1);
    const job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.key).toBe("triage:1:2");
    expect(JSON.parse(job.payload).issueNumber).toBe(2);
    store.close();
  });

  test("keeps the checkpoint when a source fails, including rate limits", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.failIssues = true;
    const poller = makePoller(store, fake);
    await expect(poller.pollOnce()).rejects.toBeInstanceOf(RateLimitedError);
    expect(store.getRepository(1)!.issuesCursor).toBe(baseline);
    expect(store.getRepository(1)!.lastPollError).toContain("rate limit");
    store.close();
  });
});

describe("polling pull requests", () => {
  test("enqueues an initial review for a new non-draft PR", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.pulls = [pull(4, "abc", false, addSeconds(nowIso(), -10), nowIso())];
    const poller = makePoller(store, fake);
    const result = await poller.pollOnce();
    expect(result.enqueued).toBe(1);
    const job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.key).toBe("review:1:4:abc");
    expect(JSON.parse(job.payload).mode).toBe("initial");
    store.close();
  });

  test("enqueues an incremental review on head change", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    store.upsertPullState({ repoId: 1, number: 4, draft: false, headSha: "old" });
    store.markPullReviewed(1, 4, "old");
    fake.state.pulls = [pull(4, "new", false, addSeconds(nowIso(), -3000), nowIso())];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    const job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.key).toBe("review:1:4:new");
    expect(JSON.parse(job.payload).mode).toBe("incremental");
    expect(JSON.parse(job.payload).previousReviewedSha).toBe("old");
    store.close();
  });

  test("enqueues a review when a draft becomes ready", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    store.upsertPullState({ repoId: 1, number: 4, draft: true, headSha: "same" });
    fake.state.pulls = [pull(4, "same", false, addSeconds(nowIso(), -3000), nowIso())];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    const job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.key).toBe("review:1:4:same");
    store.close();
  });

  test("ignores metadata-only updates that do not change the head", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    store.upsertPullState({ repoId: 1, number: 4, draft: false, headSha: "same" });
    const pr = pull(4, "same", false, addSeconds(nowIso(), -3000), nowIso());
    pr.title = "Edited title";
    fake.state.pulls = [pr];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    expect(store.queueDepth()).toBe(0);
    store.close();
  });

  test("ignores PRs authored by the reviewbot", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    const pr = pull(5, "abc", false, addSeconds(nowIso(), -10), nowIso());
    pr.author = "reviewbot[bot]";
    fake.state.pulls = [pr];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    expect(store.queueDepth()).toBe(0);
    store.close();
  });
});

describe("conditional requests", () => {
  test("advances the pull checkpoint on 304 without reviewing", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    store.setPullsEtag(1, "etag");
    fake.state.notModified = true;
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    expect(store.queueDepth()).toBe(0);
    expect(store.getRepository(1)!.pullsCursor).not.toBe(baseline);
    store.close();
  });
});

describe("mention authorization", () => {
  test("queues authorized mentions and ignores unauthorized users", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.issueComments = [
      comment(10, "@reviewbot can you investigate?", addSeconds(nowIso(), 5)),
    ];
    fake.state.permission = "read";
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    expect(store.queueDepth()).toBe(0);

    fake.state.permission = "admin";
    fake.repository = { ...fake.repository };
    // Cursors advanced, so use a fresh store to isolate the authorized case.
    const store2 = new Store(":memory:");
    store2.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    const poller2 = makePoller(store2, fake);
    await poller2.pollOnce();
    expect(store2.queueDepth()).toBe(1);
    const job = store2.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.kind).toBe("conversation");
    store.close();
    store2.close();
  });

  test("treats explicit change instructions as fix jobs", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.permission = "write";
    fake.state.issueComments = [
      comment(11, "@reviewbot fix the issue and open a draft PR", addSeconds(nowIso(), 5)),
    ];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    const job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.kind).toBe("fix");
    store.close();
  });

  test("skips an unprocessable mention but continues and advances the checkpoint", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.permission = "write";
    fake.state.permissionErrorFor = "mallory";
    fake.state.issueComments = [
      comment(20, "@reviewbot investigate", addSeconds(nowIso(), 5), 1, "mallory"),
      comment(21, "@reviewbot investigate", addSeconds(nowIso(), 6), 1, "alice"),
    ];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    expect(store.queueDepth()).toBe(1);
    const job = store.claimNextJob(addSeconds(nowIso(), 3600))!;
    expect(job.key).toBe("conversation:1:21");
    expect(store.getRepository(1)!.commentsCursor).not.toBe(baseline);
    store.close();
  });

  test("ignores comments created at or before the baseline", async () => {
    const store = new Store(":memory:");
    const fake = new FakeGitHub();
    const baseline = addSeconds(nowIso(), -3600);
    store.upsertRepository({
      id: 1,
      installationId: 1,
      owner: "acme",
      name: "repo",
      fullName: "acme/repo",
      defaultBranch: "main",
      baseline,
    });
    fake.state.issueComments = [
      comment(12, "@reviewbot investigate", addSeconds(nowIso(), -7200)),
    ];
    const poller = makePoller(store, fake);
    await poller.pollOnce();
    expect(store.queueDepth()).toBe(0);
    store.close();
  });
});
