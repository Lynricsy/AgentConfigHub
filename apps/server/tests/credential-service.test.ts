import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { CredentialService } from "../src/services/credential-service.js";

describe("CredentialService", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("stores only ciphertext, masks lists, authorizes reveal, and marks bindings dirty on rotation", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-credentials-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const service = new CredentialService(database, masterKey);
    const sentinel = "credential-sentinel-3fc974";
    const created = service.create({ label: "Model API", provider: "test", value: sentinel });
    const now = Date.now();
    database.native.prepare(
      "INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("set-1", "Work", "work", "[]", 1, now, now);
    database.native.prepare(
      "INSERT INTO secret_slots (id, config_set_id, name, default_credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("slot-1", "set-1", "MODEL_API_KEY", created.id, now, now);

    expect(service.list()).toEqual([{ ...created, referenceCount: 1 }]);
    await expect(service.reveal(created.id, "wrong", async () => false)).rejects.toThrow("verification failed");
    await expect(service.reveal(created.id, "correct", async (password) => password === "correct"))
      .resolves.toBe(sentinel);
    expect((await readFile(database.path)).includes(Buffer.from(sentinel))).toBe(false);

    const rotated = service.rotate(created.id, "rotated-secret");
    expect(rotated.revision).toBe(2);
    expect(database.native.prepare("SELECT draft_revision AS revision FROM config_sets WHERE id = ?")
      .get("set-1")).toEqual({ revision: 2 });
    expect(database.native.prepare("SELECT COUNT(*) AS count FROM credential_revisions WHERE credential_id = ?")
      .get(created.id)).toEqual({ count: 2 });

    database.native.close();
  });
});
