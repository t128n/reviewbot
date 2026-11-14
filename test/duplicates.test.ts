import { describe, expect, test } from "bun:test";
import type { DuplicateCaseRecord } from "../src/db.ts";
import type { IssueSummary } from "../src/github.ts";
import {
  decisionReference,
  duplicateNoticeBody,
  extractIssueReferences,
  isMaintainerOverride,
  isSubstantiveComment,
  readDecisionReference,
  resolveCanonical,
  resolveDuplicateDecision,
  type CanonicalLookup,
} from "../src/duplicates.ts";
import { discoverDuplicateCandidates } from "../src/duplicate-discovery.ts";
import type { Logger } from "../src/log.ts";
import type { GitHub, GitHubClient, CommentSummary } from "../src/github.ts";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const owner = "acme";
const repo = "repo";

function issue(
  number: number,
  overrides: Partial<IssueSummary> = {},
): IssueSummary {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    author: "reporter",
    authorType: "User",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    isPullRequest: false,
    state: "open",
    stateReason: null,
    labels: [],
    htmlUrl: `https://acme.ghe.com/acme/repo/issues/${number}`,
    ...overrides,
  };
}

function caseRecord(
  issueNumber: number,
  canonical: number,
  status: DuplicateCaseRecord["status"] = "pending",
): DuplicateCaseRecord {
  return {
    repoId: 1,
    issueNumber,
    canonicalIssueNumber: canonical,
    classification: "confirmed",
    status,
    noticeCommentId: 1,
    noticeRevision: 1,
    noticePostedAt: "2026-01-01T00:00:00.000Z",
    dueAt: "2026-01-02T00:00:00.000Z",
    lastCheckedCommentId: null,
    lastDecisionReference: null,
    botClosed: false,
    botAppliedLabels: [],
    followupExplained: false,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function lookup(input: {
  issues: IssueSummary[];
  cases?: Record<number, DuplicateCaseRecord>;
}): CanonicalLookup {
  return {
    getIssue: async (number) =>
      input.issues.find((candidate) => candidate.number === number) ?? null,
    getCase: (number) => input.cases?.[number] ?? null,
  };
}

describe("issue reference extraction", () => {
  test("finds same-repository hash, URL, and cross-repository references", () => {
    expect(
      extractIssueReferences(
        "see #12, https://acme.ghe.com/acme/repo/issues/13, acme/repo#14, other/repo#99",
        owner,
        repo,
      ).sort((a, b) => a - b),
    ).toEqual([12, 13, 14]);
    expect(
      extractIssueReferences(
        "https://acme.ghe.com/acme/repo/pull/21",
        owner,
        repo,
      ),
    ).toEqual([21]);
  });

  test("ignores URLs for other repositories and colour codes", () => {
    expect(
      extractIssueReferences(
        "https://acme.ghe.com/other/repo/issues/7 and #ffffff",
        owner,
        repo,
      ),
    ).toEqual([]);
  });
});

describe("comment evidence", () => {
  test("ignores acknowledgements and status pings", () => {
    for (const body of [
      "thanks!",
      "Thank you",
      "+1",
      "same here",
      "me too",
      "bump",
      "any update?",
      "Thanks for the screenshot",
      "🙏",
      "I have the same issue, any update?",
      "still happening on my machine",
    ]) {
      expect(isSubstantiveComment(body)).toBe(false);
    }
  });

  test("accepts evidence with details or an image", () => {
    expect(
      isSubstantiveComment(
        "This only happens on Linux 6.2 when the tray icon is enabled.",
      ),
    ).toBe(true);
    expect(isSubstantiveComment("This is different")).toBe(true);
    expect(isSubstantiveComment("![screenshot](https://example.invalid/a.png)")).toBe(
      true,
    );
  });

  test("detects explicit maintainer overrides", () => {
    expect(isMaintainerOverride("Please keep this open, it is not a duplicate.")).toBe(
      true,
    );
    expect(isMaintainerOverride("Don't close this issue")).toBe(true);
    expect(isMaintainerOverride("Thanks, that fixed it")).toBe(false);
  });
});

describe("duplicate notice wording", () => {
  test("appends the fixed 24-hour disclosure and canonical link", () => {
    const body = duplicateNoticeBody({
      comment: "Both reports describe the same freeze.",
      canonical: 1,
      classification: "confirmed",
    });
    expect(body).toContain("#1");
    expect(body).toContain("24 hours");
    expect(body).toContain("material difference");
  });

  test("asks a targeted question when the model omitted one", () => {
    const body = duplicateNoticeBody({
      comment: "The symptoms look the same on Windows.",
      canonical: 7,
      classification: "likely",
    });
    expect(body).toContain("How does your case differ from #7?");
    expect(body).toContain("24 hours");
  });

  test("round-trips the persisted decision reference", () => {
    const raw = decisionReference({
      decision: {
        kind: "confirmed_duplicate",
        canonicalIssueNumber: 1,
        reason: "same report",
        matchingEvidence: ["same stack trace"],
      },
      noticeComment: "notice",
      resolvedCanonical: 1,
      revision: 2,
    });
    expect(readDecisionReference(raw)).toEqual({
      noticeComment: "notice",
      canonicalIssueNumber: 1,
      reason: "same report",
    });
  });
});

describe("canonical selection and downgrades", () => {
  test("follows verified duplicate chains to the original", async () => {
    const resolution = await resolveCanonical({
      currentNumber: 4,
      proposedNumber: 3,
      lookup: lookup({
        issues: [issue(1), issue(2), issue(3), issue(4)],
        cases: {
          3: caseRecord(3, 2),
          2: caseRecord(2, 1),
        },
      }),
    });
    expect(resolution.error).toBeNull();
    expect(resolution.canonical?.number).toBe(1);
    expect(resolution.chain).toEqual([3, 2, 1]);
  });

  test("fails safely on a duplicate cycle and a self reference", async () => {
    const cycle = await resolveCanonical({
      currentNumber: 4,
      proposedNumber: 3,
      lookup: lookup({
        issues: [issue(3), issue(2), issue(4)],
        cases: {
          3: caseRecord(3, 2),
          2: caseRecord(2, 3),
        },
      }),
    });
    expect(cycle.canonical).toBeNull();
    expect(cycle.error).toContain("circular");

    const self = await resolveCanonical({
      currentNumber: 4,
      proposedNumber: 4,
      lookup: lookup({ issues: [issue(4)] }),
    });
    expect(self.canonical).toBeNull();
  });

  test("does not follow a negated duplicate reference", async () => {
    const resolution = await resolveCanonical({
      currentNumber: 2,
      proposedNumber: 1,
      lookup: lookup({
        issues: [
          issue(1, {
            state: "closed",
            body: "This is not a duplicate of #5. It is its own regression.",
          }),
          issue(2),
          issue(5),
        ],
      }),
    });
    expect(resolution.error).toBeNull();
    expect(resolution.canonical?.number).toBe(1);
  });

  test("downgrades a confirmed duplicate when the canonical is a pull request", async () => {
    const resolution = await resolveDuplicateDecision({
      decision: {
        kind: "confirmed_duplicate",
        canonicalIssueNumber: 3,
        reason: "same",
        matchingEvidence: ["same crash"],
      },
      current: issue(4),
      bodyText: "see #3",
      owner,
      repo,
      lookup: lookup({ issues: [issue(3, { isPullRequest: true }), issue(4)] }),
    });
    expect(resolution.downgraded).toBe(true);
    expect(resolution.decision.kind).toBe("related");
    expect(resolution.canonical).toBeNull();
  });

  test("does not close a regression against a closed canonical issue without an explicit link", async () => {
    const resolution = await resolveDuplicateDecision({
      decision: {
        kind: "confirmed_duplicate",
        canonicalIssueNumber: 1,
        reason: "same symptom",
        matchingEvidence: ["same crash"],
      },
      current: issue(2),
      bodyText: "The app crashes after the update.",
      owner,
      repo,
      lookup: lookup({ issues: [issue(1, { state: "closed", stateReason: "completed" }), issue(2)] }),
    });
    expect(resolution.downgraded).toBe(true);
    expect(resolution.decision.kind).toBe("related");
  });

  test("allows an explicitly linked closed incident to remain canonical", async () => {
    const resolution = await resolveDuplicateDecision({
      decision: {
        kind: "confirmed_duplicate",
        canonicalIssueNumber: 1,
        reason: "same report",
        matchingEvidence: ["same stack trace"],
      },
      current: issue(2),
      bodyText: "This is the same as #1.",
      owner,
      repo,
      lookup: lookup({
        issues: [
          issue(1, { state: "closed", stateReason: "completed" }),
          issue(2),
        ],
      }),
    });
    expect(resolution.downgraded).toBe(false);
    expect(resolution.decision.kind).toBe("confirmed_duplicate");
    expect(resolution.canonical?.number).toBe(1);
  });

  test("leaves unrelated issues alone", async () => {
    const resolution = await resolveDuplicateDecision({
      decision: {
        kind: "independent",
        reason: "no matching report",
      },
      current: issue(9),
      bodyText: "New failure with no reference.",
      owner,
      repo,
      lookup: lookup({ issues: [issue(9)] }),
    });
    expect(resolution.decision.kind).toBe("independent");
    expect(resolution.canonical).toBeNull();
  });
});

interface DiscoveryFakeState {
  issues: IssueSummary[];
  searchResults: IssueSummary[];
  recent: IssueSummary[];
  failSearch?: boolean;
  failGraphql?: boolean;
  comments?: Record<number, CommentSummary[]>;
  nodeOverrides?: Record<number, Record<string, unknown>>;
}

class DiscoveryFake {
  state: DiscoveryFakeState;
  searched: string[] = [];
  fetched: number[] = [];

  constructor(state: DiscoveryFakeState) {
    this.state = state;
  }

  private findIssue(number: number): IssueSummary | undefined {
    return (
      this.state.issues.find((item) => item.number === number) ??
      this.state.searchResults.find((item) => item.number === number) ??
      this.state.recent.find((item) => item.number === number)
    );
  }

  async graphql<T = unknown>(
    _octokit: unknown,
    _query: string,
    variables: Record<string, string | number> = {},
  ): Promise<T> {
    if (this.state.failGraphql) {
      throw Object.assign(new Error("graphql unavailable"), { status: 502 });
    }
    const number = Number(variables.n ?? 0);
    this.fetched.push(number);
    const found = this.findIssue(number);
    const override = this.state.nodeOverrides?.[number];
    if (!found && !override) {
      return { data: { repository: { issueOrPullRequest: null } } } as T;
    }
    const comments = (this.state.comments?.[number] ?? []).map((c) => ({
      body: c.body,
      author: { login: c.author },
    }));
    const base = found
      ? {
          __typename: found.isPullRequest ? "PullRequest" : "Issue",
          title: found.title,
          state: found.state.toUpperCase(),
          url: found.htmlUrl,
          body: found.body ?? "",
          author: { login: found.author },
          createdAt: found.createdAt,
          reactions: { totalCount: 0 },
          participants: { totalCount: 1 },
          comments: { totalCount: comments.length, nodes: comments },
          timelineItems: { nodes: [] },
        }
      : {};
    return {
      data: {
        repository: {
          issueOrPullRequest: { ...base, ...override },
        },
      },
    } as T;
  }

  async getIssue(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    number: number,
  ): Promise<IssueSummary> {
    this.fetched.push(number);
    const found = this.state.issues.find((item) => item.number === number);
    if (!found) {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    return found;
  }

  async searchIssues(
    _octokit: unknown,
    query: string,
  ): Promise<IssueSummary[]> {
    this.searched.push(query);
    if (this.state.failSearch) {
      throw Object.assign(new Error("secondary rate limit"), {
        status: 403,
        rateLimited: true,
      });
    }
    return this.state.searchResults;
  }

  async listRecentIssues(): Promise<IssueSummary[]> {
    return this.state.recent;
  }

  async listIssueCommentsLimited(
    _octokit: unknown,
    _owner: string,
    _repo: string,
    number: number,
  ): Promise<CommentSummary[]> {
    return this.state.comments?.[number] ?? [];
  }
}

function discoveryHarness(state: DiscoveryFakeState) {
  const fake = new DiscoveryFake(state);
  return fake;
}

describe("bounded duplicate discovery", () => {
  test("resolves direct references even when search is unavailable", async () => {
    const fake = discoveryHarness({
      issues: [issue(1), issue(2)],
      searchResults: [],
      recent: [issue(2)],
      failSearch: true,
    });
    const result = await discoverDuplicateCandidates({
      github: fake as unknown as Pick<
        GitHub,
        "graphql" | "searchIssues" | "listRecentIssues"
      >,
      octokit: {} as GitHubClient,
      owner,
      repo,
      current: issue(2, { body: "duplicate of #1" }),
      currentComments: [],
      logger,
    });
    expect(result.searchUnavailable).toBe(true);
    expect(result.candidates.map((candidate) => candidate.number)).toContain(1);
    expect(result.candidates.find((candidate) => candidate.number === 1)?.referenced).toBe(
      true,
    );
  });

  test("records unresolved explicit references without inventing a candidate", async () => {
    const fake = discoveryHarness({
      issues: [],
      searchResults: [],
      recent: [issue(2)],
    });
    const result = await discoverDuplicateCandidates({
      github: fake as unknown as GitHub,
      octokit: {} as GitHubClient,
      owner,
      repo,
      current: issue(2, { body: "see #99" }),
      currentComments: [],
      logger,
    });
    expect(result.unresolvedReferences).toEqual([99]);
    expect(result.candidates).toHaveLength(0);
  });

  test("bounds queries and candidate count and excludes the current issue", async () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      issue(index + 3, { title: `Crash when switching workspace ${index}` }),
    );
    const fake = discoveryHarness({
      issues: [],
      searchResults: many,
      recent: [...many, issue(2)],
    });
    const result = await discoverDuplicateCandidates({
      github: fake as unknown as GitHub,
      octokit: {} as GitHubClient,
      owner,
      repo,
      current: issue(2, {
        title: "Crash when switching workspace",
        body: "The application crashes when switching workspace",
      }),
      currentComments: [],
      logger,
    });
    expect(result.queries).toBeLessThanOrEqual(3);
    expect(result.candidates.length).toBeLessThanOrEqual(20);
    expect(result.candidates.some((candidate) => candidate.number === 2)).toBe(false);
    expect(fake.searched.some((query) => query.includes("is:closed"))).toBe(true);
  });

  test("discovers 1-hop graph neighbors, PR verdicts, mentionedBy, and file overlaps", async () => {
    const fake = discoveryHarness({
      issues: [
        issue(10, { title: "Session drops on reconnect" }),
        issue(11, { title: "Reconnect loses session", body: "Related to #10" }),
        issue(12, {
          title: "fix: keep session on reconnect",
          isPullRequest: true,
          state: "closed",
        }),
        issue(13, {
          title: "alt: preserve session on reconnect",
          isPullRequest: true,
          state: "open",
        }),
        issue(14, {
          title: "refactor: session store",
          isPullRequest: true,
          state: "open",
        }),
      ],
      searchResults: [],
      recent: [],
      nodeOverrides: {
        10: {
          reactions: { totalCount: 5 },
          participants: { totalCount: 3 },
          comments: {
            totalCount: 2,
            nodes: [
              { body: "Same as #11", author: { login: "alice" } },
              { body: "See PR #13", author: { login: "bob" } },
            ],
          },
          timelineItems: {
            nodes: [
              {
                createdAt: "2026-11-12T00:00:00Z",
                actor: { login: "carol" },
                source: {
                  __typename: "PullRequest",
                  number: 12,
                  repository: { owner: { login: owner }, name: repo },
                },
              },
              {
                createdAt: "2026-11-12T01:00:00Z",
                actor: { login: "dave" },
                source: {
                  __typename: "PullRequest",
                  number: 14,
                  repository: { owner: { login: owner }, name: repo },
                },
              },
            ],
          },
        },
        12: {
          state: "MERGED",
          mergedAt: "2026-11-12T02:00:00Z",
          closingIssuesReferences: {
            nodes: [{ number: 11, repository: { owner: { login: owner }, name: repo } }],
          },
          files: { nodes: [{ path: "src/session.ts", changeType: "MODIFIED" }] },
        },
        13: {
          state: "OPEN",
          closingIssuesReferences: {
            nodes: [{ number: 11, repository: { owner: { login: owner }, name: repo } }],
          },
          files: { nodes: [{ path: "src/session.ts", changeType: "MODIFIED" }] },
        },
        14: {
          state: "OPEN",
          files: { nodes: [{ path: "src/session.ts", changeType: "MODIFIED" }] },
        },
      },
    });

    const result = await discoverDuplicateCandidates({
      github: fake as unknown as Pick<
        GitHub,
        "graphql" | "searchIssues" | "listRecentIssues"
      >,
      octokit: {} as GitHubClient,
      owner,
      repo,
      current: issue(10, {
        title: "Session drops on reconnect",
        body: "Happens after idle timeout",
      }),
      currentComments: [],
      logger,
      now: new Date("2026-11-14T00:00:00Z"),
    });

    const numbers = result.candidates.map((c) => c.number);
    expect(numbers).toEqual(expect.arrayContaining([11, 12, 13, 14]));
    const pr13 = result.candidates.find((c) => c.number === 13);
    expect(pr13?.verdict).toContain("SUPERSEDED by merged acme/repo#12");
    expect(pr13?.mentionedBy).toContain("bob");
    expect(result.overlaps.length).toBeGreaterThanOrEqual(1);
    expect(result.overlaps[0]?.shared).toContain("src/session.ts");
  });

  test("degrades gracefully when GraphQL crawl fails", async () => {
    const fake = discoveryHarness({
      issues: [issue(1)],
      searchResults: [issue(1)],
      recent: [],
      failGraphql: true,
    });
    const result = await discoverDuplicateCandidates({
      github: fake as unknown as Pick<
        GitHub,
        "graphql" | "searchIssues" | "listRecentIssues"
      >,
      octokit: {} as GitHubClient,
      owner,
      repo,
      current: issue(2, { title: "Crash on startup", body: "duplicate of #1" }),
      currentComments: [],
      logger,
    });
    expect(result.searchUnavailable).toBe(true);
    expect(result.candidates.map((c) => c.number)).toContain(1);
  });
});
