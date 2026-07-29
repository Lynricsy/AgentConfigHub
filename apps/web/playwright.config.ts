import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const dataDirectory = resolve(repositoryRoot, ".tmp/e2e-data");
const systemChromium = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "dot" : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(systemChromium ? { executablePath: systemChromium } : {}),
    },
  },
  webServer: [
    {
      command: "pnpm --dir ../.. --filter @agent-config-hub/server dev",
      url: "http://127.0.0.1:3000/api/v1/health",
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        AGENT_CONFIG_HUB_DATA_DIR: dataDirectory,
        AGENT_CONFIG_HUB_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        AGENT_CONFIG_HUB_PUBLIC_URL: "http://127.0.0.1:3000",
        AGENT_CONFIG_HUB_BOOTSTRAP_TOKEN: "playwright-setup-code",
      },
    },
    {
      command: "pnpm dev --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
