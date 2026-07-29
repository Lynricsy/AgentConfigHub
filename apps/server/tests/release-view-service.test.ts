import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { ReleaseViewService } from "../src/services/release-view-service.js";
import { FileEncryptedBlobStore, type EncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("ReleaseViewService", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("returns metadata for large binary changes without opening plaintext", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-release-view-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const store = new FileEncryptedBlobStore(database, masterKey, directory);
    const beforeBlob = await store.put(Readable.from("before"), "application/octet-stream");
    const afterBlob = await store.put(Readable.from("after"), "application/octet-stream");
    const now = Date.now();
    database.native.prepare(`
      INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at)
      VALUES ('set-1', 'Work', 'work-view', '["claude-code"]', 1, ?, ?)
    `).run(now, now);
    const insertRelease = database.native.prepare(`
      INSERT INTO releases (
        id, config_set_id, release_number, draft_revision, enabled_agents,
        min_cli_version, adapter_revisions, created_at
      ) VALUES (?, 'set-1', ?, 1, '["claude-code"]', '0.1.0', '{}', ?)
    `);
    insertRelease.run("release-1", 1, now);
    insertRelease.run("release-2", 2, now);
    const insertFile = database.native.prepare(`
      INSERT INTO release_files (
        id, release_id, agent_id, root_id, relative_path, blob_sha256, size, executable, sensitive
      ) VALUES (?, ?, 'claude-code', 'claude-home', 'skills/large/data.bin', ?, ?, 0, 0)
    `);
    insertFile.run("file-1", "release-1", beforeBlob.sha256, 256 * 1024 * 1024);
    insertFile.run("file-2", "release-2", afterBlob.sha256, 256 * 1024 * 1024);
    let opens = 0;
    const metadataOnlyStore: EncryptedBlobStore = {
      put: store.put.bind(store),
      async open() {
        opens += 1;
        throw new Error("Binary diff must not open plaintext.");
      },
      verify: store.verify.bind(store),
      deleteIfUnreferenced: store.deleteIfUnreferenced.bind(store),
    };

    const diff = await new ReleaseViewService(database, metadataOnlyStore).diff("release-1", "release-2");
    expect(opens).toBe(0);
    expect(diff).toEqual([expect.objectContaining({
      action: "change",
      beforeSize: 256 * 1024 * 1024,
      afterSize: 256 * 1024 * 1024,
      beforeMediaType: "application/octet-stream",
      afterMediaType: "application/octet-stream",
      sensitive: false,
    })]);
    expect(diff[0]).not.toHaveProperty("beforeText");
    expect(diff[0]).not.toHaveProperty("afterText");
    database.native.close();
  });
});
