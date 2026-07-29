#!/usr/bin/env node

import { CliApiError } from "./api-client.js";
import { runCli, usage } from "./commands.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    await runCli(argv);
  } catch (error) {
    if (error instanceof CliApiError) {
      process.stderr.write(`${error.code}: ${error.message}${error.requestId ? ` (${error.requestId})` : ""}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : "CLI operation failed."}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
