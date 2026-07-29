import { hostname } from "node:os";

import openBrowser from "open";

import { getAdapter, resolveTargetPath, type ClientPathContext } from "@agent-config-hub/adapters";
import { AgentId, TargetRootId, type AgentId as Agent, type TargetRootId as Root } from "@agent-config-hub/protocol";

import { ApiClient, CliApiError, normalizeServerUrl } from "./api-client.js";
import {
  deleteBackup,
  listBackups,
  recoverInterruptedBackupRestores,
  restoreBackup,
} from "./backups.js";
import { inspectTarget, sha256File } from "./filesystem.js";
import {
  assertAbsoluteRoot,
  deleteStoredToken,
  localPaths,
  readLocalConfig,
  updateLocalConfig,
  type LocalPaths,
} from "./local-store.js";
import { applyRelease, recoverInterruptedTransactions, type PullAction } from "./pull/apply-release.js";
import { loadStates } from "./state.js";
import { CLI_VERSION } from "./version.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class Arguments {
  readonly #values: string[];

  constructor(values: readonly string[]) { this.#values = [...values]; }
  get done(): boolean { return this.#values.length === 0; }
  take(label = "argument"): string {
    const value = this.#values.shift();
    if (value === undefined) throw new Error(`Missing ${label}.`);
    return value;
  }
  option(name: string): string | undefined {
    const index = this.#values.indexOf(name);
    if (index < 0) return undefined;
    const value = this.#values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    this.#values.splice(index, 2);
    return value;
  }
  options(name: string): string[] {
    const values: string[] = [];
    while (true) {
      const value = this.option(name);
      if (value === undefined) return values;
      values.push(value);
    }
  }
  flag(name: string): boolean {
    const index = this.#values.indexOf(name);
    if (index < 0) return false;
    this.#values.splice(index, 1);
    return true;
  }
  assertDone(): void {
    if (!this.done) throw new Error(`Unexpected argument: ${this.#values[0]}`);
  }
}

function credentials(config: Awaited<ReturnType<typeof readLocalConfig>>, environment: NodeJS.ProcessEnv) {
  const server = environment.AGENT_CONFIG_HUB_SERVER ?? config.server;
  const token = environment.AGENT_CONFIG_HUB_TOKEN ?? config.token;
  if (!server) throw new Error("No server is configured. Run login --server <url> first.");
  if (!token) throw new Error("No pull token is configured. Run login first.");
  return { server: normalizeServerUrl(server), token };
}

function parseRootOverrides(values: readonly string[]): Partial<Record<Root, string>> {
  const overrides: Partial<Record<Root, string>> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`Root override must be <root-id>=<absolute-path>: ${value}`);
    const root = TargetRootId.parse(value.slice(0, separator));
    const path = value.slice(separator + 1);
    assertAbsoluteRoot(root, path);
    if (overrides[root]) throw new Error(`Root ${root} was overridden more than once.`);
    overrides[root] = path;
  }
  return overrides;
}

function printAction(action: PullAction): void {
  const digest = action.sha256 ? ` sha256=${action.sha256}` : "";
  process.stdout.write(`${action.action.padEnd(9)} ${action.path} size=${action.size}${digest}${action.sensitive ? " sensitive" : ""}\n`);
}

async function login(args: Arguments, paths: LocalPaths): Promise<void> {
  const serverValue = args.option("--server");
  const deviceName = args.option("--name") ?? hostname();
  args.assertDone();
  if (!serverValue) throw new Error("login requires --server <url>.");
  const server = normalizeServerUrl(serverValue);
  const api = new ApiClient(server);
  const authorization = await api.createDeviceAuthorization(deviceName, CLI_VERSION);
  process.stdout.write(`Open ${authorization.verificationUri}\nUser code: ${authorization.userCode}\n`);
  try { await openBrowser(authorization.verificationUri, { wait: false }); }
  catch { process.stdout.write("Could not open a browser; use the verification URL on any device.\n"); }
  const deadline = Date.now() + authorization.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(authorization.interval * 1000);
    try {
      const token = await api.pollDeviceAuthorization(authorization.deviceCode);
      await updateLocalConfig((current) => ({ ...current, version: 1, server, token }), paths);
      process.stdout.write(`Logged in as ${deviceName}.\n`);
      return;
    } catch (error) {
      if (error instanceof CliApiError && ["AUTHORIZATION_PENDING", "SLOW_DOWN"].includes(error.code)) continue;
      throw error;
    }
  }
  throw new Error("Device authorization expired before approval.");
}

async function listConfigSets(paths: LocalPaths, environment: NodeJS.ProcessEnv): Promise<void> {
  const config = await readLocalConfig(paths);
  const { server, token } = credentials(config, environment);
  for (const profile of await new ApiClient(server, token).configSets()) process.stdout.write(`${profile.slug}\t${profile.name}\n`);
}

async function pull(args: Arguments, paths: LocalPaths, environment: NodeJS.ProcessEnv): Promise<void> {
  const profile = args.option("--profile");
  const agents = args.options("--agent").map((agent) => AgentId.parse(agent));
  const invocationRootOverrides = parseRootOverrides(args.options("--target-root"));
  const dryRun = args.flag("--dry-run");
  const replaceSymlink = args.flag("--replace-symlink");
  const forceRemoveModified = args.flag("--force-remove-modified");
  args.assertDone();
  if (!profile) throw new Error("pull requires --profile <slug>.");
  if (new Set(agents).size !== agents.length) throw new Error("An Agent filter was repeated.");
  const config = await readLocalConfig(paths);
  const { server, token } = credentials(config, environment);
  const api = new ApiClient(server, token);
  const result = await applyRelease({
    api,
    paths,
    manifest: await api.manifest(profile, agents),
    serverOrigin: new URL(server).origin,
    profile,
    requestedAgents: agents,
    persistentRootOverrides: config.rootOverrides,
    invocationRootOverrides,
    dryRun,
    replaceSymlink,
    forceRemoveModified,
  });
  for (const action of result.actions) printAction(action);
  process.stdout.write(`${dryRun ? "Dry run" : "Installed"} release ${result.releaseNumber}${result.backupId ? `; backup ${result.backupId}` : ""}.\n`);
}

async function status(args: Arguments, paths: LocalPaths, environment: NodeJS.ProcessEnv): Promise<void> {
  const profile = args.option("--profile");
  args.assertDone();
  if (!profile) throw new Error("status requires --profile <slug>.");
  const config = await readLocalConfig(paths);
  const server = environment.AGENT_CONFIG_HUB_SERVER ?? config.server;
  if (!server) throw new Error("No server is configured. Run login --server <url> first.");
  const serverOrigin = new URL(normalizeServerUrl(server)).origin;
  const platform = process.platform;
  if (!(platform === "linux" || platform === "darwin" || platform === "win32")) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const states = (await loadStates(paths)).filter((state) => state.profile === profile && state.serverOrigin === serverOrigin);
  if (states.length === 0) {
    process.stdout.write("No local managed state exists for this profile.\n");
    return;
  }
  process.stdout.write(`Server ${serverOrigin}\n`);
  for (const state of states) {
    process.stdout.write(`${state.agentId}/${state.rootId} release=${state.releaseNumber} root=${state.resolvedRoot}\n`);
    for (const file of state.files) {
      const adapter = getAdapter(state.agentId);
      const pathContext: ClientPathContext = {
        platform,
        homeDir: state.resolvedRoot,
        rootOverrides: { [state.rootId]: state.resolvedRoot },
      };
      const destination = resolveTargetPath(
        adapter,
        { root: state.rootId, relativePath: file.relativePath },
        pathContext,
      );
      try {
        const target = await inspectTarget(state.resolvedRoot, destination, false);
        if (target.kind === "missing") {
          process.stdout.write(`  missing ${file.relativePath}${file.sensitive ? " sensitive" : ""}\n`);
          continue;
        }
        const digest = await sha256File(destination);
        process.stdout.write(`  ${digest === file.installedSha256 ? "clean" : "modified"} ${file.relativePath}${file.sensitive ? " sensitive" : ""}\n`);
      } catch (error) {
        process.stdout.write(`  conflict ${file.relativePath}${file.sensitive ? " sensitive" : ""} (${error instanceof Error ? error.message : "unsafe target"})\n`);
      }
    }
  }
}

async function backups(args: Arguments, paths: LocalPaths): Promise<void> {
  const action = args.take("backups action");
  if (action === "list") {
    args.assertDone();
    for (const backup of await listBackups(paths)) process.stdout.write(`${backup.id}\t${backup.profile}\trelease=${backup.releaseNumber}\t${backup.createdAt}\n`);
    return;
  }
  const backupId = args.take("backup ID");
  args.assertDone();
  if (action === "restore") {
    const restored = await restoreBackup(paths, backupId);
    process.stdout.write(`Restored backup ${restored.id}.\n`);
  } else if (action === "delete") {
    await deleteBackup(paths, backupId);
    process.stdout.write(`Deleted backup ${backupId}.\n`);
  } else throw new Error(`Unknown backups action: ${action}`);
}

async function roots(args: Arguments, paths: LocalPaths): Promise<void> {
  const action = args.take("roots action");
  if (action === "list") {
    args.assertDone();
    const config = await readLocalConfig(paths);
    for (const root of TargetRootId.options) process.stdout.write(`${root}\t${config.rootOverrides[root] ?? "default"}\n`);
    return;
  }
  const root = TargetRootId.parse(args.take("root ID"));
  if (action === "set") {
    const path = args.take("absolute path");
    args.assertDone();
    assertAbsoluteRoot(root, path);
    await updateLocalConfig((current) => ({ ...current, rootOverrides: { ...current.rootOverrides, [root]: path } }), paths);
    process.stdout.write(`Set ${root} to ${path}.\n`);
  } else if (action === "reset") {
    args.assertDone();
    await updateLocalConfig((current) => {
      const rootOverrides = { ...current.rootOverrides };
      delete rootOverrides[root];
      return { ...current, rootOverrides };
    }, paths);
    process.stdout.write(`Reset ${root} to its adapter default.\n`);
  } else throw new Error(`Unknown roots action: ${action}`);
}

export async function runCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  paths: LocalPaths = localPaths(environment),
): Promise<void> {
  await recoverInterruptedBackupRestores(paths);
  await recoverInterruptedTransactions(paths);
  const args = new Arguments(argv);
  const command = args.take("command");
  if (command === "login") await login(args, paths);
  else if (command === "logout") {
    args.assertDone();
    await deleteStoredToken(paths);
    process.stdout.write("Logged out locally.\n");
  } else if (command === "config-sets") {
    args.assertDone();
    await listConfigSets(paths, environment);
  } else if (command === "pull") await pull(args, paths, environment);
  else if (command === "status") await status(args, paths, environment);
  else if (command === "backups") await backups(args, paths);
  else if (command === "roots") await roots(args, paths);
  else if (command === "--version" || command === "-v") {
    args.assertDone();
    process.stdout.write(`${CLI_VERSION}\n`);
  } else throw new Error(`Unknown command: ${command}`);
}

export function usage(): string {
  return [
    "agent-config-hub login --server <url> [--name <device>]",
    "agent-config-hub logout",
    "agent-config-hub config-sets",
    "agent-config-hub pull --profile <slug> [--agent <id>...] [--dry-run] [--target-root <root>=<path>] [--replace-symlink] [--force-remove-modified]",
    "agent-config-hub status --profile <slug>",
    "agent-config-hub backups list|restore <id>|delete <id>",
    "agent-config-hub roots list|set <root-id> <absolute-path>|reset <root-id>",
  ].join("\n");
}
