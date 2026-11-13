# Operations

## Run the daemon

`reviewbot run` is the only runtime command. It runs in the foreground and performs no
self-daemonization.

```bash
reviewbot run
```

At startup it:

1. loads the global configuration and GitHub App credentials and fails if their hosts differ;
2. authenticates as the App;
3. evaluates the OpenCode permission boundary;
4. starts one poll loop and one job worker.

The poll loop runs every `polling.intervalSeconds` (default 60). The worker processes at most
one job at a time. Both run until the process receives `SIGINT` or `SIGTERM`, which stops the
loops, interrupts active OpenCode work, and closes the database. An interrupted job is
recovered into the queue on the next start; publication markers prevent a duplicate comment
or review after restart.

The daemon logs to stderr and exits non-zero on a startup error, such as invalid
configuration, missing credentials, or failed App authentication. A closed permission gate
does **not** exit the process: the daemon stays up, keeps jobs queued, and retries the gate
every 10 minutes.

## Process supervision

The operating system supervises `reviewbot run`; Reviewbot ships no service manager, unit
files, or restart logic. A supervisor should:

- start the daemon after boot with the same user account, environment, and `PATH` that setup
  used;
- restart it after a non-zero exit;
- capture stderr to a file or log collector;
- stop it with `SIGTERM`; the daemon interrupts active work and returns interrupted jobs to
  the queue.

Run a single instance per configuration and data directory. The design supports one operator,
one GitHub host, one polling interval, and one global worker.

## Check status

```bash
reviewbot status
```

`status` reads the local database and checks OpenCode connectivity. It reports:

- configured GitHub host and OpenCode model (`OpenCode default` when unset);
- OpenCode URL and version, or why it is unavailable;
- active installation and repository counts;
- the most recent successful poll time across repositories;
- queue depth and the active job, if any;
- pending, closed, and cancelled duplicate cases;
- the recorded permission-boundary result;
- poll errors and recent duplicate-case errors;
- up to five recent job failures.

Example:

```text
GitHub host:        github.com
OpenCode model:     OpenCode default
OpenCode:           http://127.0.0.1:4096 (OpenCode 2.2.7)
Installations:      1 active
Repositories:       3
Last successful poll: 2026-11-13T12:00:00.000Z
Queue:              0 queued; active: none
Duplicate cases:    0 pending, 0 closed, 0 cancelled
Permission boundary: enforced (Read-only sessions allow repository reads and deny ...)
```

The permission-boundary detail is long; the leading status is what matters. `enforced` is the
only passing value. `inconclusive` or `not-enforced` means automatic jobs stay queued.

`status` does not change job state and can run while the daemon is running.

## Diagnose the environment

```bash
reviewbot doctor
```

`doctor` prints one `OK`, `WARN`, or `FAIL` line per check and exits non-zero if any check
fails. It verifies:

- Bun runtime and Git availability;
- configuration, credential file, and POSIX credential permissions;
- SQLite readability and writability, and workspace storage;
- GitHub App authentication, active installations, installation permissions, and repository
  access;
- OpenCode connectivity, the configured model (when set), and V2 compatibility;
- the read-only and implementation permission probe.

If OpenCode is unavailable, `doctor` reports that the security boundary could not be verified;
automatic processing stays gated. `doctor` never installs tools or modifies the environment.

Run `doctor` after installation, after a configuration change, after upgrading the binary, and
after changing OpenCode, its plugins, or its global configuration.

## Logs

Logs go to stderr as structured JSON lines. `LOG_LEVEL` sets verbosity (`debug`, `info`,
`warn`, `error`; default `info`):

```bash
LOG_LEVEL=debug reviewbot run
```

At `info` the daemon logs one `poll complete` record per cycle, job start and completion,
gate changes, rate-limit backoff, and failures. Credential-shaped values (tokens, private
keys, authorization headers) are redacted before logging, and error text is sanitized before
publication.

`status` and `doctor` use a `warn` logger, so their checks do not add routine log noise.

## Queue and gate behavior

Jobs are durable in SQLite. Typical kinds include issue triage, pull request review,
authorized conversation or fix, and duplicate notice/reassessment/closure work.

- The gate is evaluated before any automatic work. If it is closed, jobs remain queued and no
  job is claimed.
- Transient failures are retried up to two times (three attempts). Permanent authorization or
  validation failures are not retried.
- GitHub rate limits produce a persisted backoff (at least 10 seconds, capped at one hour).
  Checkpoints are retained, so recovery does not skip events.
- If OpenCode becomes unavailable, the active job is requeued with a delay, the gate closes,
  and the daemon retries the gate every 10 minutes.
- Failed deadline checks back off and stop automatic retries after three attempts. A failed
  duplicate-comment reassessment is not retried for the same comment.
- There is no retry command. A permanently failed job stays failed until a repeated trigger or
  operator action creates new work.

## Configuration

Configuration is one global JSON file. Setup creates it; edit it while the daemon is stopped.

| Platform | Path |
| --- | --- |
| Linux / macOS | `${XDG_CONFIG_HOME:-~/.config}/reviewbot/config.json` |
| Windows | `%APPDATA%\reviewbot\config.json` |

```json
{
  "github": { "host": "acme.ghe.com" },
  "polling": { "intervalSeconds": 60 },
  "opencode": { "url": null, "model": null }
}
```

- `github.host` must be `github.com` or a `*.ghe.com` hostname. One host per configuration.
- `polling.intervalSeconds` must be an integer from 10 to 3600.
- `opencode.url` is `null` to discover the registered local service. Set an explicit URL to
  connect to another service. For an authenticated service, set
  `OPENCODE_SERVER_PASSWORD` in the daemon environment; Reviewbot uses HTTP basic auth with
  the user `opencode`.
- `opencode.model` is `null` to use OpenCode's default, or `providerID/modelID` to use one
  fixed model for every Reviewbot session. OpenCode still owns provider registration,
  credentials, enablement, and execution. The daemon reads configuration at startup, so a
  change requires a restart; existing OpenCode sessions keep their original model.
- There is no repository-specific Reviewbot configuration.

To change the GitHub host, re-run `reviewbot setup`.

## Data and storage

| Data | Linux / macOS | Windows |
| --- | --- | --- |
| Configuration | `${XDG_CONFIG_HOME:-~/.config}/reviewbot/config.json` | `%APPDATA%\reviewbot\config.json` |
| Data | `${XDG_DATA_HOME:-~/.local/share}/reviewbot` | `%LOCALAPPDATA%\reviewbot` |
| Credentials | `<data>/credentials/app.json` | `<data>\credentials\app.json` |
| Database | `<data>/reviewbot.db` | `<data>\reviewbot.db` |
| Repository mirrors | `<data>/workspaces/repos` | `<data>\workspaces\repos` |
| Task worktrees | `<data>/workspaces/worktrees` | `<data>\workspaces\worktrees` |

The credentials file is readable only by the current user (`0600` on POSIX, a current-user
ACL on Windows). Installation tokens are held in memory and never persisted. The SQLite
database uses WAL and stores observation state, checkpoints, sessions, jobs, publication
markers, reviewed heads, findings, and duplicate cases — not conversations or credentials.

Repository mirrors persist and grow with the number of repositories and fetched history.
Per-task worktrees are removed after their job; conversational sessions keep a stable wrapper
path. Workspace storage must be writable by the daemon; `doctor` checks this.

If you back up Reviewbot state, include the data directory and copy it while the daemon is
stopped.

## Upgrades

1. Stop the daemon.
2. Upgrade the binary:

   ```bash
   mise upgrade reviewbot
   ```

3. Start `reviewbot run` again.
4. Run `reviewbot doctor` and `reviewbot status`.

Releases are tag-driven, and the binary embeds its prompt assets, so it does not need the
source tree. SQLite schema creation and migrations run automatically when a command opens the
database; there is no separate migration step. Prereleases are not selected by mise by
default.

## Routine operational checks

| Check | Action |
| --- | --- |
| Queue grows and stays non-zero | Run `status` and `doctor`. A closed permission gate or unavailable OpenCode is the usual cause. |
| `Permission boundary` is not `enforced` | Fix OpenCode connectivity or the permission probe; jobs stay queued by design. Do not work around the gate. |
| OpenCode unreachable | Start the existing OpenCode V2 service. Reviewbot does not manage it. |
| Jobs fail with provider quota or auth errors | Fix the model and provider configuration in OpenCode, or set a working `opencode.model`. |
| Permission checks fail | Verify the installation still grants `metadata:read`, `contents:write`, `issues:write`, and `pull_requests:write`. |
| `Last successful poll` stops advancing | Inspect stderr for `poll failed` or rate-limit backoff. Checkpoints are retained; events are retried. |
| Recent duplicate-case errors | Inspect `status` for the repository and issue number. A failed deadline check leaves the issue open. |
| Disk usage grows | Inspect `<data>/workspaces`. Mirrors are cached clones and worktrees are per task. Do not delete state while the daemon is running. |
| A fix job fails | The blocker is reported on the originating thread and in `status`; Reviewbot does not bypass branch protection or permissions. |
