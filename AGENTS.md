# Reviewbot repository instructions

## Source of truth

- Product scope: `docs/specs/v1.1.md`, which extends the implemented
  `docs/specs/v1.0.md` baseline. Do not expand beyond them.
- Architecture decisions: `docs/adr/`.
- Implementation plans and progress: `docs/plans/v1.0.md` and `docs/plans/v1.1.md`.

Document intended behavior and consequential decisions before implementing them. Reconcile
the plan and ADRs with what actually shipped. Do not describe unverified external behavior
as passing.

## Commands

```bash
bun install
bun test
bun run typecheck
bun run src/cli.ts doctor
bun run src/cli.ts status
```

`reviewbot setup` and `reviewbot run` require GitHub App credentials and a live GitHub
organization; do not use production repositories for experiments.

## Architecture boundaries

- Reviewbot is an integration layer. GitHub owns collaboration state; OpenCode owns
  reasoning, tools, models, and sessions.
- Use the existing OpenCode V2 service via `@opencode/client`. Never spawn, replace, or
  manage an OpenCode runtime.
- `opencode.model` is a single optional fixed `provider/model` override for Reviewbot
  sessions. Do not add per-task routing, agent selection, provider management, or fallback
  models.
- Use Octokit and `@octokit/app` for every GitHub operation. Do not add `gh` or personal
  access token dependencies.
- Keep the daemon as the only actor that holds credentials or performs GitHub writes.
- Use `bun:sqlite` for durable state, one global worker, and stable job keys.
- Validate external data and model output with Valibot.
- Do not introduce Effect, Probot, an ORM, Redis, a workflow engine, a dashboard, webhooks,
  parallel workers, sandbox provisioning, or speculative adapters.

## Security invariants

- Automatic sessions use the default-deny permission allowlist in `src/opencode.ts`.
- Never pass App keys or installation tokens to OpenCode, prompts, logs, Git remotes, or
  repository configuration.
- Git authentication goes through the host-scoped child-process header in
  `src/workspace.ts`.
- Do not publish review results without revalidating installation access, requester
  permission, the current PR head, and diff line locations.
- Only accept idempotency markers authored by the installed App; strip marker-like text from
  model output.
- Keep Reviewbot credentials and database files denied to OpenCode sessions.
- If the permission enforcement probe cannot verify both rulesets, automatic jobs stay
  queued. Do not weaken this gate to make a task pass.
- Keep sessions rooted in a clean wrapper so repository-local OpenCode config, plugins,
  MCP definitions, and skills are not loaded.
- Never execute project scripts or tests from untrusted repositories. Every Git invocation
  must disable repository hooks.
- Reject unrequested CI workflow edits from implementation jobs.
- Duplicate labels, deadlines, canonical targets, and closure/reopen decisions are
  deterministic daemon policy. Issue text and model output may recommend a decision but never
  authorize a GitHub mutation. Revalidate installation access, issue state, canonical issue,
  and comments immediately before every duplicate transition.
- Only `pending close` and `duplicate` may be managed, and only labels recorded as
  Reviewbot-applied may be removed. Never re-close an issue a human reopened or re-arm a
  cancelled case automatically.

## Testing

- Add unit coverage for pure logic and state transitions with `bun test`.
- Use in-memory SQLite (`new Store(":memory:")`) in tests.
- External GHE.com tests require real credentials; record them as pending when unavailable.
- Run `bunx tsc --noEmit` and `bun test` before considering a change complete.

## Style

- TypeScript with explicit types at module boundaries.
- Narrow interfaces and small modules matching the established `src/*.ts` responsibility
  split.
- Prefer clear, direct code over abstractions. No dependency injection containers, plugin
  APIs, or speculative options.
- Keep user-facing GitHub text concise, specific, and free of praise or filler.
