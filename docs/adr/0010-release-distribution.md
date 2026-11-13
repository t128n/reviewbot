# ADR 0010: Tag-driven binary releases installed through mise

**Status:** Accepted
**Date:** 2026-11-13
**Related:** README "Install" and "Releases"

## Context

Reviewbot is a locally operated daemon. Operators need a working `reviewbot` command plus
Git and an existing OpenCode V2 service; they do not need a hosted deployment. Until now the
only installation path was a source checkout with Bun and `bun install`, and the repository
had no CI or release automation.

The repository is public, so GitHub Actions and GitHub Releases are available without new
infrastructure. mise is already the pinned tool manager (`mise.toml`) and can install tools
directly from GitHub release assets.

## Decision

- **CI** runs `bun install --frozen-lockfile`, the type check, unit tests, and a CLI version
  smoke test on Ubuntu and Windows.
- **CD is tag-driven.** Pushing a `vX.Y.Z` tag runs CI, verifies that the tag matches
  `package.json` and `REVIEWBOT_VERSION`, builds the binaries, and creates a GitHub Release.
  Merges to `main` do not publish.
- **Release artifacts are standalone executables** produced by `bun build --compile`. The
  build embeds `src/prompt.md` and `src/prompts/` with `--asset`, so the installed binary
  does not depend on the source tree or on Bun being installed.
- **Supported targets:** Linux x64 and arm64 (glibc), macOS x64 and arm64, and Windows x64.
  Assets are named `reviewbot-<os>-<arch>` (with `.exe` on Windows), which mise recognizes
  and cleans to `reviewbot`.
- **Every release includes `SHA256SUMS`.** GitHub's asset digests and the checksum file let
  mise verify downloads.
- **Installation uses mise's `github:` backend**:
  `mise use -g github:t128n/reviewbot@X.Y.Z`. This keeps one installation mechanism and
  avoids maintaining npm, Homebrew, Scoop, or Docker packaging in this repository.
- **Binaries are unsigned.** macOS and Windows may warn on first launch; code signing and
  notarization are separate work.

## Alternatives considered

- **Publish to npm and install with `mise use -g npm:reviewbot`.** The CLI is TypeScript run
  by Bun, so this still requires Bun on the operator machine and adds registry credentials
  and a second distribution contract. Rejected.
- **Docker image.** Reviewbot must reach a local OpenCode service and per-user configuration,
  credentials, SQLite, and workspaces on the host. Rejected as the primary install path.
- **Source tarball release.** Requires Bun, a dependency install, and a writable source tree
  per operator. Kept only as the documented development/source path.
- **Automatic releases from `main`.** Every merge would need a versioning convention and
  write access; releases should be deliberate. Rejected.

## Consequences

- Version numbers must be updated in two places before tagging; the release workflow fails
  on a mismatch instead of publishing a mislabeled binary.
- Linux arm64 and macOS arm64 binaries are built and smoke-tested on native runners. The
  macOS Intel binary is cross-compiled and not executed in CI; installing the first published
  release is the final verification for that asset.
- The release workflow only runs on tags, so its packaging and publishing steps are first
  exercised by a prerelease tag.
