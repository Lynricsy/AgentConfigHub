import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

import envPaths from "env-paths";
import { z } from "zod";

import { TargetRootId, type TargetRootId as TargetRoot } from "@agent-config-hub/protocol";

const LocalConfig = z.object({
  version: z.literal(1),
  server: z.string().optional(),
  token: z.string().optional(),
  rootOverrides: z.partialRecord(TargetRootId, z.string()).default({}),
}).strict();
export type LocalConfig = z.infer<typeof LocalConfig>;

export interface LocalPaths {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly configFile: string;
  readonly stateDirectory: string;
  readonly backupDirectory: string;
  readonly transactionDirectory: string;
}

export function localPaths(environment: NodeJS.ProcessEnv = process.env): LocalPaths {
  const defaults = envPaths("agent-config-hub", { suffix: "" });
  const configDirectory = environment.AGENT_CONFIG_HUB_CONFIG_DIR ?? defaults.config;
  const dataDirectory = environment.AGENT_CONFIG_HUB_DATA_DIR ?? defaults.data;
  return {
    configDirectory,
    dataDirectory,
    configFile: join(configDirectory, "config.json"),
    stateDirectory: join(dataDirectory, "state"),
    backupDirectory: join(dataDirectory, "backups"),
    transactionDirectory: join(dataDirectory, "transactions"),
  };
}

async function assertNotLink(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Refusing private storage through symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function tightenWindowsAcl(path: string, directory: boolean): void {
  const script = String.raw`
$ErrorActionPreference = "Stop"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$security = if ($env:AGCH_ACL_DIRECTORY -eq "1") {
  New-Object System.Security.AccessControl.DirectorySecurity
} else {
  New-Object System.Security.AccessControl.FileSecurity
}
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
if ($env:AGCH_ACL_DIRECTORY -eq "1") {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$security.AddAccessRule($rule)
Set-Acl -LiteralPath $env:AGCH_ACL_PATH -AclObject $security
$access = @((Get-Acl -LiteralPath $env:AGCH_ACL_PATH).Access)
if ($access.Count -ne 1) { throw "ACL contains an unexpected principal." }
$actualSid = $access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
if ($actualSid.Value -ne $sid.Value -or
    $access[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    (($access[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
      [System.Security.AccessControl.FileSystemRights]::FullControl)) {
  throw "ACL verification failed."
}
`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AGCH_ACL_PATH: path,
    AGCH_ACL_DIRECTORY: directory ? "1" : "0",
  };
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === "psmodulepath") delete environment[name];
  }
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      encoding: "utf8",
      windowsHide: true,
      env: environment,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Could not restrict local CLI storage ACL: ${(result.stderr || result.stdout).trim()}`);
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await assertNotLink(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") tightenWindowsAcl(path, true);
  else await chmod(path, 0o700);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = join(path, "..");
  await ensurePrivateDirectory(directory);
  await assertNotLink(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
  if (process.platform !== "win32") {
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  }
}

export async function readLocalConfig(paths: LocalPaths = localPaths()): Promise<LocalConfig> {
  try {
    return LocalConfig.parse(JSON.parse(await readFile(paths.configFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rootOverrides: {} };
    throw error;
  }
}

export async function updateLocalConfig(
  update: (current: LocalConfig) => LocalConfig,
  paths: LocalPaths = localPaths(),
): Promise<LocalConfig> {
  const next = LocalConfig.parse(update(await readLocalConfig(paths)));
  await writePrivateJson(paths.configFile, next);
  return next;
}

export async function deleteStoredToken(paths: LocalPaths = localPaths()): Promise<void> {
  const current = await readLocalConfig(paths);
  await writePrivateJson(paths.configFile, { ...current, token: undefined });
}

export function assertAbsoluteRoot(root: TargetRoot, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${root} must be set to an absolute path.`);
}

export async function removePrivatePath(path: string): Promise<void> {
  await assertNotLink(path);
  await rm(path, { force: true, recursive: true });
}
