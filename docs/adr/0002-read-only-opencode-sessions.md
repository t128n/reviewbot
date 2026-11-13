# ADR 0002: Read-only enforcement through per-session OpenCode permissions

**Status:** Accepted; read-only policy verified against OpenCode 2.2.7

## Context

Automatic triage and reviews process untrusted issue text, PR text, diffs, and repository
files. The specification requires an effective read-only boundary that denies edits, shell
and process execution, Code Mode, MCP/plugin tools, external file access, credential
access, and direct publishing. A Git worktree is not a sandbox, and prompt instructions are
not a security control.

OpenCode V2 accepts a `permissions` ruleset when creating a session. Rules are ordered,
the last matching rule wins, and actions include `read`, `edit`, `glob`, `grep`, `shell`,
`subagent`, `skill`, `question`, `webfetch`, `websearch`, `external_directory`, `execute`,
and `<server>_<tool>` for MCP tools.

## Decision

- Every Reviewbot session is created with an explicit ruleset:
  1. `{"action":"*","resource":"*","effect":"deny"}` (default deny), followed by
  2. allow `read`, `glob`, and `grep` for automatic tasks.
- Automatic tasks receive no edit, shell, execute, subagent, skill, webfetch, websearch,
  question, or MCP permission. `external_directory` remains denied. Reads of
  credential-shaped files (`.env`, private keys, credential stores) are also denied, as are
  reads of Reviewbot's own credentials, database, and probe directories.
- Explicit implementation tasks add `edit` permission but keep shell, execute, external
  directories, network access, and subagents denied. The daemon performs Git operations
  and GitHub publication.
- A startup **enforcement probe** creates read-only and implementation sessions in a
  temporary directory and asks OpenCode's permission decision API (`permission.create`)
  how each ruleset resolves required actions. The gate opens only when reads/globs/greps and in-workspace reads
  resolve to `allow` and edit, shell, execute, external directory, network, subagent, skill,
  question, MCP, and Reviewbot credential/database reads resolve to `deny`.
- The probe uses the same decision path as tool execution and does not depend on a model,
  prompt compliance, or provider quota. Sessions also use a clean wrapper root so
  repository-local OpenCode config, plugins, MCP definitions, and skills are not loaded
  (ADR 0007). Results are cached for 24 hours keyed by OpenCode version, client version,
  and ruleset hash.
- If the probe is `inconclusive` or `not-enforced`, automatic processing stops (jobs stay
  queued) and diagnostics report the condition. This fails closed.

## Verification

Against OpenCode 2.2.7 with `@opencode/client` 2.3.0:

- `permission.create` returned `allow` for `read` in the read-only ruleset and `deny` for
  `edit`, `shell`, `execute`, `external_directory`, `webfetch`, and the Reviewbot credential
  path. The implementation ruleset allowed workspace `edit` while keeping execution and
  credential access denied.
- A live read-only session with an explicitly selected test model attempted to read
  `C:\Windows\win.ini`; the tool call failed with `permission.rejected:
  external_directory`, and no sentinel file was created.
- The default provider on the test machine reports insufficient quota, so full task
  execution remains environment-dependent; the security gate itself does not.

## Alternatives considered

- **Prompt-only restriction.** Rejected: not a runtime control.
- **Separate OpenCode instance with restricted global config.** Excluded: Reviewbot must
  use the existing service and must not weaken other sessions.
- **OS sandbox / container.** Out of scope; no sandbox provisioning is included.
- **Trusting agent IDs or repository instructions.** Rejected: untrusted repository content
  can influence agent behaviour; permissions must remain the boundary.
- **Model-driven behavioural probe as the release gate.** Rejected after implementation:
  it depends on provider quota and prompt compliance. It was retained only as a manual
  verification observation.

## Consequences

- Reviewbot depends on `SessionCreateInput.permissions` and `permission.create` from the
  pinned `@opencode/client` 2.3.0.
- A permission regression in OpenCode is detected at startup, before any untrusted task.
- The probe cannot verify kernel-level isolation; it verifies that the configured runtime
  denies the concrete dangerous operations. This is documented as a limitation.
