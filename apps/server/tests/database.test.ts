import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/database.js";

describe("SQLite persistence", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  it("enables durability pragmas and applies every startup migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-config-hub-db-"));
    directories.push(directory);
    const database = openDatabase(directory);

    migrateDatabase(database);

    expect(database.native.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.native.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.native.pragma("busy_timeout", { simple: true })).toBe(5000);
    const tables = database.native.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "admin_account",
      "blobs",
      "config_sets",
      "credential_revisions",
      "releases",
      "release_files",
      "pull_tokens",
    ]));

    database.native.close();
  });
});
