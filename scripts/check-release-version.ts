/**
 * Release tags are versioned by hand in `package.json` and `src/config.ts`.
 * Fail before building assets when a tag would publish a binary that reports a
 * different version. Prerelease tags share the core version of the release.
 */
export function parseReleaseVersion(tag: string): string | null {
  const match = /^v(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(tag);
  return match?.[1] ?? null;
}

export function versionProblems(
  tag: string,
  packageVersion: string | undefined,
  reviewbotVersion: string,
): string[] {
  const releaseVersion = parseReleaseVersion(tag);
  if (!releaseVersion) {
    return [`release tag "${tag}" must look like vX.Y.Z or vX.Y.Z-prerelease`];
  }
  return [
    ["package.json", packageVersion],
    ["src/config.ts REVIEWBOT_VERSION", reviewbotVersion],
  ]
    .filter(([, version]) => version !== releaseVersion)
    .map(
      ([source, version]) =>
        `${source} is ${String(version)}, tag ${tag} expects ${releaseVersion}`,
    );
}

if (import.meta.main) {
  const tag = Bun.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (!tag) {
    console.error("usage: bun run scripts/check-release-version.ts vX.Y.Z");
    process.exit(2);
  }

  const { REVIEWBOT_VERSION } = await import("../src/config.ts");
  const packageJson = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as { version?: string };

  const problems = versionProblems(tag, packageJson.version, REVIEWBOT_VERSION);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  console.log(`release version ${parseReleaseVersion(tag)} matches ${tag}`);
}
