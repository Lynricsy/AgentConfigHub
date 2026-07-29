import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export interface ExistingTarget {
  readonly kind: "missing" | "file" | "symlink";
  readonly linkTarget?: string;
  readonly mode?: number;
}

async function metadata(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertPathInside(root: string, target: string): void {
  if (!isAbsolute(root) || !isAbsolute(target)) throw new Error("Resolved roots and targets must be absolute.");
  const fromRoot = relative(resolve(root), resolve(target));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${target} escapes managed root ${root}.`);
  }
}

export async function inspectTarget(root: string, target: string, replaceSymlink: boolean): Promise<ExistingTarget> {
  assertPathInside(root, target);
  const rootMetadata = await metadata(root);
  if (rootMetadata?.isSymbolicLink()) throw new Error(`Managed root is a symbolic link or reparse point: ${root}`);
  if (rootMetadata && !rootMetadata.isDirectory()) throw new Error(`Managed root is not a directory: ${root}`);
  const fromRoot = relative(resolve(root), resolve(target));
  let cursor = resolve(root);
  const segments = fromRoot.split(sep).filter(Boolean);
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    const current = await metadata(cursor);
    if (!current) break;
    if (current.isSymbolicLink()) throw new Error(`Target ancestor is a symbolic link or reparse point: ${cursor}`);
    if (!current.isDirectory()) throw new Error(`Target ancestor is not a directory: ${cursor}`);
  }
  const targetMetadata = await metadata(target);
  if (!targetMetadata) return { kind: "missing" };
  if (targetMetadata.isSymbolicLink()) {
    if (!replaceSymlink) throw new Error(`Target is a symbolic link or reparse point: ${target}`);
    return { kind: "symlink", linkTarget: await readlink(target) };
  }
  if (!targetMetadata.isFile()) throw new Error(`Managed target is not a regular file: ${target}`);
  return { kind: "file", mode: targetMetadata.mode & 0o777 };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function streamResponseToFile(
  response: Response,
  path: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  if (!response.body) throw new Error("Server returned an empty file stream.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response.body, verifier, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    const handle = await open(path, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    const actualSha256 = hash.digest("hex");
    if (size !== expectedSize) throw new Error(`Downloaded size ${size} does not match manifest size ${expectedSize}.`);
    if (actualSha256 !== expectedSha256) throw new Error(`Downloaded SHA-256 ${actualSha256} does not match manifest.`);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export async function copyFileDurable(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode }));
  if (process.platform !== "win32") await chmod(destination, mode);
  const handle = await open(destination, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirname(path), "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicRenamePrepared(temporary: string, destination: string): Promise<void> {
  try {
    await rename(temporary, destination);
    await syncParentDirectory(destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicCopy(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(destination), `.agent-config-hub-${randomBytes(8).toString("hex")}.tmp`);
  await copyFileDurable(source, temporary, mode);
  await atomicRenamePrepared(temporary, destination);
}

export async function restoreExistingTarget(
  destination: string,
  existing: ExistingTarget,
  backupFile?: string,
): Promise<void> {
  await rm(destination, { force: true, recursive: false });
  if (existing.kind === "missing") return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (existing.kind === "symlink") {
    if (existing.linkTarget === undefined) throw new Error("Symbolic-link backup is missing its target.");
    await symlink(existing.linkTarget, destination);
    return;
  }
  if (!backupFile) throw new Error("Regular-file backup is missing its bytes.");
  await atomicCopy(backupFile, destination, existing.mode ?? 0o600);
}

export async function readUtf8IfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
