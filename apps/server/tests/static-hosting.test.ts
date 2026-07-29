import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";

describe("production static hosting", () => {
  let webRoot: string;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousWebRoot = process.env.AGENT_CONFIG_HUB_WEB_ROOT;

  beforeEach(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "agent-config-hub-web-"));
    await writeFile(join(webRoot, "index.html"), "<main>AgentConfigHub</main>");
    process.env.NODE_ENV = "production";
    process.env.AGENT_CONFIG_HUB_WEB_ROOT = webRoot;
  });

  afterEach(async () => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousWebRoot === undefined) delete process.env.AGENT_CONFIG_HUB_WEB_ROOT;
    else process.env.AGENT_CONFIG_HUB_WEB_ROOT = previousWebRoot;
    await rm(webRoot, { force: true, recursive: true });
  });

  it("serves the SPA fallback without swallowing API 404 responses", async () => {
    const server = buildServer();

    const page = await server.inject({ method: "GET", url: "/config-sets/work" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("AgentConfigHub");

    const api = await server.inject({ method: "GET", url: "/api/v1/missing" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    await server.close();
  });
});
