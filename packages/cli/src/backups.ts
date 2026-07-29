import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { assertSafeRelativePath } from "@agent-config-hub/adapters";

import { removePrivatePath, type LocalPaths, writePrivateJson } from "./local-store.js";
import { inspectTarget, restoreExistingTarget, type ExistingTarget } from "./filesystem.js";
import { InstallState } from "./state.js";

const ExistingTargetSchema = z.object({
  kind: z.enum(["missing", "file", "symlink"]),
  linkTarget: z.string().optional(),
  mode: z.number().int().optional(),
});

const BackupOperation = z.object({
  root: z.string(),
  destination: z.string(),
  prior: ExistingTargetSchema,
  backupRelativePath: z.string().regex(/^files\/\d+$/).optional(),
});

const StateSnapshot = z.object({
  fileName: z.string().regex(/^[a-f0-9]{64}\.json$/),
  value: InstallState.nullable(),
});

export const BackupRecord = z.object({
  version: z.literal(1),
  id: z.string().regex(/^\d{17}-[a-f0-9]{12}$/),
  createdAt: z.string().datetime(),
  serverOrigin: z.string(),
  profile: z.string(),
  releaseId: z.string(),
  releaseNumber: z.number().int().positive(),
  operations: z.array(BackupOperation),
  stateSnapshots: z.array(StateSnapshot),
}).strict();

export type BackupRecord = z.infer<typeof BackupRecord>;
export type BackupOperation = z.infer<typeof BackupOperation>;

function assertBackupId(backupId: string): void {
  if (!/^\d{17}-[a-f0-9]{12}$/.test(backupId)) throw new Error("Backup ID is invalid.");
}

export function backupRecordPath(paths: LocalPaths, backupId: string): string {
  assertBackupId(backupId);
  return join(paths.backupDirectory, backupId, "backup.json");
}

export async function saveBackupRecord(paths: LocalPaths, record: BackupRecord): Promise<void> {
  await writePrivateJson(backupRecordPath(paths, record.id), BackupRecord.parse(record));
}

export async function readBackup(paths: LocalPaths, backupId: string): Promise<BackupRecord> {
  assertBackupId(backupId);
  return BackupRecord.parse(JSON.parse(await readFile(backupRecordPath(paths, backupId), "utf8")));
}

export async function listBackups(paths: LocalPaths): Promise<BackupRecord[]> {
  try {
    const directories = await readdir(paths.backupDirectory, { withFileTypes: true });
    const records: BackupRecord[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      records.push(await readBackup(paths, directory.name));
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function backupBytesPath(paths: LocalPaths, backupId: string, relativePath: string): string {
  assertBackupId(backupId);
  assertSafeRelativePath(relativePath);
  return join(paths.backupDirectory, backupId, relativePath);
}

export async function restoreBackup(paths: LocalPaths, backupId: string): Promise<BackupRecord> {
  const record = await readBackup(paths, backupId);
  for (const operation of [...record.operations].reverse()) {
    await inspectTarget(operation.root, operation.destination, true);
    await restoreExistingTarget(
      operation.destination,
      operation.prior as ExistingTarget,
      operation.backupRelativePath
        ? backupBytesPath(paths, backupId, operation.backupRelativePath)
        : undefined,
    );
  }
  for (const snapshot of record.stateSnapshots) {
    const statePath = join(paths.stateDirectory, snapshot.fileName);
    if (snapshot.value) await writePrivateJson(statePath, snapshot.value);
    else await removePrivatePath(statePath);
  }
  return record;
}

export async function deleteBackup(paths: LocalPaths, backupId: string): Promise<void> {
  await readBackup(paths, backupId);
  await removePrivatePath(join(paths.backupDirectory, backupId));
}
