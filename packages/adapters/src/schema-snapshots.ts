import type { AgentId } from "@agent-config-hub/protocol";

export interface VendorSchemaSnapshot {
  readonly version: string;
  readonly source: string;
  readonly schema: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: true,
});

// omp 顶层设置键（来源：omp config list，2026-08-27 快照）。
// 仅用于未知键检测；值级校验由下方显式类型条目提供。
const OMP_SETTINGS_KEYS = [
  "advisor", "ask", "astEdit", "astGrep", "async", "auth", "autoResume",
  "autocompleteMaxVisible", "autolearn", "bash", "bashInterceptor",
  "branchSummary", "browser", "checkpoint", "codexResets", "collab",
  "colorBlindMode", "commands", "commit", "compaction", "completion",
  "composer", "computer", "contextPromotion", "cycleOrder", "debug",
  "defaultThinkingLevel", "dev", "disabledExtensions", "disabledProviders",
  "display", "doubleEscapeAction", "edit", "emojiAutocomplete",
  "enabledModels", "error", "eval", "exa", "extendedContext",
  "extensionHandlers", "externalThinking", "features", "fetch",
  "followUpMode", "gc", "generate_image", "git", "github", "glob", "goal",
  "grep", "hideThinkingBlock", "hindsight", "images", "includeModelInPrompt",
  "includeWorkspaceTree", "inlineToolDescriptors", "inspect_image",
  "interruptMode", "irc", "julia", "launch", "live", "loop", "lsp",
  "magicKeywords", "marketplace", "mcp", "memories", "memory", "minP",
  "mnemopi", "model", "modelProviderOrder", "modelRoleStorage", "modelRoles",
  "modelTags", "omitThinking", "paste", "personality", "plan", "power",
  "presencePenalty", "prewalk", "proseOnlyThinking", "provider", "python",
  "read", "readLineNumbers", "recap", "repetitionPenalty", "retry", "ruby",
  "searxng", "secrets", "security", "setupVersion", "share",
  "shellMinimizer", "shellPath", "showHardwareCursor", "snapcompact",
  "speech", "speechgen", "spelling", "startup", "statusLine", "steeringMode",
  "stt", "symbolPreset", "task", "tasks", "temperature", "terminal",
  "textVerbosity", "theme", "thinkingBudgets", "tier", "title", "todo",
  "topK", "topP", "treeFilterMode", "tts", "ttsr", "tui", "update", "vault",
  "web_search", "workspace", "worktree",
] as const;

export const ADAPTER_SCHEMA_SNAPSHOTS: Record<AgentId, VendorSchemaSnapshot> = {
  "claude-code": {
    version: "claude-code-settings-2026-07-29",
    source: "https://json.schemastore.org/claude-code-settings.json",
    schema: objectSchema({
      $schema: { type: "string" },
      apiKeyHelper: { type: "string" },
      env: { type: "object", additionalProperties: { type: "string" } },
      hooks: { type: "object" },
      includeCoAuthoredBy: { type: "boolean" },
      model: { type: "string" },
      permissions: objectSchema({
        allow: { type: "array", items: { type: "string" } },
        ask: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
      }),
      plugins: { type: "object" },
      statusLine: { type: "object" },
    }),
  },
  codex: {
    version: "codex-config-2026-07-29",
    source: "https://developers.openai.com/codex/config-reference",
    schema: objectSchema({
      approval_policy: { type: "string" },
      features: { type: "object" },
      model: { type: "string" },
      model_provider: { type: "string" },
      model_providers: { type: "object" },
      profiles: { type: "object" },
      sandbox_mode: { type: "string" },
      tools: { type: "object" },
    }),
  },
  opencode: {
    version: "opencode-config-2026-07-29",
    source: "https://opencode.ai/config.json",
    schema: objectSchema({
      $schema: { type: "string" },
      agent: { type: "object" },
      autoupdate: { type: "boolean" },
      command: { type: "object" },
      instructions: { type: "array", items: { type: "string" } },
      mcp: { type: "object" },
      model: { type: "string" },
      permission: { type: "object" },
      plugin: { type: "array", items: { type: "string" } },
      provider: { type: "object" },
      server: { type: "object" },
      theme: { type: "string" },
      tools: { type: "object" },
    }),
  },
  pi: {
    version: "pi-settings-2026-07-29",
    source: "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#settings",
    schema: objectSchema({
      defaultModel: { type: "string" },
      defaultProvider: { type: "string" },
      extensions: { type: "array", items: { type: "string" } },
      packages: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" } },
      theme: { type: "string" },
    }),
  },
  omp: {
    version: "omp-config-2026-08-27",
    source: "https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md",
    schema: objectSchema({
      ...Object.fromEntries(OMP_SETTINGS_KEYS.map((key) => [key, {}])),
      agents: { type: "object" },
      extensions: { type: "array", items: { type: "string" } },
      hooks: { type: "object" },
      instructions: { type: "array", items: { type: "string" } },
      models: { anyOf: [{ type: "array" }, { type: "object" }] },
      providers: { type: "object" },
      skills: { anyOf: [{ type: "array" }, { type: "object" }] },
      tools: { type: "object" },
    }),
  },
  grok: {
    version: "grok-build-config-2026-07-29",
    source: "https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-pager/docs/user-guide",
    schema: objectSchema({
      api: { type: "object" },
      features: { type: "object" },
      model: { type: "string" },
      providers: { type: "object" },
      tools: { type: "object" },
      workspace: { type: "object" },
    }),
  },
};
