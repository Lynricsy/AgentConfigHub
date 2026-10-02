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
import { applyRelease, clientContext, recoverInterruptedTransactions, type PullAction, type PullOptions, type PullResult } from "./pull/apply-release.js";
import { syncOmpExtras, type OmpExtrasAction } from "./pull/omp-extras.js";
import { loadStates } from "./state.js";
import {
  displayPath,
  formatBytes,
  formatTimestamp,
  info,
  isRich,
  paint,
  printHeading,
  printPanel,
  printRichLine,
  printTable,
  startSpinner,
  success,
  symbols,
  warning,
  withSpinner,
  type Cell,
  type Style,
} from "./ui.js";
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

const ACTION_STYLES: Record<PullAction["action"], { readonly symbol: string; readonly style: Style }> = {
  add: { symbol: "+", style: "success" },
  replace: { symbol: "~", style: "warning" },
  remove: { symbol: "-", style: "danger" },
  unchanged: { symbol: "=", style: "unchanged" },
};

const ACTION_SUMMARY: Record<PullAction["action"], string> = {
  add: "added",
  replace: "replaced",
  remove: "removed",
  unchanged: "unchanged",
};

type FileState = "clean" | "modified" | "missing" | "conflict";

const FILE_STATES: Record<FileState, { readonly symbol: string; readonly style: Style }> = {
  clean: { symbol: symbols.success, style: "success" },
  modified: { symbol: "✎", style: "warning" },
  missing: { symbol: symbols.failure, style: "danger" },
  conflict: { symbol: symbols.warning, style: "danger" },
};

function printPullResult(result: PullResult, profile: string): void {
  if (!isRich()) {
    // 纯文本格式与旧版逐字一致，供脚本解析。
    for (const action of result.actions) {
      const digest = action.sha256 ? ` sha256=${action.sha256}` : "";
      process.stdout.write(`${action.action.padEnd(9)} ${action.path} size=${action.size}${digest}${action.sensitive ? " sensitive" : ""}\n`);
    }
    process.stdout.write(`${result.dryRun ? "Dry run" : "Installed"} release ${result.releaseNumber}${result.backupId ? `; backup ${result.backupId}` : ""}.\n`);
    return;
  }
  printHeading(`Release #${result.releaseNumber}`, `${profile}${result.dryRun ? " · dry run, nothing written" : ""}`);
  printTable(result.actions.map((action): Cell[] => {
    const { symbol, style } = ACTION_STYLES[action.action];
    return [
      { text: `${symbol} ${action.action}`, style },
      displayPath(action.path),
      { text: action.action === "remove" ? "" : formatBytes(action.size), style: "number" },
      { text: action.sensitive ? "sensitive" : "", style: "sensitive" },
    ];
  }));
  const counts: Record<PullAction["action"], number> = { add: 0, replace: 0, remove: 0, unchanged: 0 };
  for (const { action } of result.actions) counts[action] += 1;
  const parts = (Object.keys(ACTION_SUMMARY) as PullAction["action"][])
    .filter((action) => counts[action] > 0)
    .map((action) => paint(ACTION_STYLES[action].style, `${counts[action]} ${ACTION_SUMMARY[action]}`));
  const summary = [
    `${result.dryRun ? "Dry run of" : "Installed"} release ${paint(["bold", "number"], `#${result.releaseNumber}`)}`,
    ...(parts.length > 0 ? [parts.join(", ")] : []),
    ...(result.backupId ? [`backup ${paint("accent", result.backupId)}`] : []),
  ].join(" · ");
  process.stdout.write("\n");
  if (result.dryRun) info(summary);
  else success(summary);
}

function printOmpExtras(extras: readonly OmpExtrasAction[]): void {
  if (!isRich()) {
    for (const { kind, name, result } of extras) process.stdout.write(`${kind.padEnd(9)} ${name} ${result}\n`);
    return;
  }
  if (extras.length === 0) return;
  printHeading("OMP extras");
  printTable(extras.map(({ kind, name, result }): Cell[] => [
    { text: kind, style: "accent" },
    { text: name, style: "bold" },
    { text: result, style: result.startsWith("would") ? "warning" : result.startsWith("unchanged") ? "unchanged" : "success" },
  ]));
}

async function login(args: Arguments, paths: LocalPaths): Promise<void> {
  const serverValue = args.option("--server");
  const deviceName = args.option("--name") ?? hostname();
  args.assertDone();
  if (!serverValue) throw new Error("login requires --server <url>.");
  const server = normalizeServerUrl(serverValue);
  const api = new ApiClient(server);
  const authorization = await api.createDeviceAuthorization(deviceName, CLI_VERSION);
  printPanel("Device authorization", [
    ["Open", authorization.verificationUri, ["accent", "underline"]],
    ["User code", authorization.userCode, ["bold", "number"]],
  ]);
  try { await openBrowser(authorization.verificationUri, { wait: false }); }
  catch { warning("Could not open a browser; use the verification URL on any device."); }
  const deadline = Date.now() + authorization.expiresIn * 1000;
  const spinner = startSpinner(() => {
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    return `Waiting for approval ${paint("number", `(${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left)`, process.stderr)}`;
  });
  try {
    while (Date.now() < deadline) {
      await sleep(authorization.interval * 1000);
      try {
        const token = await api.pollDeviceAuthorization(authorization.deviceCode);
        await updateLocalConfig((current) => ({ ...current, version: 1, server, token }), paths);
        spinner.stop();
        success(`Logged in as ${deviceName}.`);
        return;
      } catch (error) {
        if (error instanceof CliApiError && ["AUTHORIZATION_PENDING", "SLOW_DOWN"].includes(error.code)) continue;
        throw error;
      }
    }
  } finally {
    spinner.stop();
  }
  throw new Error("Device authorization expired before approval.");
}

async function listConfigSets(paths: LocalPaths, environment: NodeJS.ProcessEnv): Promise<void> {
  const config = await readLocalConfig(paths);
  const { server, token } = credentials(config, environment);
  const configSets = await withSpinner("Loading config sets", () => new ApiClient(server, token).configSets());
  if (configSets.length === 0) {
    if (isRich()) info("No config sets are available to this token.");
    return;
  }
  printHeading("Config sets", `${configSets.length} available`);
  printTable(configSets.map((profile): Cell[] => [{ text: profile.slug, style: "accent" }, profile.name]), { header: ["Slug", "Name"] });
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
  const options: PullOptions = {
    api,
    paths,
    manifest: await withSpinner(`Fetching the latest ${profile} release`, () => api.manifest(profile, agents)),
    serverOrigin: new URL(server).origin,
    profile,
    requestedAgents: agents,
    persistentRootOverrides: config.rootOverrides,
    invocationRootOverrides,
    dryRun,
    replaceSymlink,
    forceRemoveModified,
  };
  const result = await withSpinner(dryRun ? "Planning changes" : "Installing files", () => applyRelease(options));
  printPullResult(result, profile);
  // 附加安装在配置文件落盘之后执行；失败时已安装的配置保持不变，命令以错误退出。
  const extras = await withSpinner("Syncing OMP plugins and skill repositories", () => syncOmpExtras({
    api,
    manifest: options.manifest,
    ompHome: getAdapter("omp").resolveRoot("omp-home", clientContext(options)),
    dryRun,
  }));
  printOmpExtras(extras);
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
    info("No local managed state exists for this profile.");
    return;
  }
  const rich = isRich();
  if (rich) printHeading("Status", `${profile} · ${serverOrigin}`);
  else process.stdout.write(`Server ${serverOrigin}\n`);
  const totals: Record<FileState, number> = { clean: 0, modified: 0, missing: 0, conflict: 0 };
  for (const state of states) {
    if (rich) {
      printRichLine(`${paint(["bold", "heading"], state.agentId)}/${paint("accent", state.rootId)}  ${paint("number", `release #${state.releaseNumber}`)} · ${paint("path", displayPath(state.resolvedRoot))}`);
    } else {
      process.stdout.write(`${state.agentId}/${state.rootId} release=${state.releaseNumber} root=${state.resolvedRoot}\n`);
    }
    const rows: Cell[][] = [];
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
      let fileState: FileState;
      let note = "";
      try {
        const target = await inspectTarget(state.resolvedRoot, destination, false);
        fileState = target.kind === "missing"
          ? "missing"
          : await sha256File(destination) === file.installedSha256 ? "clean" : "modified";
      } catch (error) {
        fileState = "conflict";
        note = error instanceof Error ? error.message : "unsafe target";
      }
      totals[fileState] += 1;
      if (rich) {
        const { symbol, style } = FILE_STATES[fileState];
        rows.push([
          { text: `${symbol} ${fileState}`, style },
          file.relativePath,
          { text: file.sensitive ? "sensitive" : "", style: "sensitive" },
          { text: note, style: "danger" },
        ]);
      } else {
        process.stdout.write(`  ${fileState} ${file.relativePath}${file.sensitive ? " sensitive" : ""}${note ? ` (${note})` : ""}\n`);
      }
    }
    if (rich) {
      printTable(rows, { indent: 4 });
      process.stdout.write("\n");
    }
  }
  if (!rich) return;
  const issues = (["modified", "missing", "conflict"] as const).filter((state) => totals[state] > 0);
  if (issues.length === 0) success(`All ${paint(["bold", "success"], String(totals.clean))} managed files match their installed release.`);
  else {
    warning([
      paint(FILE_STATES.clean.style, `${totals.clean} clean`),
      ...issues.map((state) => paint(FILE_STATES[state].style, `${totals[state]} ${state}`)),
    ].join(" · "));
  }
}

async function backups(args: Arguments, paths: LocalPaths): Promise<void> {
  const action = args.take("backups action");
  if (action === "list") {
    args.assertDone();
    const records = await listBackups(paths);
    if (records.length === 0) {
      if (isRich()) info("No local backups.");
      return;
    }
    printHeading("Backups", `${records.length} stored locally`);
    printTable(records.map((backup): Cell[] => [
      { text: backup.id, style: "accent" },
      backup.profile,
      { text: `#${backup.releaseNumber}`, plain: `release=${backup.releaseNumber}`, style: "number" },
      { text: formatTimestamp(backup.createdAt), plain: backup.createdAt, style: "path" },
    ]), { header: ["ID", "Profile", "Release", "Created"] });
    return;
  }
  const backupId = args.take("backup ID");
  args.assertDone();
  if (action === "restore") {
    const restored = await withSpinner(`Restoring backup ${backupId}`, () => restoreBackup(paths, backupId));
    success(`Restored backup ${restored.id}.`);
  } else if (action === "delete") {
    await deleteBackup(paths, backupId);
    success(`Deleted backup ${backupId}.`);
  } else throw new Error(`Unknown backups action: ${action}`);
}

async function roots(args: Arguments, paths: LocalPaths): Promise<void> {
  const action = args.take("roots action");
  if (action === "list") {
    args.assertDone();
    const config = await readLocalConfig(paths);
    printHeading("Target roots");
    printTable(TargetRootId.options.map((root): Cell[] => {
      const override = config.rootOverrides[root];
      return [
        { text: root, style: "accent" },
        override ? { text: displayPath(override), plain: override, style: "success" } : { text: "default", style: "unchanged" },
      ];
    }), { header: ["Root", "Path"] });
    return;
  }
  const root = TargetRootId.parse(args.take("root ID"));
  if (action === "set") {
    const path = args.take("absolute path");
    args.assertDone();
    assertAbsoluteRoot(root, path);
    await updateLocalConfig((current) => ({ ...current, rootOverrides: { ...current.rootOverrides, [root]: path } }), paths);
    success(`Set ${root} to ${path}.`);
  } else if (action === "reset") {
    args.assertDone();
    await updateLocalConfig((current) => {
      const rootOverrides = { ...current.rootOverrides };
      delete rootOverrides[root];
      return { ...current, rootOverrides };
    }, paths);
    success(`Reset ${root} to its adapter default.`);
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
    success("Logged out locally.");
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

const COMMANDS: readonly { readonly name: string; readonly args: readonly string[]; readonly summary: string }[] = [
  { name: "login", args: ["--server <url>", "[--name <device>]"], summary: "Approve this device in the browser and store a pull token" },
  { name: "logout", args: [], summary: "Remove the locally stored token" },
  { name: "config-sets", args: [], summary: "List config sets available to this token" },
  {
    name: "pull",
    args: ["--profile <slug>", "[--agent <id>...]", "[--dry-run]", "[--target-root <root>=<path>]", "[--replace-symlink]", "[--force-remove-modified]"],
    summary: "Install the latest release transactionally, with backups",
  },
  { name: "status", args: ["--profile <slug>"], summary: "Compare installed files with the recorded release" },
  { name: "backups", args: ["list", "| restore <id>", "| delete <id>"], summary: "List, restore, or delete local backups" },
  { name: "roots", args: ["list", "| set <root-id> <absolute-path>", "| reset <root-id>"], summary: "Show or override Agent target directories" },
];

const HELP_EXTRAS: readonly { readonly title: string; readonly entries: readonly (readonly [string, string])[] }[] = [
  { title: "Options", entries: [["-h, --help", "Show this help"], ["-v, --version", "Print the CLI version"]] },
  {
    title: "Environment",
    entries: [
      ["AGENT_CONFIG_HUB_SERVER", "Server URL; overrides the stored login"],
      ["AGENT_CONFIG_HUB_TOKEN", "Pull token; overrides the stored login"],
    ],
  },
];

export function usage(): string {
  // 伪终端可能报告 0 列，回退到 100 列；限制在 60–120 列之间保证可读。
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 120));
  const nameWidth = Math.max(...COMMANDS.map(({ name }) => name.length)) + 3;
  const lines = [
    "",
    `  ${paint("heading", symbols.brand)} ${paint(["bold", "accent"], "agent-config-hub")} ${paint("number", `v${CLI_VERSION}`)}`,
    "    Pull immutable AgentConfigHub releases with transactional backups and crash recovery.",
    "",
    `  ${paint(["bold", "heading"], "Usage")}`,
    `    agent-config-hub ${paint("accent", "<command>")} ${paint("success", "[options]")}`,
    "",
    `  ${paint(["bold", "heading"], "Commands")}`,
  ];
  const gutter = " ".repeat(4 + nameWidth);
  for (const command of COMMANDS) {
    // 参数按终端宽度折行，续行与首行参数左对齐；最短保留一个参数一行。
    const argLines: string[] = [];
    for (const arg of command.args) {
      const last = argLines.at(-1);
      if (last !== undefined && gutter.length + last.length + 1 + arg.length <= width) argLines[argLines.length - 1] = `${last} ${arg}`;
      else argLines.push(arg);
    }
    const [first, ...rest] = [...argLines.map((line) => paint("success", line)), command.summary];
    lines.push(`    ${paint(["bold", "accent"], command.name.padEnd(nameWidth))}${first}`, ...rest.map((line) => `${gutter}${line}`));
  }
  const keyWidth = Math.max(...HELP_EXTRAS.flatMap(({ entries }) => entries.map(([key]) => key.length))) + 3;
  for (const { title, entries } of HELP_EXTRAS) {
    lines.push("", `  ${paint(["bold", "heading"], title)}`, ...entries.map(([key, description]) => `    ${paint("accent", key.padEnd(keyWidth))}${description}`));
  }
  return `${lines.join("\n")}\n\n`;
}
