import { ulid } from "ulid";

import { assertAllowedTarget, getAdapter } from "@agent-config-hub/adapters";
import { AgentId, type LogicalTarget } from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { mutateDraft } from "./draft-revision.js";

type DraftFileInput = {
  configSetId: string;
  expectedRevision: number;
  agentId: AgentId;
  target: LogicalTarget;
  blobSha256: string;
  mediaType: string;
  utf8: boolean;
  executable: boolean;
};

export class AgentConfigAlreadyExistsError extends Error {
  readonly code = "AGENT_CONFIG_ALREADY_EXISTS";

  constructor(agentId: AgentId) {
    super(`A configuration for ${agentId} already exists in this configuration group.`);
    this.name = "AgentConfigAlreadyExistsError";
  }
}
export class AgentConfigNotFoundError extends Error {
  readonly code = "AGENT_CONFIG_NOT_FOUND";

  constructor(configSetId: string, agentId: AgentId) {
    super(`Configuration group ${configSetId} does not contain a configuration for ${agentId}.`);
    this.name = "AgentConfigNotFoundError";
  }
}

export class DraftFileAlreadyExistsError extends Error {
  readonly code = "DRAFT_FILE_ALREADY_EXISTS";

  constructor(agentId: AgentId, target: LogicalTarget) {
    super(`${target.root}/${target.relativePath} already exists for ${agentId}.`);
    this.name = "DraftFileAlreadyExistsError";
  }
}


export class ConfigSetService {
  readonly #database: DatabaseContext;

  constructor(database: DatabaseContext) {
    this.#database = database;
  }

  create(input: { name: string; slug: string; agentId: AgentId }): { id: string; revision: number } {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) throw new Error("Config set slug is not portable.");
    const id = ulid();
    const now = Date.now();
    this.#database.native.prepare(`
      INSERT INTO config_sets (id, name, slug, enabled_agents, draft_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, input.name, input.slug, JSON.stringify([input.agentId]), now, now);
    return { id, revision: 1 };
  }

  createAgentConfig(input: {
    configSetId: string;
    expectedRevision: number;
    agentId: AgentId;
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const row = connection.prepare(
        "SELECT enabled_agents AS enabledAgents FROM config_sets WHERE id = ?",
      ).get(input.configSetId) as { enabledAgents: string };
      const enabledAgents = AgentId.array().parse(JSON.parse(row.enabledAgents));
      if (enabledAgents.includes(input.agentId)) throw new AgentConfigAlreadyExistsError(input.agentId);
      connection.prepare("UPDATE config_sets SET enabled_agents = ? WHERE id = ?")
        .run(JSON.stringify([...enabledAgents, input.agentId]), input.configSetId);
    }).revision;
  }

  saveFile(input: DraftFileInput): number {
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
  createFile(input: DraftFileInput): number {
    assertAllowedTarget(getAdapter(input.agentId), input.target);
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const row = connection.prepare(
        "SELECT enabled_agents AS enabledAgents FROM config_sets WHERE id = ?",
      ).get(input.configSetId) as { enabledAgents: string };
      const enabledAgents = AgentId.array().parse(JSON.parse(row.enabledAgents));
      if (!enabledAgents.includes(input.agentId)) {
        throw new AgentConfigNotFoundError(input.configSetId, input.agentId);
      }
      const blob = connection.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(input.blobSha256);
      if (!blob) throw new Error(`Blob ${input.blobSha256} does not exist.`);
      const existing = connection.prepare(`
        SELECT 1 FROM draft_files
        WHERE config_set_id = ? AND agent_id = ? AND root_id = ? AND relative_path = ?
      `).get(input.configSetId, input.agentId, input.target.root, input.target.relativePath);
      if (existing) throw new DraftFileAlreadyExistsError(input.agentId, input.target);
      const now = Date.now();
      connection.prepare(`
        INSERT INTO draft_files (
          id, config_set_id, agent_id, root_id, relative_path, blob_sha256,
          media_type, utf8, executable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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


  deleteFile(input: {
    configSetId: string;
    expectedRevision: number;
    agentId: AgentId;
    target: LogicalTarget;
  }): number {
    assertAllowedTarget(getAdapter(input.agentId), input.target);
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const deleted = connection.prepare(`
        DELETE FROM draft_files
        WHERE config_set_id = ? AND agent_id = ? AND root_id = ? AND relative_path = ?
      `).run(input.configSetId, input.agentId, input.target.root, input.target.relativePath);
      if (deleted.changes !== 1) throw new Error("Draft file does not exist.");
    }).revision;
  }

  deleteInstructionOverlay(input: {
    configSetId: string;
    expectedRevision: number;
    agentId: AgentId;
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const deleted = connection.prepare(
        "DELETE FROM agent_instruction_overlays WHERE config_set_id = ? AND agent_id = ?",
      ).run(input.configSetId, input.agentId);
      if (deleted.changes !== 1) throw new Error("Instruction overlay does not exist.");
    }).revision;
  }
}
