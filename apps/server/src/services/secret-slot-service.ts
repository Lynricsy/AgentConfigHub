import { ulid } from "ulid";

import type { AgentId } from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { mutateDraft } from "./draft-revision.js";

export class SecretSlotService {
  readonly #database: DatabaseContext;

  constructor(database: DatabaseContext) {
    this.#database = database;
  }

  list(configSetId: string) {
    const slots = this.#database.native.prepare(`
      SELECT slots.id, slots.name, slots.default_credential_id AS defaultCredentialId,
        credentials.label AS defaultCredentialLabel
      FROM secret_slots slots
      LEFT JOIN credentials ON credentials.id = slots.default_credential_id
      WHERE slots.config_set_id = ? ORDER BY slots.name, slots.id
    `).all(configSetId);
    const overrides = this.#database.native.prepare(`
      SELECT overrides.secret_slot_id AS secretSlotId, overrides.agent_id AS agentId,
        overrides.credential_id AS credentialId, credentials.label AS credentialLabel
      FROM secret_agent_overrides overrides
      JOIN secret_slots slots ON slots.id = overrides.secret_slot_id
      JOIN credentials ON credentials.id = overrides.credential_id
      WHERE slots.config_set_id = ? ORDER BY slots.name, overrides.agent_id
    `).all(configSetId);
    return { slots, overrides };
  }

  setDefault(input: {
    configSetId: string;
    expectedRevision: number;
    slotName: string;
    credentialId: string | null;
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      this.#assertCredential(input.credentialId);
      const now = Date.now();
      connection.prepare(`
        INSERT INTO secret_slots (
          id, config_set_id, name, default_credential_id, default_credential_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT (config_set_id, name) DO UPDATE SET
          default_credential_id = excluded.default_credential_id,
          default_credential_revision_id = NULL,
          updated_at = excluded.updated_at
      `).run(ulid(), input.configSetId, input.slotName, input.credentialId, now, now);
    }).revision;
  }

  setOverride(input: {
    configSetId: string;
    expectedRevision: number;
    slotName: string;
    agentId: AgentId;
    credentialId: string | null;
  }): number {
    return mutateDraft(this.#database, input.configSetId, input.expectedRevision, (connection) => {
      const slot = connection.prepare(
        "SELECT id FROM secret_slots WHERE config_set_id = ? AND name = ?",
      ).get(input.configSetId, input.slotName) as { id: string } | undefined;
      if (!slot) throw new Error(`Secret slot ${input.slotName} does not exist.`);
      if (input.credentialId === null) {
        connection.prepare("DELETE FROM secret_agent_overrides WHERE secret_slot_id = ? AND agent_id = ?")
          .run(slot.id, input.agentId);
        return;
      }
      this.#assertCredential(input.credentialId);
      connection.prepare(`
        INSERT INTO secret_agent_overrides (
          secret_slot_id, agent_id, credential_id, credential_revision_id
        ) VALUES (?, ?, ?, NULL)
        ON CONFLICT (secret_slot_id, agent_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          credential_revision_id = NULL
      `).run(slot.id, input.agentId, input.credentialId);
    }).revision;
  }

  #assertCredential(credentialId: string | null): void {
    if (credentialId === null) return;
    if (!this.#database.native.prepare("SELECT 1 FROM credentials WHERE id = ?").get(credentialId)) {
      throw new Error(`Credential ${credentialId} does not exist.`);
    }
  }
}
