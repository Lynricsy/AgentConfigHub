import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, linkSync, unlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ulid } from "ulid";

import type { DatabaseContext } from "../db/database.js";
import { contentAad, unwrapDek, wrapDek } from "../security/envelope.js";
import type { MasterKey } from "../security/master-key.js";

export interface BlobDescriptor {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string | undefined;
}

export interface EncryptedBlobStore {
  put(source: Readable, mediaType?: string): Promise<BlobDescriptor>;
  open(sha256: string): Promise<Readable>;
  verify(sha256: string): Promise<BlobDescriptor>;
  deleteIfUnreferenced(sha256: string, olderThan: Date): Promise<boolean>;
}

interface BlobRow {
  sha256: string;
  plaintextSize: number;
  encryptedPath: string;
  recordId: string;
  keyId: string;
  wrappedDek: string;
  wrapNonce: string;
  wrapTag: string;
  contentNonce: string;
  contentTag: string;
  mediaType: string | null;
  createdAt: number;
}

export class FileEncryptedBlobStore implements EncryptedBlobStore {
  readonly #database: DatabaseContext;
  readonly #masterKey: MasterKey;
  readonly #dataDir: string;
  readonly #temporaryDir: string;

  constructor(database: DatabaseContext, masterKey: MasterKey, dataDir: string) {
    this.#database = database;
    this.#masterKey = masterKey;
    this.#dataDir = dataDir;
    this.#temporaryDir = join(dataDir, "blobs", "tmp");
  }

  async put(source: Readable, mediaType?: string): Promise<BlobDescriptor> {
    await mkdir(this.#temporaryDir, { recursive: true, mode: 0o700 });
    const recordId = ulid();
    const identity = { recordType: "blob", recordId } as const;
    const dek = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(contentAad(identity));
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    const temporaryPath = join(this.#temporaryDir, `${recordId}.upload`);

    try {
      await pipeline(source, meter, cipher, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
      const sha256 = hash.digest("hex");
      const existing = this.#find(sha256);
      if (existing) {
        await rm(temporaryPath, { force: true });
        return { sha256, size: existing.plaintextSize, mediaType: existing.mediaType ?? undefined };
      }

      const finalPath = join(this.#dataDir, "blobs", "sha256", sha256.slice(0, 2), sha256);
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      const wrapped = wrapDek(this.#masterKey, dek, identity, sha256, size);
      const descriptor = this.#database.native.transaction((): BlobDescriptor => {
        const insertion = this.#database.native.prepare(`
          INSERT OR IGNORE INTO blobs (
            sha256, plaintext_size, encrypted_path, record_id, key_id, wrapped_dek,
            wrap_nonce, wrap_tag, content_nonce, content_tag, media_type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sha256,
          size,
          relative(this.#dataDir, finalPath),
          recordId,
          wrapped.keyId,
          wrapped.wrappedDek,
          wrapped.wrapNonce,
          wrapped.wrapTag,
          nonce.toString("base64"),
          cipher.getAuthTag().toString("base64"),
          mediaType ?? null,
          Date.now(),
        );
        if (insertion.changes === 0) {
          const winner = this.#find(sha256);
          if (!winner) throw new Error(`Blob ${sha256} deduplication winner is missing.`);
          return {
            sha256,
            size: winner.plaintextSize,
            mediaType: winner.mediaType ?? undefined,
          };
        }

        try {
          linkSync(temporaryPath, finalPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          unlinkSync(finalPath);
          linkSync(temporaryPath, finalPath);
        }
        return { sha256, size, mediaType };
      })();
      await rm(temporaryPath, { force: true });
      return descriptor;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async open(sha256: string): Promise<Readable> {
    const row = this.#find(sha256);
    if (!row) throw new Error(`Blob ${sha256} does not exist.`);
    const identity = { recordType: "blob", recordId: row.recordId } as const;
    const dek = unwrapDek(this.#masterKey, row, identity, row.sha256, row.plaintextSize);
    const encryptedPath = join(this.#dataDir, row.encryptedPath);
    const validationDecipher = createDecipheriv(
      "aes-256-gcm",
      dek,
      Buffer.from(row.contentNonce, "base64"),
    );
    validationDecipher.setAAD(contentAad(identity));
    validationDecipher.setAuthTag(Buffer.from(row.contentTag, "base64"));
    const hash = createHash("sha256");
    let size = 0;
    const discard = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback();
      },
    });
    await pipeline(createReadStream(encryptedPath), validationDecipher, discard);
    if (size !== row.plaintextSize || hash.digest("hex") !== row.sha256) {
      throw new Error("Blob plaintext integrity mismatch.");
    }

    const outputDecipher = createDecipheriv(
      "aes-256-gcm",
      dek,
      Buffer.from(row.contentNonce, "base64"),
    );
    outputDecipher.setAAD(contentAad(identity));
    outputDecipher.setAuthTag(Buffer.from(row.contentTag, "base64"));
    return createReadStream(encryptedPath).pipe(outputDecipher);
  }

  async verify(sha256: string): Promise<BlobDescriptor> {
    const stream = await this.open(sha256);
    for await (const _chunk of stream) {
      // 丢弃已认证明文；保持常量内存。
    }
    const row = this.#find(sha256);
    if (!row) throw new Error(`Blob ${sha256} does not exist.`);
    return {
      sha256,
      size: row.plaintextSize,
      mediaType: row.mediaType ?? undefined,
    };
  }

  async deleteIfUnreferenced(sha256: string, olderThan: Date): Promise<boolean> {
    const row = this.#find(sha256);
    if (!row || row.createdAt >= olderThan.getTime()) return false;
    return this.#database.native.transaction(() => {
      const references = this.#database.native.prepare(`
        SELECT (
          (SELECT COUNT(*) FROM draft_files WHERE blob_sha256 = ?) +
          (SELECT COUNT(*) FROM resource_revision_files WHERE blob_sha256 = ?) +
          (SELECT COUNT(*) FROM release_source_files WHERE template_blob_sha256 = ?) +
          (SELECT COUNT(*) FROM release_files WHERE blob_sha256 = ?)
        ) AS count
      `).get(sha256, sha256, sha256, sha256) as { count: number };
      if (references.count !== 0) return false;
      unlinkSync(join(this.#dataDir, row.encryptedPath));
      const deletion = this.#database.native.prepare("DELETE FROM blobs WHERE sha256 = ?").run(sha256);
      return deletion.changes === 1;
    })();
  }

  #find(sha256: string): BlobRow | undefined {
    return this.#database.native.prepare(`
      SELECT
        sha256,
        plaintext_size AS plaintextSize,
        encrypted_path AS encryptedPath,
        record_id AS recordId,
        key_id AS keyId,
        wrapped_dek AS wrappedDek,
        wrap_nonce AS wrapNonce,
        wrap_tag AS wrapTag,
        content_nonce AS contentNonce,
        content_tag AS contentTag,
        media_type AS mediaType,
        created_at AS createdAt
      FROM blobs WHERE sha256 = ?
    `).get(sha256) as BlobRow | undefined;
  }
}
