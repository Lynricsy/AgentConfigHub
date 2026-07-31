import { join as posixJoin } from "node:path/posix";
import { join as windowsJoin } from "node:path/win32";

import type { AgentId, Diagnostic, LogicalTarget, TargetRootId } from "@agent-config-hub/protocol";

import type {
  AgentAdapter,
  ClientPathContext,
  GeneratedFile,
  ManagedSurface,
  SharedRenderContext,
} from "./contract.js";
import { validateAdapterFile } from "./validation.js";
import { assertAllowedTarget, UnsafeTargetError } from "./path-safety.js";

interface AdapterDefinition {
  readonly id: AgentId;
  readonly revision: number;
  readonly roots: readonly TargetRootId[];
  readonly defaults: Partial<Record<TargetRootId, readonly string[]>>;
  readonly surfaces: readonly ManagedSurface[];
  readonly instructionTarget: LogicalTarget;
  readonly skillRoot: TargetRootId;
  readonly skillDirectory: string;
}

const surface = (
  root: TargetRootId,
  pattern: string,
  format: ManagedSurface["format"],
  reserved = false,
): ManagedSurface => ({ root, pattern, format, reserved });

const definitions: readonly AdapterDefinition[] = [
  {
    id: "claude-code",
    revision: 1,
    roots: ["claude-home"],
    defaults: { "claude-home": [".claude"] },
    instructionTarget: { root: "claude-home", relativePath: "CLAUDE.md" },
    skillRoot: "claude-home",
    skillDirectory: "skills",
    surfaces: [
      surface("claude-home", "settings.json", "json"),
      surface("claude-home", "CLAUDE.md", "markdown", true),
      ...["agents", "skills", "commands", "rules", "output-styles"].map((directory) =>
        surface("claude-home", `${directory}/**`, "auto")),
    ],
  },
  {
    id: "codex",
    revision: 1,
    roots: ["codex-home", "agents-home"],
    defaults: { "codex-home": [".codex"], "agents-home": [".agents"] },
    instructionTarget: { root: "codex-home", relativePath: "AGENTS.override.md" },
    skillRoot: "agents-home",
    skillDirectory: "skills",
    surfaces: [
      surface("codex-home", "config.toml", "toml"),
      surface("codex-home", "*.config.toml", "toml"),
      surface("codex-home", "AGENTS.md", "markdown"),
      surface("codex-home", "AGENTS.override.md", "markdown", true),
      surface("codex-home", "rules/**", "auto"),
      surface("codex-home", "plugins/**", "auto"),
      surface("agents-home", "skills/**", "auto"),
      surface("agents-home", "plugins/marketplace.json", "json"),
    ],
  },
  {
    id: "opencode",
    revision: 1,
    roots: ["opencode-home"],
    defaults: { "opencode-home": [".config", "opencode"] },
    instructionTarget: { root: "opencode-home", relativePath: "AGENTS.md" },
    skillRoot: "opencode-home",
    skillDirectory: "skills",
    surfaces: [
      ...["opencode.json", "tui.json"].map((path) => surface("opencode-home", path, "json")),
      ...["opencode.jsonc", "tui.jsonc"].map((path) => surface("opencode-home", path, "jsonc")),
      surface("opencode-home", "AGENTS.md", "markdown", true),
      ...["agents", "commands", "modes", "plugins", "skills", "tools", "themes"].map((directory) =>
        surface("opencode-home", `${directory}/**`, "auto")),
      ...["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map((path) =>
        surface("opencode-home", path, "auto")),
    ],
  },
  {
    id: "pi",
    revision: 1,
    roots: ["pi-home"],
    defaults: { "pi-home": [".pi", "agent"] },
    instructionTarget: { root: "pi-home", relativePath: "AGENTS.md" },
    skillRoot: "pi-home",
    skillDirectory: "skills",
    surfaces: [
      ...["settings.json", "models.json", "keybindings.json"].map((path) => surface("pi-home", path, "json")),
      surface("pi-home", "AGENTS.md", "markdown", true),
      ...["SYSTEM.md", "APPEND_SYSTEM.md"].map((path) => surface("pi-home", path, "markdown")),
      ...["extensions", "skills", "prompts", "themes"].map((directory) => surface("pi-home", `${directory}/**`, "auto")),
    ],
  },
  {
    id: "omp",
    revision: 2,
    roots: ["omp-home"],
    defaults: { "omp-home": [".omp", "agent"] },
    instructionTarget: { root: "omp-home", relativePath: "AGENTS.md" },
    skillRoot: "omp-home",
    skillDirectory: "skills",
    surfaces: [
      ...["config.yml", "models.yml", "keybindings.yml"].map((path) => surface("omp-home", path, "yaml")),
      surface("omp-home", "keybindings.json", "json"),
      surface("omp-home", "mcp.json", "json"),
      surface("omp-home", "AGENTS.md", "markdown", true),
      ...["RULES.md", "SYSTEM.md", "APPEND_SYSTEM.md", "TITLE_SYSTEM.md"].map((path) => surface("omp-home", path, "markdown")),
      ...["skills", "commands", "rules", "prompts", "instructions", "hooks", "tools", "extensions"].map((directory) =>
        surface("omp-home", `${directory}/**`, "auto")),
    ],
  },
  {
    id: "grok",
    revision: 1,
    roots: ["grok-home"],
    defaults: { "grok-home": [".grok"] },
    instructionTarget: { root: "grok-home", relativePath: "rules/agent-config-hub.md" },
    skillRoot: "grok-home",
    skillDirectory: "skills",
    surfaces: [
      ...["config.toml", "pager.toml"].map((path) => surface("grok-home", path, "toml")),
      ...["settings.json", "lsp.json"].map((path) => surface("grok-home", path, "json")),
      surface("grok-home", "rules/agent-config-hub.md", "markdown", true),
      ...["rules", "skills", "commands", "agents", "hooks", "plugins"].map((directory) =>
        surface("grok-home", `${directory}/**`, "auto")),
    ],
  },
];

function renderInstructions(context: SharedRenderContext): string {
  const sections = context.instructions.map(({ markdown }) => markdown.trim()).filter(Boolean);
  if (context.instructionOverlay.trim()) sections.push(context.instructionOverlay.trim());
  return sections.join("\n\n");
}

function createAdapter(definition: AdapterDefinition): AgentAdapter {
  const adapter: AgentAdapter = {
    id: definition.id,
    revision: definition.revision,
    roots: definition.roots,
    surfaces: definition.surfaces,
    resolveRoot(root: TargetRootId, context: ClientPathContext): string {
      if (!definition.roots.includes(root)) throw new Error(`${root} is not owned by ${definition.id}.`);
      const override = context.rootOverrides[root];
      if (override) return override;
      const segments = definition.defaults[root];
      if (!segments) throw new Error(`No default root for ${root}.`);
      return (context.platform === "win32" ? windowsJoin : posixJoin)(context.homeDir, ...segments);
    },
    async validate(file): Promise<readonly Diagnostic[]> {
      if (file.agentId !== definition.id) {
        return [{ code: "AGENT_MISMATCH", severity: "error", message: `${file.agentId} does not match ${definition.id}.` }];
      }
      try {
        assertAllowedTarget(adapter, file.target, { allowReserved: true });
      } catch (error) {
        if (error instanceof UnsafeTargetError) {
          return [{ code: error.code, severity: "error", message: error.message, target: file.target }];
        }
        throw error;
      }
      return await validateAdapterFile(file);
    },
    async renderSharedResources(context): Promise<readonly GeneratedFile[]> {
      const generated: GeneratedFile[] = [];
      const instructions = renderInstructions(context);
      if (instructions) generated.push({
        target: definition.instructionTarget,
        mediaType: "text/markdown",
        executable: false,
        source: { kind: "text", text: `${instructions}\n` },
      });
      for (const skill of context.skills) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
          throw new Error(`Skill name ${skill.name} is not portable.`);
        }
        if (!skill.files.some(({ relativePath }) => relativePath === "SKILL.md")) {
          throw new Error(`Skill ${skill.name} must contain SKILL.md.`);
        }
        for (const file of skill.files) generated.push({
          target: {
            root: definition.skillRoot,
            relativePath: `${definition.skillDirectory}/${skill.name}/${file.relativePath}`,
          },
          mediaType: file.mediaType,
          executable: file.executable,
          source: { kind: "blob", sha256: file.blobSha256 },
        });
      }
      return generated;
    },
  };
  return adapter;
}

export const builtInAdapters: readonly AgentAdapter[] = definitions.map(createAdapter);
