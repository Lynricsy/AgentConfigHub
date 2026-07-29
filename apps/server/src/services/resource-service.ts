import { ulid } from "ulid";

import type { AgentId } from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { mutateDraft } from "./draft-revision.js";

export interface ResourceFileInput {
  readonly relativePath: string;
  readonly blobSha256: string;
  readonly mediaType: string;
  readonly executable: boolean;
}

export class ResourceRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(`Expected resource revision ${expectedRevision}, received ${actualRevision}.`);
    this.name = "ResourceRevisionConflictError";
  }
}

export class ResourceService {
  readonly #database: DatabaseContext;

  constructor(database: DatabaseContext) {
    this.#database = database;
  }

  create(input: {
    kind: "instruction" | "skill";
    slug: string;
    name: string;
    files: readonly ResourceFileInput[];
  }): { id: string; revisionId: string } {
    const resourceId = ulid();
    const revisionId = ulid();
    const now = Date.now();
    this.#database.native.transaction(() => {
      this.#database.native.prepare(
        "INSERT INTO resources (id, kind, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(resourceId, input.kind, input.slug, input.name, now, now);
      this.#insertRevision(resourceId, revisionId, 1, input.files, now);
      this.#database.native.prepare("UPDATE resources SET current_revision_id = ? WHERE id = ?")
        .run(revisionId, resourceId);
    })();
    return { id: resourceId, revisionId };
  }

  mutate(input: {
    resourceId: string;
    expectedRevisionId: string;
    files: readonly ResourceFileInput[];
  }): string {
    return this.#database.native.transaction(() => {
      const current = this.#database.native.prepare(`
        SELECT resources.current_revision_id AS revisionId, revisions.revision_number AS revisionNumber
        FROM resources
        JOIN resource_revisions revisions ON revisions.id = resources.current_revision_id
        WHERE resources.id = ?
      `).get(input.resourceId) as { revisionId: string; revisionNumber: number } | undefined;
      if (!current) throw new Error(`Resource ${input.resourceId} does not exist.`);
      if (current.revisionId !== input.expectedRevisionId) {
        throw new ResourceRevisionConflictError(input.expectedRevisionId, current.revisionId);
      }
      const revisionId = ulid();
      const now = Date.now();
      this.#insertRevision(input.resourceId, revisionId, current.revisionNumber + 1, input.files, now);
      this.#database.native.prepare(
        "UPDATE resources SET current_revision_id = ?, updated_at = ? WHERE id = ? AND current_revision_id = ?",
      ).run(revisionId, now, input.resourceId, input.expectedRevisionId);
      const configSets = this.#database.native.prepare(
        "SELECT config_set_id AS configSetId FROM config_set_resources WHERE resource_id = ?",
      ).all(input.resourceId) as { configSetId: string }[];
      const markChanged = this.#database.native.prepare(
        "UPDATE config_sets SET draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?",
      );
      for (const { configSetId } of configSets) markChanged.run(now, configSetId);
      return revisionId;
    })();
  }

  selectForConfigSet(input: {
    configSetId: string;
    expectedRevision: number;
    resourceId: string;
    sortOrder: number;
    selectedAgents: readonly AgentId[];
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      connection.prepare(`
        INSERT INTO config_set_resources (config_set_id, resource_id, sort_order, selected_agents)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (config_set_id, resource_id) DO UPDATE SET
          sort_order = excluded.sort_order,
          selected_agents = excluded.selected_agents,
          resource_revision_id = NULL
      `).run(input.configSetId, input.resourceId, input.sortOrder, JSON.stringify(input.selectedAgents));
    }).revision;
  }

  deselectForConfigSet(input: {
    configSetId: string;
    expectedRevision: number;
    resourceId: string;
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const deleted = connection.prepare(
        "DELETE FROM config_set_resources WHERE config_set_id = ? AND resource_id = ?",
      ).run(input.configSetId, input.resourceId);
      if (deleted.changes !== 1) throw new Error("Resource selection does not exist.");
    }).revision;
  }

  #insertRevision(
    resourceId: string,
    revisionId: string,
    revisionNumber: number,
    files: readonly ResourceFileInput[],
    createdAt: number,
  ): void {
    if (files.length === 0) throw new Error("A resource revision must contain at least one file.");
    this.#database.native.prepare(
      "INSERT INTO resource_revisions (id, resource_id, revision_number, created_at) VALUES (?, ?, ?, ?)",
    ).run(revisionId, resourceId, revisionNumber, createdAt);
    const insertFile = this.#database.native.prepare(`
      INSERT INTO resource_revision_files (
        id, resource_revision_id, relative_path, blob_sha256, media_type, executable
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const file of files) insertFile.run(
      ulid(),
      revisionId,
      file.relativePath,
      file.blobSha256,
      file.mediaType,
      Number(file.executable),
    );
  }
}
