import {
  NODE_QUERY,
  classify,
  crawl,
  fileOverlaps,
  fillMentionedBy,
  parseNodeResponse,
  prioritize,
  score as scoreNode,
  type FetchNode,
  type GhTransport,
  type GraphNode,
  type NodeKey,
  type RawNodeItem,
  type Seed,
  type SeedRef,
} from "issue-graph";
import type { CommentSummary, GitHub, GitHubClient, IssueSummary } from "./github.ts";
import type { Logger } from "./log.ts";
import {
  MAX_DUPLICATE_CANDIDATES,
  MAX_DUPLICATE_QUERIES,
  extractIssueReferences,
} from "./duplicates.ts";

export const CRAWL_MAX_DEPTH = 1;
export const CRAWL_MAX_NODES = 40;
export const CRAWL_HUB_THRESHOLD = 12;
export const CRAWL_CONCURRENCY = 4;

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
  kind: "Issue" | "PullRequest" | "Unknown";
  depth: number;
  verdict?: string;
  flags: string[];
  mentionedBy: string[];
  edges: string[];
}

export interface DuplicateOverlap {
  a: string;
  b: string;
  shared: string[];
  significant: number;
  sharedIssue?: string;
}

export interface DuplicateDiscovery {
  candidates: DuplicateCandidate[];
  overlaps: DuplicateOverlap[];
  unresolvedReferences: number[];
  queries: number;
  searchUnavailable: boolean;
  recentUnavailable: boolean;
  cappedOutCount: number;
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

function queryTerms(text: string, limit = 6): string[] {
  const seen = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function searchQuery(
  owner: string,
  repo: string,
  qualifier: string,
  words: string[],
): string | null {
  if (words.length === 0) return null;
  return `repo:${owner}/${repo} is:issue ${qualifier} (${words.join(" OR ")})`;
}

function nodeKey(owner: string, repo: string, number: number): NodeKey {
  return `${owner}/${repo}#${number}`;
}

function sameRepository(
  node: Pick<GraphNode, "owner" | "repo">,
  owner: string,
  repo: string,
): boolean {
  return (
    node.owner.toLowerCase() === owner.toLowerCase() &&
    node.repo.toLowerCase() === repo.toLowerCase()
  );
}

interface NodeContent {
  body: string;
  comments: CandidateComment[];
}

interface GraphQlEnvelope {
  data?: {
    repository?: {
      issueOrPullRequest?: RawNodeItem | null;
    } | null;
  } | null;
  errors?: unknown[];
}

function createOctokitTransport(options: {
  github: Pick<GitHub, "graphql" | "searchIssues">;
  octokit: GitHubClient;
  owner: string;
  repo: string;
}): GhTransport {
  return {
    async graphql(query, variables) {
      return options.github.graphql<GraphQlEnvelope>(
        options.octokit,
        query,
        variables,
      );
    },
    async search(query, limit): Promise<SeedRef[]> {
      const results = await options.github.searchIssues(
        options.octokit,
        query,
        limit,
      );
      return results.map((item) => ({
        owner: options.owner,
        repo: options.repo,
        number: item.number,
      }));
    },
  };
}

function createCapturingFetchNode(
  transport: GhTransport,
  contentByKey: Map<string, NodeContent>,
): FetchNode {
  return async (owner, repo, number, depth) => {
    try {
      const envelope = (await transport.graphql(NODE_QUERY, {
        owner,
        repo,
        n: number,
      })) as GraphQlEnvelope | undefined;
      const item = envelope?.data?.repository?.issueOrPullRequest;
      if (!item && envelope?.errors?.length) {
        const node = parseNodeResponse(null, owner, repo, number, depth);
        node.state = "FETCH_ERROR";
        return node;
      }
      if (item) {
        const key = nodeKey(owner, repo, number).toLowerCase();
        contentByKey.set(key, {
          body: (item.body ?? "").slice(0, 4_000),
          comments: (item.comments?.nodes ?? []).slice(0, 6).map((comment) => ({
            author: comment.author?.login ?? "unknown",
            body: (comment.body ?? "").slice(0, 1_500),
            createdAt: "",
          })),
        });
      }
      return parseNodeResponse(item, owner, repo, number, depth);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) {
        return parseNodeResponse(null, owner, repo, number, depth);
      }
      throw error;
    }
  };
}

function inboundRefCounts(nodes: Map<NodeKey, GraphNode>): Map<NodeKey, number> {
  const counts = new Map<NodeKey, number>();
  for (const node of nodes.values()) {
    const seenTargets = new Set<NodeKey>();
    for (const edge of node.edges) {
      if (seenTargets.has(edge.to)) continue;
      seenTargets.add(edge.to);
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    }
  }
  return counts;
}

function nodeHeatScore(
  node: GraphNode,
  openScores: Map<NodeKey, number>,
  inboundCounts: Map<NodeKey, number>,
  now: Date,
): number {
  const openScore = openScores.get(node.key);
  if (openScore !== undefined) return openScore;
  const createdAt = node.heat?.createdAt ?? "";
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const daysOpen = Number.isFinite(createdMs)
    ? Math.max(0, Math.floor((now.getTime() - createdMs) / 86_400_000))
    : 0;
  return scoreNode({
    key: node.key,
    kind: node.kind,
    title: node.title,
    url: node.url,
    comments: node.heat?.comments ?? 0,
    participants: node.heat?.participants ?? 0,
    reactions: node.heat?.reactions ?? 0,
    daysOpen,
    inboundRefs: inboundCounts.get(node.key) ?? 0,
  });
}

function candidateFromSeedSummary(
  issue: IssueSummary,
  referenced: boolean,
): DuplicateCandidate {
  return {
    number: issue.number,
    title: issue.title,
    body: (issue.body ?? "").slice(0, 4_000),
    state: issue.state.toUpperCase(),
    isPullRequest: issue.isPullRequest,
    createdAt: issue.createdAt,
    htmlUrl: issue.htmlUrl,
    referenced,
    score: 0,
    comments: [],
    kind: issue.isPullRequest ? "PullRequest" : "Issue",
    depth: 0,
    flags: [],
    mentionedBy: [],
    edges: [],
  };
}

/**
 * Discover a bounded duplicate and related-work candidate set using
 * `issue-graph` over Reviewbot's Octokit client. Direct references and bounded
 * search/recent issues seed a depth-1 graph crawl; classification, heat
 * scoring, reverse mentions, and PR file overlaps enrich the candidates
 * passed to OpenCode.
 */
export async function discoverDuplicateCandidates(options: {
  github: Pick<
    GitHub,
    "graphql" | "searchIssues" | "listRecentIssues"
  >;
  octokit: GitHubClient;
  owner: string;
  repo: string;
  current: IssueSummary;
  currentComments: CommentSummary[];
  logger: Logger;
  now?: Date;
}): Promise<DuplicateDiscovery> {
  const { github, octokit, owner, repo, current } = options;
  const now = options.now ?? new Date();

  const referenceText = [
    current.body ?? "",
    ...options.currentComments.map((comment) => comment.body),
  ].join("\n");
  const references = extractIssueReferences(referenceText, owner, repo)
    .filter((number) => number !== current.number)
    .slice(0, 10);
  const referenceSet = new Set(references);

  const seedNumbers = new Set<number>([current.number, ...references]);
  const fallbackByNumber = new Map<number, IssueSummary>();

  const titleTerms = queryTerms(current.title);
  const bodyTerms = queryTerms(current.body ?? "");
  const queries = [
    searchQuery(owner, repo, "in:title", titleTerms),
    searchQuery(owner, repo, "in:body", bodyTerms),
    searchQuery(owner, repo, "is:closed", bodyTerms),
  ].filter((query): query is string => query !== null);

  let searchUnavailable = false;
  let executed = 0;
  for (const query of queries.slice(0, MAX_DUPLICATE_QUERIES)) {
    executed += 1;
    try {
      const results = await github.searchIssues(octokit, query, 8);
      for (const issue of results) {
        if (issue.number === current.number) continue;
        seedNumbers.add(issue.number);
        fallbackByNumber.set(issue.number, issue);
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
      if (seedNumbers.size >= CRAWL_MAX_NODES) break;
      seedNumbers.add(issue.number);
      if (!fallbackByNumber.has(issue.number)) {
        fallbackByNumber.set(issue.number, issue);
      }
    }
  } catch (error) {
    recentUnavailable = true;
    options.logger.warn(
      { repo: `${owner}/${repo}`, error: messageOf(error) },
      "recent issue context could not be retrieved",
    );
  }

  const seeds: Seed[] = [...seedNumbers].map((number) => ({
    owner,
    repo,
    number,
  }));

  const transport = createOctokitTransport({ github, octokit, owner, repo });
  const contentByKey = new Map<string, NodeContent>();
  const fetchNode = createCapturingFetchNode(transport, contentByKey);

  try {
    const { nodes, cappedOut } = await crawl(
      seeds,
      {
        maxDepth: CRAWL_MAX_DEPTH,
        maxNodes: CRAWL_MAX_NODES,
        hubThreshold: CRAWL_HUB_THRESHOLD,
        concurrency: CRAWL_CONCURRENCY,
        primaryRepo: { owner, repo },
      },
      fetchNode,
    );

    classify(nodes);
    fillMentionedBy(nodes);

    const priorityRows = prioritize(nodes, now);
    const openScores = new Map<NodeKey, number>(
      priorityRows.map((row) => [row.key, row.score]),
    );
    const inboundCounts = inboundRefCounts(nodes);
    const overlaps: DuplicateOverlap[] = fileOverlaps(nodes).map((overlap) => ({
      a: overlap.a,
      b: overlap.b,
      shared: overlap.shared,
      significant: overlap.significant,
      ...(overlap.sharedIssue ? { sharedIssue: overlap.sharedIssue } : {}),
    }));

    const unresolvedReferences: number[] = [];
    for (const refNumber of references) {
      const key = nodeKey(owner, repo, refNumber);
      const node = nodes.get(key);
      if (!node || !node.fetched || node.state === "NOT_FOUND") {
        unresolvedReferences.push(refNumber);
      }
    }

    const candidates: DuplicateCandidate[] = [];
    for (const node of nodes.values()) {
      if (!sameRepository(node, owner, repo)) continue;
      if (node.number === current.number) continue;
      if (!node.fetched || node.state === "NOT_FOUND" || node.state === "FETCH_ERROR") {
        continue;
      }
      const content = contentByKey.get(node.key.toLowerCase());
      const fallback = fallbackByNumber.get(node.number);
      const score = nodeHeatScore(node, openScores, inboundCounts, now);
      candidates.push({
        number: node.number,
        title: node.title || fallback?.title || "",
        body: content?.body ?? (fallback?.body ?? "").slice(0, 4_000),
        state: node.state,
        isPullRequest: node.kind === "PullRequest",
        createdAt: node.heat?.createdAt || fallback?.createdAt || "",
        htmlUrl: node.url || fallback?.htmlUrl || "",
        referenced: referenceSet.has(node.number),
        score,
        comments: content?.comments ?? [],
        kind: node.kind,
        depth: node.depth,
        ...(node.verdict ? { verdict: node.verdict } : {}),
        flags: node.flags ?? [],
        mentionedBy: node.mentionedBy ?? [],
        edges: node.edges.map((edge) => `${edge.via} ${edge.to}`),
      });
    }

    candidates.sort(
      (a, b) =>
        Number(b.referenced) - Number(a.referenced) ||
        a.depth - b.depth ||
        b.score - a.score ||
        Date.parse(a.createdAt || "1970-01-01T00:00:00Z") -
          Date.parse(b.createdAt || "1970-01-01T00:00:00Z") ||
        a.number - b.number,
    );

    return {
      candidates: candidates.slice(0, MAX_DUPLICATE_CANDIDATES),
      overlaps,
      unresolvedReferences,
      queries: executed,
      searchUnavailable,
      recentUnavailable,
      cappedOutCount: cappedOut.size,
    };
  } catch (error) {
    options.logger.warn(
      { repo: `${owner}/${repo}`, issue: current.number, error: messageOf(error) },
      "issue-graph crawl failed; falling back to search and recent issue seeds",
    );
    const fallbackCandidates = [...fallbackByNumber.values()]
      .map((issue) => candidateFromSeedSummary(issue, referenceSet.has(issue.number)))
      .sort(
        (a, b) =>
          Number(b.referenced) - Number(a.referenced) ||
          a.number - b.number,
      )
      .slice(0, MAX_DUPLICATE_CANDIDATES);

    return {
      candidates: fallbackCandidates,
      overlaps: [],
      unresolvedReferences: references.filter((num) => !fallbackByNumber.has(num)),
      queries: executed,
      searchUnavailable: true,
      recentUnavailable,
      cappedOutCount: 0,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
