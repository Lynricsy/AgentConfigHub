import { resolve } from "node:path";

import { openDatabase } from "./db/database.js";
import { migrateDatabase } from "./db/migrate.js";
import { loadMasterKey } from "./security/master-key.js";
import { rewrapMasterKey } from "./security/rewrap-master-key.js";

function flagValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || !value) throw new Error(`Missing required ${name}.`);
  return value;
}

if (process.argv[2] !== "rewrap-master-key") {
  throw new Error("Usage: admin.js rewrap-master-key --old-key-file <path> --new-key-file <path>");
}

const oldKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY_FILE: flagValue("--old-key-file") });
const newKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY_FILE: flagValue("--new-key-file") });
const database = openDatabase(process.env.AGENT_CONFIG_HUB_DATA_DIR ?? resolve("data"));
try {
  migrateDatabase(database);
  const count = rewrapMasterKey(database, oldKey, newKey);
  process.stdout.write(`Rewrapped ${count} data keys.\n`);
} finally {
  database.native.close();
}
