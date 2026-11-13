import type { Config, Credentials } from "./config.ts";
import { Store } from "./db.ts";
import { databasePath } from "./paths.ts";
import { GitHub } from "./github.ts";
import { OpenCodeAdapter, loadPrompt } from "./opencode.ts";
import { Poller, RateLimitedError } from "./polling.ts";
import { Publisher } from "./publish.ts";
import { evaluateSecurityGate, gateIsOpen, type SecurityGate } from "./security.ts";
import { WorkspaceManager } from "./workspace.ts";
import { Worker } from "./worker.ts";
import type { Logger } from "./log.ts";

const GATE_RETRY_MS = 10 * 60 * 1000;

export async function runDaemon(options: {
  config: Config;
  credentials: Credentials;
  logger: Logger;
}): Promise<void> {
  const { config, credentials, logger } = options;
  const store = new Store(databasePath());
  const recovered = store.recoverRunningJobs();
  if (recovered > 0) {
    logger.warn({ recovered }, "requeued jobs interrupted by a previous shutdown");
  }

  const github = new GitHub(credentials, logger);
  const app = await github.appInfo();
  const adapter = new OpenCodeAdapter({
    url: config.opencode.url,
    model: config.opencode.model,
    logger,
  });
  const workspace = new WorkspaceManager({ credentials, logger });
  const publisher = new Publisher({
    store,
    github,
    logger,
    botLogin: `${app.slug}[bot]`,
  });

  let gate: SecurityGate | null = null;
  let stopped = false;
  const stop = (signal: string) => {
    if (stopped) return;
    stopped = true;
    logger.info({ signal }, "shutting down");
    void adapter.interruptAll();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  gate = await evaluateSecurityGate({ adapter, store, logger, force: true });
  if (gateIsOpen(gate)) {
    logger.info({ detail: gate.detail }, "read-only security boundary verified");
  } else {
    logger.error(
      { status: gate.status, detail: gate.detail },
      "automatic processing is gated: the read-only security boundary is not verified",
    );
  }

  const worker = new Worker({
    store,
    github,
    adapter,
    publisher,
    workspace,
    logger,
    prompt: loadPrompt(),
    gateOpen: () => gateIsOpen(gate),
    host: config.github.host,
    botLogin: `${app.slug}[bot]`,
    isStopping: () => stopped,
    closeGate: (reason: string) => {
      gate = null;
      logger.warn({ reason }, "security gate closed after OpenCode unavailability");
    },
  });
  const poller = new Poller({
    store,
    github,
    logger,
    botSlug: app.slug,
  });

  logger.info(
    {
      host: config.github.host,
      interval: config.polling.intervalSeconds,
      app: app.slug,
      model: config.opencode.model ?? "opencode-default",
    },
    "reviewbot daemon started",
  );

  const workerLoop = (async () => {
    let lastGateCheck = Date.now();
    while (!stopped) {
      if (!gateIsOpen(gate)) {
        if (Date.now() - lastGateCheck >= GATE_RETRY_MS) {
          gate = await evaluateSecurityGate({ adapter, store, logger, force: true });
          lastGateCheck = Date.now();
          logger.info(
            { status: gate.status, detail: gate.detail },
            "re-evaluated security boundary",
          );
        }
        await interruptibleSleep(5000, () => stopped);
        continue;
      }
      let processed = false;
      try {
        processed = await worker.runOnce();
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "worker loop error",
        );
      }
      if (!processed) await interruptibleSleep(3000, () => stopped);
    }
  })();

  const pollLoop = (async () => {
    while (!stopped) {
      const resetAt = store.getMeta("github.rate_limit_reset");
      if (resetAt) {
        const wait = Date.parse(resetAt) - Date.now();
        if (wait > 0) {
          logger.warn(
            { resetAt, retryAfterSeconds: Math.ceil(wait / 1000) },
            "resuming persisted GitHub rate-limit backoff",
          );
          await interruptibleSleep(Math.min(wait, 60 * 60 * 1000), () => stopped);
        }
        store.deleteMeta("github.rate_limit_reset");
      }
      const started = Date.now();
      try {
        const result = await poller.pollOnce();
        store.deleteMeta("github.rate_limit_reset");
        logger.info(result, "poll complete");
      } catch (error) {
        const candidate = error as {
          rateLimited?: boolean;
          retryAfterSeconds?: number | null;
        };
        if (error instanceof RateLimitedError || candidate.rateLimited) {
          const retryAfterSeconds =
            error instanceof RateLimitedError
              ? error.retryAfterSeconds
              : (candidate.retryAfterSeconds ?? 60);
          logger.warn(
            { retryAfterSeconds },
            "GitHub rate limit reached; backing off",
          );
          store.setMeta(
            "github.rate_limit_reset",
            new Date(
              Date.now() +
                Math.min(60 * 60 * 1000, Math.max(10_000, retryAfterSeconds * 1000)),
            ).toISOString(),
          );
          await interruptibleSleep(
            Math.min(60 * 60 * 1000, Math.max(10_000, retryAfterSeconds * 1000)),
            () => stopped,
          );
          continue;
        }
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "poll failed; checkpoints retained",
        );
      }
      const elapsed = Date.now() - started;
      const wait = Math.max(1000, config.polling.intervalSeconds * 1000 - elapsed);
      await interruptibleSleep(wait, () => stopped);
    }
  })();

  await Promise.allSettled([workerLoop, pollLoop]);
  store.close();
  logger.info("reviewbot daemon stopped");
}

async function interruptibleSleep(
  ms: number,
  stopped: () => boolean,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!stopped() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
}
