# ADR 0011: Replace token-overlap duplicate discovery with issue-graph

**Status:** Accepted  
**Date:** 2026-11-14  
**Specification:** `docs/specs/v1.2.md`

## Context

Reviewbot v1.1 (`docs/specs/v1.1.md`, ADR 0009) introduced bounded duplicate discovery in
`src/duplicate-discovery.ts`. That implementation used a hand-rolled keyword tokenizer,
three REST search queries, recent-issue listing, and word-overlap scoring to rank up to 20
candidate issues, followed by separate REST calls to fetch comments for the top candidates.

That approach has three limitations:

1. **Structural blindness:** Token overlap misses issues and pull requests connected via
   GitHub cross-references, `connected` timeline events, `closingIssuesReferences`, and
   `mentionedBy` backlinks when the wording differs.
2. **No PR or overlap awareness:** It cannot surface whether an existing PR already claims
   to close a candidate, whether an open PR is superseded by a merged PR, or whether
   multiple open PRs touch overlapping files.
3. **Redundant REST round-trips:** Separate issue-comment calls are needed after ranking.

`issue-graph` provides a runtime-agnostic graph crawler (`crawl`), structural edge parser
(`NODE_QUERY`, `parseNodeResponse`), relationship classifier (`classify`,
`fillMentionedBy`), heat-based prioritizer (`prioritize`, `score`), and PR file-overlap
detector (`fileOverlaps`). However, its built-in transports (`shell` via `gh` CLI and
`http` via `fetch` hardcoded to `api.github.com`) do not fit Reviewbot's security and
GitHub Enterprise requirements.

## Decision

1. **Replace token-overlap discovery with `issue-graph` in `src/duplicate-discovery.ts`.**
   `discoverDuplicateCandidates` uses `issue-graph` (`crawl`, `classify`, `fillMentionedBy`,
   `prioritize`, `score`, `fileOverlaps`) to build and rank the bounded candidate set.
2. **Implement an Octokit-backed `GhTransport` in the daemon.** `src/github.ts` adds a
   `graphql` method on `GitHub` using `this.request(octokit, "POST /graphql", ...)`. The
   discovery module adapts `GitHub` into `issue-graph`'s `GhTransport` interface instead of
   using `issue-graph/transport/shell` (`gh` CLI) or `issue-graph/transport/http`.
   - Preserves GitHub App installation authentication and `*.ghe.com` host support.
   - Keeps all credentials and GitHub API access strictly inside the Reviewbot daemon.
   - Preserves OpenCode's clean, read-only, tokenless session boundary.
3. **Use `NODE_QUERY` as the single per-node fetch.** Wrapping `parseNodeResponse` captures
   each crawled node's `body` and `comments` directly from the GraphQL response, avoiding
   extra per-candidate comment REST requests.
4. **Keep discovery bounded and same-repository.** Seeds are the current issue, up to 10
   explicit same-repository references, up to 3 bounded search queries (including closed
   issues), and recent repository issues when needed. Crawling is bounded (`maxDepth: 1`,
   `maxNodes: 40`, `hubThreshold: 12`), and output remains capped at 20 same-repository
   candidates.
5. **Surface graph context to OpenCode without expanding model authority.** `src/worker.ts`
   includes `issue-graph` signals (`kind`, `depth`, heat `score`, `verdict`, `flags`,
   `edges`, `mentionedBy`, and `fileOverlaps`) in the triage prompt. Canonical verification,
   duplicate lifecycle state transitions, labels, and closures remain deterministic daemon
   policy.

## Consequences

- Triage sees structural GitHub relationships (cross-references, closing PRs, superseded
  PRs, file overlaps, and discussion heat) rather than keyword overlap alone.
- `gh` CLI and personal access tokens remain unnecessary; `*.ghe.com` installations work
  through the existing `Octokit` client.
- Discovery remains testable offline by mocking `GitHub.graphql`, `GitHub.searchIssues`,
  and `GitHub.listRecentIssues` with in-memory fixtures.
- Existing v1.1 security invariants, duplicate lifecycle state machine, and label policy
  remain unchanged.
