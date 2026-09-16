import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";
import { AuthService } from "../src/services/auth-service.js";
import { DeviceTokenService } from "../src/services/device-token-service.js";
import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { ConfigSetService } from "../src/services/config-set-service.js";
import { PublishService } from "../src/services/publish-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("release manifest compatibility contract", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("publishes omp role prompts and pins the current CLI compatibility floor", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-manifest-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobs = new FileEncryptedBlobStore(database, masterKey, directory);
    const configSets = new ConfigSetService(database);
    const configSet = configSets.create({ name: "Role prompts", slug: "role-prompts", agentId: "omp" });
    const blob = await blobs.put(Readable.from("# Arianna\n"), "text/markdown");
    // role-prompt.ts 扩展读取 `<agent-dir>/role-prompts/<role>.md`；createFile 会走
    // assertAllowedTarget，publish 会再校验一次，因此这条用例同时锁住两侧的白名单。
    const revision = configSets.createFile({
      configSetId: configSet.id,
      expectedRevision: 1,
      agentId: "omp",
      target: { root: "omp-home", relativePath: "role-prompts/Arianna.md" },
      blobSha256: blob.sha256,
      mediaType: "text/markdown",
      utf8: true,
      executable: false,
    });

    const publish = new PublishService(database, blobs, new SecretBindingResolver(database, masterKey));
    const { manifest } = await publish.publish(configSet.id, revision);

    expect(manifest.files.map((file) => file.target.relativePath)).toContain("role-prompts/Arianna.md");
    // adapter revision 与 minCliVersion 是 CLI 的两道兼容闸门，必须随 surface 契约同步抬高。
    expect(manifest.adapterRevisions).toEqual({
      "claude-code": 2,
      codex: 2,
      opencode: 2,
      pi: 2,
      omp: 5,
      grok: 2,
    });
    expect(manifest.minCliVersion).toBe("0.2.3");
    expect(database.native.prepare("SELECT min_cli_version AS floor FROM releases").get())
      .toEqual({ floor: "0.2.3" });
    database.native.close();
  });

  it("requires the current CLI for releases without omp", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-manifest-base-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobs = new FileEncryptedBlobStore(database, masterKey, directory);
    const configSets = new ConfigSetService(database);
    const configSet = configSets.create({ name: "Claude only", slug: "claude-only", agentId: "claude-code" });
    const blob = await blobs.put(Readable.from("# Rule\n"), "text/markdown");
    const revision = configSets.createFile({
      configSetId: configSet.id,
      expectedRevision: 1,
      agentId: "claude-code",
      target: { root: "claude-home", relativePath: "rules/base.md" },
      blobSha256: blob.sha256,
      mediaType: "text/markdown",
      utf8: true,
      executable: false,
    });

    const publish = new PublishService(database, blobs, new SecretBindingResolver(database, masterKey));
    const { manifest } = await publish.publish(configSet.id, revision);

    // 服务端使用统一的最低 CLI 版本，即使本次 release 不含 OMP 也不能跳过兼容闸门。
    expect(manifest.minCliVersion).toBe("0.2.3");
    expect(database.native.prepare("SELECT min_cli_version AS floor FROM releases").get())
      .toEqual({ floor: "0.2.3" });
    database.native.close();
  });

  it("设备变量冻结位置计划并仅将含变量发布提升到 0.2.4", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-device-manifest-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    try {
      const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
      const blobs = new FileEncryptedBlobStore(database, masterKey, directory);
      const configSets = new ConfigSetService(database);
      const configSet = configSets.create({ name: "设备通知", slug: "device-notify", agentId: "omp" });
      const text = '{"device_name":"{{device:name}}"}';
      const blob = await blobs.put(Readable.from(text), "application/json");
      const revision = configSets.createFile({
        configSetId: configSet.id, expectedRevision: 1, agentId: "omp",
        target: { root: "omp-home", relativePath: "omp-notify.json" },
        blobSha256: blob.sha256, mediaType: "application/json", utf8: true, executable: false,
      });
      const publish = new PublishService(database, blobs, new SecretBindingResolver(database, masterKey));
      const { releaseId, manifest } = await publish.publish(configSet.id, revision);
      expect(manifest.minCliVersion).toBe("0.2.4");
      const file = manifest.files.find(({ target }) => target.relativePath === "omp-notify.json")!;
      expect(file.contentSha256).toBe(blob.sha256);
      const slot = file.deviceNameSlots![0]!;
      expect(text.slice(slot.start, slot.end)).toBe('"{{device:name}}"');
      const devices = new DeviceTokenService(database, "http://localhost");
      const { token } = devices.createAutomationToken("manifest-consumer");
      const server = buildServer({ api: {
        database, configSets, devices, blobStore: blobs, publicUrl: "http://localhost",
        auth: new AuthService(database, { bootstrapToken: "test-setup" }),
      } });
      try {
        await publish.rollback(configSet.id, releaseId, revision);
        const response = await server.inject({
          method: "GET", url: "/api/v1/cli/config-sets/device-notify/releases/latest",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        const restored = response.json<typeof manifest>();
        expect(restored.minCliVersion).toBe("0.2.4");
        const restoredFile = restored.files.find(({ target }) => target.relativePath === "omp-notify.json")!;
        expect(restoredFile.deviceNameSlots).toEqual(file.deviceNameSlots);
      } finally { await server.close(); }
    } finally { database.native.close(); }
  });
});
