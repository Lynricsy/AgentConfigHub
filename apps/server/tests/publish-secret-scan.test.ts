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
import { PublishService, PublishValidationError } from "../src/services/publish-service.js";
import { ResourceService } from "../src/services/resource-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("publish inline secret scanning", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it.each(["native Markdown", "shared skill"])("blocks high-confidence secrets in %s", async (source) => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-inline-secret-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobs = new FileEncryptedBlobStore(database, masterKey, directory);
    const configSets = new ConfigSetService(database);
    const configSet = configSets.create({ name: source, slug: source === "native Markdown" ? "native" : "skill", agentId: "claude-code" });
    let revision = 1;
    if (source === "native Markdown") {
      const blob = await blobs.put(Readable.from("-----BEGIN PRIVATE KEY-----\nnot-real\n"), "text/markdown");
      revision = configSets.saveFile({
        configSetId: configSet.id,
        expectedRevision: revision,
        agentId: "claude-code",
        target: { root: "claude-home", relativePath: "rules/secret.md" },
        blobSha256: blob.sha256,
        mediaType: "text/markdown",
        utf8: true,
        executable: false,
      });
    } else {
      const secret = `sk-${"a".repeat(30)}`;
      const blob = await blobs.put(Readable.from(`---\nname: bad-skill\ndescription: Test\n---\n${secret}\n`), "text/markdown");
      const resources = new ResourceService(database);
      const skill = resources.create({
        kind: "skill",
        slug: "bad-skill",
        name: "Bad skill",
        files: [{ relativePath: "SKILL.md", blobSha256: blob.sha256, mediaType: "text/markdown", executable: false }],
      });
      revision = resources.selectAgentForConfigSet({
        configSetId: configSet.id,
        expectedRevision: revision,
        resourceId: skill.id,
        agentId: "claude-code",
        sortOrder: 0,
      });
    }
    const publish = new PublishService(database, blobs, new SecretBindingResolver(database, masterKey));
    await expect(publish.publish(configSet.id, revision)).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "INLINE_SECRET_DETECTED" })]),
    } satisfies Partial<PublishValidationError>);
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM releases").get()).toEqual({ count: 0 });
    database.native.close();
  });
});
