#!/usr/bin/env node

import { CliApiError } from "./api-client.js";
import { runCli, usage } from "./commands.js";
import { failure } from "./ui.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  try {
    await runCli(argv);
  } catch (error) {
    if (error instanceof CliApiError) {
      failure(`${error.code}: ${error.message}${error.requestId ? ` (${error.requestId})` : ""}`);
    } else {
      failure(error instanceof Error ? error.message : "CLI operation failed.");
    }
    process.exitCode = 1;
  }
}

void main();
