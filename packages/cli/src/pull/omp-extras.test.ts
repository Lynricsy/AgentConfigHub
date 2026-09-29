import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseManifestV1, type SkillRepository } from "@agent-config-hub/protocol";

import { runCommand, syncOmpExtras, syncSkillRepository, type CommandRunner } from "./omp-extras.js";

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

async function scratch(): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), "agent-config-hub-extras-"));
  return temporary;
}

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

describe("syncOmpExtras", () => {
  it("installs declared plugins with omp and clones missing repositories", async () => {
    const home = await scratch();
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return args.includes("rev-parse") ? "aaaaaaaaaaaa\n" : "";
    };
    const actions = await syncOmpExtras({ api, manifest: manifest(), ompHome: home, dryRun: false, run });
    expect(calls[0]).toBe("omp plugin install @cortexkit/pi-magic-context@latest");
    expect(calls[1]).toBe(`git clone --quiet --depth 1 --branch main -- ${REPOSITORY_URL} ${join(home, "skill-repositories", "hyperskills")}`);
    expect(actions).toEqual([
      { kind: "plugin", name: "@cortexkit/pi-magic-context@latest", result: "installed" },
      { kind: "skills", name: "hyperskills", result: "cloned aaaaaaaaaaaa" },
    ]);
  });

  it("dry-run plans without installing or fetching", async () => {
    const home = await scratch();
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return "";
    };
    const actions = await syncOmpExtras({ api, manifest: manifest(), ompHome: home, dryRun: true, run });
    expect(calls).toEqual([]);
    expect(actions.map(({ result }) => result)).toEqual(["would install", `would clone ${REPOSITORY_URL} main`]);
    await expect(stat(join(home, "skill-repositories"))).rejects.toThrow();
  });
});

// 以下用例使用真实 Git：上游是本地仓库，经 file:// 克隆使 --depth 生效，得到与生产一致的浅克隆。
describe("syncSkillRepository with real Git", () => {
  const git = async (directory: string, ...args: string[]) =>
    (await runCommand("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args])).trim();

  async function commit(directory: string, file: string, content: string): Promise<string> {
    await writeFile(join(directory, file), content);
    await git(directory, "add", file);
    await git(directory, "commit", "--quiet", "-m", file);
    return await git(directory, "rev-parse", "HEAD");
  }

  async function setup(): Promise<{ upstream: string; clone: string; repository: SkillRepository }> {
    const root = await scratch();
    const upstream = join(root, "upstream");
    await runCommand("git", ["init", "--quiet", "--initial-branch=main", upstream]);
    await commit(upstream, "a.md", "a");
    await commit(upstream, "b.md", "b");
    const repository = { name: "skills", url: pathToFileURL(upstream).href, ref: "main" };
    const clone = join(root, "home", "skill-repositories", "skills");
    expect(await syncSkillRepository(repository, clone, false, runCommand)).toMatch(/^cloned [0-9a-f]{12}$/);
    expect(await git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    return { upstream, clone, repository };
  }

  it("fast-forwards a shallow clone across several upstream commits", async () => {
    const { upstream, clone, repository } = await setup();
    await commit(upstream, "c.md", "c");
    const latest = await commit(upstream, "d.md", "d");
    expect(await syncSkillRepository(repository, clone, false, runCommand)).toMatch(/^updated [0-9a-f]{12} -> [0-9a-f]{12}$/);
    expect(await git(clone, "rev-parse", "HEAD")).toBe(latest);
    expect(await syncSkillRepository(repository, clone, false, runCommand)).toBe(`unchanged ${latest.slice(0, 12)}`);
  });

  it("refuses to discard committed local work even when the tree is clean", async () => {
    const { upstream, clone, repository } = await setup();
    const local = await commit(clone, "local.md", "mine");
    await commit(upstream, "c.md", "c");
    await expect(syncSkillRepository(repository, clone, false, runCommand)).rejects.toThrow("cannot be fast-forwarded");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(local);
  });

  it("refuses to fast-forward over rewritten upstream history", async () => {
    const { upstream, clone, repository } = await setup();
    const before = await git(clone, "rev-parse", "HEAD");
    await git(upstream, "reset", "--quiet", "--hard", "HEAD~1");
    await commit(upstream, "rewritten.md", "r");
    await expect(syncSkillRepository(repository, clone, false, runCommand)).rejects.toThrow("cannot be fast-forwarded");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses uncommitted changes and a foreign origin", async () => {
    const { clone, repository } = await setup();
    await writeFile(join(clone, "a.md"), "edited");
    await expect(syncSkillRepository(repository, clone, false, runCommand)).rejects.toThrow("has local changes");
    await git(clone, "checkout", "--quiet", "--", "a.md");
    await expect(syncSkillRepository({ ...repository, url: "https://example.com/other.git" }, clone, false, runCommand))
      .rejects.toThrow("remove the directory to re-clone");
  });
});
