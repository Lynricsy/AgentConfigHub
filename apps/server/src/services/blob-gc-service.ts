import type { DatabaseContext } from "../db/database.js";
import type { EncryptedBlobStore } from "../storage/encrypted-blob-store.js";

const GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class BlobGcService {
  readonly #database: DatabaseContext;
  readonly #blobStore: EncryptedBlobStore;

  constructor(database: DatabaseContext, blobStore: EncryptedBlobStore) {
    this.#database = database;
    this.#blobStore = blobStore;
  }

  async run(now = new Date()): Promise<{ scanned: number; deleted: number }> {
    const cutoff = new Date(now.getTime() - GC_GRACE_MS);
    const candidates = this.#database.native.prepare(
      "SELECT sha256 FROM blobs WHERE created_at < ? ORDER BY sha256",
    ).all(cutoff.getTime()) as { sha256: string }[];
    let deleted = 0;
    for (const { sha256 } of candidates) {
      if (await this.#blobStore.deleteIfUnreferenced(sha256, cutoff)) deleted += 1;
    }
    return { scanned: candidates.length, deleted };
  }
}
