import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("FileEncryptedBlobStore", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("streams encrypted content, deduplicates plaintext, and authenticates before output", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-blobs-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const store = new FileEncryptedBlobStore(database, masterKey, directory);
    const plaintext = Buffer.from("unique-blob-sentinel-never-on-disk");

    const first = await store.put(Readable.from(plaintext), "text/plain");
    const second = await store.put(Readable.from(plaintext), "application/octet-stream");
    expect(second.sha256).toBe(first.sha256);
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM blobs").get()).toEqual({ count: 1 });
    expect(await consume(await store.open(first.sha256))).toEqual(plaintext);

    const concurrentPayload = Buffer.from("same-hash-concurrent-upload");
    const [concurrentA, concurrentB] = await Promise.all([
      store.put(Readable.from(concurrentPayload), "text/plain"),
      store.put(Readable.from(concurrentPayload), "text/plain"),
    ]);
    expect(concurrentB.sha256).toBe(concurrentA.sha256);
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM blobs").get()).toEqual({ count: 2 });
    expect(await consume(await store.open(concurrentA.sha256))).toEqual(concurrentPayload);

    const row = database.native.prepare(
      "SELECT encrypted_path AS path FROM blobs WHERE sha256 = ?",
    ).get(first.sha256) as { path: string };
    expect((await readFile(join(directory, row.path))).includes(plaintext)).toBe(false);
    expect((await readFile(database.path)).includes(plaintext)).toBe(false);
    expect(await readdir(join(directory, "blobs", "tmp"))).toEqual([]);

    const wrongKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const wrongStore = new FileEncryptedBlobStore(database, wrongKey, directory);
    await expect(wrongStore.open(first.sha256)).rejects.toThrow();
    expect(await readdir(join(directory, "blobs", "tmp"))).toEqual([]);

    database.native.close();
  });

  it("deletes only old unreferenced blobs", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-gc-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const store = new FileEncryptedBlobStore(database, masterKey, directory);
    const blob = await store.put(Readable.from("gc-content"));
    database.native.prepare("UPDATE blobs SET created_at = 1 WHERE sha256 = ?").run(blob.sha256);
    const now = Date.now();
    database.native.prepare(
      "INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("set-1", "Work", "work", "[]", 1, now, now);
    database.native.prepare(`
      INSERT INTO draft_files (
        id, config_set_id, agent_id, root_id, relative_path, blob_sha256,
        media_type, utf8, executable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("file-1", "set-1", "claude-code", "claude-home", "settings.json", blob.sha256, "application/json", 1, 0, now, now);

    expect(await store.deleteIfUnreferenced(blob.sha256, new Date(2))).toBe(false);
    database.native.prepare("DELETE FROM draft_files WHERE id = ?").run("file-1");
    expect(await store.deleteIfUnreferenced(blob.sha256, new Date(2))).toBe(true);
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM blobs").get()).toEqual({ count: 0 });

    database.native.close();
  });
});
