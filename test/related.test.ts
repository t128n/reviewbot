import { describe, expect, test } from "bun:test";
import { selectRelatedIssues } from "../src/related.ts";

describe("triage related context", () => {
  test("selects keyword-overlapping issues and PRs, excluding the current issue", () => {
    const related = selectRelatedIssues(
      {
        number: 10,
        title: "Parser crashes on empty input",
        body: "The parser throws when the input stream is empty.",
      },
      [
        {
          number: 10,
          title: "Parser crashes on empty input",
          body: "self",
          state: "open",
          isPullRequest: false,
        },
        {
          number: 4,
          title: "Parser panics on blank input",
          body: "A related parser crash.",
          state: "closed",
          isPullRequest: false,
        },
        {
          number: 7,
          title: "Update the README",
          body: "Documentation only.",
          state: "open",
          isPullRequest: true,
        },
        {
          number: 8,
          title: "Empty input handling in parser",
          body: "Adds validation for empty input.",
          state: "open",
          isPullRequest: true,
        },
      ],
    );
    expect(related.map((item) => item.number)).toEqual([8, 4]);
    expect(related[0]!.score).toBeGreaterThanOrEqual(related[1]!.score);
  });

  test("returns nothing when there is no meaningful keyword overlap", () => {
    expect(
      selectRelatedIssues(
        { number: 1, title: "Login timeout", body: "Session expires." },
        [
          {
            number: 2,
            title: "Update dependencies",
            body: "Bump versions.",
            state: "open",
            isPullRequest: false,
          },
        ],
      ),
    ).toHaveLength(0);
  });
});
