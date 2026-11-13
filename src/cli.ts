#!/usr/bin/env bun
import { Command } from "commander";
import { REVIEWBOT_VERSION, loadConfig, loadCredentials } from "./config.ts";
import { collectStatus, runDoctor } from "./diagnostics.ts";
import { runDaemon } from "./daemon.ts";
import { createLogger } from "./log.ts";
import { runSetup } from "./setup.ts";

const program = new Command();

program
  .name("reviewbot")
  .description("GitHub App integration for an existing OpenCode V2 service")
  .version(REVIEWBOT_VERSION);

program
  .command("setup")
  .description("Register the GitHub App, verify installation access, and set the monitoring baseline")
  .action(async () => {
    const logger = createLogger();
    await runSetup(logger);
  });

program
  .command("run")
  .description("Run the polling daemon and single job worker in the foreground")
  .action(async () => {
    const logger = createLogger();
    const config = loadConfig();
    const credentials = loadCredentials();
    if (credentials.host !== config.github.host) {
      throw new Error(
        `Configured host ${config.github.host} does not match credential host ${credentials.host}. Run setup again.`,
      );
    }
    await runDaemon({ config, credentials, logger });
  });

program
  .command("status")
  .description("Show configuration, connectivity, queue, and recent failure state")
  .action(async () => {
    const logger = createLogger("warn");
    const status = await collectStatus(logger);
    const lines = [
      `GitHub host:        ${status.host ?? "not configured"}`,
      `OpenCode:           ${status.opencode}`,
      `Installations:      ${status.installations} active`,
      `Repositories:       ${status.repositories}`,
      `Last successful poll: ${status.lastPoll ?? "never"}`,
      `Queue:              ${status.queued} queued; active: ${status.activeJob ?? "none"}`,
      `Permission boundary: ${
        status.security
          ? `${status.security.status} (${status.security.detail})`
          : "not evaluated"
      }`,
    ];
    for (const pollError of status.pollErrors) {
      lines.push(`Poll error (${pollError.repo}): ${pollError.error}`);
    }
    if (status.recentFailures.length > 0) {
      lines.push("Recent failures:");
      for (const failure of status.recentFailures) {
        lines.push(`  - ${failure.key}: ${failure.error ?? "unknown error"}`);
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  });

program
  .command("doctor")
  .description("Validate runtime, GitHub, OpenCode, security, and storage prerequisites")
  .action(async () => {
    const logger = createLogger("warn");
    const { checks, ok } = await runDoctor(logger);
    for (const check of checks) {
      const marker = check.status === "ok" ? "OK  " : check.status === "warn" ? "WARN" : "FAIL";
      process.stdout.write(`${marker}  ${check.name}: ${check.detail}\n`);
    }
    if (!ok) {
      process.stdout.write("\nDoctor found blocking problems.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("\nAll checks passed.\n");
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`reviewbot: ${message}\n`);
  process.exitCode = 1;
});
