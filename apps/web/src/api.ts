import { z } from "zod";

import { AgentId, ApiError, Diagnostic, LogicalTarget, TargetRootId } from "@agent-config-hub/protocol";

const ConfigSet = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  enabledAgents: AgentId.array(),
  draftRevision: z.number().int(),
  currentReleaseId: z.string().nullable(),
  currentReleaseRevision: z.number().int().nullable(),
  currentReleaseNumber: z.number().int().positive().nullable(),
});
const DraftFile = z.object({
  id: z.string(),
  agentId: AgentId,
  root: TargetRootId,
  relativePath: z.string(),
  blobSha256: z.string(),
  mediaType: z.string(),
  utf8: z.boolean(),
  executable: z.boolean(),
  size: z.number().int().nonnegative(),
});
const SecretSlots = z.object({
  slots: z.array(z.object({
    id: z.string(),
    name: z.string(),
    defaultCredentialId: z.string().nullable(),
    defaultCredentialLabel: z.string().nullable(),
  })),
  overrides: z.array(z.object({
    secretSlotId: z.string(),
    agentId: AgentId,
    credentialId: z.string(),
    credentialLabel: z.string(),
  })),
});
const ResourceSelection = z.object({
  resourceId: z.string(),
  revisionId: z.string(),
  sortOrder: z.number().int(),
  agentId: AgentId,
});

export const ConfigSetList = ConfigSet.array();
export const ConfigSetDetail = z.object({
  configSet: ConfigSet,
  files: DraftFile.array(),
  overlays: z.array(z.object({ agentId: AgentId, markdown: z.string() })),
  selectedResources: ResourceSelection.array(),
  secretSlots: SecretSlots,
});
export const CredentialList = z.array(z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  revision: z.number().int(),
  maskedValue: z.literal("••••••••"),
  referenceCount: z.number().int(),
}));
export const ResourceList = z.object({
  resources: z.array(z.object({
    id: z.string(),
    kind: z.enum(["instruction", "skill"]),
    slug: z.string(),
    name: z.string(),
    revisionId: z.string(),
    revisionNumber: z.number().int(),
  })),
  files: z.array(z.object({
    resourceId: z.string(),
    relativePath: z.string(),
    blobSha256: z.string(),
    mediaType: z.string(),
    executable: z.boolean(),
  })),
});
export const TokenList = z.array(z.object({
  id: z.string(),
  kind: z.enum(["device", "automation"]),
  label: z.string(),
  prefix: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
}));
export const ReleaseList = z.array(z.object({
  id: z.string(),
  releaseNumber: z.number().int(),
  draftRevision: z.number().int(),
  enabledAgents: AgentId.array(),
  notes: z.string().nullable(),
  minCliVersion: z.string(),
  adapterRevisions: z.record(AgentId, z.number().int()),
  createdAt: z.number(),
}));
export const AdapterList = z.array(z.object({
  id: AgentId,
  revision: z.number().int(),
  roots: z.array(TargetRootId),
  surfaces: z.array(z.object({
    root: TargetRootId,
    pattern: z.string(),
    format: z.string(),
    reserved: z.boolean(),
  })),
  schemaSnapshot: z.object({
    version: z.string(),
    source: z.string(),
    schema: z.record(z.string(), z.unknown()),
  }),
}));
export const ValidationResult = z.object({ diagnostics: Diagnostic.array() });

export type ConfigSet = z.infer<typeof ConfigSet>;
export type ConfigSetDetail = z.infer<typeof ConfigSetDetail>;
export type DraftFile = z.infer<typeof DraftFile>;
export type Credential = z.infer<typeof CredentialList>[number];
export type ResourceList = z.infer<typeof ResourceList>;
export type Release = z.infer<typeof ReleaseList>[number];
export type AdapterMetadata = z.infer<typeof AdapterList>[number];

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function checkedResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  let parsed: z.infer<typeof ApiError> | undefined;
  try {
    parsed = ApiError.parse(await response.json());
  } catch {
    throw new ApiClientError("INVALID_RESPONSE", `Server returned HTTP ${response.status}.`, "unknown");
  }
  throw new ApiClientError(parsed.error.code, parsed.error.message, parsed.error.requestId, parsed.error.details);
}

export async function api<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await checkedResponse(await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }));
  return schema.parse(await response.json());
}

export async function mutate<T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  options: { method?: string; revision?: number | string } = {},
): Promise<{ data: T; etag: string | null }> {
  const response = await checkedResponse(await fetch(path, {
    method: options.method ?? "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.revision === undefined ? {} : { "If-Match": `"${options.revision}"` }),
    },
    body: JSON.stringify(body),
  }));
  return { data: schema.parse(await response.json()), etag: response.headers.get("ETag") };
}

export async function mutateEmpty(
  path: string,
  body: unknown,
  options: { method?: string; revision?: number | string } = {},
): Promise<void> {
  await checkedResponse(await fetch(path, {
    method: options.method ?? "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.revision === undefined ? {} : { "If-Match": `"${options.revision}"` }),
    },
    body: JSON.stringify(body),
  }));
}

export async function uploadBlob(
  file: Blob,
  mediaType = file.type || "application/octet-stream",
): Promise<{
  sha256: string;
  size: number;
  mediaType?: string;
  monacoEligible: boolean;
}> {
  const response = await checkedResponse(await fetch("/api/v1/blobs", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": mediaType },
    body: file,
  }));
  const descriptor = z.object({
    sha256: z.string(),
    size: z.number(),
    mediaType: z.string().optional(),
    monacoEligible: z.boolean(),
  }).parse(await response.json());
  return descriptor.mediaType === undefined
    ? {
        sha256: descriptor.sha256,
        size: descriptor.size,
        monacoEligible: descriptor.monacoEligible,
      }
    : {
        sha256: descriptor.sha256,
        size: descriptor.size,
        mediaType: descriptor.mediaType,
        monacoEligible: descriptor.monacoEligible,
      };
}

export async function downloadBlob(sha256: string): Promise<Blob> {
  const response = await checkedResponse(await fetch(`/api/v1/blobs/${sha256}`, { credentials: "include" }));
  return await response.blob();
}

export function targetKey(target: z.infer<typeof LogicalTarget>): string {
  return `${target.root}/${target.relativePath}`;
}
