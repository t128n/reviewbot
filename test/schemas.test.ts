import { describe, expect, test } from "bun:test";
import {
  PublicationMarker,
  ResultValidationError,
  ReviewResultSchema,
  TriageResultSchema,
  hasMarker,
  parseStructuredResult,
  withMarker,
} from "../src/schemas.ts";

describe("structured results", () => {
  test("accepts a fenced JSON result with surrounding prose", () => {
    const result = parseStructuredResult(
      'Here is my assessment.\n```json\n{"comment":"Looks like a null check is missing.","duplicate":{"kind":"independent","reason":"No existing report matches"}}\n```\nDone.',
      TriageResultSchema,
    );
    expect(result.comment).toContain("null check");
    expect(result.duplicate.kind).toBe("independent");
  });

  test("accepts a bare JSON object", () => {
    const result = parseStructuredResult(
      '{"summary":"No actionable findings.","findings":[]}',
      ReviewResultSchema,
    );
    expect(result.findings).toHaveLength(0);
  });

  test("rejects malformed or schema-invalid output", () => {
    expect(() => parseStructuredResult("no json here", TriageResultSchema)).toThrow(
      ResultValidationError,
    );
    expect(() =>
      parseStructuredResult('{"comment":""}', TriageResultSchema),
    ).toThrow(ResultValidationError);
    expect(() =>
      parseStructuredResult(
        '{"summary":"x","findings":[{"path":"a","line":0,"side":"RIGHT","severity":"high","message":"m"}]}',
        ReviewResultSchema,
      ),
    ).toThrow(ResultValidationError);
  });

  test("accepts an incomplete duplicate proposal for deterministic downgrade", () => {
    const parsed = parseStructuredResult(
      '{"comment":"Probably the same.","duplicate":{"kind":"likely_duplicate","canonicalIssueNumber":7,"reason":"same symptom"}}',
      TriageResultSchema,
    );
    expect(parsed.duplicate.kind).toBe("likely_duplicate");
    expect(() =>
      parseStructuredResult(
        '{"comment":"Probably the same.","duplicate":{"kind":"likely_duplicate","reason":"same symptom"}}',
        TriageResultSchema,
      ),
    ).not.toThrow();
  });

  test("rejects oversized output", () => {
    expect(() =>
      parseStructuredResult("x".repeat(200_001), TriageResultSchema),
    ).toThrow(ResultValidationError);
  });
});

describe("publication markers", () => {
  test("are stable and detectable", () => {
    const marker = PublicationMarker.review("abc123");
    const body = withMarker("Summary", marker);
    expect(hasMarker(body, marker)).toBe(true);
    expect(hasMarker(body, PublicationMarker.review("other"))).toBe(false);
    expect(PublicationMarker.triage(4)).toContain("issue-triage:4");
    expect(PublicationMarker.reply(9)).toContain("reply:9");
    expect(PublicationMarker.fix(9)).toContain("fix:9");
  });
});
