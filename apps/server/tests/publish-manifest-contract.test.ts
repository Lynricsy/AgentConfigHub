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
import { PublishService } from "../src/services/publish-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("release manifest compatibility contract", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("publishes omp role prompts and pins the CLI compatibility floor", async () => {
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
    expect(manifest.adapterRevisions.omp).toBe(3);
    expect(manifest.minCliVersion).toBe("0.2.0");
    expect(database.native.prepare("SELECT min_cli_version AS floor FROM releases").get())
      .toEqual({ floor: "0.2.0" });
    database.native.close();
  });
});
