import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { duplicateNoticeBody } from "../src/duplicates.ts";

function readExample(name: string): string {
  return readFileSync(
    new URL(`../src/prompts/${name}.txt`, import.meta.url),
    "utf8",
  );
}

/** Extract the blockquote responses from a reference file, one per paragraph. */
function examples(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith(">"))
    .map((block) =>
      block
        .replace(/^>\s?/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const DEADLINE_CLAIM = /\bI'll close\b|\bin 24 hours\b|\bin 1 day\b/i;

describe("response phrasing references", () => {
  test("every reference documents when it applies, examples, and constraints", () => {
    for (const name of [
      "duplicate-confirmed",
      "duplicate-likely",
      "duplicate-closed",
      "duplicate-reopened",
      "issue-investigation",
      "issue-clarification",
      "pr-review",
      "conversation",
    ]) {
      const text = readExample(name);
      expect(text.startsWith("# ")).toBe(true);
      expect(text).toMatch(/^Use (?:when|for) /m);
      expect(text).toContain("## Response target");
      expect(text).toContain("## Example responses");
      expect(text).toContain("## Response constraints");
      expect(examples(text).length).toBeGreaterThanOrEqual(2);
    }
  });

  test("confirmed duplicate examples stay short, link the canonical issue, and leave closure to the daemon", () => {
    const text = readExample("duplicate-confirmed");
    const responses = examples(text);
    for (const response of responses) {
      expect(response).toMatch(/#\d+/);
      expect(words(response)).toBeLessThanOrEqual(80);
      expect(response).not.toMatch(DEADLINE_CLAIM);
      expect(response).not.toMatch(/\bI've (?:closed|reopened|labelled|labeled)\b/i);
    }
    expect(text).toContain("Reviewbot appends the 24-hour disclosure");
  });

  test("likely duplicate examples explain uncertainty and ask one targeted question", () => {
    const text = readExample("duplicate-likely");
    const responses = examples(text);
    for (const response of responses) {
      expect(response).toMatch(/#\d+/);
      expect(response).toContain("?");
      expect(words(response)).toBeLessThanOrEqual(100);
      expect(response).not.toMatch(DEADLINE_CLAIM);
    }
    expect(text).toContain("Ask one question");
  });

  test("follow-up examples reference the canonical issue without claiming lifecycle actions", () => {
    for (const name of ["duplicate-closed", "duplicate-reopened"]) {
      const text = readExample(name);
      for (const response of examples(text)) {
        expect(response).toMatch(/#\d+/);
        expect(words(response)).toBeLessThanOrEqual(70);
        expect(response).not.toMatch(DEADLINE_CLAIM);
        expect(response).not.toMatch(
          /\bI've (?:closed|reopened|labelled|labeled)\b/i,
        );
      }
    }
  });

  test("investigation, clarification, review, and conversation examples stay within their soft targets", () => {
    const limits: Record<string, number> = {
      "issue-investigation": 200,
      "issue-clarification": 100,
      "pr-review": 120,
      conversation: 150,
    };
    for (const [name, limit] of Object.entries(limits)) {
      for (const response of examples(readExample(name))) {
        expect(words(response)).toBeLessThanOrEqual(limit);
      }
    }
  });

  test("investigation examples keep concrete evidence, while clarification examples ask for it", () => {
    const investigation = examples(readExample("issue-investigation"));
    expect(investigation[0]).toContain("I'd");
    expect(investigation[0]).not.toContain("|");

    for (const response of examples(readExample("issue-clarification"))) {
      expect(response).toContain("?");
      expect(response).not.toMatch(/\b(?:root cause is|the fix is)\b/i);
    }
  });

  test("PR review examples preserve inline findings and clean-review honesty", () => {
    const text = readExample("pr-review");
    const responses = examples(text);
    expect(responses.some((response) => /left a comment on/i.test(response))).toBe(
      true,
    );
    expect(
      responses.some((response) =>
        /didn't find any actionable issues/i.test(response),
      ),
    ).toBe(true);
    expect(text).toContain("Inline findings, changed-line mapping, severity");
  });

  test("published confirmed duplicate notices add exactly one daemon-owned disclosure", () => {
    const modelComment = examples(readExample("duplicate-confirmed"))[0]!;
    const body = duplicateNoticeBody({
      comment: modelComment,
      canonical: 1,
      classification: "confirmed",
    });
    expect(body.match(/24 hours/g)).toHaveLength(1);
    expect(body).toContain("#1");
    expect(body).toContain("material difference");
  });
});
