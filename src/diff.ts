import { createHash } from "node:crypto";

export interface DiffFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface ChangedLines {
  left: Set<number>;
  right: Set<number>;
}

export type DiffIndex = Map<string, ChangedLines>;

/**
 * Parse a unified diff patch. RIGHT lines are added lines in the new file;
 * LEFT lines are removed lines in the old file. GitHub inline comments must
 * reference one of these lines for a COMMENT review to be accepted.
 */
export function parsePatch(patch: string): ChangedLines {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      right.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      left.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { left, right };
}

export function indexDiff(files: DiffFile[]): DiffIndex {
  const index: DiffIndex = new Map();
  for (const file of files) {
    if (!file.patch) {
      index.set(file.filename, { left: new Set(), right: new Set() });
      continue;
    }
    index.set(file.filename, parsePatch(file.patch));
  }
  return index;
}

export function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^repo\//, "");
}

export function isValidLocation(
  index: DiffIndex,
  path: string,
  line: number,
  side: "LEFT" | "RIGHT",
): boolean {
  const normalized = normalizeRepoPath(path);
  const changed = index.get(normalized) ?? index.get(path);
  if (!changed) return false;
  return side === "RIGHT" ? changed.right.has(line) : changed.left.has(line);
}

/** Stable duplicate-suppression key for a finding. */
export function findingHash(input: {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: string;
  message: string;
}): string {
  const normalized = [
    normalizeRepoPath(input.path).toLowerCase(),
    input.line,
    input.side,
    input.severity.toLowerCase(),
    input.message.replace(/\s+/g, " ").trim().toLowerCase(),
  ].join("\u0000");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Build a bounded unified-diff excerpt for the model prompt. */
export function renderDiffContext(files: DiffFile[], maxChars = 120_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of files) {
    const header = `--- ${file.filename} (${file.status}) ---\n`;
    const patch = file.patch ?? "(binary or unavailable diff)\n";
    if (used + header.length + patch.length > maxChars) {
      parts.push(`${header}(diff omitted: context limit reached)\n`);
      break;
    }
    parts.push(header, patch, "\n");
    used += header.length + patch.length + 1;
  }
  return parts.join("");
}
