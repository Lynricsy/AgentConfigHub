import type { AgentId, LogicalTarget } from "@agent-config-hub/protocol";

import { builtInAdapters } from "./builtin.js";
import type { AgentAdapter, GeneratedFile } from "./contract.js";
import { assertNoLogicalTargetCollisions } from "./path-safety.js";

const adapterById = Object.fromEntries(
  builtInAdapters.map((adapter) => [adapter.id, adapter]),
) as Record<AgentId, AgentAdapter>;

export function getAdapter(agentId: AgentId): AgentAdapter {
  return adapterById[agentId];
}

export function assertNativeGeneratedTargetSeparation(
  nativeTargets: readonly LogicalTarget[],
  generatedFiles: readonly GeneratedFile[],
): void {
  assertNoLogicalTargetCollisions([
    ...nativeTargets,
    ...generatedFiles.map(({ target }) => target),
  ]);
}

export const adapterRegistry: Readonly<Record<AgentId, AgentAdapter>> = adapterById;
