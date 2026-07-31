import { Readable } from "node:stream";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { ConfigSetService } from "../src/services/config-set-service.js";
import { PublishService } from "../src/services/publish-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

const directory = process.argv[2];
const encodedKey = process.argv[3];
if (!directory || !encodedKey) throw new Error("Missing worker arguments.");
const database = openDatabase(directory);
migrateDatabase(database);
const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: encodedKey });
const blobStore = new FileEncryptedBlobStore(database, masterKey, directory);
const megabyte = Buffer.alloc(1024 * 1024, 0x5a);
const source = Readable.from((async function* streamBinary() {
  for (let index = 0; index < 256; index += 1) yield megabyte;
})());
const blob = await blobStore.put(source, "application/octet-stream");
const configSets = new ConfigSetService(database);
const configSet = configSets.create({ name: "Large", slug: "large", agentId: "claude-code" });
const revision = configSets.saveFile({
  configSetId: configSet.id,
  expectedRevision: 1,
  agentId: "claude-code",
  target: { root: "claude-home", relativePath: "skills/large/asset.bin" },
  blobSha256: blob.sha256,
  mediaType: "application/octet-stream",
  utf8: false,
  executable: false,
});
const release = await new PublishService(
  database,
  blobStore,
  new SecretBindingResolver(database, masterKey),
).publish(configSet.id, revision);
if (release.manifest.files[0]?.size !== 256 * 1024 * 1024) throw new Error("Large binary size mismatch.");
if (release.manifest.files[0]?.contentSha256 !== blob.sha256) throw new Error("Large binary was not reused.");
database.native.close();
