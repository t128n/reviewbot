# ADR 0001: Organization-owned GitHub App manifest registration

**Status:** Accepted

## Context

Reviewbot needs credentials that work on both `github.com` and GitHub Enterprise Cloud
(`*.ghe.com`). The specification requires a `reviewbot setup` command that registers an
App without a permanently reachable endpoint, and it explicitly excludes enterprise-owned
App manifests. `*.ghe.com` is GitHub Enterprise Cloud, not GitHub Enterprise Server, so the
web/API split (`https://<host>` for web, `https://api.<host>` for REST) must be modelled.

## Decision

- `setup` registers an **organization-owned** GitHub App using the manifest flow.
- A loopback HTTP server on `127.0.0.1` serves a small auto-submitting manifest form and
  receives the redirect callback with `state` and `code`.
- The callback state is validated, then the code is exchanged via
  `POST https://api.<host>/app-manifests/{code}/conversions` (for `github.com` the API host
  is `api.github.com`).
- The manifest uses an inactive webhook (`https://example.invalid/reviewbot/webhook`), no
  default events, and `metadata:read`, `contents:write`, `issues:write`,
  `pull_requests:write`.
- The GitHub host is validated as a bare DNS name (`github.com` or `<name>.ghe.com`).
  Network destinations are always derived from validated configuration, never from issue,
  PR, or comment content.
- Installation tokens are requested with narrowed permissions per operation (read for
  polling, write for publication, contents write for pushes). Collaborator permission
  checks use `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, which GitHub
  documents as requiring `metadata: read`; no broader administration permission is
  requested.

## Alternatives considered

- **Personal access tokens / `gh auth`.** Rejected by the specification and weaker for
  multi-repository installation.
- **Enterprise-owned App manifest.** Not supported by the documented manifest flow.
- **Permanent webhook endpoint.** Explicitly out of scope; polling is the discovery
  mechanism, and no tunnel or hosted endpoint is permitted.
- **GitHub Enterprise Server handling.** Rejected: `*.ghe.com` is Enterprise Cloud with a
  different API hostname layout.

## Consequences

- Setup is interactive and requires an operator with organization App-management rights.
- The machine needs outbound HTTPS to the configured host and API host.
- If organization policy forbids App creation or installation, setup reports the
  restriction; it does not attempt to bypass it.
- GHE.com manifest conversion remains an external acceptance test (AC-01/AC-02) because it
  requires a live test organization.
