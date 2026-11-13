import { describe, expect, test } from "bun:test";
import {
  findingHash,
  indexDiff,
  isValidLocation,
  normalizeRepoPath,
  parsePatch,
  renderDiffContext,
} from "../src/diff.ts";

const patch = `@@ -1,3 +1,4 @@
 context
-removed
+added
+also added
 trailing
@@ -10,2 +11,2 @@
-before
+after
`;

describe("unified diff parsing", () => {
  test("collects changed lines per side", () => {
    const lines = parsePatch(patch);
    expect([...lines.left].sort((a, b) => a - b)).toEqual([2, 10]);
    expect([...lines.right].sort((a, b) => a - b)).toEqual([2, 3, 11]);
  });

  test("validates inline locations against changed lines only", () => {
    const index = indexDiff([{ filename: "src/a.ts", status: "modified", patch }]);
    expect(isValidLocation(index, "src/a.ts", 2, "RIGHT")).toBe(true);
    expect(isValidLocation(index, "src/a.ts", 2, "LEFT")).toBe(true);
    expect(isValidLocation(index, "src/a.ts", 1, "RIGHT")).toBe(false);
    expect(isValidLocation(index, "src/a.ts", 3, "LEFT")).toBe(false);
    expect(isValidLocation(index, "src/missing.ts", 3, "RIGHT")).toBe(false);
    expect(isValidLocation(index, "repo/src/a.ts", 2, "RIGHT")).toBe(true);
    expect(isValidLocation(index, "./src/a.ts", 2, "RIGHT")).toBe(true);
    expect(normalizeRepoPath("repo\\src\\a.ts")).toBe("src/a.ts");
  });

  test("treats binary files as having no valid inline lines", () => {
    const index = indexDiff([{ filename: "image.png", status: "modified" }]);
    expect(isValidLocation(index, "image.png", 1, "RIGHT")).toBe(false);
  });
});

describe("finding identity", () => {
  test("is stable across whitespace and case differences", () => {
    const a = findingHash({
      path: "src/a.ts",
      line: 4,
      side: "RIGHT",
      severity: "High",
      message: "Null   dereference in parser",
    });
    const b = findingHash({
      path: "SRC/a.ts".replace("SRC", "src"),
      line: 4,
      side: "RIGHT",
      severity: "high",
      message: "null dereference in parser",
    });
    expect(a).toBe(b);
  });

  test("changes with location or message", () => {
    const base = {
      path: "src/a.ts",
      line: 4,
      side: "RIGHT" as const,
      severity: "high",
      message: "problem",
    };
    expect(findingHash(base)).not.toBe(findingHash({ ...base, line: 5 }));
    expect(findingHash(base)).not.toBe(findingHash({ ...base, message: "other" }));
  });
});

describe("diff context bounds", () => {
  test("omits content past the limit without throwing", () => {
    const files = [
      { filename: "a.ts", status: "modified", patch: "x".repeat(50) },
      { filename: "b.ts", status: "modified", patch: "y".repeat(50) },
    ];
    const rendered = renderDiffContext(files, 60);
    expect(rendered).toContain("a.ts");
    expect(rendered).toContain("context limit reached");
    expect(rendered.length).toBeLessThan(200);
  });
});
