import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { DeviceTokenService } from "../src/services/device-token-service.js";

describe("DeviceTokenService rate limits", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("prunes expired IP and pending-code buckets with a fake clock", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-device-limits-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    let now = 100_000;
    const devices = new DeviceTokenService(database, "https://hub.example", () => now);
    const authorization = devices.createAuthorization({
      deviceName: "old",
      cliVersion: "0.1.0",
      ip: "192.0.2.1",
    });
    expect(() => devices.poll(authorization.deviceCode, "192.0.2.1")).toThrowError(
      expect.objectContaining({ code: "AUTHORIZATION_PENDING" }),
    );
    expect(devices.rateLimitEntryCounts()).toEqual({
      authorizationIps: 1,
      pollIps: 1,
      pendingCodes: 1,
    });

    now += 11 * 60 * 1000;
    devices.createAuthorization({ deviceName: "new", cliVersion: "0.1.0", ip: "198.51.100.2" });
    expect(devices.rateLimitEntryCounts()).toEqual({
      authorizationIps: 1,
      pollIps: 0,
      pendingCodes: 0,
    });
    database.native.close();
  });
});
