import pino, { type Logger } from "pino";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/Authorization:\s*(?:Basic|Bearer|token)\s+\S+/gi, "Authorization: [REDACTED]"],
];

/** Remove credential-shaped material from arbitrary text before logging. */
export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function createLogger(level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino(
    {
      level,
      redact: {
        paths: [
          "token",
          "*.token",
          "*.*.token",
          "privateKey",
          "*.privateKey",
          "*.*.privateKey",
          "password",
          "*.password",
          "authorization",
          "*.authorization",
          "headers.authorization",
        ],
        censor: "[REDACTED]",
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(2),
  );
}

export type { Logger };
