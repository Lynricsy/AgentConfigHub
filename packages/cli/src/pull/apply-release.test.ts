import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseManifestV1, type ReleaseFileV1 } from "@agent-config-hub/protocol";

import type { ApiClient } from "../api-client.js";
import { backupBytesPath, listBackups, restoreBackup, saveBackupRecord } from "../backups.js";
import { copyFileDurable } from "../filesystem.js";
import { ensurePrivateDirectory, localPaths, removePrivatePath, writePrivateJson } from "../local-store.js";
import { loadStates } from "../state.js";
import { applyRelease, recoverInterruptedTransactions, type PullOptions } from "./apply-release.js";

let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await removePrivatePath(temporary);
  temporary = undefined;
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function releaseFile(id: string, relativePath: string, content: string, executable = false): ReleaseFileV1 {
  return {
    fileId: id,
    agentId: "claude-code",
    target: { root: "claude-home", relativePath },
    contentSha256: digest(content),
    size: Buffer.byteLength(content),
    executable,
    sensitive: relativePath === "settings.json",
  };
}

function manifest(releaseNumber: number, files: ReleaseFileV1[]) {
  return ReleaseManifestV1.parse({
    protocolVersion: 1,
    releaseId: `release-${releaseNumber}`,
    releaseNumber,
    configSet: { slug: "workstation", name: "Workstation" },
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
    files,
  });
}

function fakeApi(contents: Record<string, string>, calls: string[] = []): ApiClient {
  return {
    async releaseFile(_releaseId: string, fileId: string) {
      calls.push(fileId);
      const content = contents[fileId];
      if (content === undefined) throw new Error(`No fixture for ${fileId}`);
      return new Response(content);
    },
  } as unknown as ApiClient;
}

async function fixture() {
  temporary = await mkdtemp(join(tmpdir(), "agent-config-hub-cli-"));
  const root = join(temporary, "claude");
  await mkdir(root);
  const paths = localPaths({
    AGENT_CONFIG_HUB_CONFIG_DIR: join(temporary, "config"),
    AGENT_CONFIG_HUB_DATA_DIR: join(temporary, "data"),
  });
  return { root, paths };
}

function options(
  root: string,
  paths: ReturnType<typeof localPaths>,
  release: ReturnType<typeof manifest>,
  api: ApiClient,
  overrides: Partial<PullOptions> = {},
): PullOptions {
  return {
    api,
    paths,
    manifest: release,
    serverOrigin: "https://hub.example",
    profile: "workstation",
    requestedAgents: [],
    persistentRootOverrides: { "claude-home": root },
    invocationRootOverrides: {},
    dryRun: false,
    replaceSymlink: false,
    forceRemoveModified: false,
    ...overrides,
  };
}

describe("applyRelease", () => {
  it("streams each digest once, writes independent files, modes, state, and backup", async () => {
    const { root, paths } = await fixture();
    const content = "shared bytes";
    const files = [
      releaseFile("settings", "settings.json", content),
      releaseFile("rule", "rules/shared.md", content, true),
      releaseFile("rule-2", "rules/second.md", content),
    ];
    const calls: string[] = [];
    const result = await applyRelease(options(
      root,
      paths,
      manifest(1, files),
      fakeApi({ settings: content, rule: content, "rule-2": content }, calls),
    ));
    expect(calls).toEqual(["settings"]);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(content);
    expect(await readFile(join(root, "rules/shared.md"), "utf8")).toBe(content);
    expect(await readFile(join(root, "rules/second.md"), "utf8")).toBe(content);
    const left = await stat(join(root, "settings.json"));
    const right = await stat(join(root, "rules/shared.md"));
    if (process.platform !== "win32") {
      expect(left.mode & 0o777).toBe(0o600);
      expect(right.mode & 0o777).toBe(0o700);
      expect(left.ino).not.toBe(right.ino);
    }
    expect((await loadStates(paths))[0]?.files).toHaveLength(3);
    expect(result.backupId).toBeTruthy();
    expect(await listBackups(paths)).toHaveLength(1);
  });

  it("does not alter targets when a streamed digest is invalid", async () => {
    const { root, paths } = await fixture();
    const file = releaseFile("settings", "settings.json", "expected");
    await expect(applyRelease(options(root, paths, manifest(1, [file]), fakeApi({ settings: "corrupt" })))).rejects.toThrow("does not match manifest");
    await expect(lstat(join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadStates(paths)).toEqual([]);
  });

  it("rolls files and state back after mutation and state-write failures", async () => {
    const { root, paths } = await fixture();
    const destination = join(root, "settings.json");
    await writeFile(destination, "local-before");
    const file = releaseFile("settings", "settings.json", "server-after");
    await expect(applyRelease(options(root, paths, manifest(1, [file]), fakeApi({ settings: "server-after" }), { faultAfterMutation: 1 }))).rejects.toThrow("Injected failure");
    expect(await readFile(destination, "utf8")).toBe("local-before");
    expect(await loadStates(paths)).toEqual([]);
    if (process.platform !== "win32") {
      const backup = (await listBackups(paths))[0]!;
      const backupRelativePath = backup.operations[0]!.backupRelativePath!;
      expect((await stat(backupBytesPath(paths, backup.id, backupRelativePath))).mode & 0o777).toBe(0o600);
    }
    const nested = releaseFile("nested", "rules/nested.md", "nested");
    await expect(applyRelease(options(
      root,
      paths,
      manifest(1, [nested]),
      fakeApi({ nested: "nested" }),
      { faultAfterMutation: 1 },
    ))).rejects.toThrow("Injected failure");
    await expect(lstat(join(root, "rules"))).rejects.toMatchObject({ code: "ENOENT" });

    await applyRelease(options(root, paths, manifest(1, [file]), fakeApi({ settings: "server-after" })));
    await expect(applyRelease(options(root, paths, manifest(2, [file]), fakeApi({}), { faultAfterStateUpdate: 1 }))).rejects.toThrow("state update");
    expect((await loadStates(paths))[0]?.releaseNumber).toBe(1);
    expect(await readFile(destination, "utf8")).toBe("server-after");
  });

  it("protects modified removals unless forced and leaves files when state is lost", async () => {
    const { root, paths } = await fixture();
    const destination = join(root, "settings.json");
    const file = releaseFile("settings", "settings.json", "managed");
    await applyRelease(options(root, paths, manifest(1, [file]), fakeApi({ settings: "managed" })));
    await writeFile(destination, "locally modified");
    await expect(applyRelease(options(root, paths, manifest(2, []), fakeApi({})))).rejects.toThrow("locally modified");
    expect(await readFile(destination, "utf8")).toBe("locally modified");
    await applyRelease(options(root, paths, manifest(2, []), fakeApi({}), { forceRemoveModified: true }));
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(destination, "unknown old managed bytes");
    await removePrivatePath(paths.stateDirectory);
    await applyRelease(options(root, paths, manifest(3, []), fakeApi({})));
    expect(await readFile(destination, "utf8")).toBe("unknown old managed bytes");
  });

  it("rejects ancestor links and only replaces a target link explicitly", async () => {
    const { root, paths } = await fixture();
    const outside = join(temporary!, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "rules"), process.platform === "win32" ? "junction" : "dir");
    const nested = releaseFile("rule", "rules/test.md", "rule");
    await expect(applyRelease(options(root, paths, manifest(1, [nested]), fakeApi({ rule: "rule" })))).rejects.toThrow("ancestor");
    await rm(join(root, "rules"));

    const outsideFile = join(outside, "settings.json");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, join(root, "settings.json"));
    const settings = releaseFile("settings", "settings.json", "managed");
    await expect(applyRelease(options(root, paths, manifest(1, [settings]), fakeApi({ settings: "managed" })))).rejects.toThrow("symbolic link");
    const result = await applyRelease(options(root, paths, manifest(1, [settings]), fakeApi({ settings: "managed" }), { replaceSymlink: true }));
    expect((await lstat(join(root, "settings.json"))).isFile()).toBe(true);
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
    await restoreBackup(paths, result.backupId!);
    expect((await lstat(join(root, "settings.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "settings.json"))).toBe(outsideFile);
  });

  it("partitions changed roots without deleting the old root and keeps dry-run inert", async () => {
    const { root, paths } = await fixture();
    const secondRoot = join(temporary!, "missing-parent", "claude-second");
    const file = releaseFile("settings", "settings.json", "managed");
    await applyRelease(options(root, paths, manifest(1, [file]), fakeApi({ settings: "managed" })));
    const dryCalls: string[] = [];
    const preview = await applyRelease(options(secondRoot, paths, manifest(2, [file]), fakeApi({ settings: "managed" }, dryCalls), { dryRun: true }));
    expect(preview.actions[0]?.action).toBe("add");
    expect(dryCalls).toEqual([]);
    await applyRelease(options(secondRoot, paths, manifest(2, [file]), fakeApi({ settings: "managed" })));
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("managed");
    expect(await readFile(join(secondRoot, "settings.json"), "utf8")).toBe("managed");
    expect(await loadStates(paths)).toHaveLength(2);
  });
  it("rejects an all-enabled manifest that omits an enabled Agent", async () => {
    const { root, paths } = await fixture();
    const incomplete = ReleaseManifestV1.parse({
      ...manifest(1, []),
      enabledAgents: ["claude-code", "codex"],
      includedAgents: ["claude-code"],
    });
    await expect(applyRelease(options(
      root,
      paths,
      incomplete,
      fakeApi({}),
    ))).rejects.toThrow("All-enabled manifest");
  });
  it("recovers changed files and removes journaled staging after a hard interruption", async () => {
    const { root, paths } = await fixture();
    const transactionId = "abcdef0123456789abcdef01";
    const backupId = "20260729123456789-abcdefabcdef";
    const destination = join(root, "settings.json");
    await writeFile(destination, "before crash");
    const backupRelativePath = "files/0";
    await copyFileDurable(
      destination,
      backupBytesPath(paths, backupId, backupRelativePath),
      0o600,
    );
    await saveBackupRecord(paths, {
      version: 1,
      id: backupId,
      createdAt: new Date().toISOString(),
      serverOrigin: "https://hub.example",
      profile: "workstation",
      releaseId: "release-crash",
      releaseNumber: 2,
      operations: [{
        root,
        destination,
        prior: { kind: "file", mode: 0o600 },
        backupRelativePath,
      }],
      stateSnapshots: [],
    });
    await writeFile(destination, "after crash");
    const stage = join(root, `.agent-config-hub-stage-${transactionId}`);
    const temporaryFile = join(root, `.agent-config-hub-${transactionId}-deadbeef.tmp`);
    const createdDirectory = join(root, "empty-created");
    await mkdir(stage);
    await writeFile(join(stage, "partial"), "sensitive staged bytes");
    await writeFile(temporaryFile, "sensitive temporary bytes");
    await mkdir(createdDirectory);
    await ensurePrivateDirectory(paths.transactionDirectory);
    const journalPath = join(paths.transactionDirectory, `${transactionId}.json`);
    await writePrivateJson(journalPath, {
      version: 1,
      transactionId,
      backupId,
      backupReady: true,
      started: 1,
      roots: [root],
      stageDirectories: [stage],
      temporaryFiles: [temporaryFile],
      createdDirectories: [createdDirectory],
    });

    await recoverInterruptedTransactions(paths);
    expect(await readFile(destination, "utf8")).toBe("before crash");
    for (const removed of [stage, temporaryFile, createdDirectory, journalPath]) {
      await expect(lstat(removed)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("handles a Windows case-only managed path change without deleting the replacement", async () => {
    if (process.platform !== "win32") return;
    const { root, paths } = await fixture();
    const before = releaseFile("before-case", "rules/Case.md", "before");
    await applyRelease(options(root, paths, manifest(1, [before]), fakeApi({ "before-case": "before" })));
    const after = releaseFile("after-case", "rules/case.md", "after");
    await applyRelease(options(root, paths, manifest(2, [after]), fakeApi({ "after-case": "after" })));
    expect(await readFile(join(root, "rules/case.md"), "utf8")).toBe("after");
    expect((await readdir(join(root, "rules"))).map((entry) => entry.toLocaleLowerCase("en-US"))).toEqual(["case.md"]);
  });
});
