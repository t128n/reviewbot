# Reviewbot

[![CI](https://github.com/t128n/reviewbot/actions/workflows/ci.yml/badge.svg)](https://github.com/t128n/reviewbot/actions/workflows/ci.yml)

Reviewbot connects GitHub repositories to an existing [OpenCode](https://opencode.ai) V2
service. It provides automatic issue triage and pull request reviews, plus authorized
conversational follow-ups and explicitly requested draft pull requests.

It is an integration layer, not an agent platform:

- **GitHub** owns collaboration state: issues, PRs, comments, reviews, permissions.
- **OpenCode** owns reasoning, tools, models, sessions, and project instructions.
- **Reviewbot** owns authentication, discovery, authorization, durable jobs, task dispatch,
  validation, and publication.

The authoritative product specification is [`docs/specs/v1.1.md`](docs/specs/v1.1.md),
which extends the implemented [`v1.0`](docs/specs/v1.0.md) baseline. Implementation plans and
architectural decisions live in [`docs/plans`](docs/plans) and [`docs/adr`](docs/adr).

## Documentation

Operator documentation lives in [`docs/guide`](docs/guide): installation, setup, daemon
operations, and deployment considerations.

## Requirements

- Bun 1.4.4 or newer, only when running from source (release binaries embed Bun).
- Git on `PATH`.
- An existing, running OpenCode V2 service (2.2.0 or newer; tested with 2.2.7 and
  `@opencode/client` 2.3.0). Reviewbot discovers the registered local service or connects
  to a configured URL. It never starts or manages OpenCode.
- A GitHub App created and installed by an organization on `github.com` or a
  `*.ghe.com` host. The operator needs permission to create and install organization Apps.
  `*.ghe.com` is GitHub Enterprise Cloud; Reviewbot uses the host-specific API at
  `https://api.<host>` and does not treat it as GitHub Enterprise Server.
- Outbound HTTPS access to the GitHub web and API hosts.
- A working OpenCode model configuration. Reviewbot selects no models or agents.

Reviewbot authenticates with GitHub App installation tokens. It does not use personal
access tokens or `gh auth`, and `gh` is not required.

## Install

Install the released binary with [mise](https://mise.jdx.dev):

```bash
mise use -g github:t128n/reviewbot@latest
reviewbot --version
```

Pin a version, or install for a single command without changing global configuration:

```bash
mise use -g github:t128n/reviewbot@1.1.0
mise x github:t128n/reviewbot@1.1.0 -- reviewbot --version
```

Upgrade with `mise upgrade reviewbot`. Releases are standalone binaries for Linux (x64 and
arm64, glibc), macOS (Intel and Apple silicon), and Windows (x64). The macOS and Windows
binaries are not code-signed, so the operating system may ask for confirmation on first
launch.

mise must be activated in the shell (`mise activate`) for the `reviewbot` command to be on
`PATH`; `mise x` works without activation.

### From source

Source installs require Bun 1.4.4 and Git on `PATH`:

```bash
mise install
bun install
bun link        # optional: makes the `reviewbot` command available
```

Run directly without linking:

```bash
bun run src/cli.ts <command>
```

## Setup

```bash
reviewbot setup
```

The wizard:

1. Prompts for the GitHub host and organization.
2. Creates an organization-owned GitHub App through the manifest flow using a temporary
   `127.0.0.1` callback. No public endpoint, tunnel, or webhook receiver is used.
3. Exchanges the callback code through the host-specific API
   (`https://api.<host>/app-manifests/<code>/conversions`).
4. Stores the App credentials with user-only permissions.
5. Opens the installation page and waits for an installation with repository access.
6. Verifies required permissions.
7. Initializes the monitoring baseline. Historical issues and PRs are not processed.

If organization policy blocks App creation or installation, setup reports the restriction.
It does not bypass it.

If OpenCode is unavailable or the permission gate cannot be verified, jobs stay queued and
`status` reports the condition. Reviewbot never weakens the boundary to make progress.

## Commands

```bash
reviewbot setup    # register the App, install it, initialize the baseline
reviewbot run      # foreground polling daemon and single job worker
reviewbot status   # host, OpenCode connectivity, queue, last poll, recent failures
reviewbot doctor   # runtime, Git, GitHub, permissions, OpenCode, security, SQLite checks
```

The operating system supervises `reviewbot run`; there is no built-in service manager.

## Configuration and storage

Configuration is a single global file:

```json
{
  "github": { "host": "acme.ghe.com" },
  "polling": { "intervalSeconds": 60 },
  "opencode": { "url": null, "model": null }
}
```

A null OpenCode URL discovers the registered local service. To connect to an explicit
authenticated service, set `opencode.url` and provide `OPENCODE_SERVER_PASSWORD` in the
environment (basic auth user `opencode`). `opencode.model` is optional: set it to
`providerID/modelID` (for example `opencode-go/deepseek-v4.1-flash`) to use a fixed model for
Reviewbot sessions, or leave it `null` to use OpenCode's default. OpenCode still owns
provider registration, credentials, model enablement, and execution; Reviewbot does not route
models per task or select agents. There is no repository-specific Reviewbot configuration.
One GitHub host is supported per configuration.

Default locations:

| Data | Linux / macOS | Windows |
| --- | --- | --- |
| Configuration | `${XDG_CONFIG_HOME:-~/.config}/reviewbot/config.json` | `%APPDATA%\reviewbot\config.json` |
| Data | `${XDG_DATA_HOME:-~/.local/share}/reviewbot` | `%LOCALAPPDATA%\reviewbot` |
| Credentials | `<data>/credentials/app.json` | `<data>\credentials\app.json` |
| Database | `<data>/reviewbot.db` | `<data>\reviewbot.db` |
| Mirrors and worktrees | `<data>/workspaces` | `<data>\workspaces` |

Credentials are written with mode `0600` on POSIX and a best-effort current-user-only ACL on
Windows. Installation tokens are never persisted.

## Behavior

### Triggers

| Trigger | Action |
| --- | --- |
| New issue | One decision-first triage comment, including bounded duplicate discovery |
| New non-draft PR | One review with inline findings when they map to changed lines |
| New commits on a non-draft PR | Incremental review of changes since the last reviewed commit |
| Draft PR becomes ready | Initial review |
| Authorized `/rb` command | Conversational reply, or a draft PR for an explicit change request |
| Reporter or write-access follow-up on an active duplicate case | Duplicate-only reassessment without a command |
| Duplicate deadline reached | Recheck and close, renew, or cancel the duplicate case |
| Bot's own events | Ignored |
| Title/body/label edits | Ignored |

Start a command with `/rb` at the beginning of a comment or after whitespace, for example `/rb can you investigate this?`. The old `@reviewbot` mention and path fragments such as `src/rb` do not trigger work.

Automatic triage does not modify code, assignees, milestones, or projects. It may change only
the two duplicate labels and the duplicate lifecycle described below. Other issue state changes
are limited to closing a verified duplicate after 24 hours and reopening only a duplicate that
Reviewbot closed. Subsequent general responses still require an authorized `/rb` command.

Polling runs every 60 seconds with bounded overlapping windows and independent checkpoints
for issues, PRs, issue comments, and inline review comments. The open-PR list uses ETag
conditional requests; the other windows carry a changing `since` value and rely on overlap
plus idempotent job keys. Cursors advance only after a source is fully enumerated, and
pagination limits fail the source instead of truncating it. Initial discovery records the
current state without processing history. A single global worker processes one job at a
time.

### Authorization

Explicit tasks require repository `write`, `maintain`, or `admin` permission, checked
through GitHub's repository permission API at enqueue time, before fix execution, and again
immediately before publication. Unknown or insufficient permissions deny execution.
Automatic triage and reviews apply regardless of the contributor's permission level.

### Duplicate lifecycle

New-issue triage resolves explicit issue references and inspects a bounded set of existing
issues (at most three searches and 20 retrieved candidates, plus direct references). The
model proposes `confirmed_duplicate`, `likely_duplicate`, `related`, or `independent`. The
daemon then verifies the canonical issue: it must exist in the same repository, must not be
the current issue or a pull request, and chains resolve to the original with cycle and depth
guards. Model output is advisory; only the daemon can authorize a lifecycle transition.

For a verified duplicate, Reviewbot publishes one concise notice, applies `pending close`, and
records `due_at = notice_posted_at + 24 hours`. The issue stays open. At the deadline the
existing poll loop enqueues a check that re-reads the issue, canonical issue, installation
access, and all comments. Reviewbot then:

- cancels the case and leaves the issue open after a maintainer override, a human state
  change, or a canonical issue that can no longer be verified;
- pauses and reassesses a substantive reporter or write-access follow-up (generic thanks,
  emoji, `+1`, and status pings do not reset the deadline);
- renews the deadline with a new notice when the report is still defensibly the same;
- otherwise posts one closing explanation, closes with `state_reason=duplicate`, replaces
  `pending close` with `duplicate`, and records bot ownership.

Before closing, Reviewbot re-resolves the canonical chain; if the verified original moved, it
posts an updated reference and starts a new 24-hour window instead of closing onto a stale
target. Failed deadline checks back off and stop automatic retries after three attempts, and a
permanently failed comment reassessment is not retried for the same comment; the issue stays
open and the error is visible in `status`.

After closure, a substantiated difference from the reporter or a write-access collaborator can
reopen only an issue that Reviewbot closed as a duplicate. A human reopen, human close, or
cancellation is never fought or automatically re-armed. These labels are created only when
missing; label API failures are recorded in diagnostics and never block the issue workflow.

### Response style

Comments are written as concise maintainer prose, not investigation reports. The shared
instructions live in `src/prompt.md`; task-specific phrasing references in `src/prompts/` are
appended only for the current job kind (triage, duplicate reassessment, review, or
conversation). A confirmed duplicate links the canonical issue, states the match briefly, and
does not repeat evidence already tracked there. Investigation depth does not determine comment
length, and the daemon still appends every deadline and lifecycle disclosure.
Reviewbot also bundles adapted Matt Pocock triage and code-review skills under `src/skills/`;
the relevant skill is included in each automatic task prompt and shipped in standalone
binaries.

### Sessions

Each issue or PR has one conversational OpenCode session, reused for authorized follow-ups.
Session IDs persist in SQLite across daemon restarts, and sessions remain visible through
normal OpenCode interfaces. Automatic PR reviews use fresh sessions. Reviewbot does not
maintain a separate conversational memory.

### Reviews

Findings must be concrete and introduced or exposed by the change. Inline comments are only
published on changed lines; findings that cannot be mapped are included in the review
summary. Previously published findings are suppressed. Reviews always use the `COMMENT`
state. Reviewbot never approves, requests changes, merges, or creates check runs. If the PR
head moves during a review, the stale result is discarded and the new head is queued.

### Explicit fixes

An authorized request with a clear change instruction may produce an isolated branch and a
draft PR. Issue requests branch from the default branch; PR requests branch from the original
PR head and target its base. Contributor branches are never modified. OpenCode edits only the
isolated worktree, and the daemon performs commit, push, and PR creation. Project scripts
and tests are not executed, so the draft PR states what was and was not verified. The daemon
records the changed file list and diff stat, and rejects unrequested CI-workflow edits. If
branch protection or installation permissions prevent a valid draft PR, the blocker is
reported on the originating thread and in `reviewbot status`; Reviewbot does not bypass it
and never force-pushes.

## Security model

Automatic sessions are created with an OpenCode permission allowlist: default deny, then
allow `read`, `glob`, and `grep`, with credential-shaped files (for example `.env`, private
keys, and credential stores) denied. Edit, shell, Code Mode (`execute`), subagents, skills,
web fetches, web search, external directories, questions, and MCP tools remain denied.
Implementation sessions add `edit` inside the worktree and keep execution denied.

Each session runs in a clean wrapper directory containing only `repo/`. Repository-local
OpenCode configuration, plugins, MCP definitions, and skills are therefore not loaded;
repository instructions are treated as untrusted data. At startup, Reviewbot creates
read-only and implementation sessions and asks OpenCode how each ruleset resolves required
actions. The gate opens only when repository reads are allowed; implementation edit is
allowed; and credential access, shell, Code Mode, external-directory, network, subagents,
skills, questions, and MCP actions are denied. If the probe is inconclusive or fails,
automatic processing stops and jobs remain queued. This is deliberate: the runtime boundary
is the control, not the prompt.

The App private key, installation tokens, and GitHub publishing stay in the daemon. Tokens
are passed to Git through a host-scoped child-process header, never in remote URLs, prompts,
logs, or repository configuration. A Git worktree is not a sandbox; the OpenCode permission
ruleset is the execution boundary.

## Logging

`reviewbot status` shows the configured model (or `OpenCode default`), pending/closed
duplicate-case counts, and recorded lifecycle or poll errors. `reviewbot doctor` verifies that
a configured model is enabled and available.

`LOG_LEVEL` controls daemon log verbosity (`debug`, `info`, `warn`, `error`). Logs go to
stderr; credential-shaped values are redacted.

## Tests

```bash
bun test
bun run typecheck
reviewbot doctor
```

Unit tests cover host/config validation, command and intent detection, diff line mapping,
job transitions and recovery, idempotency markers, result validation, permission rules,
credential isolation, rate-limit classification, polling baselines, authorization,
publication, duplicate discovery, canonical selection, duplicate deadlines, maintainer
overrides, reopening, and restart reconciliation. They use in-memory SQLite, fake GitHub and
OpenCode collaborators, and injected time; no test waits 24 hours or contacts GitHub.

External acceptance tests (AC-01 through AC-20 from v1.0 and AC-21 through AC-41 from v1.1)
require a dedicated organization and test repository on `acme.ghe.com`, an installed App, and
working model quota. They are not claimed as passed without those resources.

CI runs the type check and unit tests on Ubuntu and Windows. The release workflow builds and
smoke-tests the standalone binaries before publishing.

## Releases

Releases are tag-driven. Tags publish standalone binaries and `SHA256SUMS` to GitHub Releases;
mise installs them through its `github:` backend.

1. Set the same `X.Y.Z` version in `package.json` and `src/config.ts` (`REVIEWBOT_VERSION`).
2. Commit and merge the version change to `main`.
3. Tag that commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The release workflow verifies the tag against both version fields, runs CI, builds the
binaries for Linux, macOS, and Windows, and creates the GitHub release. A prerelease suffix
(for example `v1.1.0-rc.1`) publishes a GitHub prerelease, which mise does not select by
default.

## Troubleshooting

- `setup` times out before the callback: organization policy may prohibit App creation, or
  the browser could not reach the loopback URL. The URL is printed for manual opening.
- `doctor` reports the permission boundary as `inconclusive`: OpenCode is unavailable or
  rejected a permission decision. Fix OpenCode connectivity; jobs stay queued.
- Jobs are queued but not processed: run `reviewbot status` and `reviewbot doctor`; the
  permission gate or OpenCode availability is the usual cause.
- Tasks fail with provider quota/auth errors: fix the model configuration in OpenCode.
  Reviewbot does not manage models or providers.
- Permission checks fail: verify the installation still grants `metadata:read`,
  `contents:write`, `issues:write`, and `pull_requests:write`.

## Known limitations

- GHE.com manifest registration and installation authentication have not been validated
  against a live enterprise organization in this environment.
- The security gate verifies OpenCode permission decisions and does not need a model. Task
  execution still needs a working model; if the configured default provider is unavailable
  or out of quota, jobs fail and are recorded in `status`.
- Tests are not executed for untrusted repositories. Fix PRs report static-only verification.
- Permanently failed jobs remain failed until a repeated trigger or operator action; there
  is no retry command by design.
- After an ambiguous review publication is recovered, the head is marked reviewed without
  recording the unpublished model result as published findings.
- Duplicate canonical selection follows direct references, bounded search, and verified
  bot-managed duplicate chains; it does not perform semantic cross-repository deduplication.
- A closed canonical issue only supports `confirmed_duplicate` when the reporter explicitly
  linked it. Other matches against a closed issue are treated as related so a regression is
  not silently closed.
- A comment that arrives after the final pre-close read but before GitHub processes the close
  is handled by the post-closure reassessment path rather than preventing that close.
- Live App-permission behavior for label creation and `state_reason=duplicate` on GHE.com
  remains an external acceptance item.
- Conditional requests cover the stable open-PR list; issue and comment queries change their
  `since` window each cycle and rely on bounded overlap and dedupe.
- One GitHub host, one local operator, one global worker, and one polling interval are
  supported by design.
- Reviewbot verifies OpenCode permission decisions and observed an external-read denial, but
  it does not provide kernel-level isolation or audit plugin load paths inside the shared
  OpenCode process.
- Windows credential ACLs are applied with `icacls`; `doctor` does not independently verify
  the effective ACL.

## Project layout

```
scripts/
  check-release-version.ts  Release tag and packaged version consistency check
src/
  cli.ts        Commander entrypoint (setup, run, status, doctor)
  daemon.ts     Foreground polling and single-worker loops
  setup.ts      Organization App manifest wizard and baseline
  diagnostics.ts status and doctor checks
  config.ts     Valibot schemas, host validation, secure paths
  paths.ts      Per-user config/data/workspace locations
  github.ts     App auth, installation clients, REST helpers, manifest exchange
  polling.ts    Discovery, baselines, cursors, command authorization, duplicate deadlines
  db.ts         SQLite schema, durable jobs, publication idempotency, duplicate cases
  jobs.ts       Payload schemas, job keys, prompt truncation
  worker.ts     Single worker, task prompts, timeouts, retries, recovery, duplicate tasks
  commands.ts   `/rb` command detection and instruction stripping
  opencode.ts   Service discovery, compatibility, sessions, permissions, results
  workspace.ts  Mirror clones, clean wrapper worktrees, authenticated Git, integrity checks
  duplicate-discovery.ts  Bounded direct references, search, and candidate context
  duplicates.ts  Duplicate policy, canonical rules, notices, comment evidence heuristics
  duplicate-lifecycle.ts  Durable notice, deadline, cancellation, closure, and reopen transitions
  diff.ts       Unified diff parsing and changed-line mapping
  publish.ts    Triage, review, reply, duplicate notice/close, and draft PR publication
  schemas.ts    Result schemas, markers, model-output parsing
  security.ts   Permission enforcement probe and gate
  log.ts        Pino logger and redaction
  prompt.md     Versioned shared task instructions
  prompts/      Task-specific plain-text phrasing references appended per job kind
test/           bun test suites
```
