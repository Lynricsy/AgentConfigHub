import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { buildServer } from "../src/index.js";
import { parseTrustedProxies, validatePublicUrl, verifyLocalDataVolume } from "../src/runtime.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("production runtime boundaries", () => {
  it("requires HTTPS except for numeric or localhost loopback", () => {
    expect(() => validatePublicUrl(undefined)).toThrow("required");
    expect(validatePublicUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(validatePublicUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validatePublicUrl("https://hub.example")).toBe("https://hub.example");
    expect(() => validatePublicUrl("http://hub.example")).toThrow("HTTPS");
    expect(() => validatePublicUrl("http://127.evil")).toThrow("HTTPS");
    expect(() => validatePublicUrl("https://hub.example/path")).toThrow("path");
  });

  it("only accepts explicit trusted proxy IPs and CIDRs", () => {
    expect(parseTrustedProxies(undefined)).toBe(false);
    expect(parseTrustedProxies("10.0.0.0/8, 2001:db8::/32")).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
    expect(() => parseTrustedProxies("true")).toThrow("Invalid trusted proxy");
    expect(() => parseTrustedProxies("10.0.0.0/99")).toThrow("prefix");
  });

  it("probes SQLite locking and durable local-volume rename without residue", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-runtime-"));
    const database = openDatabase(directory);
    try {
      migrateDatabase(database);
      await verifyLocalDataVolume(directory, database);
      expect((await readdir(directory)).some((entry) => entry.startsWith(".volume-probe-"))).toBe(false);
    } finally {
      database.native.close();
    }
  });

  it("returns unavailable when a post-start readiness check fails", async () => {
    const server = buildServer({ health: () => false });
    const response = await server.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    await server.close();
  });
});
