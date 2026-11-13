# Reviewbot

Reviewbot connects GitHub repositories to an existing [OpenCode](https://opencode.ai) V2
service. It provides automatic issue triage and pull request reviews, plus authorized
conversational follow-ups and explicitly requested draft pull requests.

It is an integration layer, not an agent platform:

- **GitHub** owns collaboration state: issues, PRs, comments, reviews, permissions.
- **OpenCode** owns reasoning, tools, models, sessions, and project instructions.
- **Reviewbot** owns authentication, discovery, authorization, durable jobs, task dispatch,
  validation, and publication.

The authoritative product specification is [`docs/specs/v1.0.md`](docs/specs/v1.0.md).
Implementation plans and architectural decisions live in [`docs/plans`](docs/plans) and
[`docs/adr`](docs/adr).

## Requirements

- Bun 1.4 or newer (the runtime and test runner).
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

```bash
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
  "opencode": { "url": null }
}
```

A null OpenCode URL discovers the registered local service. To connect to an explicit
authenticated service, set `opencode.url` and provide `OPENCODE_SERVER_PASSWORD` in the
environment (basic auth user `opencode`). There is no repository-specific Reviewbot
configuration. Model selection and development settings remain under OpenCode's control.
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
| New issue | One evidence-based triage comment |
| New non-draft PR | One review with inline findings when they map to changed lines |
| New commits on a non-draft PR | Incremental review of changes since the last reviewed commit |
| Draft PR becomes ready | Initial review |
| Authorized mention | Conversational reply, or a draft PR for an explicit change request |
| Bot's own events | Ignored |
| Title/body/label edits | Ignored |

Triage does not modify code, labels, assignees, milestones, projects, or issue state.
Subsequent responses require an authorized mention.

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

`LOG_LEVEL` controls daemon log verbosity (`debug`, `info`, `warn`, `error`). Logs go to
stderr; credential-shaped values are redacted.

## Tests

```bash
bun test
bun run typecheck
reviewbot doctor
```

Unit tests cover host/config validation, mention and intent detection, diff line mapping,
job transitions and recovery, idempotency markers, result validation, permission rules,
credential isolation, rate-limit classification, polling baselines, authorization, and
publication. They use in-memory SQLite and do not contact GitHub.

External acceptance tests (AC-01 through AC-20) require a dedicated organization and test
repository on `acme.ghe.com`, an installed App, and working model quota. They are not
claimed as passed without those resources.

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
src/
  cli.ts        Commander entrypoint (setup, run, status, doctor)
  daemon.ts     Foreground polling and single-worker loops
  setup.ts      Organization App manifest wizard and baseline
  diagnostics.ts status and doctor checks
  config.ts     Valibot schemas, host validation, secure paths
  paths.ts      Per-user config/data/workspace locations
  github.ts     App auth, installation clients, REST helpers, manifest exchange
  polling.ts    Discovery, baselines, cursors, mention authorization
  db.ts         SQLite schema, durable jobs, publication idempotency
  jobs.ts       Payload schemas, job keys, prompt truncation
  worker.ts     Single worker, task prompts, timeouts, retries, recovery
  opencode.ts   Service discovery, compatibility, sessions, permissions, results
  workspace.ts  Mirror clones, clean wrapper worktrees, authenticated Git, integrity checks
  related.ts    Bounded related issue/PR context for triage
  diff.ts       Unified diff parsing and changed-line mapping
  publish.ts    Triage, review, reply, and draft PR publication
  schemas.ts    Result schemas, markers, model-output parsing
  security.ts   Permission enforcement probe and gate
  log.ts        Pino logger and redaction
  prompt.md     Versioned task instructions
test/           bun test suites
```
