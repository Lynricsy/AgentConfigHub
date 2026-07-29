import type { AgentId, Diagnostic, LogicalTarget, TargetRootId } from "@agent-config-hub/protocol";

export type FileFormat =
  | "json"
  | "jsonc"
  | "toml"
  | "yaml"
  | "dotenv"
  | "markdown"
  | "text"
  | "binary";

export interface ManagedSurface {
  readonly root: TargetRootId;
  readonly pattern: string;
  readonly format: FileFormat | "auto";
  readonly reserved: boolean;
}

export interface ClientPathContext {
  readonly platform: "linux" | "darwin" | "win32";
  readonly homeDir: string;
  readonly rootOverrides: Partial<Record<TargetRootId, string>>;
}

export interface AdapterFile {
  readonly agentId: AgentId;
  readonly target: LogicalTarget;
  readonly mediaType: string;
  readonly format: FileFormat;
  readonly text: string | null;
  readonly executable: boolean;
}

export interface SharedResourceFile {
  readonly relativePath: string;
  readonly blobSha256: string;
  readonly mediaType: string;
  readonly executable: boolean;
}

export interface SharedRenderContext {
  readonly instructions: readonly { slug: string; markdown: string }[];
  readonly instructionOverlay: string;
  readonly skills: readonly {
    readonly name: string;
    readonly files: readonly SharedResourceFile[];
  }[];
}

export interface GeneratedFile {
  readonly target: LogicalTarget;
  readonly mediaType: string;
  readonly executable: boolean;
  readonly source:
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "blob"; readonly sha256: string };
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly revision: number;
  readonly roots: readonly TargetRootId[];
  readonly surfaces: readonly ManagedSurface[];
  resolveRoot(root: TargetRootId, context: ClientPathContext): string;
  validate(file: AdapterFile): Promise<readonly Diagnostic[]>;
  renderSharedResources(context: SharedRenderContext): Promise<readonly GeneratedFile[]>;
}
