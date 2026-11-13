import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  apiBaseUrl,
  loadConfig,
  loadCredentials,
  normalizeHost,
  saveConfig,
  saveCredentials,
  webBaseUrl,
} from "../src/config.ts";

describe("host validation", () => {
  test("normalizes github.com and ghe.com hosts", () => {
    expect(normalizeHost("github.com")).toBe("github.com");
    expect(normalizeHost("  ACME.GHE.COM ")).toBe("acme.ghe.com");
    expect(normalizeHost("https://acme.ghe.com/")).toBe("acme.ghe.com");
  });

  test("rejects hosts that could redirect credentials", () => {
    expect(() => normalizeHost("evil.example.com")).toThrow();
    expect(() => normalizeHost("acme.ghe.com/path")).toThrow();
    expect(() => normalizeHost("acme.ghe.com:8443")).toThrow();
    expect(() => normalizeHost("user@acme.ghe.com")).toThrow();
    expect(() => normalizeHost("")).toThrow();
  });

  test("uses the GHE.com API host, not a GHES path", () => {
    expect(apiBaseUrl("acme.ghe.com")).toBe("https://api.acme.ghe.com");
    expect(apiBaseUrl("github.com")).toBe("https://api.github.com");
    expect(webBaseUrl("acme.ghe.com")).toBe("https://acme.ghe.com");
  });
});

describe("configuration persistence", () => {
  test("round-trips config with validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewbot-config-"));
    try {
      const path = join(dir, "config.json");
      saveConfig(
        {
          ...DEFAULT_CONFIG,
          github: { host: "acme.ghe.com" },
          polling: { intervalSeconds: 120 },
          opencode: { url: null, model: "opencode-go/deepseek-v4.1-flash" },
        },
        path,
      );
      const loaded = loadConfig(path);
      expect(loaded.github.host).toBe("acme.ghe.com");
      expect(loaded.polling.intervalSeconds).toBe(120);
      expect(loaded.opencode.url).toBeNull();
      expect(loaded.opencode.model).toBe("opencode-go/deepseek-v4.1-flash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an invalid OpenCode model reference", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewbot-config-"));
    try {
      const path = join(dir, "config.json");
      expect(() =>
        saveConfig(
          {
            ...DEFAULT_CONFIG,
            opencode: { url: null, model: "not-a-model" },
          },
          path,
        ),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an invalid polling interval", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewbot-config-"));
    try {
      const path = join(dir, "config.json");
      expect(() =>
        saveConfig(
          { ...DEFAULT_CONFIG, polling: { intervalSeconds: 1 } },
          path,
        ),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips credentials and rejects malformed app ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewbot-creds-"));
    try {
      const path = join(dir, "app.json");
      saveCredentials(
        {
          host: "acme.ghe.com",
          appId: 42,
          slug: "reviewbot",
          name: "Reviewbot",
          privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
          organization: "acme",
        },
        path,
      );
      const loaded = loadCredentials(path);
      expect(loaded.appId).toBe(42);
      expect(loaded.slug).toBe("reviewbot");
      expect(loaded.host).toBe("acme.ghe.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
