import { describe, expect, test } from "bun:test";
import {
  parseReleaseVersion,
  versionProblems,
} from "../scripts/check-release-version.ts";

describe("release version checks", () => {
  test("accepts stable tags", () => {
    expect(parseReleaseVersion("v1.1.0")).toBe("1.1.0");
    expect(parseReleaseVersion("v0.0.1")).toBe("0.0.1");
  });

  test("accepts prerelease tags against the core version", () => {
    expect(parseReleaseVersion("v1.1.0-rc.1")).toBe("1.1.0");
    expect(versionProblems("v1.1.0-rc.1", "1.1.0", "1.1.0")).toEqual([]);
  });

  test("rejects tags that are not vX.Y.Z", () => {
    for (const tag of ["1.1.0", "v1.1", "v1.1.0.0", "release-1.1.0", "v1.1.0-"]) {
      expect(parseReleaseVersion(tag)).toBeNull();
      expect(versionProblems(tag, "1.1.0", "1.1.0")[0]).toContain(
        "must look like vX.Y.Z",
      );
    }
  });

  test("reports each version field that disagrees with the tag", () => {
    expect(versionProblems("v1.2.0", "1.1.0", "1.1.0")).toEqual([
      "package.json is 1.1.0, tag v1.2.0 expects 1.2.0",
      "src/config.ts REVIEWBOT_VERSION is 1.1.0, tag v1.2.0 expects 1.2.0",
    ]);
  });

  test("accepts matching versions", () => {
    expect(versionProblems("v1.1.0", "1.1.0", "1.1.0")).toEqual([]);
  });
});
