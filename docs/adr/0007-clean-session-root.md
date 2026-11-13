# ADR 0007: Clean session root around the repository checkout

**Status:** Accepted

## Context

OpenCode loads project configuration, plugins, MCP servers, skills, and instructions from
the session's Location directory and its ancestors. Repository content is untrusted,
including branches, `opencode.json`, `.opencode/`, plugins, MCP definitions, and
instruction files. Loading repository-local configuration inside the shared OpenCode
service could execute code or register tools with the operator's privileges before
session permission rules apply. Session permission rules cannot protect code that runs
during plugin/config loading.

## Decision

- Each task checks out the repository into a clean wrapper directory:
  `<worktrees>/<task>/repo`.
- OpenCode sessions use `<worktrees>/<task>` as their Location, not the repository root.
- The wrapper contains only the checkout and OpenCode's own session artifacts. Repository
  `opencode.json`, `.opencode/`, plugins, MCP definitions, and project instruction files
  are not discovered as project configuration.
- The task prompt names `./repo` as the repository root and requires review findings to be
  repository-relative. The model may read repository instruction files as untrusted data,
  but they are not loaded as OpenCode configuration.
- Conversational sessions keep a stable wrapper path so session continuity survives
  daemon restarts.
- The permission ruleset, not repository configuration, remains the execution boundary.

## Verification

Against OpenCode 2.2.7, `config.get` with a location containing a child repository that had
an `opencode.json` returned only global configuration, including when the child was an
initialized Git repository; the child document was not loaded. Pointing the location at the
child loaded the extra document. A session created with the read-only rules still denied
shell/edit/external actions even when a repository config attempted to allow everything.

## Alternatives considered

- **Use the repository root as the Location.** Rejected: repository config/plugins could
  load with daemon privileges.
- **Delete or rewrite repository config files.** Mutates the checkout, is brittle across
  formats, and does not cover plugins/MCP/skills discovered from other paths.
- **Start a separate restricted OpenCode service.** Explicitly excluded; Reviewbot must use
  the existing service without weakening other sessions.
- **Only rely on session permissions.** Rejected: permissions gate tool calls, not
  configuration/plugin load-time code.

## Consequences

- The model must address the repository through `./repo`; prompts state this explicitly.
- Repository `AGENTS.md` and similar instructions are not automatically loaded. They remain
  available as untrusted repository data.
- Global OpenCode configuration and plugins remain trusted operator configuration. Reviewbot
  verifies session permission decisions but does not audit operator-installed plugins.
- Wrapper directories are stable for conversations and disposable for triage/reviews/fixes.
