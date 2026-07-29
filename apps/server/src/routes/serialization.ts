import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

const StoredConfigSet = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  enabledAgents: z.string(),
  draftRevision: z.number().int(),
  currentReleaseId: z.string().nullable(),
  currentReleaseRevision: z.number().int().nullable(),
  currentReleaseNumber: z.number().int().positive().nullable(),
});

const StoredBoolean = z.union([z.literal(0), z.literal(1)]);
const AdapterRevisions = z.record(AgentId, z.number().int().positive());

export function parseSqliteBoolean(value: unknown): boolean {
  return Boolean(StoredBoolean.parse(value));
}

export function parseAgentJson(value: unknown) {
  return AgentId.array().parse(JSON.parse(z.string().parse(value)));
}

export function parseAdapterRevisionJson(value: unknown) {
  return AdapterRevisions.parse(JSON.parse(z.string().parse(value)));
}

export function serializeConfigSet(row: unknown) {
  const stored = StoredConfigSet.parse(row);
  return { ...stored, enabledAgents: parseAgentJson(stored.enabledAgents) };
}
