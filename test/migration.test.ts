import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";

describe("schema migration", () => {
  test("upgrades an earlier development database without losing markers or findings", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewbot-migration-"));
    const path = join(dir, "old.db");
    try {
      const old = new Database(path, { create: true });
      old.exec(`
        CREATE TABLE repositories (
          id INTEGER PRIMARY KEY,
          installation_id INTEGER NOT NULL,
          owner TEXT NOT NULL,
          name TEXT NOT NULL,
          full_name TEXT NOT NULL UNIQUE,
          default_branch TEXT NOT NULL,
          initialized_at TEXT NOT NULL,
          issues_cursor TEXT NOT NULL,
          pulls_cursor TEXT NOT NULL,
          comments_cursor TEXT NOT NULL,
          review_comments_cursor TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          last_poll_at TEXT,
          last_poll_error TEXT
        );
        CREATE TABLE publications (
          marker TEXT PRIMARY KEY,
          repo_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          github_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE findings (
          repo_id INTEGER NOT NULL,
          pr_number INTEGER NOT NULL,
          hash TEXT NOT NULL,
          path TEXT NOT NULL,
          line INTEGER NOT NULL,
          severity TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (repo_id, pr_number, hash)
        );
        INSERT INTO repositories VALUES
          (1, 1, 'acme', 'repo', 'acme/repo', 'main', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, NULL, NULL);
        INSERT INTO publications VALUES ('m', 1, 'review', '1', '2026-01-01T00:00:00.000Z');
        INSERT INTO findings VALUES (1, 4, 'h', 'src/a.ts', 1, 'high', 'problem', '2026-01-01T00:00:00.000Z');
      `);
      old.close();

      const store = new Store(path);
      expect(store.hasPublication(1, "m")).toBe(true);
      expect(store.listFindings(1, 4)).toHaveLength(1);
      store.setPullsEtag(1, "etag");
      expect(store.getRepository(1)!.pullsEtag).toBe("etag");
      expect(store.recordPublication({
        marker: "m",
        repoId: 2,
        kind: "review",
        githubId: 2,
      })).toBeUndefined();
      expect(store.hasPublication(2, "m")).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
