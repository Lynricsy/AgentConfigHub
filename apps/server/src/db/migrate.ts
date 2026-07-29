import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { openDatabase, type DatabaseContext } from "./database.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function migrateDatabase(database: DatabaseContext): void {
  migrate(database.orm, { migrationsFolder });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = openDatabase();
  try {
    migrateDatabase(database);
  } finally {
    database.native.close();
  }
}
