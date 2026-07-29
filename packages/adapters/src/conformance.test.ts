import { describe, expect, it } from "vitest";

import type { AgentId, LogicalTarget, TargetRootId } from "@agent-config-hub/protocol";

import { builtInAdapters } from "./builtin.js";
import type { AdapterFile, FileFormat } from "./contract.js";
import {
  assertAllowedTarget,
  assertNoLogicalTargetCollisions,
  assertNoResolvedTargetCollisions,
  assertSafeRelativePath,
} from "./path-safety.js";
import { assertNativeGeneratedTargetSeparation } from "./registry.js";
import { ADAPTER_SCHEMA_SNAPSHOTS } from "./validation.js";

const excluded: Record<AgentId, readonly { root: LogicalTarget["root"]; path: string }[]> = {
  "claude-code": [
    { root: "claude-home", path: ".claude.json" },
    { root: "claude-home", path: "projects/work/state.json" },
    { root: "claude-home", path: "history.jsonl" },
    { root: "claude-home", path: "todos/work.json" },
    { root: "claude-home", path: "plugins/cache/pkg" },
    { root: "claude-home", path: "plugins/installed/pkg" },
  ],
  codex: [
    { root: "codex-home", path: "auth.json" },
    { root: "codex-home", path: "sessions/1.json" },
    { root: "codex-home", path: "logs/codex.log" },
    { root: "codex-home", path: "state.sqlite" },
    { root: "codex-home", path: "state.db" },
    { root: "codex-home", path: "cache/model.bin" },
    { root: "codex-home", path: "downloads/tool.bin" },
  ],
  opencode: [
    { root: "opencode-home", path: "node_modules/pkg/index.js" },
    { root: "opencode-home", path: "auth.json" },
    { root: "opencode-home", path: "auth/session.json" },
    { root: "opencode-home", path: "runtime/state.json" },
  ],
  pi: [
    { root: "pi-home", path: "auth.json" },
    { root: "pi-home", path: "trust.json" },
    { root: "pi-home", path: "sessions/1.json" },
    { root: "pi-home", path: "packages/npm/pkg/index.js" },
    { root: "pi-home", path: "packages/git/pkg/index.js" },
    { root: "pi-home", path: "cache/pkg.bin" },
  ],
  omp: [
    { root: "omp-home", path: "agent.db" },
    { root: "omp-home", path: "sessions/1.json" },
    { root: "omp-home", path: "blobs/aa/hash" },
    { root: "omp-home", path: "managed-skills/pkg/SKILL.md" },
    { root: "omp-home", path: "extensions/pkg/node_modules/a.js" },
    { root: "omp-home", path: "install-state.json" },
  ],
  grok: [
    { root: "grok-home", path: "auth.json" },
    { root: "grok-home", path: "credentials/token.json" },
    { root: "grok-home", path: "trusted_folders.toml" },
    { root: "grok-home", path: "bundled/rules.md" },
    { root: "grok-home", path: "sessions/1.json" },
    { root: "grok-home", path: "memory/state.json" },
    { root: "grok-home", path: "cache/model.bin" },
    { root: "grok-home", path: "system/managed.toml" },
  ],
};

const rootSuffix: Record<TargetRootId, { posix: string; windows: string }> = {
  "claude-home": { posix: ".claude", windows: ".claude" },
  "codex-home": { posix: ".codex", windows: ".codex" },
  "agents-home": { posix: ".agents", windows: ".agents" },
  "opencode-home": { posix: ".config/opencode", windows: ".config\\opencode" },
  "pi-home": { posix: ".pi/agent", windows: ".pi\\agent" },
  "omp-home": { posix: ".omp/agent", windows: ".omp\\agent" },
  "grok-home": { posix: ".grok", windows: ".grok" },
};

const instructionTarget: Record<AgentId, LogicalTarget> = {
  "claude-code": { root: "claude-home", relativePath: "CLAUDE.md" },
  codex: { root: "codex-home", relativePath: "AGENTS.override.md" },
  opencode: { root: "opencode-home", relativePath: "AGENTS.md" },
  pi: { root: "pi-home", relativePath: "AGENTS.md" },
  omp: { root: "omp-home", relativePath: "AGENTS.md" },
  grok: { root: "grok-home", relativePath: "rules/agent-config-hub.md" },
};

const skillRoot: Record<AgentId, TargetRootId> = {
  "claude-code": "claude-home",
  codex: "agents-home",
  opencode: "opencode-home",
  pi: "pi-home",
  omp: "omp-home",
  grok: "grok-home",
};

const primaryConfig: Record<AgentId, { target: LogicalTarget; format: FileFormat; valid: string; invalid: string }> = {
  "claude-code": {
    target: { root: "claude-home", relativePath: "settings.json" },
    format: "json",
    valid: '{"model":"test","futureKey":true}',
    invalid: "{",
  },
  codex: {
    target: { root: "codex-home", relativePath: "config.toml" },
    format: "toml",
    valid: 'model = "test"\nfuture_key = true\n',
    invalid: "model = [",
  },
  opencode: {
    target: { root: "opencode-home", relativePath: "opencode.jsonc" },
    format: "jsonc",
    valid: '{"model":"test","futureKey":true,}',
    invalid: "{",
  },
  pi: {
    target: { root: "pi-home", relativePath: "settings.json" },
    format: "json",
    valid: '{"defaultModel":"test","futureKey":true}',
    invalid: "{",
  },
  omp: {
    target: { root: "omp-home", relativePath: "config.yml" },
    format: "yaml",
    valid: "models: {}\nfutureKey: true\n",
    invalid: "key: [",
  },
  grok: {
    target: { root: "grok-home", relativePath: "config.toml" },
    format: "toml",
    valid: 'model = "test"\nfuture_key = true\n',
    invalid: "model = [",
  },
};

const typeInvalidConfig: Record<AgentId, string> = {
  "claude-code": "{\"permissions\":1}",
  codex: "model = 1\n",
  opencode: "{\"model\":1}",
  pi: "{\"defaultModel\":1}",
  omp: "extensions: invalid\n",
  grok: "model = 1\n",
};

function samplePath(pattern: string): string {
  if (pattern.endsWith("/**")) return `${pattern.slice(0, -3)}/fixture.txt`;
  if (pattern.startsWith("*.")) return `fixture${pattern.slice(1)}`;
  return pattern;
}

describe.each(builtInAdapters)("$id adapter conformance", (adapter) => {
  it("accepts every declared surface and protects generated targets", () => {
    for (const surface of adapter.surfaces) {
      const target = { root: surface.root, relativePath: samplePath(surface.pattern) };
      expect(assertAllowedTarget(adapter, target, { allowReserved: true })).toBe(surface);
      if (surface.reserved) expect(() => assertAllowedTarget(adapter, target)).toThrow(/generated/);
      else expect(() => assertAllowedTarget(adapter, target)).not.toThrow();
    }
  });

  it("rejects every explicitly unmanaged area", () => {
    for (const fixture of excluded[adapter.id]) {
      expect(() => assertAllowedTarget(adapter, {
        root: fixture.root,
        relativePath: fixture.path,
      })).toThrow();
    }
  });

  it("resolves deterministic Linux, macOS, and Windows roots", () => {
    for (const root of adapter.roots) {
      const linux = adapter.resolveRoot(root, { platform: "linux", homeDir: "/home/fox", rootOverrides: {} });
      const darwin = adapter.resolveRoot(root, { platform: "darwin", homeDir: "/Users/fox", rootOverrides: {} });
      const windows = adapter.resolveRoot(root, { platform: "win32", homeDir: "C:\\Users\\fox", rootOverrides: {} });
      expect(linux).toBe(`/home/fox/${rootSuffix[root].posix}`);
      expect(darwin).toBe(`/Users/fox/${rootSuffix[root].posix}`);
      expect(windows).toBe(`C:\\Users\\fox\\${rootSuffix[root].windows}`);
    }
  });

  it("renders ordered instructions, overlay, and portable skill attachments", async () => {
    const generated = await adapter.renderSharedResources({
      instructions: [
        { slug: "first", markdown: "First" },
        { slug: "second", markdown: "Second" },
      ],
      instructionOverlay: "Overlay",
      skills: [{
        name: "portable-skill",
        files: [
          { relativePath: "SKILL.md", blobSha256: "a".repeat(64), mediaType: "text/markdown", executable: false },
          { relativePath: "assets/data.bin", blobSha256: "b".repeat(64), mediaType: "application/octet-stream", executable: false },
        ],
      }],
    });
    expect(generated[0]?.target).toEqual(instructionTarget[adapter.id]);
    expect(generated[0]?.source).toEqual({ kind: "text", text: "First\n\nSecond\n\nOverlay\n" });
    expect(generated.slice(1).map(({ target }) => target.relativePath)).toEqual([
      "skills/portable-skill/SKILL.md",
      "skills/portable-skill/assets/data.bin",
    ]);
    expect(generated.slice(1).every(({ target }) => target.root === skillRoot[adapter.id])).toBe(true);
    for (const file of generated) expect(() => assertAllowedTarget(adapter, file.target, { allowReserved: true })).not.toThrow();
  });

  it("requires SKILL.md and detects native/generated collisions", async () => {
    await expect(adapter.renderSharedResources({
      instructions: [],
      instructionOverlay: "",
      skills: [{ name: "missing-root", files: [] }],
    })).rejects.toThrow("SKILL.md");
    const generated = await adapter.renderSharedResources({
      instructions: [{ slug: "one", markdown: "One" }],
      instructionOverlay: "",
      skills: [],
    });
    expect(() => assertNativeGeneratedTargetSeparation([generated[0]!.target], generated)).toThrow("collides");
  });

  it("reports syntax errors and warns on snapshot-unknown keys", async () => {
    const fixture = primaryConfig[adapter.id];
    const validFile: AdapterFile = {
      agentId: adapter.id,
      target: fixture.target,
      mediaType: "text/plain",
      format: fixture.format,
      text: fixture.valid,
      executable: false,
    };
    expect(await adapter.validate(validFile)).toContainEqual(expect.objectContaining({
      code: "UNKNOWN_SCHEMA_KEY",
      severity: "warning",
    }));
    expect(await adapter.validate({ ...validFile, text: fixture.invalid })).toContainEqual(expect.objectContaining({
      code: "FORMAT_SYNTAX_ERROR",
      severity: "error",
    }));
    expect(await adapter.validate({ ...validFile, text: typeInvalidConfig[adapter.id] })).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_VALIDATION_ERROR", severity: "error" }),
    );
    expect(ADAPTER_SCHEMA_SNAPSHOTS[adapter.id].version).toMatch(/^.+-2026-07-29$/);
  });
});

describe("cross-platform target safety", () => {
  it.each([
    "/absolute.json",
    "C:/absolute.json",
    "../escape.json",
    "rules//empty.md",
    "rules/NUL.txt",
    "rules/trailing. ",
    "rules/a:b.md",
    "rules/a?.json",
    "rules/a*.toml",
    "rules/a|b",
    "rules/a<b",
    'rules/a"b',
    "rules/control\u0001.txt",
    "rules\\backslash.md",
    "rules/zero\0byte.md",
  ])("rejects unsafe path %s", (path) => {
    expect(() => assertSafeRelativePath(path)).toThrow();
  });

  it("rejects case-folded logical collisions", () => {
    expect(() => assertNoLogicalTargetCollisions([
      { root: "claude-home", relativePath: "rules/Policy.md" },
      { root: "claude-home", relativePath: "rules/policy.md" },
    ])).toThrow("collides");
  });

  it("rejects different roots resolving to one local destination", () => {
    const codex = builtInAdapters.find(({ id }) => id === "codex")!;
    expect(() => assertNoResolvedTargetCollisions([
      { adapter: codex, target: { root: "codex-home", relativePath: "plugins/marketplace.json" } },
      { adapter: codex, target: { root: "agents-home", relativePath: "plugins/marketplace.json" } },
    ], {
      platform: "linux",
      homeDir: "/home/fox",
      rootOverrides: { "codex-home": "/same", "agents-home": "/same" },
    })).toThrow("same file");
  });
});
