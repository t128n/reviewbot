# ADR 0008: Optional global OpenCode model override

**Status:** Accepted (operator-requested scope change)

## Context

The approved v1.0 specification delegated model selection entirely to OpenCode. In practice,
the default model in the shared OpenCode service may be unavailable, unfunded, or unsuitable
for Reviewbot tasks, even when another enabled model works. Editing the global OpenCode
configuration affects every OpenCode session, while Reviewbot has no way to select a working
model for its own sessions.

The operator asked Reviewbot to allow configuring the model used by its OpenCode sessions.
This is narrower than provider management or per-task routing: one fixed identifier is chosen
for every Reviewbot session.

## Decision

- Add an optional global configuration field:
  `"opencode": { "model": "providerID/modelID" }`.
- A null/missing value keeps OpenCode’s own default model selection.
- When set, Reviewbot passes the parsed reference as `SessionCreateInput.model` for every
  session it creates (read-only and implementation).
- OpenCode remains authoritative for provider registration, authentication, model
  enablement, variants, and execution. Reviewbot does not manage providers, discover model
  catalogs at runtime for routing, select agents, or route models per task.
- `doctor` checks that the configured model is present and enabled in OpenCode’s model list.
- The daemon reads configuration at startup; changing the model requires restarting
  `reviewbot run`. Existing sessions keep the model they were created with.
- Configuration is validated with Valibot; the format is `provider/model`, split at the
  first slash so model IDs containing slashes remain usable.

## Alternatives considered

- **Only use OpenCode’s global `model` setting.** Rejected after operator request: it changes
  every OpenCode session and prevents Reviewbot-specific selection.
- **Per-task or per-repository model routing.** Rejected: explicitly outside v1.0 scope.
- **Provider management in Reviewbot.** Rejected: OpenCode owns providers and credentials.
- **Agent selection.** Rejected: not requested and outside scope.

## Consequences

- A single model identifier becomes part of Reviewbot configuration and diagnostics.
- An invalid or unavailable model is reported by `doctor` and by task failures; jobs are not
  silently routed to another model.
- Reviewbot still does not own model credentials, provider configuration, or fallback
  routing.
- This supersedes the earlier specification sentence that model selection remained entirely
  under OpenCode’s control; provider authentication and model execution still do.
