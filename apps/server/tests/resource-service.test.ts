import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { ConfigSetService } from "../src/services/config-set-service.js";
import { ResourceService } from "../src/services/resource-service.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("ResourceService", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("creates immutable revisions and marks every selecting config set dirty", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-resource-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobs = new FileEncryptedBlobStore(database, masterKey, directory);
    const firstBlob = await blobs.put(Readable.from("first"), "text/markdown");
    const secondBlob = await blobs.put(Readable.from("second"), "text/markdown");
    const resources = new ResourceService(database);
    const resource = resources.create({
      kind: "instruction",
      slug: "shared",
      name: "Shared",
      files: [{ relativePath: "instruction.md", blobSha256: firstBlob.sha256, mediaType: "text/markdown", executable: false }],
    });
    const configSets = new ConfigSetService(database);
    const configSet = configSets.create({ name: "Work", slug: "work-resource", agentId: "claude-code" });
    const selectedRevision = resources.selectForConfigSet({
      configSetId: configSet.id,
      expectedRevision: 1,
      resourceId: resource.id,
      sortOrder: 0,
      selectedAgents: ["claude-code"],
    });
    const nextRevisionId = resources.mutate({
      resourceId: resource.id,
      expectedRevisionId: resource.revisionId,
      files: [{ relativePath: "instruction.md", blobSha256: secondBlob.sha256, mediaType: "text/markdown", executable: false }],
    });
    expect(nextRevisionId).not.toBe(resource.revisionId);
    expect(database.native.prepare("SELECT draft_revision AS revision FROM config_sets WHERE id = ?")
      .get(configSet.id)).toEqual({ revision: selectedRevision + 1 });
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM resource_revisions WHERE resource_id = ?")
      .get(resource.id)).toEqual({ count: 2 });
    database.native.close();
  });
});
