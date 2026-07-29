import { describe, expect, it } from "vitest";

import { ReleaseManifestV1 } from "./release.js";

const manifest = {
  protocolVersion: 1,
  releaseId: "01K123",
  releaseNumber: 1,
  configSet: { slug: "work", name: "Work" },
  enabledAgents: ["claude-code"],
  selection: "all-enabled",
  includedAgents: ["claude-code"],
  minCliVersion: "0.1.0",
  adapterRevisions: {
    "claude-code": 1,
    codex: 1,
    opencode: 1,
    pi: 1,
    omp: 1,
    grok: 1,
  },
  files: [{
    fileId: "01K124",
    agentId: "claude-code",
    target: { root: "claude-home", relativePath: "settings.json" },
    contentSha256: "a".repeat(64),
    size: 2,
    executable: false,
    sensitive: false,
  }],
} as const;

describe("ReleaseManifestV1", () => {
  it("accepts logical targets without absolute client paths", () => {
    expect(ReleaseManifestV1.parse(manifest)).toEqual(manifest);
  });

  it("rejects incompatible protocol versions and malformed hashes", () => {
    expect(ReleaseManifestV1.safeParse({ ...manifest, protocolVersion: 2 }).success).toBe(false);
    expect(ReleaseManifestV1.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], contentSha256: "/client/secret" }],
    }).success).toBe(false);
  });
});
