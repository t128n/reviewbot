import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import type { SessionMessageAssistant } from "@opencode/client";
import { Service, headers as serviceHeaders } from "@opencode/client/service";
import type { Logger } from "./log.ts";
import { redactText } from "./log.ts";
import { dataDir } from "./paths.ts";

export const OPENCODE_CLIENT_VERSION = "2.3.0";
export const MINIMUM_OPENCODE_VERSION = "2.2.0";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** Default-deny ruleset for automatic tasks. Only repository reading is allowed. */
export const READ_ONLY_RULES: PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  // Repository content is untrusted, but local credential-shaped files are
  // never needed for triage or review.
  { action: "read", resource: "*.env*", effect: "deny" },
  { action: "read", resource: "*.pem", effect: "deny" },
  { action: "read", resource: "*.p12", effect: "deny" },
  { action: "read", resource: "*.pfx", effect: "deny" },
  { action: "read", resource: "*id_rsa*", effect: "deny" },
  { action: "read", resource: "*/.git-credentials", effect: "deny" },
  { action: "read", resource: "*/.npmrc", effect: "deny" },
  { action: "read", resource: "*/.netrc", effect: "deny" },
  { action: "read", resource: "*/credentials.json", effect: "deny" },
];

/**
 * Authorized implementation tasks may edit the isolated worktree, but never
 * execute shell/Code Mode, read outside the worktree, or use network/MCP tools.
 */
export const IMPLEMENT_RULES: PermissionRule[] = [
  ...READ_ONLY_RULES,
  { action: "edit", resource: "*", effect: "allow" },
];

/** Defence in depth: never expose Reviewbot's own credential/database files. */
export function sensitivePathRules(): PermissionRule[] {
  const base = dataDir().replace(/\\/g, "/");
  return [
    { action: "read", resource: `${base}/credentials/*`, effect: "deny" },
    { action: "read", resource: `${base}/reviewbot.db*`, effect: "deny" },
    { action: "edit", resource: `${base}/credentials/*`, effect: "deny" },
    { action: "edit", resource: `${base}/reviewbot.db*`, effect: "deny" },
  ];
}

export function sessionRules(mode: "read" | "implement"): PermissionRule[] {
  return [
    ...(mode === "read" ? READ_ONLY_RULES : IMPLEMENT_RULES),
    ...sensitivePathRules(),
  ];
}

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export function parseModelRef(
  value: string,
): { providerID: string; id: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const providerID = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (!providerID || !id || /\s/.test(value)) return null;
  return { providerID, id };
}

export class OpenCodeUnavailableError extends Error {
  constructor(message: string) {
    super(redactText(message));
    this.name = "OpenCodeUnavailableError";
  }
}

export class OpenCodeCompatibilityError extends Error {
  constructor(message: string) {
    super(redactText(message));
    this.name = "OpenCodeCompatibilityError";
  }
}

export class TaskTimeoutError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "TaskTimeoutError";
  }
}

export class TaskExecutionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(redactText(message));
    this.name = "TaskExecutionError";
    this.retryable = retryable;
  }
}

export interface ToolObservation {
  name: string;
  status: string;
  input: Record<string, unknown>;
  error: string | null;
}

export interface TaskRunResult {
  text: string;
  tools: ToolObservation[];
  sessionId: string;
}

export interface SessionOptions {
  directory: string;
  title: string;
  mode: "read" | "implement";
}

export function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isCompatibleServer(version: string): boolean {
  const parsed = parseVersion(version);
  const minimum = parseVersion(MINIMUM_OPENCODE_VERSION);
  if (!parsed || !minimum) return false;
  if (parsed[0] !== 2) return false;
  return (
    parsed[0] > minimum[0] ||
    (parsed[0] === minimum[0] && parsed[1] > minimum[1]) ||
    (parsed[0] === minimum[0] &&
      parsed[1] === minimum[1] &&
      parsed[2] >= minimum[2])
  );
}

export class OpenCodeAdapter {
  private readonly configuredUrl: string | null;
  private readonly configuredModel: string | null;
  private readonly logger: Logger;
  private cached: { client: OpenCodeClient; url: string; version: string } | null =
    null;
  private readonly activeSessions = new Set<string>();
  private cachedAt = 0;

  constructor(options: {
    url: string | null;
    model: string | null;
    logger: Logger;
  }) {
    this.configuredUrl = options.url;
    this.configuredModel = options.model;
    this.logger = options.logger;
  }

  async connect(): Promise<{ client: OpenCodeClient; url: string; version: string }> {
    if (this.cached && Date.now() - this.cachedAt < 60_000) {
      return this.cached;
    }
    let url: string;
    let requestHeaders: Record<string, string> | undefined;

    if (this.configuredUrl) {
      url = this.configuredUrl;
      const password = process.env.OPENCODE_SERVER_PASSWORD;
      if (password) {
        requestHeaders = {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        };
      }
    } else {
      let endpoint;
      try {
        endpoint = await Service.discover();
      } catch (error) {
        throw new OpenCodeUnavailableError(
          `OpenCode service discovery failed: ${errorText(error)}`,
        );
      }
      if (!endpoint) {
        throw new OpenCodeUnavailableError(
          "No healthy OpenCode V2 service was discovered. Start OpenCode and retry.",
        );
      }
      url = endpoint.url;
      requestHeaders = serviceHeaders(endpoint);
    }

    const client = OpenCode.make({ baseUrl: url, headers: requestHeaders });
    let info;
    try {
      info = await client.server.info({ signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      this.cached = null;
      throw new OpenCodeUnavailableError(
        `OpenCode service is not reachable at ${url}: ${errorText(error)}`,
      );
    }
    if (!isCompatibleServer(info.version)) {
      throw new OpenCodeCompatibilityError(
        `OpenCode ${info.version} is not compatible; Reviewbot requires V2 >= ${MINIMUM_OPENCODE_VERSION} (tested with 2.2.7 and @opencode/client ${OPENCODE_CLIENT_VERSION}).`,
      );
    }
    this.cached = { client, url, version: info.version };
    this.cachedAt = Date.now();
    this.logger.info(
      { url, version: info.version, client: OPENCODE_CLIENT_VERSION },
      "connected to OpenCode",
    );
    return this.cached;
  }

  async modelAvailable(value: string): Promise<boolean> {
    const ref = parseModelRef(value);
    if (!ref) return false;
    const { client } = await this.connect();
    const models = await client.model.list({ location: { directory: process.cwd() } });
    return models.data.some(
      (model) =>
        model.enabled &&
        model.providerID === ref.providerID &&
        (model.modelID === ref.id || model.id === ref.id),
    );
  }

  async createSession(options: SessionOptions): Promise<string> {
    const { client } = await this.connect();
    const permissions = sessionRules(options.mode);
    const model = this.configuredModel
      ? parseModelRef(this.configuredModel)
      : null;
    let session;
    try {
      session = await client.session.create(
        {
          title: options.title,
          location: { directory: options.directory },
          permissions,
          ...(model ? { model } : {}),
        },
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      this.cached = null;
      throw new OpenCodeUnavailableError(
        `OpenCode could not create a session: ${errorText(error)}`,
      );
    }
    this.logger.info(
      { sessionId: session.id, mode: options.mode },
      "created OpenCode session",
    );
    return session.id;
  }

  async applyInstructions(sessionId: string, text: string): Promise<void> {
    const { client } = await this.connect();
    try {
      await client.experimental.session.instructions.entry.put(
        {
          sessionID: sessionId,
          key: "reviewbot",
          value: text,
        },
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      this.cached = null;
      throw new OpenCodeUnavailableError(
        `OpenCode could not apply session instructions: ${errorText(error)}`,
      );
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const { client } = await this.connect();
      await client.session.get(
        { sessionID: sessionId },
        { signal: AbortSignal.timeout(10_000) },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ask the server how the session's permission ruleset resolves an action.
   * This is the same decision path used before tool execution and does not
   * require a model call.
   */
  async permissionDecision(
    sessionId: string,
    action: string,
    resource: string,
  ): Promise<"allow" | "deny" | "ask"> {
    const { client } = await this.connect();
    const result = await client.permission.create(
      {
        sessionID: sessionId,
        action,
        resources: [resource],
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    return result.effect;
  }

  /**
   * Send a prompt and wait for the session to become idle. On timeout the
   * execution is interrupted, satisfying the task-limit requirement.
   */
  async runTask(options: {
    sessionId: string;
    text: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<TaskRunResult> {
    this.activeSessions.add(options.sessionId);
    try {
      return await this.runTaskInner(options);
    } finally {
      this.activeSessions.delete(options.sessionId);
    }
  }

  async interruptAll(): Promise<void> {
    await Promise.all(
      [...this.activeSessions].map((sessionId) => this.interrupt(sessionId)),
    );
  }

  private async runTaskInner(options: {
    sessionId: string;
    text: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<TaskRunResult> {
    const { client } = await this.connect();
    const startedAt = Date.now();
    let previousIdle: number | undefined;
    try {
      const before = await client.session.get(
        { sessionID: options.sessionId },
        { signal: AbortSignal.timeout(10_000) },
      );
      previousIdle = before.time.idle;
    } catch {
      previousIdle = undefined;
    }
    try {
      await client.session.prompt(
        { sessionID: options.sessionId, text: options.text },
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      this.cached = null;
      throw new TaskExecutionError(
        `OpenCode rejected the prompt: ${errorText(error)}`,
        true,
      );
    }

    const deadline = startedAt + options.timeoutMs;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        await this.interrupt(options.sessionId);
        throw new TaskExecutionError("Task aborted", true);
      }
      await sleep(1500);
      let session;
      try {
        session = await client.session.get(
          { sessionID: options.sessionId },
          { signal: AbortSignal.timeout(30_000) },
        );
      } catch (error) {
        this.cached = null;
        throw new TaskExecutionError(
          `OpenCode session became unavailable: ${errorText(error)}`,
          true,
        );
      }
      if (sessionTurnComplete(session.time.idle, startedAt, previousIdle)) {
        return await this.collectResult(options.sessionId, startedAt);
      }
    }

    await this.interrupt(options.sessionId);
    throw new TaskTimeoutError(
      `OpenCode task exceeded ${Math.round(options.timeoutMs / 60_000)} minutes and was interrupted`,
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    try {
      const { client } = await this.connect();
      await client.session.interrupt(
        { sessionID: sessionId },
        { signal: AbortSignal.timeout(10_000) },
      );
    } catch (error) {
      this.logger.warn(
        { sessionId, error: errorText(error) },
        "failed to interrupt OpenCode session",
      );
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    try {
      const { client } = await this.connect();
      await client.session.remove(
        { sessionID: sessionId },
        { signal: AbortSignal.timeout(10_000) },
      );
    } catch (error) {
      this.logger.debug(
        { sessionId, error: errorText(error) },
        "failed to remove probe session",
      );
    }
  }

  private async collectResult(
    sessionId: string,
    startedAt: number,
  ): Promise<TaskRunResult> {
    const { client } = await this.connect();
    let messages;
    try {
      messages = await client.message.list(
        {
          sessionID: sessionId,
          limit: 200,
          order: "asc",
        },
        { signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      this.cached = null;
      throw new TaskExecutionError(
        `OpenCode session result could not be read: ${errorText(error)}`,
        true,
      );
    }
    const assistant = messages.data.filter(
      (message) => message.type === "assistant" && message.time.created >= startedAt,
    ) as SessionMessageAssistant[];
    if (assistant.length === 0) {
      throw new TaskExecutionError(
        "OpenCode produced no assistant response",
        true,
      );
    }
    const tools: ToolObservation[] = [];
    let text = "";
    for (const message of assistant) {
      if (message.error) {
        throw new TaskExecutionError(
          `OpenCode task failed: ${message.error.message}`,
          isRetryableProviderError(message.error.type, message.error.status),
        );
      }
      for (const content of message.content) {
        if (content.type === "tool") {
          const input =
            "input" in content.state &&
            typeof content.state.input === "object" &&
            content.state.input !== null
              ? (content.state.input as Record<string, unknown>)
              : {};
          tools.push({
            name: content.name,
            status: content.state.status,
            input,
            error:
              content.state.status === "error"
                ? `${content.state.error.type}: ${content.state.error.message}`
                : null,
          });
        }
        if (content.type === "text") {
          text = content.text;
        }
      }
    }
    if (!text.trim()) {
      throw new TaskExecutionError("OpenCode returned an empty response", true);
    }
    return { text, tools, sessionId };
  }
}

/**
 * A turn is complete only when the session has become idle after the prompt
 * was submitted. The outcome field belongs to the previous completed run and
 * must not be used, or a reused conversational session returns immediately.
 */
export function sessionTurnComplete(
  idleAt: number | undefined,
  startedAt: number,
  previousIdle?: number,
): boolean {
  if (idleAt === undefined) return false;
  if (previousIdle !== undefined) return idleAt > previousIdle;
  return idleAt >= startedAt;
}

export function loadPrompt(): string {
  try {
    return readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
  } catch (error) {
    throw new Error(`Reviewbot instruction prompt is missing: ${errorText(error)}`);
  }
}

/** Job-shaped task kinds that receive task-specific phrasing references. */
export type PromptTask =
  | "triage"
  | "duplicate-reassessment"
  | "review"
  | "conversation"
  | "fix";

/**
 * Triage covers every possible outcome, so it receives the duplicate, investigation, and
 * clarification references together. Other tasks receive only the examples for their outcome.
 */
export const PROMPT_EXAMPLES: Record<PromptTask, readonly string[]> = {
  triage: [
    "duplicate-confirmed",
    "duplicate-likely",
    "issue-investigation",
    "issue-clarification",
  ],
  "duplicate-reassessment": ["duplicate-closed", "duplicate-reopened"],
  review: ["pr-review"],
  conversation: ["conversation"],
  fix: [],
};

const EXAMPLES_NOTE =
  "The examples below are behavioral references for this task. Adapt them to the supplied evidence; do not reuse their issue numbers, paths, symptoms, or findings, and do not treat them as fixed templates.";

export function loadPromptFor(task: PromptTask): string {
  return composePrompt(loadPrompt(), task);
}

/** Append only the example sets relevant to the selected task. */
export function composePrompt(base: string, task: PromptTask): string {
  const names = PROMPT_EXAMPLES[task];
  if (names.length === 0) return base.trimEnd();
  return [
    base.trimEnd(),
    "## Task-specific response examples",
    EXAMPLES_NOTE,
    ...names.map((name) =>
      [`Example set: ${name}`, "", loadPromptExample(name)].join("\n"),
    ),
  ].join("\n\n");
}

function loadPromptExample(name: string): string {
  try {
    return readFileSync(
      new URL(`./prompts/${name}.txt`, import.meta.url),
      "utf8",
    ).trim();
  } catch (error) {
    throw new Error(
      `Reviewbot response example "${name}" is missing: ${errorText(error)}`,
    );
  }
}

function isRetryableProviderError(type: string, status?: number): boolean {
  if (type === "provider.quota" || type === "provider.auth") return false;
  if (status === 401 || status === 403) return false;
  return true;
}

function errorText(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
