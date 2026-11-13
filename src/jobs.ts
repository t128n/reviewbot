import * as v from "valibot";

export const MAX_PROMPT_BODY_CHARS = 60_000;

const RepoFields = {
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

export const TriagePayloadSchema = v.object({
  ...RepoFields,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  body: v.string(),
  author: v.string(),
});

export const ReviewPayloadSchema = v.object({
  ...RepoFields,
  pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  headSha: v.pipe(v.string(), v.minLength(1)),
  previousReviewedSha: v.nullable(v.string()),
  mode: v.picklist(["initial", "incremental"]),
});

export const ConversationPayloadSchema = v.object({
  ...RepoFields,
  subjectType: v.picklist(["issue", "pr"]),
  subjectNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  commentId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  channel: v.picklist(["issue", "review"]),
  body: v.string(),
  author: v.string(),
  title: v.string(),
  path: v.optional(v.nullable(v.string())),
  line: v.optional(v.nullable(v.number())),
  originalLine: v.optional(v.nullable(v.number())),
  diffHunk: v.optional(v.nullable(v.string())),
  inReplyToId: v.optional(v.nullable(v.number())),
});

export const FixPayloadSchema = v.object({
  ...RepoFields,
  subjectType: v.picklist(["issue", "pr"]),
  subjectNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  commentId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  channel: v.picklist(["issue", "review"]),
  body: v.string(),
  author: v.string(),
  title: v.string(),
});

export type TriagePayload = v.InferOutput<typeof TriagePayloadSchema>;
export type ReviewPayload = v.InferOutput<typeof ReviewPayloadSchema>;
export type ConversationPayload = v.InferOutput<typeof ConversationPayloadSchema>;
export type FixPayload = v.InferOutput<typeof FixPayloadSchema>;

export type JobPayload =
  | TriagePayload
  | ReviewPayload
  | ConversationPayload
  | FixPayload;

export function triageKey(repoId: number, issueNumber: number): string {
  return `triage:${repoId}:${issueNumber}`;
}

export function reviewKey(
  repoId: number,
  pullNumber: number,
  headSha: string,
): string {
  return `review:${repoId}:${pullNumber}:${headSha}`;
}

export function conversationKey(repoId: number, commentId: number): string {
  return `conversation:${repoId}:${commentId}`;
}

export function fixKey(repoId: number, commentId: number): string {
  return `fix:${repoId}:${commentId}`;
}

export function truncateBody(body: string): string {
  if (body.length <= MAX_PROMPT_BODY_CHARS) return body;
  return `${body.slice(0, MAX_PROMPT_BODY_CHARS)}\n\n[truncated by Reviewbot]`;
}

export function parsePayload<T>(schema: v.GenericSchema<T>, raw: string): T {
  return v.parse(schema, JSON.parse(raw));
}
