import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AgentId, TargetRootId } from "@agent-config-hub/protocol";

import { ensurePrivateDirectory, type LocalPaths, writePrivateJson } from "./local-store.js";

export const ManagedFileState = z.object({
  relativePath: z.string(),
  installedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  executable: z.boolean(),
  sensitive: z.boolean(),
});

export const InstallState = z.object({
  version: z.literal(1),
  serverOrigin: z.string(),
  profile: z.string(),
  agentId: AgentId,
  rootId: TargetRootId,
  resolvedRoot: z.string(),
  releaseId: z.string(),
  releaseNumber: z.number().int().positive(),
  backupId: z.string().nullable(),
  installedAt: z.string().datetime(),
  files: z.array(ManagedFileState),
}).strict();

export type InstallState = z.infer<typeof InstallState>;
export type ManagedFileState = z.infer<typeof ManagedFileState>;

export function statePartitionKey(input: Pick<InstallState, "serverOrigin" | "profile" | "agentId" | "rootId" | "resolvedRoot">): string {
  const resolvedRoot = process.platform === "win32"
    ? input.resolvedRoot.toLocaleLowerCase("en-US")
    : input.resolvedRoot;
  return [input.serverOrigin, input.profile, input.agentId, input.rootId, resolvedRoot].join("\0");
}

export function stateFileName(input: Pick<InstallState, "serverOrigin" | "profile" | "agentId" | "rootId" | "resolvedRoot">): string {
  return `${createHash("sha256").update(statePartitionKey(input)).digest("hex")}.json`;
}

export async function loadStates(paths: LocalPaths): Promise<InstallState[]> {
  try {
    const entries = await readdir(paths.stateDirectory, { withFileTypes: true });
    const states: InstallState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      states.push(InstallState.parse(JSON.parse(await readFile(join(paths.stateDirectory, entry.name), "utf8"))));
    }
    return states;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveState(paths: LocalPaths, state: InstallState): Promise<void> {
  await ensurePrivateDirectory(paths.stateDirectory);
  await writePrivateJson(join(paths.stateDirectory, stateFileName(state)), InstallState.parse(state));
}

export async function stateForPartition(
  paths: LocalPaths,
  partition: Pick<InstallState, "serverOrigin" | "profile" | "agentId" | "rootId" | "resolvedRoot">,
): Promise<InstallState | undefined> {
  return (await loadStates(paths)).find((state) => statePartitionKey(state) === statePartitionKey(partition));
}
