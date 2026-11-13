import type { DuplicateCaseRecord } from "./db.ts";
import type { IssueSummary } from "./github.ts";
import type { DuplicateDecision } from "./schemas.ts";

export const PENDING_CLOSE_LABEL = "pending close";
export const DUPLICATE_LABEL = "duplicate";
export const DUPLICATE_WINDOW_SECONDS = 24 * 60 * 60;
export const MAX_DUPLICATE_QUERIES = 3;
export const MAX_DUPLICATE_CANDIDATES = 20;
export const MAX_CANONICAL_CHAIN = 5;

export const LABEL_DEFINITIONS: Record<
  string,
  { color: string; description: string }
> = {
  [PENDING_CLOSE_LABEL]: {
    color: "fbca04",
    description: "Proposed duplicate with a 24-hour explanation window",
  },
  [DUPLICATE_LABEL]: {
    color: "cfd3d7",
    description: "Closed by Reviewbot as a duplicate of another issue",
  },
};

export function isDuplicateDecision(
  decision: DuplicateDecision,
): decision is Extract<
  DuplicateDecision,
  { kind: "confirmed_duplicate" | "likely_duplicate" }
> {
  return (
    decision.kind === "confirmed_duplicate" ||
    decision.kind === "likely_duplicate"
  );
}

export function classificationOf(
  decision: DuplicateDecision,
): "confirmed" | "likely" {
  return decision.kind === "confirmed_duplicate" ? "confirmed" : "likely";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract same-repository issue references. Supports `#123`, same-repository
 * issue/pull URLs, and `owner/repo#123`. Cross-repository references are not
 * duplicate candidates.
 */
export function extractIssueReferences(
  text: string,
  owner: string,
  repo: string,
): number[] {
  if (!text) return [];
  const found = new Set<number>();
  const hashPattern = /(^|[^\w/&#])#(\d{1,9})\b/g;
  for (const match of text.matchAll(hashPattern)) {
    found.add(Number(match[2]));
  }
  const urlPattern = new RegExp(
    `https?://[^/\\s]+/${escapeRegExp(owner)}/${escapeRegExp(repo)}/(?:issues|pull)/(\\d{1,9})`,
    "gi",
  );
  for (const match of text.matchAll(urlPattern)) {
    found.add(Number(match[1]));
  }
  const crossPattern = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})\b/g;
  for (const match of text.matchAll(crossPattern)) {
    if (
      match[1]!.toLowerCase() === owner.toLowerCase() &&
      match[2]!.toLowerCase() === repo.toLowerCase()
    ) {
      found.add(Number(match[3]));
    }
  }
  found.delete(0);
  return [...found];
}

export function hasExplicitReference(
  text: string,
  issueNumber: number,
  owner: string,
  repo: string,
): boolean {
  return extractIssueReferences(text, owner, repo).includes(issueNumber);
}

function duplicateBodyReference(body: string | null): number | null {
  if (!body) return null;
  const cleaned = body.replace(
    /\b(?:not|isn['’]t|is not|no longer)\s+(?:a\s+)?(?:duplicate|superseded)\s+(?:of|by)\s+#\d{1,9}/gi,
    "",
  );
  const match = /\b(?:duplicate|superseded)\s+(?:of|by)\s+#(\d{1,9})\b/i.exec(cleaned);
  return match ? Number(match[1]) : null;
}

export interface CanonicalLookup {
  getIssue: (number: number) => Promise<IssueSummary | null>;
  getCase: (number: number) => DuplicateCaseRecord | null;
}

export interface CanonicalResolution {
  canonical: IssueSummary | null;
  error: string | null;
  chain: number[];
}

/**
 * Resolve the proposed canonical issue, following verified duplicate chains so
 * that chains converge on the original. Never returns the current issue, a pull
 * request, or a member of a cycle.
 */
export async function resolveCanonical(input: {
  currentNumber: number;
  proposedNumber: number;
  lookup: CanonicalLookup;
}): Promise<CanonicalResolution> {
  const visited = new Set<number>([input.currentNumber]);
  const chain: number[] = [];
  let number = input.proposedNumber;

  for (let depth = 0; depth < MAX_CANONICAL_CHAIN; depth += 1) {
    if (visited.has(number)) {
      return { canonical: null, error: "duplicate chain is circular", chain };
    }
    visited.add(number);
    chain.push(number);

    const issue = await input.lookup.getIssue(number);
    if (!issue) {
      return {
        canonical: null,
        error: "proposed canonical issue is inaccessible",
        chain,
      };
    }
    if (issue.isPullRequest) {
      return {
        canonical: null,
        error: "proposed canonical reference is a pull request",
        chain,
      };
    }

    const linkedCase = input.lookup.getCase(number);
    const linkedCanonical =
      linkedCase?.canonicalIssueNumber &&
      (linkedCase.status === "pending" || linkedCase.status === "closed") &&
      linkedCase.canonicalIssueNumber !== number
        ? linkedCase.canonicalIssueNumber
        : issue.state === "closed"
          ? duplicateBodyReference(issue.body)
          : null;
    if (linkedCanonical) {
      if (visited.has(linkedCanonical)) {
        return {
          canonical: null,
          error: "duplicate chain is circular",
          chain,
        };
      }
      number = linkedCanonical;
      continue;
    }
    return { canonical: issue, error: null, chain };
  }

  return {
    canonical: null,
    error: "duplicate chain exceeds the verification depth",
    chain,
  };
}

export interface DecisionResolution {
  decision: DuplicateDecision;
  canonical: IssueSummary | null;
  resolutionChain: number[];
  /** True when deterministic policy overrode the model's classification. */
  downgraded: boolean;
  /** Technical rationale safe to publish when the model text cannot be used. */
  rationale: string;
}

/**
 * Apply deterministic eligibility rules to the model's advisory decision.
 * Only verified same-repository issues that still exist may serve as canonical.
 */
export async function resolveDuplicateDecision(input: {
  decision: DuplicateDecision;
  current: IssueSummary;
  bodyText: string;
  owner: string;
  repo: string;
  lookup: CanonicalLookup;
}): Promise<DecisionResolution> {
  const { decision, current } = input;

  if (!isDuplicateDecision(decision)) {
    let canonical: IssueSummary | null = null;
    let chain: number[] = [];
    if (
      decision.canonicalIssueNumber &&
      decision.canonicalIssueNumber !== current.number
    ) {
      const resolved = await resolveCanonical({
        currentNumber: current.number,
        proposedNumber: decision.canonicalIssueNumber,
        lookup: input.lookup,
      });
      canonical = resolved.canonical;
      chain = resolved.chain;
    }
    return {
      decision,
      canonical,
      resolutionChain: chain,
      downgraded: false,
      rationale: decision.reason,
    };
  }

  const missing: string[] = [];
  if (!decision.canonicalIssueNumber) missing.push("a canonical issue");
  if (!decision.matchingEvidence || decision.matchingEvidence.length === 0) {
    missing.push("concrete matching evidence");
  }
  if (
    decision.kind === "likely_duplicate" &&
    !decision.distinguishingQuestion?.trim()
  ) {
    missing.push("a distinguishing question");
  }
  if (missing.length > 0) {
    let canonical: IssueSummary | null = null;
    let chain: number[] = [];
    if (
      decision.canonicalIssueNumber &&
      decision.canonicalIssueNumber !== current.number
    ) {
      const resolved = await resolveCanonical({
        currentNumber: current.number,
        proposedNumber: decision.canonicalIssueNumber,
        lookup: input.lookup,
      });
      canonical = resolved.canonical;
      chain = resolved.chain;
    }
    return {
      decision: {
        kind: "related",
        canonicalIssueNumber: canonical?.number,
        reason: `the duplicate proposal omitted ${missing.join(", ")}`,
      },
      canonical,
      resolutionChain: chain,
      downgraded: true,
      rationale:
        "I couldn't establish a concrete duplicate match, so I'll keep this issue open for now.",
    };
  }

  const proposedNumber = decision.canonicalIssueNumber!;
  const explicit = hasExplicitReference(
    input.bodyText,
    proposedNumber,
    input.owner,
    input.repo,
  );
  const resolved = await resolveCanonical({
    currentNumber: current.number,
    proposedNumber,
    lookup: input.lookup,
  });
  if (!resolved.canonical) {
    return {
      decision: {
        kind: "related",
        canonicalIssueNumber: undefined,
        reason: resolved.error ?? "the proposed canonical issue could not be verified",
      },
      canonical: null,
      resolutionChain: resolved.chain,
      downgraded: true,
      rationale:
        "I couldn't verify the proposed duplicate issue, so I'll keep this issue open for now.",
    };
  }

  const canonical = resolved.canonical;
  if (canonical.number === current.number) {
    return {
      decision: {
        kind: "independent",
        reason: "the only proposed duplicate candidate is this issue",
      },
      canonical: null,
      resolutionChain: resolved.chain,
      downgraded: true,
      rationale: "I couldn't find a verified duplicate for this report.",
    };
  }

  if (canonical.state === "closed") {
    const resolvedIncident = decision.kind === "confirmed_duplicate" && explicit;
    if (!resolvedIncident) {
      return {
        decision: {
          kind: "related",
          canonicalIssueNumber: canonical.number,
          reason:
            "the proposed canonical issue is closed and the reports were not explicitly linked",
        },
        canonical,
        resolutionChain: resolved.chain,
        downgraded: true,
        rationale:
          `#${canonical.number} is already closed, and I can't confirm this is the same resolved incident rather than a regression. I'll keep this issue open and treat it as related for now.`,
      };
    }
  }

  return {
    decision,
    canonical,
    resolutionChain: resolved.chain,
    downgraded: false,
    rationale: decision.reason,
  };
}

const ACKNOWLEDGEMENTS = [
  "thanks",
  "thank you",
  "thx",
  "same here",
  "me too",
  "+1",
  "bump",
  "any update",
  "following",
  "are you sure",
  "ok",
  "okay",
];

const DISTINCTION_CUE =
  /\b(different|distinct|not the same|only happens|only when|instead|whereas|however|actually|regression|version|upgraded?|reproduc\w*|steps|logs?|trace)\b/i;

/**
 * Whether a comment is worth a duplicate reassessment. Generic thanks, emoji,
 * "+1", and status pings do not reset the deadline or trigger a new analysis.
 */
export function isSubstantiveComment(body: string): boolean {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^[>\s]*>.*$/gm, " ")
    .replace(/@[A-Za-z0-9_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;
  if (/!\[[^\]]*\]\([^)]+\)/.test(cleaned)) return true;

  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const normalized = words.join(" ");
  const compact = normalized.replace(/[^a-z0-9+]/g, "");
  if (ACKNOWLEDGEMENTS.includes(normalized) || ACKNOWLEDGEMENTS.includes(compact)) {
    return false;
  }
  if (
    /^(thanks|thank you|thx)\b/.test(normalized) &&
    words.length <= 8 &&
    !DISTINCTION_CUE.test(normalized)
  ) {
    return false;
  }
  if (/^(same here|me too|\+1|bump|following)\b/.test(normalized)) return false;
  if (
    /^(same (issue|problem|bug)|i have the same|i'm seeing the same|any update|is there any update|still happening|still broken)\b/.test(
      normalized,
    ) &&
    !DISTINCTION_CUE.test(normalized)
  ) {
    return false;
  }
  if (words.length >= 2 && DISTINCTION_CUE.test(normalized)) {
    return true;
  }
  return words.length >= 4;
}

const OVERRIDE_PATTERNS = [
  /\b(?:keep|leave)\s+(?:this|it|the issue)\s+open\b/i,
  /\b(?:don'?t|do not|never)\s+close\b/i,
  /\bnot\s+(?:a\s+)?duplicate\b/i,
  /\bisn'?t\s+(?:a\s+)?duplicate\b/i,
  /\bwrong(?:ly)?\s+(?:duplicate|deduplicat)/i,
  /\bthis\s+(?:is|was)\s+(?:a\s+)?(?:different|distinct)\s+(?:issue|problem|bug|failure)\b/i,
  /\breopen\b/i,
];

/** Explicit human instruction that must cancel the automated closure. */
export function isMaintainerOverride(body: string): boolean {
  return OVERRIDE_PATTERNS.some((pattern) => pattern.test(body));
}

export function isWindowElapsed(dueAt: string | null, now: string): boolean {
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  const current = Date.parse(now);
  if (!Number.isFinite(due) || !Number.isFinite(current)) return false;
  return current >= due;
}

function ensureCanonicalLink(comment: string, canonical: number): string {
  return comment.includes(`#${canonical}`)
    ? comment.trim()
    : `This looks like a duplicate of #${canonical}.\n\n${comment.trim()}`;
}

function ensureQuestion(comment: string, canonical: number): string {
  return comment.includes("?")
    ? comment
    : `${comment}\n\nHow does your case differ from #${canonical}?`;
}

/** Concise initial notice with a fixed, daemon-owned 24-hour disclosure. */
export function duplicateNoticeBody(input: {
  comment: string;
  canonical: number;
  classification: "confirmed" | "likely";
  question?: string;
}): string {
  let comment = ensureCanonicalLink(input.comment, input.canonical);
  if (input.classification === "likely") {
    const question = input.question?.trim();
    if (question && !comment.includes(question)) {
      comment = `${comment}\n\n${question}`;
    }
    comment = ensureQuestion(comment, input.canonical);
  }
  const disclosure =
    input.classification === "confirmed"
      ? `I'll close this as a duplicate of #${input.canonical} in 24 hours unless you reply with a material difference. Please follow #${input.canonical} for updates.`
      : `If your case is different, please reply with the difference. Otherwise I'll close this as a duplicate of #${input.canonical} in 24 hours. Please follow #${input.canonical} for updates.`;
  return `${comment}\n\n${disclosure}`;
}

export function duplicateClosureBody(canonical: number): string {
  return [
    `Closing this as a duplicate of #${canonical}.`,
    "",
    `No distinguishing difference was established during the 24-hour response window. Please continue the discussion in #${canonical}.`,
  ].join("\n");
}

export function duplicateCancellationBody(input: {
  comment?: string;
  canonical: number | null;
}): string {
  const opening = input.comment?.trim()
    ? input.comment.trim()
    : input.canonical
      ? `Thanks for clarifying. This is a different problem from #${input.canonical}.`
      : "Thanks for clarifying. This is a different problem.";
  return `${opening}\n\nI'll leave this issue open and remove the pending duplicate classification.`;
}

export function duplicateRenewalBody(input: {
  comment: string;
  canonical: number;
  classification: "confirmed" | "likely";
}): string {
  return duplicateNoticeBody(input);
}

export function duplicateReopenBody(input: {
  comment: string;
  canonical: number;
}): string {
  const opening = input.comment.trim()
    ? input.comment.trim()
    : `You're right — this is a different problem from #${input.canonical}.`;
  const withLink = opening.includes(`#${input.canonical}`)
    ? opening
    : `You're right — this is a different problem from #${input.canonical}.\n\n${opening}`;
  return `${withLink}\n\nI've reopened this issue and removed the duplicate classification.`;
}

export function duplicateStillDuplicateBody(input: {
  comment: string;
  canonical: number;
}): string {
  const opening = input.comment.trim()
    ? input.comment.trim()
    : `This still looks like the same problem tracked in #${input.canonical}.`;
  const withLink = opening.includes(`#${input.canonical}`)
    ? opening
    : `${opening}\n\n#${input.canonical} already tracks this problem.`;
  return `${withLink}\n\nPlease continue the discussion in #${input.canonical}.`;
}

export function duplicateInvalidCanonicalBody(): string {
  return "I couldn't verify the proposed duplicate issue, so I'll leave this issue open for now.";
}

/**
 * Serialise the validated decision and notice text so a crash before or after
 * publication can be reconciled without another model run.
 */
export function decisionReference(input: {
  decision: DuplicateDecision;
  noticeComment: string;
  resolvedCanonical: number | null;
  revision: number;
}): string {
  return JSON.stringify({
    kind: input.decision.kind,
    reason: input.decision.reason,
    canonicalIssueNumber: input.resolvedCanonical,
    noticeComment: input.noticeComment,
    revision: input.revision,
    matchingEvidence:
      "matchingEvidence" in input.decision
        ? input.decision.matchingEvidence
        : undefined,
    distinguishingQuestion:
      "distinguishingQuestion" in input.decision
        ? input.decision.distinguishingQuestion
        : undefined,
  });
}

export function readDecisionReference(
  raw: string | null,
): {
  noticeComment: string | null;
  canonicalIssueNumber: number | null;
  reason: string | null;
} {
  if (!raw) {
    return { noticeComment: null, canonicalIssueNumber: null, reason: null };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      noticeComment:
        typeof parsed.noticeComment === "string" ? parsed.noticeComment : null,
      canonicalIssueNumber:
        typeof parsed.canonicalIssueNumber === "number"
          ? parsed.canonicalIssueNumber
          : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return { noticeComment: null, canonicalIssueNumber: null, reason: null };
  }
}
