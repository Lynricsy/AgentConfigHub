import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { Diagnostic } from "@agent-config-hub/protocol";

const require = createRequire(import.meta.url);
const taploCli = join(dirname(require.resolve("@taplo/cli/package.json")), "dist", "cli.js");

export async function lintToml(text: string): Promise<Diagnostic[]> {
  const { promise, resolve, reject } = Promise.withResolvers<Diagnostic[]>();
  const child = spawn(process.execPath, [
    taploCli,
    "lint",
    "--colors",
    "never",
    "--no-auto-config",
    "--no-schema",
    "-",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) {
      resolve([]);
      return;
    }
    const location = /:(\d+):(\d+)/.exec(output);
    resolve([{
      code: "FORMAT_SYNTAX_ERROR",
      severity: "error",
      message: "Invalid TOML syntax.",
      ...(location?.[1] && location[2] ? {
        range: {
          startLine: Number(location[1]),
          startColumn: Number(location[2]),
          endLine: Number(location[1]),
          endColumn: Number(location[2]) + 1,
        },
      } : {}),
    }]);
  });
  child.stdin.end(text);
  return await promise;
}
