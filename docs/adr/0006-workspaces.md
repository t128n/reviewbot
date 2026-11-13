# ADR 0006: Workspace strategy and explicit-change flow

**Status:** Accepted

## Context

Reviewbot needs repository content for evidence-based triage and reviews, and isolated
workspaces for explicitly requested fixes. The specification forbids modifying contributor
branches, automatic merges/approvals, and running untrusted code. Git worktrees are not a
sandbox; execution safety comes from the OpenCode permission ruleset.

## Decision

- Maintain one bare mirror clone per repository under the data directory, authenticated by
  short-lived installation tokens supplied through child-process environment headers.
- Create a disposable detached worktree per task from a fetched PR head
  (`refs/pull/<n>/head`) or the default branch. Remove it after the job.
- Automatic tasks receive read-only OpenCode sessions restricted to that worktree.
- Explicit fixes require a maintainer request (write permission re-checked immediately
  before execution and before push). OpenCode receives an `edit`-only session in the
  worktree; shell and test execution remain denied. If verification is impossible, the
  result and draft PR state that verification was not performed.
- The daemon verifies that Git metadata still resolves inside its repository storage, stages
  all changes, records the changed file list and diff stat, rejects unrequested CI-workflow
  edits, commits on a new branch, pushes to the target repository, and opens a draft PR:
  - issue request → branch from default branch, PR targets default branch;
  - PR request → branch from the original PR head, PR targets the original PR base and
    states that it includes the original PR's changes;
  - links the originating issue/PR.
- Contributor branches are never pushed to or modified. Branch protection or permission
  failures are reported, not bypassed.

## Alternatives considered

- **Reuse a single checkout per repository.** Breaks isolation between concurrent tasks and
  risks stale content.
- **Clone into the user's workspace.** Pollutes user projects and creates path-access risk.
- **Let OpenCode run tests and push.** Violates credential isolation and the execution
  boundary.
- **Sandbox provisioning.** Out of scope.

## Consequences

- Disk usage grows with repositories and cached fetches.
- Fork PR heads are fetched through the base repository's `refs/pull/<n>/head`, which
  requires only base-repository installation access.
- Fix quality is limited to static reasoning because tests are not executed by default.
