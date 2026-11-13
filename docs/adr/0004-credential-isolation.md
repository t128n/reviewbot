# ADR 0004: Credential isolation and daemon-owned GitHub writes

**Status:** Accepted

## Context

The daemon holds an App private key, installation tokens, and the ability to push code and
publish comments. Untrusted repository content and OpenCode sessions must not receive any
of these credentials. The specification forbids tokens in prompts, logs, Git remotes, or
persistent repository configuration, and reserves all writes to the daemon.

## Decision

- The App private key and App metadata are stored in a single credentials file under the
  per-user data directory with user-only permissions (POSIX `0600`; Windows ACL restricted
  to the current user).
- Installation tokens are requested on demand and kept in memory only. They are never
  written to SQLite, configuration, logs, prompts, or Git configuration.
- Git clone/fetch/push authenticate through a per-process `http.<host>.extraheader`
  passed in the child environment. Tokens never appear in remote URLs or `.git/config`.
- OpenCode sessions receive only repository files and task text. They never receive a
  GitHub token, App key, or `gh` credential. Automatic sessions are read-only.
- Only `publish.ts` and `workspace.ts` (daemon code) use installation credentials. Before a
  write, the daemon re-fetches current GitHub state, checks installation access, and for
  conversational/fix requests re-checks the requesting user's repository permission.
- Pino redacts credential-shaped fields at the logger boundary. Error messages are
  sanitized before logging or publication.

## Alternatives considered

- **Credential helper scripts.** More moving parts and persistent helper configuration.
- **Embedding tokens in remote URLs.** Explicitly forbidden and leaks through process
  listings and `.git/config`.
- **Passing tokens to OpenCode for `gh`/Git.** Violates the security boundary and the
  read-only requirement.

## Consequences

- Pushes and clones require the daemon to remain the actor; OpenCode cannot verify against
  GitHub or push by itself.
- Windows ACL handling is applied during setup and setup fails if the ACL command cannot be
  applied. `doctor` does not independently verify the effective ACL.
- A compromised local operator account can read the App key; this is outside the threat
  model (the specification scopes the key to the local operator).
