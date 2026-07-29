import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { rewrapMasterKey } from "../src/security/rewrap-master-key.js";
import { CredentialService } from "../src/services/credential-service.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

async function consume(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("rewrapMasterKey", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("rewraps data keys without changing encrypted blob or credential payloads", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-rewrap-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const oldKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const newKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const oldStore = new FileEncryptedBlobStore(database, oldKey, directory);
    const blob = await oldStore.put(Readable.from("blob-before-rewrap"));
    const credentials = new CredentialService(database, oldKey);
    const credential = credentials.create({ label: "Key", provider: "test", value: "credential-before-rewrap" });
    const ciphertextBefore = database.native.prepare(
      "SELECT encrypted_value AS value FROM credential_revisions WHERE credential_id = ?",
    ).get(credential.id);

    expect(rewrapMasterKey(database, oldKey, newKey)).toBe(2);
    expect(database.native.prepare(
      "SELECT encrypted_value AS value FROM credential_revisions WHERE credential_id = ?",
    ).get(credential.id)).toEqual(ciphertextBefore);
    await expect(oldStore.open(blob.sha256)).rejects.toThrow();
    expect(await consume(await new FileEncryptedBlobStore(database, newKey, directory).open(blob.sha256)))
      .toBe("blob-before-rewrap");
    await expect(new CredentialService(database, newKey).reveal(credential.id, "ok", async () => true))
      .resolves.toBe("credential-before-rewrap");

    database.native.close();
  });
});
