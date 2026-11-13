# Setup

`reviewbot setup` registers an organization-owned GitHub App, stores its credentials, waits
for an installation, verifies permissions, and records the monitoring baseline. It is
interactive and must run in a terminal that can open a browser.

## Before you start

- Know the GitHub host (`github.com` or `<name>.ghe.com`) and the organization that will own
  the App.
- Use an account that can create and install organization-owned Apps. Enterprise-owned App
  manifests are not supported by the documented flow.
- OpenCode does **not** need to be running for `setup`; it verifies GitHub access and records
  the baseline. Start OpenCode before `reviewbot doctor` or `reviewbot run`.
- Organization policy may require an owner to approve App creation or installation. Setup
  reports a policy restriction; it does not bypass one.

## What the wizard does

1. **Prompts for the GitHub host.** The value is normalized (scheme and case are removed) and
   must be `github.com` or a `*.ghe.com` hostname. Invalid input is re-prompted.
2. **Prompts for the owning organization.** An empty answer is rejected.
3. **Prompts for the App name.** The default is `reviewbot-<organization>`, lowercased and
   reduced to letters, digits, and hyphens, with a maximum of 34 characters.
4. **Writes the host configuration.** Existing `polling` and `opencode` settings are
   preserved. This happens before registration, so a failed run can leave a configuration
   file for the new host without valid credentials.
5. **Starts a temporary loopback listener.** The callback is `127.0.0.1` on an ephemeral port
   with a random `state` value. No public endpoint, tunnel, or webhook receiver is used. The
   URL is printed and opened in the default browser when possible.
6. **Submits the App manifest to GitHub.** The App is organization-owned, private, has no
   default events, and requests `metadata:read`, `contents:write`, `issues:write`, and
   `pull_requests:write`. Its webhook is present but inactive
   (`https://example.invalid/reviewbot/webhook`) and is never used at runtime.
7. **Validates the callback and exchanges the code.** The returned `state` must match. The
   temporary code is exchanged at `https://api.<host>/app-manifests/<code>/conversions`
   (`https://api.github.com` for `github.com`).
8. **Stores credentials.** The App ID, slug, private key, and related manifest fields are
   written to `<data>/credentials/app.json`, restricted to the current user. Setup fails if
   the restriction cannot be applied.
9. **Opens the installation page and waits.** You install the App on the organization and
   select repositories. The install URL is printed, so you can open it manually if the
   browser does not. Setup waits up to 10 minutes, checking every 5 seconds for an active,
   non-suspended installation matching the organization with at least one repository and the
   required write permissions.
10. **Initializes the baseline.** The poller records the current state. Historical issues and
    pull requests are not processed. New issues, non-draft pull requests, and later qualifying
    changes are processed after the daemon starts.

The callback and installation waits each time out after 10 minutes.

## Expected result

On success the terminal prints the registered App, its installation ID, the repository count
used for the baseline, and:

```text
Setup complete. Start the daemon with:
  reviewbot run
```

Verify the environment before starting the daemon:

```bash
reviewbot doctor
```

## Re-running setup

Re-running `reviewbot setup` registers a new App for the configured host and overwrites the
stored credentials. Reviewbot does not uninstall the previous App or remove its installation;
clean that up in GitHub if it is no longer used. Only one GitHub host is supported per
configuration, so switching hosts also means running setup again.

## When setup fails

| Symptom | Cause and action |
| --- | --- |
| Times out before the callback | Organization policy prohibits App creation, or the browser cannot reach the loopback URL. Open the URL printed in the terminal manually. On Windows, an "Application not found" error can be bypassed by copying the URL into Edge, Chrome, or Firefox. |
| GitHub reports an error or the state does not match | The registration was rejected or the callback was stale. Re-run `reviewbot setup` and complete the flow in the same browser session. |
| "credentials were written but their permissions could not be restricted" | The POSIX `chmod 0600` or Windows `icacls` step failed. On Windows, `USERNAME` must be set for the ACL step. Fix the permission problem and re-run setup. |
| Installation wait times out | No active installation with repository access was found for the named organization. Install the App and select at least one repository. If setup already exited, start `reviewbot run`; newly discovered repositories are baselined without processing history. Re-running setup instead registers a new App and overwrites the stored credentials. |
| Missing write permissions | The installation does not grant `contents:write`, `issues:write`, and `pull_requests:write`. Update the App's permissions in GitHub, accept the updated installation, then run `reviewbot doctor`. |
| `run` reports a host mismatch | The configured host and stored credential host differ. Re-run `reviewbot setup` for the intended host. |
| Setup succeeds but `doctor` fails | Follow the failing check: GitHub authentication, installation permissions, OpenCode connectivity, or the permission boundary. Fix it before relying on the daemon; a closed permission gate or unavailable OpenCode leaves jobs queued. |

If organization policy blocks App creation or installation, setup stops with an explanatory
error. Reviewbot never attempts to bypass organization policy.

## GHE.com

`*.ghe.com` is GitHub Enterprise Cloud, not GitHub Enterprise Server. Reviewbot uses
`https://<host>` for web pages and `https://api.<host>` for REST calls, and the host value is
validated before any network destination is constructed.

The manifest flow, installation authentication, label creation, and
`state_reason=duplicate` behavior have not been validated against a live enterprise
organization in this environment. Treat a GHE.com setup as an acceptance exercise with a test
organization and repository rather than a proven deployment. See
[GHE.com status](considerations.md#ghecom-status).

## Next step

Run the daemon in the foreground under your process supervisor:

```bash
reviewbot run
```

See [Operations](operations.md).
