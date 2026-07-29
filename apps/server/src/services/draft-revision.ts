import type Database from "better-sqlite3";

import type { DatabaseContext } from "../db/database.js";

export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Expected draft revision ${expectedRevision}, received ${actualRevision}.`);
    this.name = "RevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function parseIfMatchRevision(value: string | undefined): number {
  const match = /^"([1-9]\d*)"$/.exec(value ?? "");
  if (!match?.[1]) throw new TypeError('If-Match must contain a quoted positive revision, for example "3".');
  return Number(match[1]);
}

export function mutateDraft<T>(
  database: DatabaseContext,
  configSetId: string,
  expectedRevision: number,
  mutation: (connection: Database.Database) => T,
): { result: T; revision: number } {
  return database.native.transaction(() => {
    const row = database.native.prepare(
      "SELECT draft_revision AS draftRevision FROM config_sets WHERE id = ?",
    ).get(configSetId) as { draftRevision: number } | undefined;
    if (!row) throw new Error(`Config set ${configSetId} does not exist.`);
    if (row.draftRevision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, row.draftRevision);
    }

    const result = mutation(database.native);
    const revision = expectedRevision + 1;
    const update = database.native.prepare(
      "UPDATE config_sets SET draft_revision = ?, updated_at = ? WHERE id = ? AND draft_revision = ?",
    ).run(revision, Date.now(), configSetId, expectedRevision);
    if (update.changes !== 1) throw new RevisionConflictError(expectedRevision, row.draftRevision);
    return { result, revision };
  })();
}
