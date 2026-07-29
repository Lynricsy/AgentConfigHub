import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { mutateDraft, parseIfMatchRevision, RevisionConflictError } from "../src/services/draft-revision.js";

describe("draft revision transactions", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("accepts only quoted positive If-Match revisions", () => {
    expect(parseIfMatchRevision('"7"')).toBe(7);
    expect(() => parseIfMatchRevision("7")).toThrow(TypeError);
    expect(() => parseIfMatchRevision('"0"')).toThrow(TypeError);
  });

  it("increments once and rejects a stale browser revision before mutation", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-revision-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const now = Date.now();
    database.native.prepare(
      "INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("set-1", "Work", "work", "[]", 1, now, now);

    const first = mutateDraft(database, "set-1", 1, (connection) => connection.prepare(
      "UPDATE config_sets SET name = ? WHERE id = ?",
    ).run("Work updated", "set-1"));
    expect(first.revision).toBe(2);

    expect(() => mutateDraft(database, "set-1", 1, () => {
      throw new Error("stale mutation must not run");
    })).toThrow(RevisionConflictError);
    expect(database.native.prepare("SELECT name, draft_revision AS revision FROM config_sets WHERE id = ?")
      .get("set-1")).toEqual({ name: "Work updated", revision: 2 });

    database.native.close();
  });
});
