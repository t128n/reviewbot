import { describe, expect, test } from "bun:test";
import { hasMention, isFixRequest, stripMention } from "../src/mentions.ts";

describe("mentions", () => {
  test("recognizes the installed App identity", () => {
    expect(hasMention("@reviewbot please investigate", "reviewbot")).toBe(true);
    expect(hasMention("hey @ReviewBot, is this a regression?", "reviewbot")).toBe(true);
    expect(hasMention("ping @reviewbot", "reviewbot")).toBe(true);
  });

  test("does not match lookalike or embedded handles", () => {
    expect(hasMention("@reviewbot-extra please", "reviewbot")).toBe(false);
    expect(hasMention("mail@reviewbot", "reviewbot")).toBe(false);
    expect(hasMention("@reviewbots", "reviewbot")).toBe(false);
    expect(hasMention("@otherbot", "reviewbot")).toBe(false);
    expect(hasMention("", "reviewbot")).toBe(false);
  });

  test("strips the mention for a self-contained instruction", () => {
    expect(stripMention("@reviewbot fix the bug", "reviewbot")).toBe("fix the bug");
    expect(stripMention("@reviewbot, fix the bug", "reviewbot")).toBe("fix the bug");
    expect(stripMention("@reviewbot: fix the bug", "reviewbot")).toBe("fix the bug");
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
    expect(isFixRequest(stripMention("@reviewbot, fix the parser", "reviewbot"))).toBe(true);
    expect(isFixRequest(stripMention("@reviewbot: fix the parser", "reviewbot"))).toBe(true);
  });
});
