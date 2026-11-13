# ADR 0003: Overlapping REST polling with per-source checkpoints

**Status:** Accepted

## Context

Reviewbot must discover issues, PRs, PR head changes, draft transitions, conversation
comments, inline review comments, and command requests without webhooks. Discovery must not miss
events when pagination or API calls fail, must not retroactively process history, and must
not create loops from its own activity.

GitHub exposes `since` filtering for issue and comment collections but not for pull
requests. Timestamps have second precision and pagination windows can move.

## Decision

- Poll every 60 seconds by default, per installation and repository.
- Persist independent ISO cursors for issues/PRs, issue comments, and inline review
  comments. Pull request state (head SHA, draft, last reviewed SHA) is persisted per PR.
- Query with a bounded overlap (120 seconds) before the stored cursor. Every candidate
  event is deduplicated through a stable job key, so overlap cannot duplicate work.
- Advance a cursor to the poll start time only after every page of that source has been
  enumerated and candidate jobs committed. On failure, leave the cursor unchanged and
  record the error; the next poll re-reads the window.
- New repositories and installations are initialized with cursors set to the discovery
  time. Existing open PRs are recorded as baseline state without enqueueing reviews.
  Events whose creation time is not after the repository baseline are ignored.
- A temporary installation suspension retains cursors so work created during the suspension
  is caught up after reactivation. It is not treated as a fresh repository baseline.
- Exclude events authored by the installed App's own bot identity.
- On rate limiting, stop the cycle, persist the reset time in SQLite, and resume later
  without advancing cursors. The persisted reset is honored after a daemon restart.
- Use ETag conditional requests for the stable open-PR list. The pull cursor and ETag are
  committed in one update only after the list has been fully processed, so a crash cannot
  advance the ETag without the checkpoint. Issue and comment queries carry
  a changing `since` window, so they rely on bounded overlap and idempotent job keys rather
  than conditional requests.

## Alternatives considered

- **Webhooks.** Explicit non-goal; no hosted or tunnel endpoint is allowed.
- **Exact high-water marks without overlap.** Rejected: pagination and timestamp precision
  can skip events.
- **GraphQL polling.** Adds complexity without improving the required event set; REST is
  sufficient and easier to bound.

## Consequences

- Some events are read more than once and deduplicated in SQLite.
- Poll volume is proportional to active repositories and the overlap window.
- PR head detection compares stored head SHAs on every open-PR poll; it does not depend on
  `updated_at`, so metadata edits do not trigger reviews.
- Pagination limits fail the source and retain its checkpoint rather than returning a
  silently truncated collection.
