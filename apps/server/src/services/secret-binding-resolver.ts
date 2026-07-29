import { decryptBuffer } from "../security/envelope.js";
import type { MasterKey } from "../security/master-key.js";
import type { DatabaseContext } from "../db/database.js";

import type { AgentId, Diagnostic } from "@agent-config-hub/protocol";

export interface ResolvedSecret {
  readonly value: string;
  readonly credentialId: string;
  readonly credentialRevisionId: string;
  readonly bindingSource: "default" | "override";
  readonly pinnedRevision: boolean;
}

export interface SecretBindingResolution {
  readonly byAgent: Partial<Record<AgentId, Record<string, ResolvedSecret>>>;
  readonly diagnostics: readonly Diagnostic[];
}

interface BindingRow {
  slotName: string;
  defaultCredentialId: string | null;
  defaultCredentialRevisionId: string | null;
  overrideCredentialId: string | null;
  overrideCredentialRevisionId: string | null;
}

interface RevisionRow {
  id: string;
  credentialId: string;
  encryptedValue: string;
  recordId: string;
  keyId: string;
  wrappedDek: string;
  wrapNonce: string;
  wrapTag: string;
  contentNonce: string;
  contentTag: string;
  plaintextSha256: string;
  plaintextSize: number;
}

export class SecretBindingResolver {
  readonly #database: DatabaseContext;
  readonly #masterKey: MasterKey;

  constructor(database: DatabaseContext, masterKey: MasterKey) {
    this.#database = database;
    this.#masterKey = masterKey;
  }

  resolve(configSetId: string, agents: readonly AgentId[], slots: readonly string[]): SecretBindingResolution {
    const byAgent: Partial<Record<AgentId, Record<string, ResolvedSecret>>> = {};
    const diagnostics: Diagnostic[] = [];
    const credentialAgents = new Map<string, Set<AgentId>>();

    for (const agent of agents) {
      const bindings: Record<string, ResolvedSecret> = {};
      byAgent[agent] = bindings;
      for (const slot of slots) {
        const binding = this.#database.native.prepare(`
          SELECT
            slots.name AS slotName,
            slots.default_credential_id AS defaultCredentialId,
            slots.default_credential_revision_id AS defaultCredentialRevisionId,
            overrides.credential_id AS overrideCredentialId,
            overrides.credential_revision_id AS overrideCredentialRevisionId
          FROM secret_slots slots
          LEFT JOIN secret_agent_overrides overrides
            ON overrides.secret_slot_id = slots.id AND overrides.agent_id = ?
          WHERE slots.config_set_id = ? AND slots.name = ?
        `).get(agent, configSetId, slot) as BindingRow | undefined;
        const credentialId = binding?.overrideCredentialId ?? binding?.defaultCredentialId;
        const credentialRevisionId = binding?.overrideCredentialId
          ? binding.overrideCredentialRevisionId
          : binding?.defaultCredentialRevisionId;
        if (!credentialId) {
          diagnostics.push({
            code: "SECRET_BINDING_MISSING",
            severity: "error",
            message: `Secret slot ${slot} has no binding for ${agent}.`,
          });
          continue;
        }
        const revision = this.#revision(credentialId, credentialRevisionId ?? undefined);
        const plaintext = decryptBuffer(
          Buffer.from(revision.encryptedValue, "base64"),
          this.#masterKey,
          { recordType: "credential", recordId: revision.recordId },
          revision.plaintextSha256,
          revision.plaintextSize,
          revision,
          revision,
        );
        bindings[slot] = {
          value: plaintext.toString("utf8"),
          credentialId,
          credentialRevisionId: revision.id,
          bindingSource: binding?.overrideCredentialId ? "override" : "default",
          pinnedRevision: credentialRevisionId !== null && credentialRevisionId !== undefined,
        };
        const usedBy = credentialAgents.get(credentialId) ?? new Set<AgentId>();
        usedBy.add(agent);
        credentialAgents.set(credentialId, usedBy);
      }
    }

    for (const agentsUsingCredential of credentialAgents.values()) {
      if (agentsUsingCredential.size < 2) continue;
      diagnostics.push({
        code: "SHARED_CREDENTIAL_REDUCES_ATTRIBUTION",
        severity: "warning",
        message: `One credential is shared by ${[...agentsUsingCredential].sort().join(", ")}.`,
      });
    }
    return { byAgent, diagnostics };
  }

  #revision(credentialId: string, revisionId?: string): RevisionRow {
    const revision = this.#database.native.prepare(`
      SELECT
        revisions.id,
        revisions.credential_id AS credentialId,
        revisions.encrypted_value AS encryptedValue,
        revisions.record_id AS recordId,
        revisions.key_id AS keyId,
        revisions.wrapped_dek AS wrappedDek,
        revisions.wrap_nonce AS wrapNonce,
        revisions.wrap_tag AS wrapTag,
        revisions.content_nonce AS contentNonce,
        revisions.content_tag AS contentTag,
        revisions.plaintext_sha256 AS plaintextSha256,
        revisions.plaintext_size AS plaintextSize
      FROM credentials
      JOIN credential_revisions revisions ON revisions.credential_id = credentials.id
      WHERE credentials.id = ? AND revisions.id = COALESCE(?, credentials.current_revision_id)
    `).get(credentialId, revisionId ?? null) as RevisionRow | undefined;
    if (!revision) throw new Error(`Credential ${credentialId} has no current revision.`);
    return revision;
  }
}
