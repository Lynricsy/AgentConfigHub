import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { assertSafeRelativePath } from "@agent-config-hub/adapters";

import { copyFileDurable, inspectTarget, restoreExistingTarget, type ExistingTarget } from "./filesystem.js";
import { ensurePrivateDirectory, removePrivatePath, type LocalPaths, writePrivateJson } from "./local-store.js";
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
const RestoreJournal = z.object({
  version: z.literal(1),
  transactionId: z.string().regex(/^[a-f0-9]{24}$/),
  targetBackupId: z.string().regex(/^\d{17}-[a-f0-9]{12}$/),
  inverseBackupId: z.string().regex(/^\d{17}-[a-f0-9]{12}$/),
  inverseReady: z.boolean(),
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

function makeBackupId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomBytes(6).toString("hex")}`;
}

async function preflightBackup(record: BackupRecord): Promise<void> {
  for (const operation of record.operations) {
    await inspectTarget(operation.root, operation.destination, true);
  }
}

async function currentStateSnapshot(paths: LocalPaths, fileName: string): Promise<InstallState | null> {
  try {
    return InstallState.parse(JSON.parse(await readFile(join(paths.stateDirectory, fileName), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function applyBackupRecord(paths: LocalPaths, record: BackupRecord): Promise<void> {
  await preflightBackup(record);
  for (const operation of [...record.operations].reverse()) {
    await restoreExistingTarget(
      operation.destination,
      operation.prior as ExistingTarget,
      operation.backupRelativePath
        ? backupBytesPath(paths, record.id, operation.backupRelativePath)
        : undefined,
    );
  }
  for (const snapshot of record.stateSnapshots) {
    const statePath = join(paths.stateDirectory, snapshot.fileName);
    if (snapshot.value) await writePrivateJson(statePath, snapshot.value);
    else await removePrivatePath(statePath);
  }
}

export async function restoreBackup(paths: LocalPaths, backupId: string): Promise<BackupRecord> {
  const record = await readBackup(paths, backupId);
  await preflightBackup(record);
  const transactionId = randomBytes(12).toString("hex");
  const inverseBackupId = makeBackupId();
  await ensurePrivateDirectory(paths.transactionDirectory);
  const journalPath = join(paths.transactionDirectory, `restore-${transactionId}.json`);
  const persistJournal = async (inverseReady: boolean) => await writePrivateJson(journalPath, {
    version: 1,
    transactionId,
    targetBackupId: backupId,
    inverseBackupId,
    inverseReady,
  });
  await persistJournal(false);
  const inverseOperations: BackupOperation[] = [];
  for (let index = 0; index < record.operations.length; index += 1) {
    const operation = record.operations[index]!;
    const current = await inspectTarget(operation.root, operation.destination, true);
    const backupRelativePath = current.kind === "file" ? `files/${index}` : undefined;
    if (backupRelativePath) {
      await copyFileDurable(
        operation.destination,
        backupBytesPath(paths, inverseBackupId, backupRelativePath),
        0o600,
      );
    }
    inverseOperations.push({
      root: operation.root,
      destination: operation.destination,
      prior: current,
      ...(backupRelativePath ? { backupRelativePath } : {}),
    });
  }
  const inverse: BackupRecord = {
    version: 1,
    id: inverseBackupId,
    createdAt: new Date().toISOString(),
    serverOrigin: record.serverOrigin,
    profile: record.profile,
    releaseId: record.releaseId,
    releaseNumber: record.releaseNumber,
    operations: inverseOperations,
    stateSnapshots: await Promise.all(record.stateSnapshots.map(async ({ fileName }) => ({
      fileName,
      value: await currentStateSnapshot(paths, fileName),
    }))),
  };
  await saveBackupRecord(paths, inverse);
  await persistJournal(true);
  try {
    await applyBackupRecord(paths, record);
    await removePrivatePath(journalPath);
    return record;
  } catch (error) {
    await applyBackupRecord(paths, inverse);
    await removePrivatePath(journalPath);
    throw error;
  }
}

export async function recoverInterruptedBackupRestores(paths: LocalPaths): Promise<void> {
  try {
    const entries = await readdir(paths.transactionDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("restore-") || !entry.name.endsWith(".json")) continue;
      const journalPath = join(paths.transactionDirectory, entry.name);
      const journal = RestoreJournal.parse(JSON.parse(await readFile(journalPath, "utf8")));
      if (entry.name !== `restore-${journal.transactionId}.json`) {
        throw new Error(`Restore journal name does not match its ID: ${entry.name}`);
      }
      if (journal.inverseReady) {
        await applyBackupRecord(paths, await readBackup(paths, journal.inverseBackupId));
      } else {
        await removePrivatePath(join(paths.backupDirectory, journal.inverseBackupId));
      }
      await removePrivatePath(journalPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function deleteBackup(paths: LocalPaths, backupId: string): Promise<void> {
  await readBackup(paths, backupId);
  await removePrivatePath(join(paths.backupDirectory, backupId));
}
