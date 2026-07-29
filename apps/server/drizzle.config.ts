import { resolve } from "node:path";

import { defineConfig } from "drizzle-kit";

const dataDir = process.env.AGENT_CONFIG_HUB_DATA_DIR ?? resolve("../../data");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolve(dataDir, "metadata.sqlite"),
  },
  strict: true,
  verbose: true,
});
