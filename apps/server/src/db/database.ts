import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

export interface DatabaseContext {
  readonly native: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;
  readonly path: string;
}

export function openDatabase(dataDir = process.env.AGENT_CONFIG_HUB_DATA_DIR ?? resolve("data")): DatabaseContext {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "metadata.sqlite");
  const native = new Database(path);
  native.pragma("journal_mode = WAL");
  native.pragma("foreign_keys = ON");
  native.pragma("busy_timeout = 5000");
  native.pragma("synchronous = FULL");

  return {
    native,
    orm: drizzle(native, { schema }),
    path,
  };
}
