const FIX_VERBS = new Set([
  "fix",
  "implement",
  "change",
  "modify",
  "update",
  "refactor",
  "add",
  "remove",
  "rename",
  "apply",
  "address",
  "patch",
  "correct",
  "resolve",
]);

const CODE_OBJECTS = [
  "code",
  "change",
  "changes",
  "bug",
  "issue",
  "finding",
  "findings",
  "patch",
  "implementation",
  "regression",
  "test",
  "tests",
  "pr",
  "pull request",
  "branch",
  "commit",
  "function",
  "method",
  "parser",
  "input",
  "output",
  "module",
  "handler",
  "validation",
  "endpoint",
  "api",
  "regex",
  "type",
  "schema",
  "query",
  "config",
];

/** True when the comment contains the `/rb` command token. */
export function hasCommand(body: string): boolean {
  if (!body) return false;
  return /(^|\s)\/rb(?![A-Za-z0-9_/-])/i.test(body);
}

/**
 * Conservative intent detection. The specification treats examples as
 * illustrative rather than a command grammar, but code modification requires a
 * clear request. We require an action verb plus a code-change object (or an
 * explicit draft PR request) to avoid mutating code for a question.
 */
export function isFixRequest(body: string): boolean {
  let text = body.toLowerCase().trim();
  if (!text) return false;
  // Questions and hypotheticals are conversation, even when they ask for a
  // change. Code modification requires an imperative request.
  if (text.endsWith("?")) return false;
  if (/(open|create|raise|submit)\s+(a\s+)?draft\s+(pr|pull request)/.test(text)) {
    return true;
  }
  text = text.replace(/^[\s>*\-]+/, "").replace(/^please[\s,]+/, "").trim();
  const first = /^[a-z]+/.exec(text)?.[0] ?? "";
  if (!FIX_VERBS.has(first)) return false;
  return CODE_OBJECTS.some((object) =>
    new RegExp(`\\b${object.replace(/ /g, "\\s+")}\\b`).test(text),
  );
}

/** Remove the command token so the remaining instruction is self-contained. */
export function stripCommand(body: string): string {
  return body
    .replace(/(^|\s)\/rb(?![A-Za-z0-9_/-])/gi, "")
    .replace(/^[\s,;:.!?\-–—]+/, "")
    .trim();
}
