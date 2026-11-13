import type { CommentSummary, GitHub, GitHubClient, IssueSummary } from "./github.ts";
import type { Logger } from "./log.ts";
import {
  MAX_DUPLICATE_CANDIDATES,
  MAX_DUPLICATE_QUERIES,
  extractIssueReferences,
} from "./duplicates.ts";

export interface CandidateComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface DuplicateCandidate {
  number: number;
  title: string;
  body: string;
  state: string;
  isPullRequest: boolean;
  createdAt: string;
  htmlUrl: string;
  referenced: boolean;
  score: number;
  comments: CandidateComment[];
}

export interface DuplicateDiscovery {
  candidates: DuplicateCandidate[];
  unresolvedReferences: number[];
  queries: number;
  searchUnavailable: boolean;
  recentUnavailable: boolean;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "when",
  "what",
  "have",
  "into",
  "does",
  "should",
  "would",
  "could",
  "there",
  "their",
  "about",
  "issue",
  "error",
  "problem",
  "after",
  "before",
  "using",
  "please",
  "also",
  "only",
  "still",
  "which",
  "where",
  "while",
  "then",
  "than",
  "been",
  "were",
  "will",
  "your",
  "you",
  "its",
  "it's",
]);

function tokens(text: string, limit = 40): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
    .slice(0, limit);
}

function overlap(a: string[], b: string[]): number {
  const right = new Set(b);
  let score = 0;
  for (const token of a) if (right.has(token)) score += 1;
  return score;
}

function searchQuery(
  owner: string,
  repo: string,
  qualifier: string,
  words: string[],
): string | null {
  const terms = [...new Set(words)].slice(0, 6);
  if (terms.length === 0) return null;
  return `repo:${owner}/${repo} is:issue ${qualifier} (${terms.join(" OR ")})`;
}

function candidateFromIssue(
  issue: IssueSummary,
  referenced: boolean,
  score: number,
): DuplicateCandidate {
  return {
    number: issue.number,
    title: issue.title,
    body: (issue.body ?? "").slice(0, 4_000),
    state: issue.state,
    isPullRequest: issue.isPullRequest,
    createdAt: issue.createdAt,
    htmlUrl: issue.htmlUrl,
    referenced,
    score,
    comments: [],
  };
}

/**
 * Discover a bounded duplicate-candidate set. Direct references are fetched by
 * number; search is limited to three queries and the returned candidate list to
 * 20 issues. Search failure degrades to the candidates already known, never to
 * an invented duplicate.
 */
export async function discoverDuplicateCandidates(options: {
  github: Pick<
    GitHub,
    | "searchIssues"
    | "getIssue"
    | "listRecentIssues"
    | "listIssueCommentsLimited"
  >;
  octokit: GitHubClient;
  owner: string;
  repo: string;
  current: IssueSummary;
  currentComments: CommentSummary[];
  logger: Logger;
}): Promise<DuplicateDiscovery> {
  const { github, octokit, owner, repo, current } = options;
  const referenceText = [
    current.body ?? "",
    ...options.currentComments.map((comment) => comment.body),
  ].join("\n");
  const references = extractIssueReferences(referenceText, owner, repo)
    .filter((number) => number !== current.number)
    .slice(0, 10);

  const pool = new Map<number, DuplicateCandidate>();
  const unresolvedReferences: number[] = [];
  const poolLimit = MAX_DUPLICATE_CANDIDATES + references.length;

  for (const number of references) {
    try {
      const issue = await github.getIssue(octokit, owner, repo, number);
      pool.set(number, candidateFromIssue(issue, true, 1_000));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) {
        unresolvedReferences.push(number);
      } else {
        options.logger.warn(
          { issue: number, error: messageOf(error) },
          "explicit duplicate reference could not be retrieved",
        );
      }
    }
  }

  const currentTokens = tokens(`${current.title} ${current.body ?? ""}`);
  const titleTokens = tokens(current.title);
  const bodyTokens = tokens(current.body ?? "");
  const queries = [
    searchQuery(owner, repo, "in:title", titleTokens),
    searchQuery(owner, repo, "in:body", bodyTokens),
    searchQuery(owner, repo, "is:closed", bodyTokens),
  ].filter((query): query is string => query !== null);

  let searchUnavailable = false;
  let executed = 0;
  for (const query of queries.slice(0, MAX_DUPLICATE_QUERIES)) {
    executed += 1;
    try {
      const results = await github.searchIssues(octokit, query, 8);
      for (const issue of results) {
        if (issue.number === current.number) continue;
        if (pool.size >= poolLimit) break;
        const score = overlap(
          currentTokens,
          tokens(`${issue.title} ${issue.body ?? ""}`),
        );
        const existing = pool.get(issue.number);
        if (existing) {
          existing.score = Math.max(existing.score, score);
          continue;
        }
        pool.set(issue.number, candidateFromIssue(issue, false, score));
      }
    } catch (error) {
      searchUnavailable = true;
      options.logger.warn(
        { repo: `${owner}/${repo}`, error: messageOf(error) },
        "duplicate search failed; continuing with direct references and recent issues",
      );
    }
  }

  let recentUnavailable = false;
  try {
    const recent = await github.listRecentIssues(octokit, owner, repo, 20);
    for (const issue of recent) {
      if (issue.number === current.number) continue;
      if (pool.has(issue.number)) continue;
      if (pool.size >= poolLimit) break;
      const score = overlap(
        currentTokens,
        tokens(`${issue.title} ${issue.body ?? ""}`),
      );
      pool.set(issue.number, candidateFromIssue(issue, false, score));
    }
  } catch (error) {
    recentUnavailable = true;
    options.logger.warn(
      { repo: `${owner}/${repo}`, error: messageOf(error) },
      "recent issue context could not be retrieved",
    );
  }

  const ranked = [...pool.values()]
    .filter((candidate) => candidate.referenced || candidate.score > 0)
    .sort(
      (a, b) =>
        Number(b.referenced) - Number(a.referenced) ||
        b.score - a.score ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.number - b.number,
    )
    .slice(0, MAX_DUPLICATE_CANDIDATES);

  const withComments = ranked.filter(
    (candidate) => candidate.referenced || candidate.score >= 2,
  );
  for (const candidate of withComments.slice(0, 6)) {
    try {
      const comments = await github.listIssueCommentsLimited(
        octokit,
        owner,
        repo,
        candidate.number,
        6,
      );
      candidate.comments = comments.map((comment) => ({
        author: comment.author,
        body: comment.body.slice(0, 1_500),
        createdAt: comment.createdAt,
      }));
    } catch (error) {
      options.logger.debug(
        { issue: candidate.number, error: messageOf(error) },
        "candidate discussion could not be retrieved",
      );
    }
  }

  return {
    candidates: ranked,
    unresolvedReferences,
    queries: executed,
    searchUnavailable,
    recentUnavailable,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
