import type { DatabaseContext } from "../db/database.js";
import type { EncryptedBlobStore } from "../storage/encrypted-blob-store.js";
import { Readable } from "node:stream";

interface ReleaseFileRow {
  agentId: string;
  rootId: string;
  relativePath: string;
  blobSha256: string;
  size: number;
  sensitive: number;
  mediaType: string | null;
}

export interface ReleaseDiffEntry {
  readonly target: string;
  readonly action: "add" | "change" | "remove";
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly beforeSize: number | null;
  readonly afterSize: number | null;
  readonly beforeMediaType: string | null;
  readonly afterMediaType: string | null;
  readonly sensitive: boolean;
  readonly beforeText?: string;
  readonly afterText?: string;
}

async function consume(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function canShowText(file: ReleaseFileRow): boolean {
  return file.size <= 2 * 1024 * 1024 && (
    file.mediaType?.startsWith("text/") === true ||
    file.mediaType === "application/json" ||
    file.mediaType === "application/yaml" ||
    file.mediaType === "application/toml"
  );
}

export class ReleaseViewService {
  readonly #database: DatabaseContext;
  readonly #blobStore: EncryptedBlobStore;

  constructor(database: DatabaseContext, blobStore: EncryptedBlobStore) {
    this.#database = database;
    this.#blobStore = blobStore;
  }

  async diff(beforeReleaseId: string | null, afterReleaseId: string): Promise<ReleaseDiffEntry[]> {
    const before = beforeReleaseId ? this.#files(beforeReleaseId) : [];
    const after = this.#files(afterReleaseId);
    const beforeByTarget = new Map(before.map((file) => [
      `${file.agentId}/${file.rootId}/${file.relativePath}`,
      file,
    ]));
    const afterByTarget = new Map(after.map((file) => [
      `${file.agentId}/${file.rootId}/${file.relativePath}`,
      file,
    ]));
    const targets = [...new Set([...beforeByTarget.keys(), ...afterByTarget.keys()])].sort();
    const entries: ReleaseDiffEntry[] = [];
    for (const target of targets) {
      const oldFile = beforeByTarget.get(target);
      const newFile = afterByTarget.get(target);
      if (oldFile?.blobSha256 === newFile?.blobSha256) continue;
      const sensitive = Boolean(oldFile?.sensitive || newFile?.sensitive);
      const action = oldFile ? newFile ? "change" : "remove" : "add";
      entries.push({
        target,
        action,
        beforeSha256: oldFile?.blobSha256 ?? null,
        afterSha256: newFile?.blobSha256 ?? null,
        beforeSize: oldFile?.size ?? null,
        afterSize: newFile?.size ?? null,
        beforeMediaType: oldFile?.mediaType ?? null,
        afterMediaType: newFile?.mediaType ?? null,
        sensitive,
        ...(!sensitive && oldFile && canShowText(oldFile)
          ? { beforeText: await consume(await this.#blobStore.open(oldFile.blobSha256)) }
          : {}),
        ...(!sensitive && newFile && canShowText(newFile)
          ? { afterText: await consume(await this.#blobStore.open(newFile.blobSha256)) }
          : {}),
      });
    }
    return entries;
  }

  #files(releaseId: string): ReleaseFileRow[] {
    return this.#database.native.prepare(`
      SELECT files.agent_id AS agentId, files.root_id AS rootId, files.relative_path AS relativePath,
        files.blob_sha256 AS blobSha256, files.size, files.sensitive, blobs.media_type AS mediaType
      FROM release_files files
      JOIN blobs ON blobs.sha256 = files.blob_sha256
      WHERE files.release_id = ?
    `).all(releaseId) as ReleaseFileRow[];
  }

}
