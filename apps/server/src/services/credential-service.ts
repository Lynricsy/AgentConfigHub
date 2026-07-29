import { createHash } from "node:crypto";

import { ulid } from "ulid";

import type { DatabaseContext } from "../db/database.js";
import { decryptBuffer, encryptBuffer } from "../security/envelope.js";
import type { MasterKey } from "../security/master-key.js";

export interface CredentialSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly revision: number;
  readonly maskedValue: "••••••••";
  readonly referenceCount: number;
}

interface CredentialRevisionRow {
  id: string;
  credentialId: string;
  revisionNumber: number;
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

export class CredentialService {
  readonly #database: DatabaseContext;
  readonly #masterKey: MasterKey;

  constructor(database: DatabaseContext, masterKey: MasterKey) {
    this.#database = database;
    this.#masterKey = masterKey;
  }

  create(input: { label: string; provider: string; value: string }): CredentialSummary {
    const credentialId = ulid();
    const revision = this.#encryptRevision(credentialId, 1, input.value);
    const now = Date.now();
    this.#database.native.transaction(() => {
      this.#database.native.prepare(
        "INSERT INTO credentials (id, label, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(credentialId, input.label, input.provider, now, now);
      this.#insertRevision(revision, now);
      this.#database.native.prepare("UPDATE credentials SET current_revision_id = ? WHERE id = ?")
        .run(revision.id, credentialId);
    })();
    return {
      id: credentialId,
      label: input.label,
      provider: input.provider,
      revision: 1,
      maskedValue: "••••••••",
      referenceCount: 0,
    };
  }

  rotate(credentialId: string, value: string): CredentialSummary {
    const current = this.#current(credentialId);
    const revision = this.#encryptRevision(credentialId, current.revisionNumber + 1, value);
    const now = Date.now();
    this.#database.native.transaction(() => {
      this.#insertRevision(revision, now);
      this.#database.native.prepare(
        "UPDATE credentials SET current_revision_id = ?, updated_at = ? WHERE id = ?",
      ).run(revision.id, now, credentialId);
      const affected = this.#database.native.prepare(`
        SELECT DISTINCT config_set_id AS configSetId FROM secret_slots WHERE default_credential_id = ?
        UNION
        SELECT DISTINCT slots.config_set_id AS configSetId
        FROM secret_agent_overrides overrides
        JOIN secret_slots slots ON slots.id = overrides.secret_slot_id
        WHERE overrides.credential_id = ?
      `).all(credentialId, credentialId) as { configSetId: string }[];
      const markChanged = this.#database.native.prepare(
        "UPDATE config_sets SET draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?",
      );
      for (const { configSetId } of affected) markChanged.run(now, configSetId);
    })();
    return this.list().find(({ id }) => id === credentialId)!;
  }

  list(): CredentialSummary[] {
    return this.#database.native.prepare(`
      SELECT
        credentials.id,
        credentials.label,
        credentials.provider,
        credential_revisions.revision_number AS revision,
        (
          (SELECT COUNT(*) FROM secret_slots WHERE default_credential_id = credentials.id) +
          (SELECT COUNT(*) FROM secret_agent_overrides WHERE credential_id = credentials.id)
        ) AS referenceCount
      FROM credentials
      JOIN credential_revisions ON credential_revisions.id = credentials.current_revision_id
      ORDER BY credentials.label, credentials.id
    `).all().map((row) => ({
      ...(row as Omit<CredentialSummary, "maskedValue">),
      maskedValue: "••••••••" as const,
    }));
  }

  async reveal(
    credentialId: string,
    password: string,
    authorize: (password: string) => Promise<boolean>,
  ): Promise<string> {
    if (!await authorize(password)) throw new Error("Administrator password verification failed.");
    const revision = this.#current(credentialId);
    const plaintext = decryptBuffer(
      Buffer.from(revision.encryptedValue, "base64"),
      this.#masterKey,
      { recordType: "credential", recordId: revision.recordId },
      revision.plaintextSha256,
      revision.plaintextSize,
      revision,
      revision,
    );
    return plaintext.toString("utf8");
  }

  #encryptRevision(credentialId: string, revisionNumber: number, value: string): CredentialRevisionRow {
    const plaintext = Buffer.from(value, "utf8");
    const plaintextSha256 = createHash("sha256").update(plaintext).digest("hex");
    const recordId = ulid();
    const encrypted = encryptBuffer(
      plaintext,
      this.#masterKey,
      { recordType: "credential", recordId },
      plaintextSha256,
    );
    return {
      id: ulid(),
      credentialId,
      revisionNumber,
      encryptedValue: encrypted.ciphertext.toString("base64"),
      recordId,
      ...encrypted.wrapped,
      ...encrypted.content,
      plaintextSha256,
      plaintextSize: plaintext.length,
    };
  }

  #insertRevision(revision: CredentialRevisionRow, createdAt: number): void {
    this.#database.native.prepare(`
      INSERT INTO credential_revisions (
        id, credential_id, revision_number, encrypted_value, record_id, key_id,
        wrapped_dek, wrap_nonce, wrap_tag, content_nonce, content_tag,
        plaintext_sha256, plaintext_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.id,
      revision.credentialId,
      revision.revisionNumber,
      revision.encryptedValue,
      revision.recordId,
      revision.keyId,
      revision.wrappedDek,
      revision.wrapNonce,
      revision.wrapTag,
      revision.contentNonce,
      revision.contentTag,
      revision.plaintextSha256,
      revision.plaintextSize,
      createdAt,
    );
  }

  #current(credentialId: string): CredentialRevisionRow {
    const row = this.#database.native.prepare(`
      SELECT
        revisions.id,
        revisions.credential_id AS credentialId,
        revisions.revision_number AS revisionNumber,
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
      JOIN credential_revisions revisions ON revisions.id = credentials.current_revision_id
      WHERE credentials.id = ?
    `).get(credentialId) as CredentialRevisionRow | undefined;
    if (!row) throw new Error(`Credential ${credentialId} does not exist.`);
    return row;
  }
}
