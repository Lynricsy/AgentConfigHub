import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseContext } from "../src/db/database.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { PublishService } from "../src/services/publish-service.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

const migrationsDirectory = fileURLToPath(new URL("../drizzle/", import.meta.url));

async function applyMigration(database: DatabaseContext, fileName: string): Promise<void> {
  const sql = await readFile(join(migrationsDirectory, fileName), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) database.native.exec(statement);
  }
}

describe("resource binding migration", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("expands multi-agent draft and frozen release bindings and preserves rollback", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-migration-"));
    const database = openDatabase(directory);
    await applyMigration(database, "0000_free_ronan.sql");
    await applyMigration(database, "0001_overjoyed_star_brand.sql");
    await applyMigration(database, "0002_broken_deathstrike.sql");

    const now = Date.now();
    database.native.prepare(`
      INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at)
      VALUES ('set-1', 'Main', 'main', '["claude-code","omp"]', 1, ?, ?)
    `).run(now, now);
    database.native.prepare(`
      INSERT INTO resources (id, kind, slug, name, current_revision_id, created_at, updated_at)
      VALUES ('resource-1', 'instruction', 'winefox', 'Wine Fox', NULL, ?, ?)
    `).run(now, now);
    database.native.prepare(`
      INSERT INTO resource_revisions (id, resource_id, revision_number, created_at)
      VALUES ('revision-1', 'resource-1', 1, ?)
    `).run(now);
    database.native.prepare("UPDATE resources SET current_revision_id = 'revision-1' WHERE id = 'resource-1'").run();
    database.native.prepare(`
      INSERT INTO config_set_resources (
        config_set_id, resource_id, resource_revision_id, sort_order, selected_agents
      ) VALUES ('set-1', 'resource-1', NULL, 0, '["claude-code","omp"]')
    `).run();
    database.native.prepare(`
      INSERT INTO releases (
        id, config_set_id, release_number, draft_revision, enabled_agents,
        notes, min_cli_version, adapter_revisions, created_at
      ) VALUES (
        'release-1', 'set-1', 1, 1, '["claude-code","omp"]',
        'Initial', '0.1.0', '{}', ?
      )
    `).run(now);
    database.native.prepare("UPDATE config_sets SET current_release_id = 'release-1' WHERE id = 'set-1'").run();
    database.native.prepare(`
      INSERT INTO release_resource_revisions (
        release_id, resource_revision_id, sort_order, selected_agents
      ) VALUES ('release-1', 'revision-1', 0, '["claude-code","omp"]')
    `).run();

    await applyMigration(database, "0003_eminent_robbie_robertson.sql");

    expect(database.native.prepare(`
      SELECT agent_id AS agentId FROM config_set_resources ORDER BY agent_id
    `).all()).toEqual([{ agentId: "claude-code" }, { agentId: "omp" }]);
    expect(database.native.prepare(`
      SELECT agent_id AS agentId FROM release_resource_revisions
      WHERE release_id = 'release-1' ORDER BY agent_id
    `).all()).toEqual([{ agentId: "claude-code" }, { agentId: "omp" }]);

    const masterKey = await loadMasterKey({
      AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64"),
    });
    const blobs = new FileEncryptedBlobStore(database, masterKey, directory);
    const publish = new PublishService(database, blobs, new SecretBindingResolver(database, masterKey));
    const rollback = await publish.rollback("set-1", "release-1", 1);

    expect(database.native.prepare(`
      SELECT agent_id AS agentId FROM config_set_resources ORDER BY agent_id
    `).all()).toEqual([{ agentId: "claude-code" }, { agentId: "omp" }]);
    expect(database.native.prepare(`
      SELECT agent_id AS agentId FROM release_resource_revisions
      WHERE release_id = ? ORDER BY agent_id
    `).all(rollback.releaseId)).toEqual([{ agentId: "claude-code" }, { agentId: "omp" }]);
    database.native.close();
  });
});
