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
    version: "omp-config-2026-07-29",
    source: "https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md",
    schema: objectSchema({
      agents: { type: "object" },
      extensions: { type: "array", items: { type: "string" } },
      hooks: { type: "object" },
      instructions: { type: "array", items: { type: "string" } },
      models: { anyOf: [{ type: "array" }, { type: "object" }] },
      providers: { type: "object" },
      skills: { type: "array", items: { type: "string" } },
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
