# Reviewbot operator guide

This guide is for the person who installs, configures, runs, and monitors Reviewbot for a
GitHub organization. It assumes you can create and install organization-owned GitHub Apps and
that an OpenCode V2 service already exists on the same machine (or at a reachable URL).

Reviewbot is a single-operator local daemon. It is not a hosted service, and it has no
dashboard, webhook receiver, or built-in process supervisor.

## Guide contents

| Page | Covers |
| --- | --- |
| [Installation](installation.md) | Requirements, release binaries through mise, source installs, supported platforms |
| [Setup](setup.md) | The `reviewbot setup` wizard, GitHub App registration, organization policy, installation, baseline, failure handling |
| [Operations](operations.md) | Running and supervising the daemon, `status`, `doctor`, logs, queue and gate behavior, configuration, storage, upgrades, routine checks |
| [Considerations](considerations.md) | Security boundaries, authorization, duplicate-lifecycle side effects, exclusions, limitations, GHE.com status, operator decisions |

## Where the details live

- [`README.md`](../../README.md) — product summary, commands, defaults, and limitations at a
  glance.
- [`docs/specs/v1.0.md`](../specs/v1.0.md) and [`docs/specs/v1.1.md`](../specs/v1.1.md) —
  authoritative product behavior.
- [`docs/plans`](../plans) — implementation status and remaining external verification.
- [`docs/adr`](../adr) — architecture decisions behind the security, storage, and lifecycle
  behavior described here.

## Status of this release

Version 1.1.0 is implemented. The type check and unit suite pass. A `reviewbot doctor` run
against a `github.com` App and OpenCode environment is recorded in the v1.1 plan as passing.
Live GHE.com acceptance (App registration, installation authentication, label creation, and
`state_reason=duplicate`) is still pending and is explicitly **not** claimed as verified. See
[Considerations](considerations.md#ghecom-status) before planning a GHE.com deployment.
