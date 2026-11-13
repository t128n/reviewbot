export interface RelatedIssueCandidate {
  number: number;
  title: string;
  body: string | null;
  state: string;
  isPullRequest: boolean;
}

export interface RelatedIssue {
  number: number;
  title: string;
  excerpt: string;
  state: string;
  isPullRequest: boolean;
  score: number;
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
]);

function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return new Set(words.slice(0, 80));
}

/**
 * Select a small set of potentially related issues/PRs using title/body
 * keyword overlap. This gives the agent bounded repository context without
 * granting it GitHub access or storing conversations.
 */
export function selectRelatedIssues(
  current: { number: number; title: string; body: string | null },
  candidates: RelatedIssueCandidate[],
  limit = 5,
): RelatedIssue[] {
  const currentKeywords = keywords(`${current.title} ${current.body ?? ""}`);
  if (currentKeywords.size === 0) return [];
  const scored: RelatedIssue[] = [];
  for (const candidate of candidates) {
    if (candidate.number === current.number) continue;
    const candidateKeywords = keywords(
      `${candidate.title} ${candidate.body ?? ""}`,
    );
    let score = 0;
    for (const keyword of currentKeywords) {
      if (candidateKeywords.has(keyword)) score += 1;
    }
    if (score === 0) continue;
    scored.push({
      number: candidate.number,
      title: candidate.title,
      excerpt: (candidate.body ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      state: candidate.state,
      isPullRequest: candidate.isPullRequest,
      score,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .slice(0, limit);
}
