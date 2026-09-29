import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseManifestV1 } from "@agent-config-hub/protocol";

import { syncOmpExtras, type CommandRunner } from "./omp-extras.js";

const REPOSITORY_URL = "https://github.com/Lynricsy/HyperSkills.git";
const declaration = JSON.stringify({
  version: 1,
  plugins: ["@cortexkit/pi-magic-context@latest"],
  skillRepositories: [{ name: "hyperskills", url: REPOSITORY_URL }],
});

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

function manifest() {
  return ReleaseManifestV1.parse({
    protocolVersion: 1,
    releaseId: "release-1",
    releaseNumber: 1,
    configSet: { slug: "main", name: "Main" },
    enabledAgents: ["omp"],
    selection: "all-enabled",
    includedAgents: ["omp"],
    minCliVersion: "0.3.0",
    adapterRevisions: { "claude-code": 2, codex: 2, opencode: 2, pi: 2, omp: 6, grok: 2 },
    files: [{
      fileId: "extras",
      agentId: "omp",
      target: { root: "omp-home", relativePath: "agent-config-hub.json" },
      contentSha256: createHash("sha256").update(declaration).digest("hex"),
      size: Buffer.byteLength(declaration),
      executable: false,
      sensitive: false,
    }],
  });
}

const api = { releaseFile: async () => new Response(declaration) };

// 模拟 git：HEAD 在 fetch 之后变化，status 输出由用例决定。
function fakeRunner(options: { origin?: string; dirty?: boolean } = {}) {
  const calls: string[] = [];
  let head = "aaaaaaaaaaaa";
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("rev-parse")) return `${head}\n`;
    if (args.includes("get-url")) return `${options.origin ?? REPOSITORY_URL}\n`;
    if (args.includes("status")) return options.dirty ? " M skills/go/SKILL.md\n" : "";
    if (args.includes("reset")) head = "bbbbbbbbbbbb";
    return "";
  };
  return { calls, run };
}

async function ompHome(withClone: boolean): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), "agent-config-hub-extras-"));
  if (withClone) await mkdir(join(temporary, "skill-repositories", "hyperskills"), { recursive: true });
  return temporary;
}

describe("syncOmpExtras", () => {
  it("installs plugins and clones a missing skill repository", async () => {
    const home = await ompHome(false);
    const { calls, run } = fakeRunner();
    const actions = await syncOmpExtras({ api, manifest: manifest(), ompHome: home, dryRun: false, run });
    expect(calls[0]).toBe("omp plugin install @cortexkit/pi-magic-context@latest");
    expect(calls[1]).toBe(`git clone --quiet --depth 1 --branch main -- ${REPOSITORY_URL} ${join(home, "skill-repositories", "hyperskills")}`);
    expect(actions).toEqual([
      { kind: "plugin", name: "@cortexkit/pi-magic-context@latest", result: "installed" },
      { kind: "skills", name: "hyperskills", result: "cloned aaaaaaaaaaaa" },
    ]);
    expect((await stat(join(home, "skill-repositories"))).isDirectory()).toBe(true);
  });

  it("fast-forwards an existing clean clone to the latest ref", async () => {
    const { run } = fakeRunner();
    const actions = await syncOmpExtras({ api, manifest: manifest(), ompHome: await ompHome(true), dryRun: false, run });
    expect(actions[1]).toEqual({ kind: "skills", name: "hyperskills", result: "updated aaaaaaaaaaaa -> bbbbbbbbbbbb" });
  });

  it("refuses to overwrite local changes in a clone", async () => {
    const { calls, run } = fakeRunner({ dirty: true });
    await expect(syncOmpExtras({ api, manifest: manifest(), ompHome: await ompHome(true), dryRun: false, run }))
      .rejects.toThrow("has local changes");
    expect(calls.some((call) => call.includes(" reset "))).toBe(false);
  });

  it("refuses a clone that tracks a different origin", async () => {
    const { run } = fakeRunner({ origin: "https://example.com/other.git" });
    await expect(syncOmpExtras({ api, manifest: manifest(), ompHome: await ompHome(true), dryRun: false, run }))
      .rejects.toThrow("remove the directory to re-clone");
  });

  it("dry-run plans without installing or fetching", async () => {
    const home = await ompHome(false);
    const { calls, run } = fakeRunner();
    const actions = await syncOmpExtras({ api, manifest: manifest(), ompHome: home, dryRun: true, run });
    expect(calls).toEqual([]);
    expect(actions.map(({ result }) => result)).toEqual(["would install", `would clone ${REPOSITORY_URL} main`]);
    await expect(stat(join(home, "skill-repositories"))).rejects.toThrow();
  });
});
