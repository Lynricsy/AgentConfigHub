import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

it("publishes a 256 MiB binary with a 64 MiB heap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-config-hub-large-publish-"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, [
    "--max-old-space-size=64",
    "--import",
    "tsx",
    "tests/large-binary-publish-worker.ts",
    directory,
    randomBytes(32).toString("base64"),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Large binary worker exited ${String(code)}:\n${output}`));
  });
  await expect(promise).resolves.toBeUndefined();
  await rm(directory, { force: true, recursive: true });
}, 120_000);
