# Considerations

## Security model

Reviewbot splits responsibilities deliberately:

- **GitHub** owns collaboration state: issues, pull requests, comments, reviews, permissions.
- **OpenCode** owns reasoning, tools, models, sessions, and project instructions.
- **Reviewbot** owns authentication, discovery, authorization, durable jobs, dispatch,
  validation, and publication.

Untrusted input includes issue and PR text, comments, contributor changes, repository files
and instructions, and model output. The security boundary is enforced at runtime, not by
prompt wording.

### Credentials

- The App private key is stored only in `<data>/credentials/app.json`, restricted to the
  current user. Setup fails if the restriction cannot be applied.
- Installation tokens are requested on demand and kept in memory. They are never written to
  configuration, SQLite, logs, prompts, or Git configuration, and never placed in remote URLs.
- Git authentication uses a host-scoped child-process header. OpenCode never receives GitHub
  credentials.
- Logs redact token-shaped values and authorization headers.
- Only the daemon publishes comments, reviews, labels, commits, and pull requests. Before a
  write it revalidates installation access and, where applicable, the requester's permission,
  the PR head, and diff line locations.

### OpenCode session permissions

Every Reviewbot session is created with an explicit, default-deny ruleset:

- automatic sessions allow `read`, `glob`, and `grep`, restricted to the task workspace;
- credential-shaped files and Reviewbot's own credentials and database are denied;
- edit, shell, Code Mode (`execute`), external directories, network access, subagents, skills,
  questions, and MCP tools remain denied;
- implementation sessions add `edit` inside the worktree and keep execution denied.

Each task runs in a clean wrapper containing the `repo/` checkout. Repository-local OpenCode
configuration, plugins, MCP definitions, and skills are not loaded, so untrusted repository
configuration cannot execute with daemon privileges. Repository instructions are available
as untrusted data, not as configuration.

At startup Reviewbot asks OpenCode how both rulesets resolve the required actions. The gate
opens only when repository reads and implementation edit are allowed and the dangerous
actions are denied. If the probe is inconclusive or fails, automatic processing stops and
jobs stay queued. This is deliberate; do not weaken the gate to make work proceed.

A Git worktree is **not** a sandbox. The permission ruleset is the execution boundary. The
probe verifies OpenCode's decisions, not kernel-level isolation, and Reviewbot does not audit
operator-installed global OpenCode plugins or configuration.

## Permissions and authorization

The App requests `metadata:read`, `contents:write`, `issues:write`, and
`pull_requests:write`. Polling uses read access; writes are narrowed per operation.

Explicit tasks require repository `write`, `maintain`, or `admin` permission, checked through
GitHub's repository permission API:

1. when the task is enqueued;
2. before fix execution;
3. immediately before publication.

Unknown or insufficient permission denies execution. Automatic issue triage and PR reviews
apply to contributors at any permission level.

A duplicate-case follow-up from a reporter or write-access collaborator can supply facts that
pause or cancel a closure without `/rb`. It does not authorize code execution or any other
task; those still require an authorized `/rb` command.

## Duplicate lifecycle side effects

Automatic triage may change only duplicate-related state:

- apply `pending close` when a confirmed or likely duplicate notice is posted;
- leave the issue open for 24 hours;
- after revalidating the issue, canonical issue, installation, and comments, close with
  `state_reason=duplicate`, remove `pending close`, and apply `duplicate`;
- reopen only an issue Reviewbot itself closed under this workflow, and only when new
  evidence shows a material difference.

`pending close` and `duplicate` are the only labels Reviewbot creates or manages. They are
created on demand when missing, added without replacing unrelated labels, and removed only
when Reviewbot applied them. Label API failures are recorded in `status` and do not block the
issue workflow.

Model output is advisory. The daemon verifies the canonical issue, enforces the deadline, and
performs every transition. A maintainer override before closure, a human close or reopen, a
canonical issue that can no longer be verified, or lost access cancels the case. Cancelled
cases are not re-armed automatically, and human state changes are never fought. A maintainer
override on a bot-closed duplicate reopens it once and removes the bot-applied `duplicate`
label. Deadline retries stop after three failed attempts; the issue stays open and the error
appears in `status`.

Operators should tell maintainers and contributors that duplicates may be closed
automatically after the window, and that a substantive reply is the way to stop it.

## What Reviewbot will not do

- Approve, request changes, merge, or create check runs or commit statuses. Reviews always use
  the `COMMENT` state.
- Modify code without an explicit request from an authorized collaborator. It never modifies a
  contributor's branch, never force-pushes, and rejects unrequested CI-workflow edits.
- Run project scripts or tests from untrusted repositories. Draft PRs state that verification
  was static only.
- Manage assignees, milestones, projects, issue titles or bodies, or labels other than the two
  duplicate labels.
- Repair CI, resolve review threads, or close pull requests.
- Host webhooks or tunnels, run a dashboard, support multiple GitHub hosts, or use
  per-repository configuration.
- Select models or agents per task, manage providers, or fall back to another model.
- Deduplicate semantically across repositories.
- Provide kernel-level isolation, or a retry command for permanently failed jobs.

## Known limitations

- Live GHE.com behavior is unverified; see below.
- Task execution needs a working OpenCode model. The security gate does not, but jobs fail and
  are recorded in `status` if the provider is unavailable or out of quota.
- Permanently failed jobs remain failed until a repeated trigger or operator action. There is
  no retry command.
- After an ambiguous review publication is recovered, the head is marked reviewed without
  recording the unpublished model result as published findings, so duplicate suppression may
  be less complete for that head.
- Canonical duplicate selection follows direct references, bounded search, and verified
  bot-managed chains. A closed canonical issue supports `confirmed_duplicate` only when the
  reporter explicitly linked it; other matches are treated as `related` so regressions are not
  silently closed.
- A comment that arrives after the final pre-close read but before GitHub processes the close
  is handled by the post-closure reassessment path.
- Conditional requests cover the stable open-PR list; issue and comment queries use a changing
  `since` window with bounded overlap and idempotent jobs.
- One GitHub host, one operator, one global worker, and one polling interval are supported by
  design.
- Reviewbot verifies permission decisions but does not provide kernel-level isolation or audit
  plugin load paths inside the shared OpenCode process.
- Windows credential ACLs are applied with `icacls`; `doctor` does not independently verify the
  effective ACL.

The full list is maintained in [`README.md`](../../README.md#known-limitations).

## GHE.com status

`*.ghe.com` is GitHub Enterprise Cloud. Reviewbot models it with `https://<host>` for web and
`https://api.<host>` for REST, and never treats it as GitHub Enterprise Server. Host values are
validated, and network destinations come from configuration, never from issue or PR content.

What is verified in this repository:

- host validation and API-host mapping are unit-tested;
- the type check and unit suite pass;
- the v1.1 plan records `reviewbot doctor` passing against a configured `github.com` App and
  OpenCode environment, including credentials, installation permissions, repository access,
  compatibility, storage, and the permission probe.

What remains an external acceptance item:

- organization-owned App manifest registration and installation authentication on GHE.com;
- live publication paths, including label creation and `state_reason=duplicate`;
- the v1.0 acceptance suite (AC-01–AC-20) and the v1.1 suite (AC-21–AC-41) against a test
  organization and repository with working model quota.

Mocked unit tests do not establish GHE.com compatibility. Do not describe a GHE.com
deployment as verified until those checks have run with real credentials.

## Decisions operators must make

- Which organization and repositories to install the App on, and whether automatic duplicate
  closure fits each repository's policy.
- Whether organization policy permits App creation and installation, and who approves it.
- Which OpenCode service, model, and provider quota Reviewbot should use. Global OpenCode
  configuration and plugins are trusted operator configuration.
- The polling interval, and the supervision, log-retention, backup, and disk-capacity policy
  for the host.
- The upgrade cadence. mise does not select prereleases by default.
- For GHE.com, whether to run the acceptance suite before production use.

## What to monitor

- `reviewbot status` for queue depth, active job, last poll, permission-boundary state,
  duplicate-case counts and errors, and recent failures.
- `reviewbot doctor` after upgrades and after any OpenCode, plugin, or configuration change.
- Installation access. Revoked or expired installations halt writes for their repositories.
- Rate-limit backoff in the logs; it is persisted across restarts and capped at one hour.
- Disk usage under `<data>/workspaces`.
- Draft PRs created by explicit fixes. Reviewbot never merges or approves them; a human must
  review and merge.
