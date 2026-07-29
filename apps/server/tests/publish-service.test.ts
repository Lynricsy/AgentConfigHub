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
import { CredentialService } from "../src/services/credential-service.js";
import { PublishService } from "../src/services/publish-service.js";
import { ReleaseViewService } from "../src/services/release-view-service.js";
import { ResourceService } from "../src/services/resource-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

async function consume(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("PublishService", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("freezes exact outputs and restores slot identity and binding source on rollback", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-publish-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobStore = new FileEncryptedBlobStore(database, masterKey, directory);
    const configSets = new ConfigSetService(database);
    const resources = new ResourceService(database);
    const credentials = new CredentialService(database, masterKey);
    const publish = new PublishService(database, blobStore, new SecretBindingResolver(database, masterKey));
    const views = new ReleaseViewService(database, blobStore);
    const configSet = configSets.create({ name: "Work", slug: "work", enabledAgents: ["claude-code", "omp"] });

    const claudeTemplate = await blobStore.put(Readable.from(
      '{"model":"sonnet","env":{"MODEL_API_KEY":"{{secret:MODEL_API_KEY}}"}}',
    ), "application/json");
    const ompTemplate = await blobStore.put(Readable.from(
      'models: []\nproviders:\n  api_key: "{{secret:MODEL_API_KEY}}"\n',
    ), "text/yaml");
    let revision = configSets.saveFile({
      configSetId: configSet.id,
      expectedRevision: 1,
      agentId: "claude-code",
      target: { root: "claude-home", relativePath: "settings.json" },
      blobSha256: claudeTemplate.sha256,
      mediaType: "application/json",
      utf8: true,
      executable: false,
    });
    revision = configSets.saveFile({
      configSetId: configSet.id,
      expectedRevision: revision,
      agentId: "omp",
      target: { root: "omp-home", relativePath: "config.yml" },
      blobSha256: ompTemplate.sha256,
      mediaType: "text/yaml",
      utf8: true,
      executable: false,
    });
    revision = configSets.saveInstructionOverlay({
      configSetId: configSet.id,
      expectedRevision: revision,
      agentId: "claude-code",
      markdown: "Claude overlay",
    });
    revision = configSets.saveInstructionOverlay({
      configSetId: configSet.id,
      expectedRevision: revision,
      agentId: "omp",
      markdown: "OMP overlay",
    });

    const instructionBlob = await blobStore.put(Readable.from("Shared instruction"), "text/markdown");
    const instruction = resources.create({
      kind: "instruction",
      slug: "shared",
      name: "Shared",
      files: [{ relativePath: "instruction.md", blobSha256: instructionBlob.sha256, mediaType: "text/markdown", executable: false }],
    });
    const skillMarkdown = await blobStore.put(Readable.from("---\nname: portable-skill\ndescription: Test\n---\n"), "text/markdown");
    const skillAttachment = await blobStore.put(Readable.from("attachment"), "application/octet-stream");
    const skill = resources.create({
      kind: "skill",
      slug: "portable-skill",
      name: "Portable skill",
      files: [
        { relativePath: "SKILL.md", blobSha256: skillMarkdown.sha256, mediaType: "text/markdown", executable: false },
        { relativePath: "assets/data.bin", blobSha256: skillAttachment.sha256, mediaType: "application/octet-stream", executable: false },
      ],
    });
    revision = resources.selectForConfigSet({
      configSetId: configSet.id,
      expectedRevision: revision,
      resourceId: instruction.id,
      sortOrder: 0,
      selectedAgents: ["claude-code", "omp"],
    });
    revision = resources.selectForConfigSet({
      configSetId: configSet.id,
      expectedRevision: revision,
      resourceId: skill.id,
      sortOrder: 1,
      selectedAgents: ["claude-code", "omp"],
    });

    const defaultCredential = credentials.create({ label: "Default", provider: "test", value: "default-v1" });
    const ompCredential = credentials.create({ label: "OMP", provider: "test", value: "omp-v1" });
    const now = Date.now();
    database.native.prepare(`
      INSERT INTO secret_slots (id, config_set_id, name, default_credential_id, created_at, updated_at)
      VALUES ('slot-1', ?, 'MODEL_API_KEY', ?, ?, ?)
    `).run(configSet.id, defaultCredential.id, now, now);
    database.native.prepare(`
      INSERT INTO secret_agent_overrides (secret_slot_id, agent_id, credential_id)
      VALUES ('slot-1', 'omp', ?)
    `).run(ompCredential.id);

    const release1 = await publish.publish(configSet.id, revision, "Initial");
    expect(release1.manifest.files).toHaveLength(8);
    const claudeConfig1 = release1.manifest.files.find(({ agentId, target }) =>
      agentId === "claude-code" && target.relativePath === "settings.json")!;
    const ompConfig1 = release1.manifest.files.find(({ agentId, target }) =>
      agentId === "omp" && target.relativePath === "config.yml")!;
    expect(claudeConfig1.sensitive).toBe(true);
    expect(ompConfig1.sensitive).toBe(true);
    expect(await consume(await blobStore.open(claudeConfig1.contentSha256))).toContain("default-v1");
    expect(await consume(await blobStore.open(ompConfig1.contentSha256))).toContain("omp-v1");

    credentials.rotate(defaultCredential.id, "default-v2");
    credentials.rotate(ompCredential.id, "omp-v2");
    revision += 2;
    const release2 = await publish.publish(configSet.id, revision, "Rotated");
    expect(await consume(await blobStore.open(claudeConfig1.contentSha256))).toContain("default-v1");
    const claudeConfig2 = release2.manifest.files.find(({ agentId, target }) =>
      agentId === "claude-code" && target.relativePath === "settings.json")!;
    expect(await consume(await blobStore.open(claudeConfig2.contentSha256))).toContain("default-v2");

    const release3 = await publish.publish(configSet.id, revision, "Deterministic repeat");
    expect(release3.manifest.files.map(({ contentSha256 }) => contentSha256))
      .toEqual(release2.manifest.files.map(({ contentSha256 }) => contentSha256));

    revision = configSets.saveInstructionOverlay({
      configSetId: configSet.id,
      expectedRevision: revision,
      agentId: "claude-code",
      markdown: "Changed overlay",
    });
    const release4 = await publish.publish(configSet.id, revision, "Overlay changed");
    const diff = await views.diff(release3.releaseId, release4.releaseId);
    expect(diff).toContainEqual(expect.objectContaining({
      target: "claude-code/claude-home/CLAUDE.md",
      action: "change",
      sensitive: false,
      beforeText: expect.stringContaining("Claude overlay"),
      afterText: expect.stringContaining("Changed overlay"),
    }));

    const changedInstruction = await blobStore.put(Readable.from("Changed shared instruction"), "text/markdown");
    resources.mutate({
      resourceId: instruction.id,
      expectedRevisionId: instruction.revisionId,
      files: [{
        relativePath: "instruction.md",
        blobSha256: changedInstruction.sha256,
        mediaType: "text/markdown",
        executable: false,
      }],
    });

    database.native.prepare("UPDATE secret_slots SET name = 'RENAMED', default_credential_id = ? WHERE id = 'slot-1'")
      .run(ompCredential.id);
    database.native.prepare("DELETE FROM secret_agent_overrides WHERE secret_slot_id = 'slot-1'").run();
    const rollback = await publish.rollback(configSet.id, release1.releaseId);
    expect(rollback.releaseNumber).toBe(5);
    const rollbackRevisions = database.native.prepare(`
      SELECT sets.draft_revision AS configRevision, releases.draft_revision AS releaseRevision
      FROM config_sets sets
      JOIN releases ON releases.id = sets.current_release_id
      WHERE sets.id = ?
    `).get(configSet.id) as { configRevision: number; releaseRevision: number };
    expect(rollbackRevisions.releaseRevision).toBe(rollbackRevisions.configRevision);
    expect(database.native.prepare(
      "SELECT name, default_credential_id AS credentialId FROM secret_slots WHERE id = 'slot-1'",
    ).get()).toEqual({ name: "MODEL_API_KEY", credentialId: defaultCredential.id });
    expect(database.native.prepare(
      "SELECT credential_id AS credentialId FROM secret_agent_overrides WHERE secret_slot_id = 'slot-1' AND agent_id = 'omp'",
    ).get()).toEqual({ credentialId: ompCredential.id });
    const release1Hashes = database.native.prepare(
      "SELECT agent_id, root_id, relative_path, blob_sha256 FROM release_files WHERE release_id = ? ORDER BY agent_id, root_id, relative_path",
    ).all(release1.releaseId);
    const rollbackHashes = database.native.prepare(
      "SELECT agent_id, root_id, relative_path, blob_sha256 FROM release_files WHERE release_id = ? ORDER BY agent_id, root_id, relative_path",
    ).all(rollback.releaseId);
    expect(rollbackHashes).toEqual(release1Hashes);

    expect(() => publish.deleteHistorical(configSet.id, rollback.releaseId)).toThrow("CURRENT_RELEASE");
    const restoredDraft = database.native.prepare(
      "SELECT draft_revision AS revision FROM config_sets WHERE id = ?",
    ).get(configSet.id) as { revision: number };
    const republished = await publish.publish(configSet.id, restoredDraft.revision, "Republish restored draft");
    const republishedHashes = database.native.prepare(
      "SELECT agent_id, root_id, relative_path, blob_sha256 FROM release_files WHERE release_id = ? ORDER BY agent_id, root_id, relative_path",
    ).all(republished.releaseId);
    expect(republishedHashes).toEqual(release1Hashes);
    publish.deleteHistorical(configSet.id, release1.releaseId);
    expect(database.native.prepare("SELECT id FROM releases WHERE id = ?").get(release1.releaseId)).toBeUndefined();
    database.native.close();
  }, 30_000);
});
