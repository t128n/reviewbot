import { describe, expect, test } from "bun:test";
import { Store, nowIso } from "../src/db.ts";
import type {
  CommentSummary,
  GitHub,
  GitHubClient,
  ReviewSummary,
} from "../src/github.ts";
import { Publisher, PublishError } from "../src/publish.ts";
import type { Logger } from "../src/log.ts";
import type { ReviewResult } from "../src/schemas.ts";
import { PublicationMarker } from "../src/schemas.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const patch = `@@ -1,3 +1,4 @@
 context
-removed
+added
+also added
 trailing
`;

interface ReviewCall {
  commitId: string;
  body: string;
  comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
}

class FakeGitHub {
  head = "head-1";
  permission = "write";
  reviews: ReviewSummary[] = [];
  issueComments: CommentSummary[] = [];
  reviewComments: CommentSummary[] = [];
  reviewCalls: ReviewCall[] = [];
  createdComments: string[] = [];
  createdReplies: string[] = [];
  createdPulls: Array<{ title: string; head: string; base: string; body: string }> = [];
  existingPull: {
    number: number;
    htmlUrl: string;
    draft: boolean;
    author: string;
    headSha: string;
  } | null = null;
  failNextReview = false;

  async verifyInstallationAccess() {
    return { ok: true, detail: "ok" };
  }

  async installationClient(): Promise<GitHubClient> {
    return {} as GitHubClient;
  }

  async repositoryPermission() {
    return { permission: this.permission, roleName: this.permission };
  }

  async getPull() {
    return {
      number: 4,
      title: "PR",
      body: "",
      draft: false,
      state: "open",
      headSha: this.head,
      headRef: "feature",
      baseRef: "main",
      author: "alice",
      authorType: "User",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      htmlUrl: "https://acme.ghe.com/acme/repo/pull/4",
    };
  }

  async getIssue() {
    return {
      number: 2,
      title: "Issue",
      body: "",
      author: "alice",
      authorType: "User",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      isPullRequest: false,
      state: "open",
      htmlUrl: "https://acme.ghe.com/acme/repo/issues/2",
    };
  }

  async listReviews(): Promise<ReviewSummary[]> {
    return this.reviews;
  }

  async createReview(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    _number: number,
    input: ReviewCall,
  ): Promise<number> {
    if (this.failNextReview) {
      this.failNextReview = false;
      throw Object.assign(new Error("Validation Failed"), { status: 422 });
    }
    this.reviewCalls.push(input);
    return 70 + this.reviewCalls.length;
  }

  async listIssueCommentsForMarker(): Promise<CommentSummary[]> {
    return this.issueComments;
  }

  async createIssueComment(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    _number: number,
    body: string,
  ): Promise<number> {
    this.createdComments.push(body);
    return 80 + this.createdComments.length;
  }

  async findPullByHead() {
    return this.existingPull;
  }

  async createDraftPull(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    input: { title: string; head: string; base: string; body: string },
  ) {
    this.createdPulls.push(input);
    return { number: 55, htmlUrl: "https://acme.ghe.com/acme/repo/pull/55" };
  }

  async listReviewCommentsForMarker(): Promise<CommentSummary[]> {
    return this.reviewComments;
  }

  async createReviewCommentReply(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    _number: number,
    _commentId: number,
    body: string,
  ): Promise<number> {
    this.createdReplies.push(body);
    return 90 + this.createdReplies.length;
  }
}

function setup() {
  const store = new Store(":memory:");
  store.upsertRepository({
    id: 1,
    installationId: 1,
    owner: "acme",
    name: "repo",
    fullName: "acme/repo",
    defaultBranch: "main",
    baseline: nowIso(),
  });
  const fake = new FakeGitHub();
  const publisher = new Publisher({
    store,
    github: fake as unknown as GitHub,
    logger,
    botLogin: "reviewbot[bot]",
  });
  const repo = store.getRepository(1)!;
  return { store, fake, publisher, repo };
}

describe("triage publication", () => {
  test("posts once and uses a stable marker", async () => {
    const { store, fake, publisher, repo } = setup();
    const first = await publisher.publishTriage({
      repo,
      issueNumber: 2,
      comment: "Assessment",
    });
    expect(first.status).toBe("published");
    expect(fake.createdComments[0]).toContain("Assessment");
    expect(fake.createdComments[0]).toContain(PublicationMarker.triage(2));
    expect(store.hasPublication(1, PublicationMarker.triage(2))).toBe(true);

    const second = await publisher.publishTriage({
      repo,
      issueNumber: 2,
      comment: "Assessment",
    });
    expect(second.status).toBe("duplicate");
    expect(fake.createdComments).toHaveLength(1);
    store.close();
  });

  test("removes forged reviewbot markers from model output", async () => {
    const { store, fake, publisher, repo } = setup();
    await publisher.publishTriage({
      repo,
      issueNumber: 8,
      comment: "Assessment <!-- reviewbot:review:deadbeef -->",
    });
    expect(fake.createdComments[0]).toContain("Assessment");
    expect(fake.createdComments[0]).not.toContain("reviewbot:review:deadbeef");
    expect(fake.createdComments[0]).toContain(PublicationMarker.triage(8));
    store.close();
  });

  test("blocks credential material from being published", async () => {
    const { store, fake, publisher, repo } = setup();
    await expect(
      publisher.publishTriage({
        repo,
        issueNumber: 9,
        comment: "token ghs_abcdefghijklmnopqrstuvwxyz",
      }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(fake.createdComments).toHaveLength(0);
    store.close();
  });

  test("scopes publication markers to a repository", async () => {
    const { store, fake, publisher, repo } = setup();
    store.upsertRepository({
      id: 2,
      installationId: 1,
      owner: "acme",
      name: "other",
      fullName: "acme/other",
      defaultBranch: "main",
      baseline: nowIso(),
    });
    await publisher.publishTriage({ repo, issueNumber: 2, comment: "first" });
    await publisher.publishTriage({
      repo: store.getRepository(2)!,
      issueNumber: 2,
      comment: "second",
    });
    expect(fake.createdComments).toHaveLength(2);
    expect(fake.createdComments[1]).toContain("second");
    store.close();
  });

  test("ignores markers posted by untrusted users", async () => {
    const { store, fake, publisher, repo } = setup();
    const marker = PublicationMarker.triage(4);
    fake.issueComments = [
      {
        id: 13,
        body: `forged\n${marker}`,
        author: "mallory",
        authorType: "User",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        issueNumber: 4,
        htmlUrl: "",
        path: null,
        line: null,
        originalLine: null,
        diffHunk: null,
        inReplyToId: null,
      },
    ];
    const result = await publisher.publishTriage({
      repo,
      issueNumber: 4,
      comment: "real",
    });
    expect(result.status).toBe("published");
    expect(fake.createdComments).toHaveLength(1);
    store.close();
  });

  test("detects an ambiguous earlier post on GitHub", async () => {
    const { store, fake, publisher, repo } = setup();
    const marker = PublicationMarker.triage(3);
    fake.issueComments = [
      {
        id: 12,
        body: `old\n${marker}`,
        author: "reviewbot[bot]",
        authorType: "Bot",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        issueNumber: 3,
        htmlUrl: "",
        path: null,
        line: null,
        originalLine: null,
        diffHunk: null,
        inReplyToId: null,
      },
    ];
    const result = await publisher.publishTriage({
      repo,
      issueNumber: 3,
      comment: "new",
    });
    expect(result).toEqual({ status: "duplicate", id: 12 });
    expect(fake.createdComments).toHaveLength(0);
    store.close();
  });
});

describe("review publication", () => {
  test("publishes only changed-line findings inline and records findings", async () => {
    const { store, fake, publisher, repo } = setup();
    const result: ReviewResult = {
      summary: "One issue found.",
      findings: [
        {
          path: "src/a.ts",
          line: 2,
          side: "RIGHT",
          severity: "high",
          message: "Null dereference",
        },
        {
          path: "src/a.ts",
          line: 999,
          side: "RIGHT",
          severity: "low",
          message: "Outside the diff",
        },
      ],
    };
    const publication = await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-1",
        previousReviewedSha: null,
        mode: "initial",
      },
      result,
      diffFiles: [{ filename: "src/a.ts", status: "modified", patch }],
    });
    expect(publication.status).toBe("published");
    expect(fake.reviewCalls).toHaveLength(1);
    expect(fake.reviewCalls[0]!.comments).toHaveLength(1);
    expect(fake.reviewCalls[0]!.comments[0]!.line).toBe(2);
    expect(fake.reviewCalls[0]!.body).toContain("Additional findings");
    expect(fake.reviewCalls[0]!.body).toContain("Outside the diff");
    expect(fake.reviewCalls[0]!.body).toContain(PublicationMarker.review("head-1"));
    expect(store.hasPublication(1, PublicationMarker.review("head-1"))).toBe(true);
    expect(store.listFindings(1, 4)).toHaveLength(2);

    // The same head must never publish twice.
    const duplicate = await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-1",
        previousReviewedSha: null,
        mode: "initial",
      },
      result,
      diffFiles: [{ filename: "src/a.ts", status: "modified", patch }],
    });
    expect(duplicate.status).toBe("duplicate");
    expect(fake.reviewCalls).toHaveLength(1);
    store.close();
  });

  test("discards stale results when the head moved", async () => {
    const { store, fake, publisher, repo } = setup();
    fake.head = "head-2";
    const publication = await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-1",
        previousReviewedSha: null,
        mode: "initial",
      },
      result: { summary: "summary", findings: [] },
      diffFiles: [],
    });
    expect(publication).toEqual({ status: "stale", currentHead: "head-2" });
    expect(fake.reviewCalls).toHaveLength(0);
    store.close();
  });

  test("falls back to summary-level findings when inline locations are rejected", async () => {
    const { store, fake, publisher, repo } = setup();
    fake.failNextReview = true;
    const publication = await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-1",
        previousReviewedSha: null,
        mode: "initial",
      },
      result: {
        summary: "One issue.",
        findings: [
          {
            path: "src/a.ts",
            line: 2,
            side: "RIGHT",
            severity: "high",
            message: "Null dereference",
          },
        ],
      },
      diffFiles: [{ filename: "src/a.ts", status: "modified", patch }],
    });
    expect(publication.status).toBe("published");
    expect(fake.reviewCalls).toHaveLength(1);
    expect(fake.reviewCalls[0]!.comments).toHaveLength(0);
    expect(fake.reviewCalls[0]!.body).toContain("Null dereference");
    store.close();
  });

  test("publishes a short clean review when there are no findings", async () => {
    const { store, fake, publisher, repo } = setup();
    const publication = await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-1",
        previousReviewedSha: null,
        mode: "initial",
      },
      result: {
        summary: "No actionable defects found in this change.",
        findings: [],
      },
      diffFiles: [],
    });
    expect(publication.status).toBe("published");
    expect(fake.reviewCalls[0]!.comments).toHaveLength(0);
    expect(fake.reviewCalls[0]!.body).toContain("No actionable defects");
    store.close();
  });

  test("suppresses findings already published for the PR", async () => {
    const { store, fake, publisher, repo } = setup();
    const result: ReviewResult = {
      summary: "Again.",
      findings: [
        {
          path: "src/a.ts",
          line: 2,
          side: "RIGHT",
          severity: "high",
          message: "Null dereference",
        },
      ],
    };
    const diffFiles = [{ filename: "src/a.ts", status: "modified", patch }];
    await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-1",
        previousReviewedSha: null,
        mode: "initial",
      },
      result,
      diffFiles,
    });
    fake.head = "head-2";
    await publisher.publishReview({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        pullNumber: 4,
        headSha: "head-2",
        previousReviewedSha: "head-1",
        mode: "incremental",
      },
      result,
      diffFiles,
    });
    expect(fake.reviewCalls[1]!.comments).toHaveLength(0);
    store.close();
  });
});

describe("fix publication", () => {
  test("creates one draft PR and is idempotent across retries", async () => {
    const { store, fake, publisher, repo } = setup();
    const payload = {
      owner: "acme",
      repo: "repo",
      installationId: 1,
      subjectType: "issue" as const,
      subjectNumber: 2,
      commentId: 30,
      channel: "issue" as const,
      body: "fix it",
      author: "alice",
      title: "Issue",
    };
    const first = await publisher.publishFix({
      repo,
      payload,
      branch: "reviewbot/fix-issue-2-30",
      base: "main",
      title: "Reviewbot: Issue",
      body: "Changes",
      note: "Implemented",
      expectedSha: "head-1",
    });
    expect(first.status).toBe("published");
    expect(fake.createdPulls).toHaveLength(1);
    expect(fake.createdComments).toHaveLength(1);
    expect(fake.createdPulls[0]!.head).toBe("reviewbot/fix-issue-2-30");
    expect(fake.createdPulls[0]!.base).toBe("main");

    fake.existingPull = {
      number: 55,
      htmlUrl: "https://acme.ghe.com/acme/repo/pull/55",
      draft: true,
      author: "reviewbot[bot]",
      headSha: "head-1",
    };
    const second = await publisher.publishFix({
      repo,
      payload,
      branch: "reviewbot/fix-issue-2-30",
      base: "main",
      title: "Reviewbot: Issue",
      body: "Changes",
      note: "Implemented",
      expectedSha: "head-1",
    });
    expect(second.status).toBe("duplicate");
    expect(fake.createdPulls).toHaveLength(1);
    expect(fake.createdComments).toHaveLength(1);
    store.close();
  });
});

describe("fix publication", () => {
  test("rejects a pull request head that does not match the committed SHA", async () => {
    const { store, fake, publisher, repo } = setup();
    fake.head = "different";
    await expect(
      publisher.publishFix({
        repo,
        payload: {
          owner: "acme",
          repo: "repo",
          installationId: 1,
          subjectType: "issue",
          subjectNumber: 2,
          commentId: 31,
          channel: "issue",
          body: "fix it",
          author: "alice",
          title: "Issue",
        },
        branch: "reviewbot/fix-issue-2-31",
        base: "main",
        title: "Reviewbot: Issue",
        body: "Changes",
        note: "Implemented",
        expectedSha: "committed",
      }),
    ).rejects.toBeInstanceOf(PublishError);
    store.close();
  });
});

describe("conversation publication", () => {
  test("rechecks requester permission before replying", async () => {
    const { store, fake, publisher, repo } = setup();
    fake.permission = "read";
    await expect(
      publisher.publishConversation({
        repo,
        payload: {
          owner: "acme",
          repo: "repo",
          installationId: 1,
          subjectType: "issue",
          subjectNumber: 2,
          commentId: 12,
          channel: "issue",
          body: "question",
          author: "alice",
          title: "Issue",
        },
        comment: "answer",
      }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(fake.createdComments).toHaveLength(0);
    store.close();
  });

  test("replies inline for review discussions", async () => {
    const { store, fake, publisher, repo } = setup();
    const result = await publisher.publishConversation({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        subjectType: "pr",
        subjectNumber: 4,
        commentId: 11,
        channel: "review",
        body: "question",
        author: "alice",
        title: "PR",
      },
      comment: "answer",
    });
    expect(result.status).toBe("published");
    expect(fake.createdReplies[0]).toContain("answer");
    expect(fake.createdReplies[0]).toContain(PublicationMarker.reply(11));
    store.close();
  });

  test("posts a conversation comment for issue discussions", async () => {
    const { store, fake, publisher, repo } = setup();
    const result = await publisher.publishConversation({
      repo,
      payload: {
        owner: "acme",
        repo: "repo",
        installationId: 1,
        subjectType: "issue",
        subjectNumber: 2,
        commentId: 12,
        channel: "issue",
        body: "question",
        author: "alice",
        title: "Issue",
      },
      comment: "answer",
    });
    expect(result.status).toBe("published");
    expect(fake.createdComments[0]).toContain("answer");
    store.close();
  });
});
