import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  OMP_EXTRAS_PATH,
  OMP_SKILL_REPOSITORY_DIRECTORY,
  OmpExtrasV1,
  type ReleaseManifestV1,
  type SkillRepository,
} from "@agent-config-hub/protocol";

import type { ApiClient } from "../api-client.js";
import { readVerifiedResponse } from "../filesystem.js";

const execFileAsync = promisify(execFile);

// 返回 stdout；失败时抛出带 stderr 的错误。测试通过注入替身避免真实调用 omp/git。
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

export interface OmpExtrasAction {
  readonly kind: "plugin" | "skills";
  readonly name: string;
  readonly result: string;
}

export interface OmpExtrasOptions {
  readonly api: Pick<ApiClient, "releaseFile">;
  readonly manifest: ReleaseManifestV1;
  readonly ompHome: string;
  readonly dryRun: boolean;
  readonly run?: CommandRunner;
}

export const runCommand: CommandRunner = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      // 不经过 shell；禁止 git 在无人值守的 pull 中等待凭据输入。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") throw new Error(`${command} is not installed or not on PATH.`);
    throw new Error(`${command} ${args.join(" ")} failed: ${(failure.stderr || failure.message).trim()}`);
  }
};

async function syncRepository(
  repository: SkillRepository,
  directory: string,
  dryRun: boolean,
  run: CommandRunner,
): Promise<string> {
  const head = async () => (await run("git", ["-C", directory, "rev-parse", "--short=12", "HEAD"])).trim();
  let existing: Stats | null = null;
  try {
    existing = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existing) {
    if (dryRun) return `would clone ${repository.url} ${repository.ref}`;
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await run("git", ["clone", "--quiet", "--depth", "1", "--branch", repository.ref, "--", repository.url, directory]);
    return `cloned ${await head()}`;
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(`Skill repository path is not a directory: ${directory}`);
  }
  const origin = (await run("git", ["-C", directory, "remote", "get-url", "origin"])).trim();
  if (origin !== repository.url) {
    throw new Error(`${directory} tracks ${origin}, not ${repository.url}; remove the directory to re-clone it.`);
  }
  // 克隆目录归 CLI 所有，但本地改动可能是用户有意为之，发现改动时拒绝覆盖。
  if ((await run("git", ["-C", directory, "status", "--porcelain"])).trim()) {
    throw new Error(`${directory} has local changes; refusing to update it.`);
  }
  const before = await head();
  if (dryRun) return `would update from ${before} to latest ${repository.ref}`;
  await run("git", ["-C", directory, "fetch", "--quiet", "--depth", "1", "origin", repository.ref]);
  await run("git", ["-C", directory, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
  const after = await head();
  return before === after ? `unchanged ${after}` : `updated ${before} -> ${after}`;
}

// 按 Release 中的 agent-config-hub.json 安装 OMP 插件并同步技能仓库。
// 每次 pull 都执行，使插件规格中的 @latest 与仓库分支始终跟随上游最新版本。
export async function syncOmpExtras(options: OmpExtrasOptions): Promise<readonly OmpExtrasAction[]> {
  const file = options.manifest.files.find(({ agentId, target }) =>
    agentId === "omp" && target.root === "omp-home" && target.relativePath === OMP_EXTRAS_PATH);
  if (!file) return [];
  const bytes = await readVerifiedResponse(
    await options.api.releaseFile(options.manifest.releaseId, file.fileId),
    file.contentSha256,
    file.size,
  );
  const extras = OmpExtrasV1.parse(JSON.parse(bytes.toString("utf8")));
  const run = options.run ?? runCommand;
  const actions: OmpExtrasAction[] = [];
  for (const spec of extras.plugins) {
    if (!options.dryRun) await run("omp", ["plugin", "install", spec]);
    actions.push({ kind: "plugin", name: spec, result: options.dryRun ? "would install" : "installed" });
  }
  for (const repository of extras.skillRepositories) {
    const directory = join(options.ompHome, OMP_SKILL_REPOSITORY_DIRECTORY, repository.name);
    actions.push({ kind: "skills", name: repository.name, result: await syncRepository(repository, directory, options.dryRun, run) });
  }
  return actions;
}
