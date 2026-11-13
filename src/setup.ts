import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as v from "valibot";
import {
  DEFAULT_CONFIG,
  loadConfig,
  normalizeHost,
  saveConfig,
  saveCredentials,
  type Config,
  type Credentials,
} from "./config.ts";
import {
  GitHub,
  appInstallUrl,
  buildManifest,
  manifestRegistrationUrl,
  exchangeManifestCode,
} from "./github.ts";
import { Store } from "./db.ts";
import { Poller } from "./polling.ts";
import { databasePath } from "./paths.ts";
import type { Logger } from "./log.ts";

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const SetupInputSchema = v.object({
  host: v.pipe(v.string(), v.minLength(1)),
  organization: v.pipe(v.string(), v.minLength(1)),
  appName: v.pipe(v.string(), v.minLength(1), v.maxLength(34)),
});

interface CallbackResult {
  code: string;
  state: string;
}

export async function runSetup(logger: Logger): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  let activeServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    stdout.write("\nReviewbot setup\n===============\n\n");
    const hostInput = await rl.question(
      "GitHub host (github.com or acme.ghe.com): ",
    );
    const host = normalizeHost(hostInput);
    const organization = (
      await rl.question("Organization that will own the GitHub App: ")
    ).trim();
    const defaultName =
      `reviewbot-${organization}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 34) || "reviewbot";
    const appNameInput = await rl.question(
      `App name [${defaultName}]: `,
    );
    const appName = (appNameInput.trim() || defaultName)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 34) || "reviewbot";
    const input = v.parse(SetupInputSchema, {
      host,
      organization,
      appName,
    });

    let existingConfig: Config = DEFAULT_CONFIG;
    try {
      existingConfig = loadConfig();
    } catch {
      existingConfig = DEFAULT_CONFIG;
    }
    const config: Config = {
      ...existingConfig,
      github: { host: input.host },
    };
    saveConfig(config);

    const state = randomBytes(24).toString("hex");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("Reviewbot setup is starting", { status: 503 }),
    });
    activeServer = server;
    const redirectUrl = `http://127.0.0.1:${server.port}/callback`;
    let resolveCallback: ((result: CallbackResult) => void) | null = null;
    let rejectCallback: ((error: Error) => void) | null = null;
    const callback = new Promise<CallbackResult>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });

    const manifest = buildManifest({
      name: input.appName,
      homepageUrl: `https://${input.host}`,
      redirectUrl,
    });
    const registrationUrl = `${manifestRegistrationUrl(input.host, input.organization)}?state=${state}`;
    const form = renderManifestForm(registrationUrl, manifest);

    server.reload({
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/" && request.method === "GET") {
          return new Response(form, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/callback") {
          const returnedState = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
          if (error) {
            rejectCallback?.(new Error(`GitHub App registration failed: ${error}`));
            return htmlResponse(
              "<h2>Reviewbot setup failed</h2><p>GitHub reported an error. Return to the terminal for details.</p>",
              400,
            );
          }
          if (!returnedState || returnedState !== state) {
            rejectCallback?.(new Error("GitHub App callback state did not match"));
            return htmlResponse(
              "<h2>Reviewbot setup failed</h2><p>Invalid registration state.</p>",
              400,
            );
          }
          if (!code) {
            rejectCallback?.(new Error("GitHub App callback did not include a code"));
            return htmlResponse(
              "<h2>Reviewbot setup failed</h2><p>Missing registration code.</p>",
              400,
            );
          }
          resolveCallback?.({ code, state: returnedState });
          return htmlResponse(
            "<h2>Reviewbot App created</h2><p>You can close this window and return to the terminal.</p>",
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    stdout.write(
      `\nOpen this URL in a browser to create the organization-owned App:\n  http://127.0.0.1:${server.port}/\n\n`,
    );
    openBrowser(`http://127.0.0.1:${server.port}/`);
    stdout.write(
      "Waiting for GitHub to redirect back to the local callback...\n",
    );

    const timeout = setTimeout(
      () =>
        rejectCallback?.(
          new Error(
            "Timed out waiting for GitHub App registration. Organization policy may prohibit App creation.",
          ),
        ),
      CALLBACK_TIMEOUT_MS,
    );
    let result: CallbackResult;
    try {
      result = await callback;
    } finally {
      clearTimeout(timeout);
    }

    stdout.write("Exchanging registration code for App credentials...\n");
    const manifestData = await exchangeManifestCode(input.host, result.code);
    const credentials: Credentials = {
      host: input.host,
      appId: manifestData.appId,
      slug: manifestData.slug,
      name: manifestData.name,
      privateKey: manifestData.privateKey,
      clientId: manifestData.clientId ?? undefined,
      clientSecret: manifestData.clientSecret ?? undefined,
      webhookSecret: manifestData.webhookSecret ?? undefined,
      organization: input.organization,
      htmlUrl: manifestData.htmlUrl ?? undefined,
    };
    const secured = saveCredentials(credentials);
    if (!secured.ok) {
      throw new Error(
        `GitHub App credentials were written but their permissions could not be restricted: ${secured.detail ?? "unknown error"}`,
      );
    }
    serversClose(server);

    const github = new GitHub(credentials, logger);
    const app = await github.appInfo();
    stdout.write(
      `\nRegistered ${app.name} (${app.slug}) as App ${credentials.appId}.\n`,
    );
    const installUrl = appInstallUrl(input.host, app.slug);
    stdout.write(
      `\nInstall the App on the organization and selected repositories:\n  ${installUrl}\n\n`,
    );
    openBrowser(installUrl);
    stdout.write("Waiting for an installation with repository access...\n");

    const installation = await waitForInstallation(
      github,
      input.organization,
      logger,
    );
    stdout.write(
      `\nInstallation ${installation.id} (${installation.accountLogin}) is active.\n`,
    );

    const store = new Store(databasePath());
    try {
      store.recoverRunningJobs();
      const poller = new Poller({
        store,
        github,
        logger,
        botSlug: app.slug,
      });
      const baseline = await poller.pollOnce();
      stdout.write(
        `\nRepository monitoring baseline initialized for ${baseline.repositories} repositories.\n` +
          "Historical issues and pull requests will not be processed.\n",
      );
      stdout.write(
        "\nSetup complete. Start the daemon with:\n  reviewbot run\n\n",
      );
    } finally {
      store.close();
    }
  } finally {
    rl.close();
    activeServer?.stop(true);
  }
}

async function waitForInstallation(
  github: GitHub,
  organization: string,
  logger: Logger,
): Promise<{ id: number; accountLogin: string }> {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const installations = await github.listInstallations();
    const matching = installations.filter(
      (installation) =>
        installation.accountLogin.toLowerCase() === organization.toLowerCase() &&
        !installation.suspended,
    );
    for (const installation of matching) {
      const repositories = await github.listInstallationRepositories(installation.id);
      if (repositories.length > 0) {
        const missing = ["contents", "issues", "pull_requests"].filter(
          (permission) => installation.permissions[permission] !== "write",
        );
        if (missing.length > 0) {
          throw new Error(
            `Installation ${installation.id} is missing required write permissions: ${missing.join(", ")}. Update the App installation permissions and retry.`,
          );
        }
        return {
          id: installation.id,
          accountLogin: installation.accountLogin,
        };
      }
    }
    await sleep(5000);
  }
  logger.error(
    { organization },
    "installation wait timed out; install the App on at least one repository",
  );
  throw new Error(
    "Timed out waiting for an installation with repository access. Organization policy may prohibit installation.",
  );
}

function renderManifestForm(action: string, manifest: Record<string, unknown>): string {
  const value = escapeAttribute(JSON.stringify(manifest));
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Reviewbot setup</title></head>
<body>
<p>Redirecting to GitHub to create the Reviewbot App...</p>
<form id="manifest-form" action="${escapeAttribute(action)}" method="post">
  <input type="hidden" name="manifest" value="${value}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("manifest-form").submit();</script>
</body></html>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url];
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed for manual opening.
  }
}

function serversClose(server: ReturnType<typeof Bun.serve>): void {
  try {
    server.stop(true);
  } catch {
    // Already stopped.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
