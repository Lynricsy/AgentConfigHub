import { ulid } from "ulid";

import { assertAllowedTarget, getAdapter } from "@agent-config-hub/adapters";
import type { AgentId, LogicalTarget } from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { mutateDraft } from "./draft-revision.js";

export class ConfigSetService {
  readonly #database: DatabaseContext;

  constructor(database: DatabaseContext) {
    this.#database = database;
  }

  create(input: { name: string; slug: string; enabledAgents: readonly AgentId[] }): { id: string; revision: number } {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) throw new Error("Config set slug is not portable.");
    const id = ulid();
    const now = Date.now();
    this.#database.native.prepare(`
      INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, input.name, input.slug, JSON.stringify([...new Set(input.enabledAgents)]), now, now);
    return { id, revision: 1 };
  }

  saveFile(input: {
    configSetId: string;
    expectedRevision: number;
    agentId: AgentId;
    target: LogicalTarget;
    blobSha256: string;
    mediaType: string;
    utf8: boolean;
    executable: boolean;
  }): number {
    assertAllowedTarget(getAdapter(input.agentId), input.target);
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const blob = connection.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(input.blobSha256);
      if (!blob) throw new Error(`Blob ${input.blobSha256} does not exist.`);
      const now = Date.now();
      connection.prepare(`
        INSERT INTO draft_files (
          id, config_set_id, agent_id, root_id, relative_path, blob_sha256,
          media_type, utf8, executable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (config_set_id, agent_id, root_id, relative_path) DO UPDATE SET
          blob_sha256 = excluded.blob_sha256,
          media_type = excluded.media_type,
          utf8 = excluded.utf8,
          executable = excluded.executable,
          updated_at = excluded.updated_at
      `).run(
        ulid(),
        input.configSetId,
        input.agentId,
        input.target.root,
        input.target.relativePath,
        input.blobSha256,
        input.mediaType,
        Number(input.utf8),
        Number(input.executable),
        now,
        now,
      );
    }).revision;
  }

  saveInstructionOverlay(input: {
    configSetId: string;
    expectedRevision: number;
    agentId: AgentId;
    markdown: string;
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      connection.prepare(`
        INSERT INTO agent_instruction_overlays (id, config_set_id, agent_id, markdown, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (config_set_id, agent_id) DO UPDATE SET
          markdown = excluded.markdown,
          updated_at = excluded.updated_at
      `).run(ulid(), input.configSetId, input.agentId, input.markdown, Date.now());
    }).revision;
  }
}
