import type { DatabaseContext } from "../db/database.js";
import { unwrapDek, wrapDek } from "./envelope.js";
import type { MasterKey } from "./master-key.js";

interface RewrapRow {
  id: string;
  recordId: string;
  sha256: string;
  size: number;
  keyId: string;
  wrappedDek: string;
  wrapNonce: string;
  wrapTag: string;
}

export function rewrapMasterKey(database: DatabaseContext, oldKey: MasterKey, newKey: MasterKey): number {
  return database.native.transaction(() => {
    const blobs = database.native.prepare(`
      SELECT sha256 AS id, record_id AS recordId, sha256, plaintext_size AS size,
        key_id AS keyId, wrapped_dek AS wrappedDek, wrap_nonce AS wrapNonce, wrap_tag AS wrapTag
      FROM blobs
    `).all() as RewrapRow[];
    const credentials = database.native.prepare(`
      SELECT id, record_id AS recordId, plaintext_sha256 AS sha256, plaintext_size AS size,
        key_id AS keyId, wrapped_dek AS wrappedDek, wrap_nonce AS wrapNonce, wrap_tag AS wrapTag
      FROM credential_revisions
    `).all() as RewrapRow[];
    const updateBlob = database.native.prepare(
      "UPDATE blobs SET key_id = ?, wrapped_dek = ?, wrap_nonce = ?, wrap_tag = ? WHERE sha256 = ?",
    );
    const updateCredential = database.native.prepare(
      "UPDATE credential_revisions SET key_id = ?, wrapped_dek = ?, wrap_nonce = ?, wrap_tag = ? WHERE id = ?",
    );

    for (const row of blobs) {
      const identity = { recordType: "blob", recordId: row.recordId } as const;
      const dek = unwrapDek(oldKey, row, identity, row.sha256, row.size);
      const wrapped = wrapDek(newKey, dek, identity, row.sha256, row.size);
      updateBlob.run(wrapped.keyId, wrapped.wrappedDek, wrapped.wrapNonce, wrapped.wrapTag, row.id);
    }
    for (const row of credentials) {
      const identity = { recordType: "credential", recordId: row.recordId } as const;
      const dek = unwrapDek(oldKey, row, identity, row.sha256, row.size);
      const wrapped = wrapDek(newKey, dek, identity, row.sha256, row.size);
      updateCredential.run(wrapped.keyId, wrapped.wrappedDek, wrapped.wrapNonce, wrapped.wrapTag, row.id);
    }
    return blobs.length + credentials.length;
  })();
}
