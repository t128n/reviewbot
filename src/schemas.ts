import * as v from "valibot";

export const MAX_RESULT_CHARS = 200_000;

const CommentText = v.pipe(v.string(), v.minLength(1), v.maxLength(20_000));
const IssueNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const ReasonText = v.pipe(v.string(), v.minLength(1), v.maxLength(4_000));
const EvidenceText = v.pipe(v.string(), v.minLength(1), v.maxLength(2_000));

/**
 * The model's advisory duplicate decision. The daemon validates references and
 * decides whether the proposal may trigger a lifecycle transition.
 */
export const DuplicateDecisionSchema = v.variant("kind", [
  v.object({
    kind: v.picklist(["independent", "related"]),
    canonicalIssueNumber: v.optional(v.nullable(IssueNumber)),
    reason: ReasonText,
  }),
  v.object({
    kind: v.literal("confirmed_duplicate"),
    canonicalIssueNumber: v.optional(v.nullable(IssueNumber)),
    reason: ReasonText,
    matchingEvidence: v.optional(
      v.pipe(v.array(EvidenceText), v.maxLength(10)),
    ),
    distinguishingQuestion: v.optional(
      v.pipe(v.string(), v.maxLength(1_000)),
    ),
  }),
  v.object({
    kind: v.literal("likely_duplicate"),
    canonicalIssueNumber: v.optional(v.nullable(IssueNumber)),
    reason: ReasonText,
    matchingEvidence: v.optional(
      v.pipe(v.array(EvidenceText), v.maxLength(10)),
    ),
    distinguishingQuestion: v.optional(
      v.pipe(v.string(), v.maxLength(1_000)),
    ),
  }),
]);

export type DuplicateDecision = v.InferOutput<typeof DuplicateDecisionSchema>;
export type DuplicateDecisionKind = DuplicateDecision["kind"];

export const TriageResultSchema = v.object({
  comment: CommentText,
  duplicate: DuplicateDecisionSchema,
});

export type TriageResult = v.InferOutput<typeof TriageResultSchema>;

/** Result of reviewing new comments in an existing duplicate case. */
export const DuplicateReassessmentSchema = v.object({
  comment: CommentText,
  outcome: v.picklist(["distinct", "still_duplicate", "uncertain"]),
  reason: ReasonText,
});

export type DuplicateReassessment = v.InferOutput<
  typeof DuplicateReassessmentSchema
>;

export const ConversationResultSchema = v.object({
  comment: CommentText,
});

export type ConversationResult = v.InferOutput<typeof ConversationResultSchema>;

export const ReviewFindingSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["LEFT", "RIGHT"]),
  severity: v.picklist(["low", "medium", "high"]),
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});

export const ReviewResultSchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
  findings: v.pipe(v.array(ReviewFindingSchema), v.maxLength(50)),
});

export type ReviewResult = v.InferOutput<typeof ReviewResultSchema>;
export type ReviewFinding = v.InferOutput<typeof ReviewFindingSchema>;

export const FixResultSchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
  verification: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
  notes: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
});

export type FixResult = v.InferOutput<typeof FixResultSchema>;

export class ResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultValidationError";
  }
}

/**
 * Extract and validate the model's machine-readable result. Accepts a fenced
 * JSON block or a single JSON object. Malformed output is never replaced with
 * invented findings.
 */
export function parseStructuredResult<T>(
  text: string,
  schema: v.GenericSchema<T>,
): T {
  if (text.length > MAX_RESULT_CHARS) {
    throw new ResultValidationError(
      `Model output exceeds ${MAX_RESULT_CHARS} characters`,
    );
  }
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenced)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  if (candidates.length === 0) {
    throw new ResultValidationError("Model output did not contain a JSON object");
  }
  for (const candidate of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = v.safeParse(schema, parsed);
    if (result.success) return result.output;
  }
  throw new ResultValidationError("Model output did not match the required schema");
}

export const PublicationMarker = {
  triage: (issueNumber: number) => `<!-- reviewbot:issue-triage:${issueNumber} -->`,
  review: (headSha: string) => `<!-- reviewbot:review:${headSha} -->`,
  reply: (commentId: number) => `<!-- reviewbot:reply:${commentId} -->`,
  fix: (commentId: number) => `<!-- reviewbot:fix:${commentId} -->`,
  fixPr: (commentId: number) => `<!-- reviewbot:fix-pr:${commentId} -->`,
  fixError: (commentId: number) => `<!-- reviewbot:fix-error:${commentId} -->`,
  duplicateNotice: (issueNumber: number, revision: number) =>
    `<!-- reviewbot:duplicate-notice:${issueNumber}:${revision} -->`,
  duplicateClosure: (issueNumber: number, revision: number) =>
    `<!-- reviewbot:duplicate-close:${issueNumber}:${revision} -->`,
  duplicateComment: (issueNumber: number, key: string) =>
    `<!-- reviewbot:duplicate-comment:${issueNumber}:${key} -->`,
};

export function withMarker(body: string, marker: string): string {
  return `${body.trimEnd()}\n\n${marker}`;
}

export function hasMarker(body: string | null, marker: string): boolean {
  return typeof body === "string" && body.includes(marker);
}
