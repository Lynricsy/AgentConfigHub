import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import {
  assertNoResolvedTargetCollisions,
  getAdapter,
  resolveTargetPath,
  type ClientPathContext,
} from "@agent-config-hub/adapters";
import type { AgentId, ReleaseFileV1, ReleaseManifestV1, TargetRootId } from "@agent-config-hub/protocol";

import type { ApiClient } from "../api-client.js";
import {
  backupBytesPath,
  type BackupOperation,
  type BackupRecord,
  restoreBackup,
  saveBackupRecord,
} from "../backups.js";
import {
  atomicRenamePrepared,
  copyFileDurable,
  inspectTarget,
  sha256File,
  streamResponseToFile,
  type ExistingTarget,
} from "../filesystem.js";
import {
  ensurePrivateDirectory,
  removePrivatePath,
  type LocalPaths,
  writePrivateJson,
} from "../local-store.js";
import {
  type InstallState,
  loadStates,
  saveState,
  stateFileName,
  statePartitionKey,
} from "../state.js";
import { CLI_VERSION } from "../version.js";

interface PlannedFile {
  readonly manifest: ReleaseFileV1;
  readonly root: string;
  readonly destination: string;
  readonly partitionKey: string;
}

interface PlannedMutation {
  readonly action: "write" | "remove";
  readonly root: string;
  readonly destination: string;
  readonly prior: ExistingTarget;
  readonly file?: PlannedFile;
  temporary?: string;
}

export interface PullOptions {
  readonly api: ApiClient;
  readonly paths: LocalPaths;
  readonly manifest: ReleaseManifestV1;
  readonly serverOrigin: string;
  readonly profile: string;
  readonly requestedAgents: readonly AgentId[];
  readonly persistentRootOverrides: Partial<Record<TargetRootId, string>>;
  readonly invocationRootOverrides: Partial<Record<TargetRootId, string>>;
  readonly dryRun: boolean;
  readonly replaceSymlink: boolean;
  readonly forceRemoveModified: boolean;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly faultAfterStateUpdate?: number;
  readonly faultAfterMutation?: number;
}

export interface PullAction {
  readonly action: "add" | "replace" | "remove" | "unchanged";
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly sensitive: boolean;
}

export interface PullResult {
  readonly releaseId: string;
  readonly releaseNumber: number;
  readonly backupId: string | null;
  readonly actions: readonly PullAction[];
  readonly dryRun: boolean;
}
const TransactionJournal = z.object({
  version: z.literal(1),
  transactionId: z.string().regex(/^[a-f0-9]{24}$/),
  backupId: z.string().regex(/^\d{17}-[a-f0-9]{12}$/).nullable(),
  backupReady: z.boolean(),
  started: z.number().int().nonnegative(),
  roots: z.array(z.string()),
  stageDirectories: z.array(z.string()),
  temporaryFiles: z.array(z.string()),
  createdDirectories: z.array(z.string()),
}).strict();

type TransactionJournal = z.infer<typeof TransactionJournal>;

function versionTuple(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Unsupported semantic version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

function assertManifest(options: PullOptions): void {
  const { manifest, requestedAgents } = options;
  if (compareVersions(CLI_VERSION, manifest.minCliVersion) < 0) {
    throw new Error(`Release requires CLI ${manifest.minCliVersion}; installed CLI is ${CLI_VERSION}.`);
  }
  const expectedSelection = requestedAgents.length > 0 ? "subset" : "all-enabled";
  if (manifest.selection !== expectedSelection) throw new Error(`Manifest selection must be ${expectedSelection}.`);
  if (new Set(manifest.enabledAgents).size !== manifest.enabledAgents.length) {
    throw new Error("Manifest repeats an enabled Agent.");
  }
  if (new Set(manifest.includedAgents).size !== manifest.includedAgents.length) throw new Error("Manifest repeats an included Agent.");
  if (requestedAgents.length > 0) {
    const expected = [...requestedAgents].sort().join(",");
    const actual = [...manifest.includedAgents].sort().join(",");
    if (expected !== actual) throw new Error("Manifest included Agents do not match the requested filter.");
  }
  else {
    const enabled = [...manifest.enabledAgents].sort().join(",");
    const included = [...manifest.includedAgents].sort().join(",");
    if (enabled !== included) throw new Error("All-enabled manifest omits or adds an Agent.");
  }
  for (const agentId of manifest.includedAgents) {
    if (!manifest.enabledAgents.includes(agentId)) throw new Error(`${agentId} is included but not enabled.`);
    const adapter = getAdapter(agentId);
    if (manifest.adapterRevisions[agentId] !== adapter.revision) throw new Error(`Adapter revision mismatch for ${agentId}.`);
  }
  if (new Set(manifest.files.map(({ fileId }) => fileId)).size !== manifest.files.length) {
    throw new Error("Manifest repeats a file ID.");
  }
}

function clientContext(options: PullOptions): ClientPathContext {
  const platform = options.platform ?? process.platform;
  if (!(platform === "linux" || platform === "darwin" || platform === "win32")) throw new Error(`Unsupported platform: ${platform}`);
  return {
    platform,
    homeDir: options.homeDirectory ?? homedir(),
    rootOverrides: { ...options.persistentRootOverrides, ...options.invocationRootOverrides },
  };
}

function normalizedResolvedPath(context: ClientPathContext, path: string): string {
  const resolved = resolve(path);
  return context.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let cursor = resolve(path);
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Unsafe staging ancestor: ${cursor}`);
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`No existing staging ancestor for ${path}.`);
      cursor = parent;
    }
  }
}

async function ensureDestinationDirectory(
  root: string,
  directory: string,
  created: Set<string>,
  onCreated: () => Promise<void>,
): Promise<void> {
  const existingAncestor = await nearestExistingDirectory(root);
  const segments = relative(existingAncestor, resolve(directory)).split(sep).filter(Boolean);
  let cursor = existingAncestor;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Unsafe target directory: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      created.add(cursor);
      await onCreated();
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        created.delete(cursor);
        await onCreated();
        const raced = await lstat(cursor);
        if (raced.isSymbolicLink() || !raced.isDirectory()) {
          throw new Error(`Unsafe target directory created concurrently: ${cursor}`);
        }
      }
    }
  }
}

async function removeEmptyCreatedDirectories(created: Set<string>): Promise<void> {
  const deepestFirst = [...created].sort((left, right) => right.length - left.length);
  for (const directory of deepestFirst) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

function pathIsOnRootChain(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const resolvedPath = resolve(path);
  return roots.some((root) => {
    const resolvedRoot = resolve(root);
    const fromRoot = relative(resolvedRoot, resolvedPath);
    const insideRoot = fromRoot === "" || (
      fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
    );
    const fromPath = relative(resolvedPath, resolvedRoot);
    const ancestorOfRoot = fromPath === "" || (
      fromPath !== ".." && !fromPath.startsWith(`..${sep}`) && !isAbsolute(fromPath)
    );
    return insideRoot || ancestorOfRoot;
  });
}

function assertJournalPaths(journal: TransactionJournal): void {
  if (journal.roots.some((root) => !isAbsolute(root))) throw new Error("Transaction journal contains a relative root.");
  for (const stage of journal.stageDirectories) {
    if (basename(stage) !== `.agent-config-hub-stage-${journal.transactionId}` ||
        !pathIsOnRootChain(dirname(stage), journal.roots)) {
      throw new Error("Transaction journal contains an unsafe staging directory.");
    }
  }
  for (const temporary of journal.temporaryFiles) {
    if (!basename(temporary).startsWith(`.agent-config-hub-${journal.transactionId}-`) ||
        !basename(temporary).endsWith(".tmp") ||
        !journal.roots.some((root) => {
          const fromRoot = relative(resolve(root), resolve(temporary));
          return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
        })) {
      throw new Error("Transaction journal contains an unsafe temporary file.");
    }
  }
  if (journal.createdDirectories.some((directory) => !pathIsOnRootChain(directory, journal.roots))) {
    throw new Error("Transaction journal contains an unsafe created directory.");
  }
}

async function recoverTransaction(
  paths: LocalPaths,
  journal: TransactionJournal,
  journalPath: string,
): Promise<void> {
  assertJournalPaths(journal);
  if (journal.backupReady && journal.backupId) {
    await restoreBackup(paths, journal.backupId);
  } else if (journal.backupId) {
    await removePrivatePath(join(paths.backupDirectory, journal.backupId));
  }
  for (const temporary of journal.temporaryFiles) await rm(temporary, { force: true });
  for (const stage of journal.stageDirectories) await rm(stage, { force: true, recursive: true });
  await removeEmptyCreatedDirectories(new Set(journal.createdDirectories));
  await removePrivatePath(journalPath);
}

function makeBackupId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomBytes(6).toString("hex")}`;
}

function mutationAction(mutation: PlannedMutation): PullAction {
  if (mutation.action === "remove") return { action: "remove", path: mutation.destination, size: 0, sha256: "", sensitive: false };
  const file = mutation.file!.manifest;
  return {
    action: mutation.prior.kind === "missing" ? "add" : "replace",
    path: mutation.destination,
    size: file.size,
    sha256: file.contentSha256,
    sensitive: file.sensitive,
  };
}

export async function applyRelease(options: PullOptions): Promise<PullResult> {
  assertManifest(options);
  const pathContext = clientContext(options);
  const currentStates = await loadStates(options.paths);
  const relevantStates = currentStates.filter((state) => state.serverOrigin === options.serverOrigin && state.profile === options.profile);
  const plannedFiles: PlannedFile[] = options.manifest.files.map((file) => {
    if (!options.manifest.includedAgents.includes(file.agentId)) throw new Error(`${file.fileId} belongs to an excluded Agent.`);
    const adapter = getAdapter(file.agentId);
    const root = adapter.resolveRoot(file.target.root, pathContext);
    const partitionKey = statePartitionKey({ serverOrigin: options.serverOrigin, profile: options.profile, agentId: file.agentId, rootId: file.target.root, resolvedRoot: root });
    return { manifest: file, root, destination: resolveTargetPath(adapter, file.target, pathContext), partitionKey };
  });
  assertNoResolvedTargetCollisions(plannedFiles.map(({ manifest }) => ({ adapter: getAdapter(manifest.agentId), target: manifest.target })), pathContext);

  const desiredByPartition = new Map<string, PlannedFile[]>();
  for (const file of plannedFiles) desiredByPartition.set(file.partitionKey, [...(desiredByPartition.get(file.partitionKey) ?? []), file]);
  const selectedOldStates = relevantStates.filter((state) => {
    if (!options.manifest.includedAgents.includes(state.agentId)) return options.requestedAgents.length === 0;
    return normalizedResolvedPath(pathContext, state.resolvedRoot) === normalizedResolvedPath(
      pathContext,
      getAdapter(state.agentId).resolveRoot(state.rootId, pathContext),
    );
  });
  const mutations: PlannedMutation[] = [];
  const actions: PullAction[] = [];

  for (const file of plannedFiles) {
    const prior = await inspectTarget(file.root, file.destination, options.replaceSymlink);
    if (prior.kind === "file" && await sha256File(file.destination) === file.manifest.contentSha256) {
      actions.push({ action: "unchanged", path: file.destination, size: file.manifest.size, sha256: file.manifest.contentSha256, sensitive: file.manifest.sensitive });
    } else {
      const mutation: PlannedMutation = { action: "write", root: file.root, destination: file.destination, prior, file };
      mutations.push(mutation);
      actions.push(mutationAction(mutation));
    }
  }

  for (const oldState of selectedOldStates) {
    const desired = new Set(
      (desiredByPartition.get(statePartitionKey(oldState)) ?? [])
        .map(({ destination }) => normalizedResolvedPath(pathContext, destination)),
    );
    const adapter = getAdapter(oldState.agentId);
    const oldContext: ClientPathContext = { ...pathContext, rootOverrides: { ...pathContext.rootOverrides, [oldState.rootId]: oldState.resolvedRoot } };
    for (const previousFile of oldState.files) {
      const destination = resolveTargetPath(adapter, { root: oldState.rootId, relativePath: previousFile.relativePath }, oldContext);
      if (desired.has(normalizedResolvedPath(pathContext, destination))) continue;
      const prior = await inspectTarget(oldState.resolvedRoot, destination, options.replaceSymlink);
      if (prior.kind === "missing") continue;
      const modified = prior.kind !== "file" || await sha256File(destination) !== previousFile.installedSha256;
      if (modified && !options.forceRemoveModified) throw new Error(`Refusing to remove locally modified managed file: ${destination}`);
      const mutation: PlannedMutation = { action: "remove", root: oldState.resolvedRoot, destination, prior };
      mutations.push(mutation);
      actions.push({ action: "remove", path: destination, size: previousFile.size, sha256: previousFile.installedSha256, sensitive: previousFile.sensitive });
    }
  }

  if (options.dryRun) return { releaseId: options.manifest.releaseId, releaseNumber: options.manifest.releaseNumber, backupId: null, actions, dryRun: true };

  const transactionId = randomBytes(12).toString("hex");
  const stageDirectories = new Set<string>();
  const temporaryFiles = new Set<string>();
  const downloaded = new Map<string, string>();
  const createdDirectories = new Set<string>();
  const transactionRoots = [...new Set([
    ...plannedFiles.map(({ root }) => root),
    ...selectedOldStates.map(({ resolvedRoot }) => resolvedRoot),
    ...options.manifest.includedAgents.flatMap((agentId) => {
      const adapter = getAdapter(agentId);
      return adapter.roots.map((rootId) => adapter.resolveRoot(rootId, pathContext));
    }),
  ])];
  await ensurePrivateDirectory(options.paths.transactionDirectory);
  const journalPath = join(options.paths.transactionDirectory, `${transactionId}.json`);
  let backupId: string | null = null;
  let backupReady = false;
  let started = 0;
  const currentJournal = (): TransactionJournal => TransactionJournal.parse({
    version: 1,
    transactionId,
    backupId,
    backupReady,
    started,
    roots: transactionRoots,
    stageDirectories: [...stageDirectories],
    temporaryFiles: [...temporaryFiles],
    createdDirectories: [...createdDirectories],
  });
  const persistJournal = async () => await writePrivateJson(journalPath, currentJournal());
  await persistJournal();

  try {
    for (const mutation of mutations.filter(({ action }) => action === "write")) {
      const file = mutation.file!;
      let source = downloaded.get(file.manifest.contentSha256);
      if (!source) {
        const stageDirectory = join(
          await nearestExistingDirectory(file.root),
          `.agent-config-hub-stage-${transactionId}`,
        );
        stageDirectories.add(stageDirectory);
        await persistJournal();
        source = join(stageDirectory, "downloads", file.manifest.contentSha256);
        await streamResponseToFile(
          await options.api.releaseFile(options.manifest.releaseId, file.manifest.fileId),
          source,
          file.manifest.contentSha256,
          file.manifest.size,
        );
        downloaded.set(file.manifest.contentSha256, source);
      }
    }
    for (const mutation of mutations.filter(({ action }) => action === "write")) {
      const file = mutation.file!;
      const source = downloaded.get(file.manifest.contentSha256);
      if (!source) throw new Error(`Missing staged bytes for ${file.manifest.fileId}.`);
      await ensureDestinationDirectory(
        file.root,
        dirname(mutation.destination),
        createdDirectories,
        persistJournal,
      );
      mutation.temporary = join(
        dirname(mutation.destination),
        `.agent-config-hub-${transactionId}-${randomBytes(4).toString("hex")}.tmp`,
      );
      temporaryFiles.add(mutation.temporary);
      await persistJournal();
      await copyFileDurable(source, mutation.temporary, file.manifest.executable ? 0o700 : 0o600);
    }

    backupId = makeBackupId();
    await persistJournal();
    const stateUpdates = new Map<string, InstallState | null>();
    const installedAt = new Date().toISOString();
    for (const agentId of options.manifest.includedAgents) {
      const adapter = getAdapter(agentId);
      for (const rootId of adapter.roots) {
        const resolvedRoot = adapter.resolveRoot(rootId, pathContext);
        const partition = {
          serverOrigin: options.serverOrigin,
          profile: options.profile,
          agentId,
          rootId,
          resolvedRoot,
        };
        const files = desiredByPartition.get(statePartitionKey(partition)) ?? [];
        stateUpdates.set(stateFileName(partition), {
          version: 1,
          ...partition,
          releaseId: options.manifest.releaseId,
          releaseNumber: options.manifest.releaseNumber,
          backupId,
          installedAt,
          files: files.map(({ manifest }) => ({
            relativePath: manifest.target.relativePath,
            installedSha256: manifest.contentSha256,
            size: manifest.size,
            executable: manifest.executable,
            sensitive: manifest.sensitive,
          })),
        });
      }
    }
    if (options.requestedAgents.length === 0) {
      for (const state of selectedOldStates) {
        if (!options.manifest.includedAgents.includes(state.agentId)) {
          stateUpdates.set(stateFileName(state), null);
        }
      }
    }
    const snapshots = [...stateUpdates.keys()].map((fileName) => ({
      fileName,
      value: currentStates.find((state) => stateFileName(state) === fileName) ?? null,
    }));
    const operations: BackupOperation[] = [];
    for (let index = 0; index < mutations.length; index += 1) {
      const mutation = mutations[index]!;
      const backupRelativePath = mutation.prior.kind === "file" ? `files/${index}` : undefined;
      if (backupRelativePath) {
        await copyFileDurable(
          mutation.destination,
          backupBytesPath(options.paths, backupId, backupRelativePath),
          0o600,
        );
      }
      operations.push({
        root: mutation.root,
        destination: mutation.destination,
        prior: mutation.prior,
        ...(backupRelativePath ? { backupRelativePath } : {}),
      });
    }
    const record: BackupRecord = {
      version: 1,
      id: backupId,
      createdAt: new Date().toISOString(),
      serverOrigin: options.serverOrigin,
      profile: options.profile,
      releaseId: options.manifest.releaseId,
      releaseNumber: options.manifest.releaseNumber,
      operations,
      stateSnapshots: snapshots,
    };
    await saveBackupRecord(options.paths, record);
    backupReady = true;
    await persistJournal();

    for (const mutation of mutations) {
      started += 1;
      await persistJournal();
      if (mutation.action === "write") {
        await atomicRenamePrepared(mutation.temporary!, mutation.destination);
        if (process.platform !== "win32") {
          await chmod(mutation.destination, mutation.file!.manifest.executable ? 0o700 : 0o600);
        }
      } else {
        await rm(mutation.destination, { force: true });
      }
      if (options.faultAfterMutation === started) {
        throw new Error(`Injected failure after mutation ${started}.`);
      }
    }
    let writtenStates = 0;
    for (const [fileName, state] of stateUpdates) {
      if (state) await saveState(options.paths, state);
      else await removePrivatePath(join(options.paths.stateDirectory, fileName));
      writtenStates += 1;
      if (options.faultAfterStateUpdate === writtenStates) {
        throw new Error(`Injected failure after state update ${writtenStates}.`);
      }
    }
    for (const temporary of temporaryFiles) await rm(temporary, { force: true });
    for (const directory of stageDirectories) await rm(directory, { force: true, recursive: true });
    await removeEmptyCreatedDirectories(createdDirectories);
    await removePrivatePath(journalPath);
    return {
      releaseId: options.manifest.releaseId,
      releaseNumber: options.manifest.releaseNumber,
      backupId,
      actions,
      dryRun: false,
    };
  } catch (error) {
    await recoverTransaction(options.paths, currentJournal(), journalPath);
    throw error;
  } finally {
    for (const temporary of temporaryFiles) await rm(temporary, { force: true });
    for (const directory of stageDirectories) await rm(directory, { force: true, recursive: true });
    await removeEmptyCreatedDirectories(createdDirectories);
  }
}

export async function recoverInterruptedTransactions(paths: LocalPaths): Promise<void> {
  try {
    const journals = await readdir(paths.transactionDirectory, { withFileTypes: true });
    for (const journal of journals) {
      if (!journal.isFile() || !journal.name.endsWith(".json")) continue;
      const journalPath = join(paths.transactionDirectory, journal.name);
      const payload = TransactionJournal.parse(JSON.parse(await readFile(journalPath, "utf8")));
      if (journal.name !== `${payload.transactionId}.json`) {
        throw new Error(`Transaction journal name does not match its ID: ${journal.name}`);
      }
      await recoverTransaction(paths, payload, journalPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
