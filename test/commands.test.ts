import { describe, expect, test } from "bun:test";
import { hasCommand, isFixRequest, stripCommand } from "../src/commands.ts";

describe("commands", () => {
  test("recognizes /rb at the start or after whitespace", () => {
    expect(hasCommand("/rb please investigate")).toBe(true);
    expect(hasCommand("/RB is this a regression?")).toBe(true);
    expect(hasCommand("ping /rb")).toBe(true);
    expect(hasCommand("> /rb investigate")).toBe(true);
    expect(hasCommand("/rb, fix this")).toBe(true);
    expect(hasCommand("/rb: fix this")).toBe(true);
    expect(hasCommand("/rb\nfix this")).toBe(true);
    expect(hasCommand("/rb")).toBe(true);
  });

  test("ignores lookalikes, paths, and the old mention trigger", () => {
    expect(hasCommand("@reviewbot please investigate")).toBe(false);
    expect(hasCommand("/rb-extra please")).toBe(false);
    expect(hasCommand("/rbs please")).toBe(false);
    expect(hasCommand("src/rb/file.ts")).toBe(false);
    expect(hasCommand("https://example.invalid/rb")).toBe(false);
    expect(hasCommand("foo/rb")).toBe(false);
    expect(hasCommand("")).toBe(false);
  });

  test("strips the command for a self-contained instruction", () => {
    expect(stripCommand("/rb fix the bug")).toBe("fix the bug");
    expect(stripCommand("/rb, fix the bug")).toBe("fix the bug");
    expect(stripCommand("/rb: fix the bug")).toBe("fix the bug");
    expect(stripCommand("please /rb fix the bug")).toBe("please fix the bug");
    expect(stripCommand("/rb\nfix the bug")).toBe("fix the bug");
    expect(stripCommand("/rb /rb fix the bug")).toBe("fix the bug");
    expect(stripCommand("/rb")).toBe("");
    expect(stripCommand("@reviewbot fix the bug")).toBe("@reviewbot fix the bug");
  });
});

describe("implementation intent", () => {
  test("questions are not implementation requests", () => {
    expect(isFixRequest("can you investigate the root cause?")).toBe(false);
    expect(isFixRequest("is this actually a regression?")).toBe(false);
    expect(isFixRequest("can you reproduce this?")).toBe(false);
    expect(isFixRequest("what does this function do?")).toBe(false);
    expect(isFixRequest("why did you update the tests?")).toBe(false);
    expect(isFixRequest("should we remove this validation?")).toBe(false);
    expect(isFixRequest("did you change the parser?")).toBe(false);
    expect(isFixRequest("could you fix this?")).toBe(false);
    expect(isFixRequest("should we open a draft PR?")).toBe(false);
  });

  test("explicit change requests are recognized", () => {
    expect(isFixRequest("fix the issue and open a draft PR.")).toBe(true);
    expect(isFixRequest("please address the findings here.")).toBe(true);
    expect(isFixRequest("add a regression test for this case")).toBe(true);
    expect(isFixRequest("refactor the parser to handle empty input")).toBe(true);
    expect(isFixRequest("open a draft pr with the correction")).toBe(true);
    expect(isFixRequest(stripCommand("/rb, fix the parser"))).toBe(true);
    expect(isFixRequest(stripCommand("/rb: fix the parser"))).toBe(true);
  });
});
