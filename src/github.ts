import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import * as v from "valibot";
import { apiBaseUrl, errorMessage, type Credentials } from "./config.ts";
import { redactText, type Logger } from "./log.ts";

export type GitHubClient = InstanceType<typeof Octokit>;

export interface InstallationSummary {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  permissions: Record<string, string>;
}

export interface RepositorySummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}

export interface PullSummary {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  state: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: string;
  authorType: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  body: string | null;
  author: string;
  authorType: string;
  createdAt: string;
  updatedAt: string;
  isPullRequest: boolean;
  state: string;
  htmlUrl: string;
}

export interface CommentSummary {
  id: number;
  body: string;
  author: string;
  authorType: string;
  createdAt: string;
  updatedAt: string;
  issueNumber: number | null;
  htmlUrl: string;
  pullRequestReviewId?: number | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffHunk: string | null;
  inReplyToId: number | null;
}

export interface ReviewSummary {
  id: number;
  body: string | null;
  state: string;
  commitId: string | null;
  author: string;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      rateLimited?: boolean;
      retryAfterSeconds?: number | null;
    } = {},
  ) {
    super(redactText(message));
    this.name = "GitHubError";
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.rateLimited = options.rateLimited ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** Classify Octokit failures without inspecting credential material. */
export function classifyGitHubError(error: unknown): GitHubError {
  if (error instanceof GitHubError) return error;
  const candidate = error as {
    status?: number;
    message?: string;
    response?: {
      headers?: Record<string, string | number | undefined>;
      data?: { message?: string };
    };
  };
  const status = candidate.status ?? 0;
  const headers = candidate.response?.headers ?? {};
  const remaining = Number(headers["x-ratelimit-remaining"] ?? Number.NaN);
  const retryAfter = Number(headers["retry-after"] ?? Number.NaN);
  const reset = Number(headers["x-ratelimit-reset"] ?? Number.NaN);
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (remaining === 0 ||
        String(candidate.response?.data?.message ?? "").toLowerCase().includes("rate limit")));
  let retryAfterSeconds: number | null = null;
  if (Number.isFinite(retryAfter)) retryAfterSeconds = Math.max(0, retryAfter);
  else if (Number.isFinite(reset)) retryAfterSeconds = Math.max(0, reset - Math.floor(Date.now() / 1000));
  const message =
    candidate.response?.data?.message ?? candidate.message ?? errorMessage(error);
  return new GitHubError(message, {
    status,
    retryable:
      rateLimited ||
      status === 0 ||
      status >= 500 ||
      status === 408 ||
      status === 409,
    rateLimited,
    retryAfterSeconds,
  });
}

function requestOptions(baseUrl: string) {
  return {
    baseUrl,
    request: { retries: 0 },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

export class GitHub {
  readonly host: string;
  readonly apiBase: string;
  readonly app: App;
  readonly logger: Logger;

  constructor(credentials: Credentials, logger: Logger) {
    this.host = credentials.host;
    this.apiBase = apiBaseUrl(credentials.host);
    this.logger = logger;
    const ConfiguredOctokit = Octokit.defaults(requestOptions(this.apiBase));
    this.app = new App({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      Octokit: ConfiguredOctokit,
      log: {
        debug: () => {},
        info: () => {},
        warn: (message) => logger.warn({ message }, "octokit warning"),
        error: (message) => logger.error({ message: redactText(String(message)) }, "octokit error"),
      },
    });
  }

  /** Unauthenticated App-level client used for App metadata and installations. */
  appClient(): GitHubClient {
    return this.app.octokit as unknown as GitHubClient;
  }

  /**
   * Installation client with narrowed permissions. Tokens are cached by
   * @octokit/auth-app and never persisted by Reviewbot.
   */
  async installationClient(
    installationId: number,
    permissions: Record<string, string>,
  ): Promise<GitHubClient> {
    const authentication = (await this.app.octokit.auth({
      type: "installation",
      installationId,
      permissions,
    })) as { token: string };
    return new Octokit({
      ...requestOptions(this.apiBase),
      auth: authentication.token,
    });
  }

  async installationToken(
    installationId: number,
    permissions: Record<string, string> = {
      contents: "write",
      metadata: "read",
    },
  ): Promise<string> {
    const authentication = (await this.app.octokit.auth({
      type: "installation",
      installationId,
      permissions,
      refresh: true,
    })) as { token: string };
    return authentication.token;
  }

  async appInfo(): Promise<{ slug: string; name: string; htmlUrl: string | null }> {
    const data = await this.request<{
      slug?: string;
      name?: string;
      html_url?: string;
    }>(this.appClient(), "GET /app");
    if (!data.slug) throw new GitHubError("GitHub App response did not include a slug");
    return {
      slug: data.slug,
      name: data.name ?? data.slug,
      htmlUrl: data.html_url ?? null,
    };
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    const data = await paginate<Record<string, unknown>>(
      this.appClient(),
      "GET /app/installations",
      {},
      20,
    );
    return data.map((item) => ({
      id: Number(item.id),
      accountLogin: String((item.account as Record<string, unknown> | undefined)?.login ?? ""),
      accountType: String((item.account as Record<string, unknown> | undefined)?.type ?? ""),
      suspended: Boolean(item.suspended_at),
      permissions: (item.permissions as Record<string, string> | undefined) ?? {},
    }));
  }

  async listInstallationRepositories(
    installationId: number,
  ): Promise<RepositorySummary[]> {
    const octokit = await this.installationClient(installationId, {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
    });
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /installation/repositories",
      {},
      50,
      (body) =>
        ((body as { repositories?: Array<Record<string, unknown>> }).repositories ??
          []) as Array<Record<string, unknown>>,
    );
    return data
      .map((entry) => {
        const repo = (entry.repository ?? entry) as Record<string, unknown>;
        return mapRepository(repo);
      })
      .filter((repo): repo is RepositorySummary => repo !== null);
  }

  async verifyInstallationAccess(
    installationId: number,
    owner: string,
    repo: string,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const installation = await this.request<{ suspended_at?: string | null }>(
        this.appClient(),
        "GET /app/installations/{installation_id}",
        { installation_id: installationId },
      );
      if (installation.suspended_at) {
        return { ok: false, detail: "installation is suspended" };
      }
      const octokit = await this.installationClient(installationId, {
        metadata: "read",
        contents: "read",
      });
      await this.request(octokit, "GET /repos/{owner}/{repo}", { owner, repo });
      return { ok: true, detail: "installation access confirmed" };
    } catch (error) {
      const classified = classifyGitHubError(error);
      if (classified.retryable || classified.rateLimited) throw classified;
      return { ok: false, detail: classified.message };
    }
  }

  async getIssue(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
  ): Promise<IssueSummary> {
    const data = await this.request<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner, repo, issue_number: number },
    );
    return mapIssue(data);
  }

  async getPull(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullSummary> {
    const data = await this.request<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: number },
    );
    return mapPull(data);
  }

  async listIssues(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    since: string,
  ): Promise<IssueSummary[]> {    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/issues",
      {
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "asc",
        since,
      },
      20,
    );
    return data.filter((item) => !item.pull_request).map(mapIssue);
  }

  /** Bounded recent issue/PR titles and bodies for triage context. */
  async listRecentIssues(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    limit = 50,
  ): Promise<IssueSummary[]> {
    let response;
    try {
      response = await octokit.request("GET /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: limit,
      } as never);
    } catch (error) {
      throw classifyGitHubError(error);
    }
    return (response.data as Array<Record<string, unknown>>).map(mapIssue);
  }

  async listIssueComments(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    since: string,
  ): Promise<CommentSummary[]> {
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/issues/comments",
      { owner, repo, sort: "updated", direction: "asc", since },
      20,
    );
    return data.map((item) => mapComment(item, true));
  }

  async listReviewComments(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    since: string,
  ): Promise<CommentSummary[]> {
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/comments",
      { owner, repo, sort: "updated", direction: "asc", since },
      20,
    );
    return data.map((item) => mapComment(item, false));
  }

  async listPullFiles(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
  ): Promise<Array<{ filename: string; status: string; patch?: string; previousFilename?: string | null }>> {
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: number },
      30,
    );
    return data.map((file) => ({
      filename: String(file.filename),
      status: String(file.status),
      patch: typeof file.patch === "string" ? file.patch : undefined,
      previousFilename:
        typeof file.previous_filename === "string" ? file.previous_filename : null,
    }));
  }

  async compare(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    const data = await this.request<{ files?: Array<Record<string, unknown>> }>(
      octokit,
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      { owner, repo, basehead: `${base}...${head}` },
    );
    return (data.files ?? []).map((file) => ({
      filename: String(file.filename),
      status: String(file.status),
      patch: typeof file.patch === "string" ? file.patch : undefined,
    }));
  }

  async listReviews(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
  ): Promise<ReviewSummary[]> {
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { owner, repo, pull_number: number },
      10,
    );
    return data.map((review) => ({
      id: Number(review.id),
      body: typeof review.body === "string" ? review.body : null,
      state: String(review.state ?? ""),
      commitId: typeof review.commit_id === "string" ? review.commit_id : null,
      author: String((review.user as Record<string, unknown> | undefined)?.login ?? ""),
    }));
  }

  async createIssueComment(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<number> {
    const data = await this.request<{ id: number }>(
      octokit,
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: number, body },
    );
    return data.id;
  }

  async createReview(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
    input: {
      commitId: string;
      body: string;
      comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
    },
  ): Promise<number> {
    const data = await this.request<{ id: number }>(
      octokit,
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner,
        repo,
        pull_number: number,
        commit_id: input.commitId,
        body: input.body,
        event: "COMMENT",
        comments: input.comments,
      },
    );
    return data.id;
  }

  async createReviewCommentReply(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<number> {
    const data = await this.request<{ id: number }>(
      octokit,
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        owner,
        repo,
        pull_number: number,
        in_reply_to: commentId,
        body,
      },
    );
    return data.id;
  }

  async listIssueCommentsForMarker(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
  ): Promise<CommentSummary[]> {
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: number },
      20,
    );
    return data.map((item) => mapComment(item, true));
  }

  async listReviewCommentsForMarker(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    number: number,
  ): Promise<CommentSummary[]> {
    const data = await paginate<Record<string, unknown>>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      { owner, repo, pull_number: number },
      20,
    );
    return data.map((item) => mapComment(item, false));
  }

  async createDraftPull(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; htmlUrl: string }> {
    const data = await this.request<{ number: number; html_url: string }>(
      octokit,
      "POST /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: true,
      },
    );
    return { number: data.number, htmlUrl: data.html_url };
  }

  async findPullByHead(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    head: string,
  ): Promise<{ number: number; htmlUrl: string; draft: boolean; author: string } | null> {
    const data = await this.request<Array<Record<string, unknown>>>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        state: "all",
        head: `${owner}:${head}`,
        per_page: 10,
      },
    );
    const match = data[0];
    if (!match) return null;
    return {
      number: Number(match.number),
      htmlUrl: String(match.html_url ?? ""),
      draft: Boolean(match.draft),
      author: String((match.user as Record<string, unknown> | undefined)?.login ?? ""),
    };
  }

  async repositoryPermission(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    username: string,
  ): Promise<{ permission: string | null; roleName: string | null }> {
    try {
      const data = await this.request<{ permission?: string; role_name?: string }>(
        octokit,
        "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
        { owner, repo, username },
      );
      return {
        permission: data.permission ?? null,
        roleName: data.role_name ?? null,
      };
    } catch (error) {
      const classified = classifyGitHubError(error);
      if (classified.status === 404) return { permission: null, roleName: null };
      throw classified;
    }
  }

  async listOpenPulls(
    octokit: GitHubClient,
    owner: string,
    repo: string,
    etag?: string | null,
  ): Promise<{
    pulls: PullSummary[];
    etag: string | null;
    notModified: boolean;
  }> {
    const route = "GET /repos/{owner}/{repo}/pulls";
    const parameters = {
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    };
    let response;
    try {
      response = await octokit.request(route, {
        ...parameters,
        ...(etag ? { headers: { "if-none-match": etag } } : {}),
      } as never);
    } catch (error) {
      if ((error as { status?: number }).status === 304) {
        return { pulls: [], etag: etag ?? null, notModified: true };
      }
      throw classifyGitHubError(error);
    }
    if ((response.status as number) === 304) {
      return { pulls: [], etag: etag ?? null, notModified: true };
    }
    const pulls = (response.data as Array<Record<string, unknown>>).map(mapPull);
    let more = hasNextPage(response.headers.link);
    let page = 2;
    while (more && page <= 20) {
      let next;
      try {
        next = await octokit.request(route, {
          ...parameters,
          page,
        } as never);
      } catch (error) {
        throw classifyGitHubError(error);
      }
      pulls.push(...(next.data as Array<Record<string, unknown>>).map(mapPull));
      more = hasNextPage(next.headers.link);
      page += 1;
    }
    if (more) {
      throw new GitHubError(
        "Pagination limit reached for the open pull request list; checkpoint retained",
        { retryable: false },
      );
    }
    const responseEtag = response.headers.etag;
    return {
      pulls,
      etag: typeof responseEtag === "string" ? responseEtag : null,
      notModified: false,
    };
  }

  private async request<T>(
    octokit: GitHubClient,
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      const response = await octokit.request(route, parameters as never);
      return response.data as T;
    } catch (error) {
      throw classifyGitHubError(error);
    }
  }
}

async function paginate<T>(
  octokit: GitHubClient,
  route: string,
  parameters: Record<string, unknown>,
  maxPages: number,
  pick: (body: unknown) => T[] = (body) => body as T[],
): Promise<T[]> {
  const results: T[] = [];
  let more = false;
  for (let page = 1; page <= maxPages; page += 1) {
    let response;
    try {
      response = await octokit.request(route, {
        ...parameters,
        per_page: 100,
        page,
      } as never);
    } catch (error) {
      throw classifyGitHubError(error);
    }
    const data = pick(response.data);
    results.push(...data);
    more = hasNextPage(response.headers.link);
    if (!more) break;
  }
  if (more) {
    // Do not return a truncated collection: callers advance checkpoints after
    // a successful read, so a silently partial page would skip events.
    throw new GitHubError(
      `Pagination limit reached for ${route}; checkpoint retained`,
      { retryable: false },
    );
  }
  return results;
}

function hasNextPage(link: string | undefined): boolean {
  if (!link) return false;
  return link.split(",").some((part) => /rel="next"/.test(part));
}

function mapRepository(repo: Record<string, unknown>): RepositorySummary | null {
  const owner = (repo.owner as Record<string, unknown> | undefined)?.login;
  if (!repo.name || !owner) return null;
  return {
    id: Number(repo.id),
    owner: String(owner),
    name: String(repo.name),
    fullName: String(repo.full_name ?? `${owner}/${repo.name}`),
    defaultBranch: String(repo.default_branch ?? "main"),
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
  };
}

function mapIssue(item: Record<string, unknown>): IssueSummary {
  const user = (item.user as Record<string, unknown> | undefined) ?? {};
  return {
    number: Number(item.number),
    title: String(item.title ?? ""),
    body: typeof item.body === "string" ? item.body : null,
    author: String(user.login ?? ""),
    authorType: String(user.type ?? "User"),
    createdAt: String(item.created_at ?? ""),
    updatedAt: String(item.updated_at ?? ""),
    isPullRequest: Boolean(item.pull_request),
    state: String(item.state ?? "open"),
    htmlUrl: String(item.html_url ?? ""),
  };
}

function mapPull(item: Record<string, unknown>): PullSummary {
  const user = (item.user as Record<string, unknown> | undefined) ?? {};
  const head = (item.head as Record<string, unknown> | undefined) ?? {};
  const base = (item.base as Record<string, unknown> | undefined) ?? {};
  return {
    number: Number(item.number),
    title: String(item.title ?? ""),
    body: typeof item.body === "string" ? item.body : null,
    draft: Boolean(item.draft),
    state: String(item.state ?? "open"),
    headSha: String(head.sha ?? ""),
    headRef: String(head.ref ?? ""),
    baseRef: String(base.ref ?? ""),
    author: String(user.login ?? ""),
    authorType: String(user.type ?? "User"),
    createdAt: String(item.created_at ?? ""),
    updatedAt: String(item.updated_at ?? ""),
    htmlUrl: String(item.html_url ?? ""),
  };
}

function mapComment(item: Record<string, unknown>, isIssueComment: boolean): CommentSummary {
  const user = (item.user as Record<string, unknown> | undefined) ?? {};
  return {
    id: Number(item.id),
    body: String(item.body ?? ""),
    author: String(user.login ?? ""),
    authorType: String(user.type ?? "User"),
    createdAt: String(item.created_at ?? ""),
    updatedAt: String(item.updated_at ?? ""),
    issueNumber: isIssueComment
      ? numberFromIssueUrl(String(item.issue_url ?? item.html_url ?? ""))
      : numberFromPullUrl(String(item.html_url ?? "")),
    htmlUrl: String(item.html_url ?? ""),
    pullRequestReviewId:
      typeof item.pull_request_review_id === "number"
        ? item.pull_request_review_id
        : null,
    path: !isIssueComment && typeof item.path === "string" ? item.path : null,
    line: !isIssueComment && typeof item.line === "number" ? item.line : null,
    originalLine:
      !isIssueComment && typeof item.original_line === "number"
        ? item.original_line
        : null,
    diffHunk:
      !isIssueComment && typeof item.diff_hunk === "string" ? item.diff_hunk : null,
    inReplyToId:
      !isIssueComment && typeof item.in_reply_to_id === "number"
        ? item.in_reply_to_id
        : null,
  };
}

export function numberFromIssueUrl(url: string): number | null {
  const match = /\/issues\/(\d+)(?:$|[?#])/.exec(url);
  return match ? Number(match[1]) : null;
}

export function numberFromPullUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:$|[?#/])/.exec(url);
  return match ? Number(match[1]) : null;
}

export function canWriteRepository(permission: string | null): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

export const READ_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "read",
};

export const WRITE_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
};

const ManifestConversionSchema = v.object({
  id: v.number(),
  slug: v.string(),
  name: v.string(),
  pem: v.string(),
  html_url: v.optional(v.string()),
  webhook_secret: v.optional(v.nullable(v.string())),
  client_id: v.optional(v.string()),
  client_secret: v.optional(v.string()),
});

export interface ManifestData {
  appId: number;
  slug: string;
  name: string;
  privateKey: string;
  htmlUrl: string | null;
  webhookSecret: string | null;
  clientId: string | null;
  clientSecret: string | null;
}

/** Exchange a manifest callback code for App credentials. */
export async function exchangeManifestCode(
  host: string,
  code: string,
): Promise<ManifestData> {
  const octokit = new Octokit(requestOptions(apiBaseUrl(host)));
  try {
    const response = await octokit.request(
      "POST /app-manifests/{code}/conversions",
      { code },
    );
    const data = v.parse(ManifestConversionSchema, response.data);
    return {
      appId: data.id,
      slug: data.slug,
      name: data.name,
      privateKey: data.pem,
      htmlUrl: data.html_url ?? null,
      webhookSecret: data.webhook_secret ?? null,
      clientId: data.client_id ?? null,
      clientSecret: data.client_secret ?? null,
    };
  } catch (error) {
    throw classifyGitHubError(error);
  }
}

export function buildManifest(input: {
  name: string;
  homepageUrl: string;
  redirectUrl: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    url: input.homepageUrl,
    redirect_url: input.redirectUrl,
    hook_attributes: {
      url: "https://example.invalid/reviewbot/webhook",
      active: false,
    },
    default_permissions: {
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    },
    default_events: [],
    public: false,
    request_oauth_on_install: false,
  };
}

export function manifestRegistrationUrl(host: string, organization: string): string {
  return `${webBase(host)}/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
}

export function appInstallUrl(host: string, slug: string): string {
  return `${webBase(host)}/apps/${encodeURIComponent(slug)}/installations/new`;
}

function webBase(host: string): string {
  return `https://${host}`;
}
