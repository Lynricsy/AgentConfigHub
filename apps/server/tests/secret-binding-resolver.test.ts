import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { CredentialService } from "../src/services/credential-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";

describe("SecretBindingResolver", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("uses agent override before default and warns when attribution is shared", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-bindings-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const credentials = new CredentialService(database, masterKey);
    const defaultCredential = credentials.create({ label: "Default", provider: "test", value: "default-key" });
    const ompCredential = credentials.create({ label: "OMP", provider: "test", value: "omp-key" });
    const now = Date.now();
    database.native.prepare(
      "INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("set-1", "Work", "work", '["claude-code","codex","omp"]', 1, now, now);
    database.native.prepare(
      "INSERT INTO secret_slots (id, config_set_id, name, default_credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("slot-1", "set-1", "MODEL_API_KEY", defaultCredential.id, now, now);
    database.native.prepare(
      "INSERT INTO secret_agent_overrides (secret_slot_id, agent_id, credential_id) VALUES (?, ?, ?)",
    ).run("slot-1", "omp", ompCredential.id);

    const result = new SecretBindingResolver(database, masterKey).resolve(
      "set-1",
      ["claude-code", "codex", "omp"],
      ["MODEL_API_KEY"],
    );
    expect(result.byAgent["claude-code"]?.MODEL_API_KEY?.value).toBe("default-key");
    expect(result.byAgent.codex?.MODEL_API_KEY?.value).toBe("default-key");
    expect(result.byAgent.omp?.MODEL_API_KEY?.value).toBe("omp-key");
    expect(result.diagnostics).toMatchObject([{
      code: "SHARED_CREDENTIAL_REDUCES_ATTRIBUTION",
      severity: "warning",
    }]);

    database.native.close();
  });
});
