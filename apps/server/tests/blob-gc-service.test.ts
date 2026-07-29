import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { BlobGcService } from "../src/services/blob-gc-service.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("BlobGcService", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("keeps unreferenced blobs through seven days and deletes them after the cutoff", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-gc-service-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const store = new FileEncryptedBlobStore(database, masterKey, directory);
    const blob = await store.put(Readable.from("orphan-after-release-delete"));
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    database.native.prepare("UPDATE blobs SET created_at = ? WHERE sha256 = ?").run(createdAt.getTime(), blob.sha256);
    const gc = new BlobGcService(database, store);
    expect(gc.stats()).toEqual({
      blobs: 1,
      plaintextBytes: Buffer.byteLength("orphan-after-release-delete"),
      unreferencedBlobs: 1,
    });

    expect(await gc.run(new Date("2026-07-07T23:59:59.999Z"))).toEqual({ scanned: 0, deleted: 0 });
    expect(await gc.run(new Date("2026-07-08T00:00:00.001Z"))).toEqual({ scanned: 1, deleted: 1 });
    expect(database.native.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").get(blob.sha256)).toBeUndefined();
    expect(gc.stats()).toEqual({ blobs: 0, plaintextBytes: 0, unreferencedBlobs: 0 });
    database.native.close();
  });
});
