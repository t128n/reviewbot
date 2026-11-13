# ADR 0009: Duplicate lifecycle is deterministic, bounded, and advisory at the model boundary

**Status:** Accepted
**Date:** 2026-11-13
**Specification:** `docs/specs/v1.1.md`

## Context

v1.0 triage can mention a related issue but may not change labels or close issues. v1.1
adds a narrow exception: Reviewbot may label and close duplicate issues after a 24-hour
reporter window, and may reopen only duplicates it closed itself.

Duplicate classification depends on reading issue bodies, discussion, and repository
context, which is OpenCode work. But closure and reopening are irreversible GitHub
mutations driven by untrusted issue text. The design must let the model reason about
duplicates without granting it authority to mutate GitHub or determine its own policy
inputs (label names, deadlines, target repository or host).

The existing architecture already provides the needed primitives: one SQLite database with
stable job keys, one worker, outbound polling, read-only OpenCode sessions, marker-backed
publication, and installation-scoped GitHub writes. v1.1 must extend these rather than add a
scheduler, second worker, or workflow engine.

## Decision

1. **The model returns an advisory decision; the daemon owns policy.** `TriageResultSchema`
   carries `{comment, duplicate}` where `duplicate` is a validated union. The model may name
   a canonical issue, a match rationale, evidence, and one distinguishing question. It
   cannot name labels, deadlines, repositories, API hosts, or closure outcomes.
2. **Discovery is bounded and performed by the daemon.** Direct references are resolved by
   issue number. At most three search queries and 20 retrieved candidates are allowed per
   initial triage, plus direct references. Search failure degrades to "no duplicate" rather
   than a guess.
3. **Canonical selection is verified, not trusted.** The daemon fetches the proposed issue,
   rejects self-references and pull requests, follows verified duplicate chains with cycle
   and depth guards, and downgrades a decision when the canonical target is inaccessible.
   A closed canonical issue only supports `confirmed_duplicate` with an explicit reporter
   reference; otherwise the result degrades to `related`, so a regression is not silently
   closed.
4. **One durable case per issue, with intent before publication.** `duplicate_cases` stores
   the validated decision, canonical issue, notice revision and text, `notice_posted_at`,
   `due_at`, checkpoint, bot ownership, and applied-label provenance. The intent is written
   before the notice; the deadline is armed only after GitHub confirms the notice.
5. **Deadline work uses the existing queue.** The repository poll enqueues a
   `duplicate-due` job when `due_at` is reached. Substantive reporter/collaborator comments
   enqueue `duplicate-comment`. There is no scheduler or new daemon.
6. **Every mutation is revalidated and marker-idempotent.** Notices and closure comments use
   stable HTML markers keyed by issue and revision. Before each write the daemon revalidates
   installation access, repository state, issue state, and canonical accessibility. The
   canonical chain is re-resolved at the deadline; if the verified original moved, the case
   receives a new notice and window instead of closing onto a stale target. Retries reconcile
   GitHub comments, labels, issue state, and `state_reason` before acting. Failed deadline
   checks back off and stop automatic retries after three attempts; a failed comment
   reassessment is not re-enqueued for the same comment.
7. **Only two labels are managed.** `pending close` and `duplicate` are hard-coded names with
   recorded provenance. They are created only when missing, added without replacing other
   labels, and removed only when Reviewbot applied them. Label failures are diagnosed but do
   not block the issue workflow.
8. **Human state wins.** Maintainer overrides, human closure/reopening, transfers, or an
   invalid canonical target cancel the case. A cancelled case is never re-armed
   automatically. Reopening is restricted to issues Reviewbot closed under this workflow and
   that GitHub still shows closed with the duplicate state reason.

## Consequences

- Duplicate behavior is testable without a model: tests drive the store, publisher, and a
  fake GitHub through every transition and inject time.
- The model cannot escalate its authority by prompt injection in issue content; at worst it
  produces a comment that is validated, sanitized, and published under fixed policy.
- A failed publication or daemon restart may delay a notice or closure, but cannot produce a
  duplicate notice, premature close, or lost deadline.
- The system has a bounded discovery cost per new issue (three search calls plus candidate
  reads). If search is rate-limited, triage continues without a duplicate claim.
- Semantic deduplication remains intentionally out of scope; canonical quality depends on
  the model's comparison of retrieved evidence and the daemon's verification rules.
