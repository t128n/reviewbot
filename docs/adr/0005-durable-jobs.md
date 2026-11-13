# ADR 0005: Durable single-worker jobs with idempotent publication

**Status:** Accepted

## Context

Jobs can be interrupted by process restarts, timeouts, or ambiguous GitHub failures. The
specification requires durable queued/running state, a single global worker, at most two
retries for transient errors, no retries for permanent failures, and no duplicate
publication after restart. Publication identifiers must allow recovery.

## Decision

- One SQLite database in WAL mode holds installation/repository state, cursors, session
  mappings, jobs, reviewed heads, publication markers, and finding dedupe hashes.
- Job kinds: `triage`, `review`, `conversation`, `fix`. Each has a stable dedupe key
  (`triage:<repo>:<issue>`, `review:<repo>:<pr>:<head>`, `conversation:<repo>:<comment>`,
  `fix:<repo>:<comment>`). An upsert on the key makes enqueueing idempotent and refreshes the payload when a
  permanently failed trigger is seen again.
- The worker claims one job in a transaction (`queued` → `running`), executes it with a
  task-specific timeout, then marks it `completed` or `failed`. Transient failures are
  retried at most twice with backoff; authorization, validation, and malformed-output
  failures are permanent. A repeated trigger may re-enqueue a permanently failed job with a
  fresh attempt budget.
- On startup, `running` jobs are returned to `queued` and reconciled. Every publication is
  preceded by a lookup of its publication marker in SQLite and, after an ambiguous failure,
  in GitHub. Existing markers complete the job instead of posting again.
- If an ambiguous review publication is discovered by marker, the head is marked reviewed
  but the unpublished model result is not recorded as published findings; this avoids
  suppressing valid future findings at the cost of less complete dedupe for that head.
- Publication markers are keyed by repository and marker text; marker lookups on GitHub only
  accept comments/reviews authored by the installed App, so untrusted users cannot forge
  idempotency markers. Model-derived text is stripped of marker-like sequences.
- PR reviews carry the reviewed head SHA. The head is re-fetched immediately before
  publishing; if it changed, the result is discarded and a review for the new head is
  queued. This prevents publishing stale assessments.
- A findings table stores a hash of each published finding per PR so incremental reviews
  can suppress duplicates without storing conversation history.

## Alternatives considered

- **In-memory queue.** Loses jobs on restart and cannot reconcile publication.
- **External queue (Redis).** Excluded dependency and unnecessary for a single worker.
- **Parallel workers.** Explicitly out of scope and would complicate idempotency and
  OpenCode session ownership.
- **Storing full GitHub/OpenCode transcripts.** Excluded; GitHub and OpenCode remain the
  authoritative stores.

## Consequences

- Publication markers are part of the external contract and must remain stable.
- Job retries re-run the model when a failure occurs before publication; an ambiguous
  publication is detected by marker instead of re-running blindly.
- SQLite must remain accessible for the daemon to operate; `doctor` checks this.
