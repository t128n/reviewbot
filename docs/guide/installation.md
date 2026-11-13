# Installation

## Requirements

| Requirement | Detail |
| --- | --- |
| GitHub organization | An organization on `github.com` or a `*.ghe.com` host. You need permission to create and install organization-owned GitHub Apps. |
| OpenCode | An existing OpenCode V2 service, version 2.2.0 or newer, running before `reviewbot run`. Reviewbot was tested with OpenCode 2.2.7 and `@opencode/client` 2.3.0. It discovers the registered local service or connects to a configured URL; it never starts or manages OpenCode. |
| Model configuration | A working OpenCode model configuration. Reviewbot does not select models or agents. |
| Git | Git on `PATH`. |
| Bun | Bun 1.4.4 or newer, only when running from source. Release binaries embed Bun. |
| Network | Outbound HTTPS to the GitHub web host and the host-specific API host. |

Reviewbot authenticates with GitHub App installation tokens. It does not use personal access
tokens or `gh auth`, and `gh` is not required.

## Install a release binary

Releases are installed with [mise](https://mise.jdx.dev) through its `github:` backend:

```bash
mise use -g github:t128n/reviewbot@latest
reviewbot --version
```

Pin a version, or run a single command without changing global configuration:

```bash
mise use -g github:t128n/reviewbot@1.1.0
mise x github:t128n/reviewbot@1.1.0 -- reviewbot --version
```

`mise activate` must be active in your shell for the bare `reviewbot` command to be on
`PATH`. `mise x` works without activation.

Upgrade an existing installation with:

```bash
mise upgrade reviewbot
```

Restart `reviewbot run` after upgrading so the new binary and its embedded prompts are in
use. Prerelease tags (for example `v1.1.0-rc.1`) are published as GitHub prereleases, which
mise does not select by default.

## Supported platforms

| Platform | Assets |
| --- | --- |
| Linux x64 and arm64 | glibc builds. There is no musl/Alpine asset. |
| macOS Intel and Apple silicon | `darwin-x64` and `darwin-arm64`. |
| Windows x64 | Single `.exe` asset. |

Release assets are named `reviewbot-<os>-<arch>` (`.exe` on Windows), and each release
includes a `SHA256SUMS` file. mise installs from these assets and verifies downloads.

The macOS and Windows binaries are **not code-signed**. The operating system may ask for
confirmation on first launch: macOS Gatekeeper may block the binary until you allow it in
System Settings, and Windows SmartScreen may show a warning. Code signing and notarization
are separate work.

All native targets are smoke-tested in CI with `--version`, except the macOS Intel binary,
which is cross-compiled and not executed there. Installing the first published release is the
final verification for that asset.

## Install from source

Source installs require Bun 1.4.4 and Git on `PATH`:

```bash
mise install        # installs the Bun version pinned in mise.toml
bun install
bun link            # optional: puts the `reviewbot` command on PATH
```

Run directly without linking:

```bash
bun run src/cli.ts <command>
```

Source mode still uses the same per-user configuration, credentials, database, and workspace
locations as a release binary.

## Next step

Configure the GitHub App and monitoring baseline:

```bash
reviewbot setup
```

See [Setup](setup.md). After setup, `reviewbot doctor` validates the full environment.
