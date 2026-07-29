import { z } from "zod";

export const AgentId = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "omp",
  "grok",
]);

export const TargetRootId = z.enum([
  "claude-home",
  "codex-home",
  "agents-home",
  "opencode-home",
  "pi-home",
  "omp-home",
  "grok-home",
]);

export const LogicalTarget = z.object({
  root: TargetRootId,
  relativePath: z.string(),
});

export const DiagnosticRange = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

export const Diagnostic = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  target: LogicalTarget.optional(),
  range: DiagnosticRange.optional(),
});

export const ReleaseFileV1 = z.object({
  fileId: z.string(),
  agentId: AgentId,
  target: LogicalTarget,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  executable: z.boolean(),
  sensitive: z.boolean(),
});

export const ReleaseManifestV1 = z.object({
  protocolVersion: z.literal(1),
  releaseId: z.string(),
  releaseNumber: z.number().int().positive(),
  configSet: z.object({ slug: z.string(), name: z.string() }),
  enabledAgents: z.array(AgentId),
  selection: z.enum(["all-enabled", "subset"]),
  includedAgents: z.array(AgentId),
  minCliVersion: z.string(),
  adapterRevisions: z.record(AgentId, z.number().int().positive()),
  files: z.array(ReleaseFileV1),
});

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

export type AgentId = z.infer<typeof AgentId>;
export type TargetRootId = z.infer<typeof TargetRootId>;
export type LogicalTarget = z.infer<typeof LogicalTarget>;
export type Diagnostic = z.infer<typeof Diagnostic>;
export type ReleaseFileV1 = z.infer<typeof ReleaseFileV1>;
export type ReleaseManifestV1 = z.infer<typeof ReleaseManifestV1>;
export type ApiError = z.infer<typeof ApiError>;
