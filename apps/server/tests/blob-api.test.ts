import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { buildServer } from "../src/index.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("blob API", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("accepts raw bodies and streams authenticated plaintext", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-blob-api-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobStore = new FileEncryptedBlobStore(database, masterKey, directory);
    const server = buildServer({ blobStore });
    const payload = Buffer.from("blob-api-payload");

    const upload = await server.inject({
      method: "PUT",
      url: "/api/v1/blobs",
      headers: { "content-type": "text/plain" },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ size: payload.length, mediaType: "text/plain", monacoEligible: true });

    const download = await server.inject({
      method: "GET",
      url: `/api/v1/blobs/${upload.json().sha256 as string}`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.rawPayload).toEqual(payload);

    await server.close();
    database.native.close();
  });
});
