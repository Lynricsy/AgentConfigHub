import { spawnSync } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./commands.js";
import { ensurePrivateDirectory, localPaths, readLocalConfig, removePrivatePath, updateLocalConfig } from "./local-store.js";

let temporary: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (temporary) await removePrivatePath(temporary);
  temporary = undefined;
});

async function fixture() {
  temporary = await mkdtemp(join(tmpdir(), "agent-config-hub-settings-"));
  return localPaths({
    AGENT_CONFIG_HUB_CONFIG_DIR: join(temporary, "config"),
    AGENT_CONFIG_HUB_DATA_DIR: join(temporary, "data"),
  });
}

describe("local CLI settings", () => {
  it("stores token and root overrides with private operating-system permissions", async () => {
    const paths = await fixture();
    await updateLocalConfig(() => ({
      version: 1,
      server: "https://hub.example",
      token: "secret-device-token",
      rootOverrides: { "claude-home": join(temporary!, "claude") },
    }), paths);
    expect(await readLocalConfig(paths)).toMatchObject({ token: "secret-device-token" });
    if (process.platform !== "win32") {
      expect((await stat(paths.configDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    } else {
      const widened = spawnSync("icacls", [
        paths.configDirectory,
        "/grant",
        "*S-1-1-0:(OI)(CI)F",
      ], { encoding: "utf8", windowsHide: true });
      expect(widened.status, widened.stderr).toBe(0);
      await ensurePrivateDirectory(paths.configDirectory);
      const verification = String.raw`
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$other = @((Get-Acl -LiteralPath $env:AGCH_ACL_PATH).Access | Where-Object {
  $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $owner
})
if ($other.Count -ne 0) { exit 1 }
`;
      const verified = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(verification, "utf16le").toString("base64"),
      ], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGCH_ACL_PATH: paths.configDirectory },
      });
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
    }
  });

  it("implements persistent roots set/reset and local logout", async () => {
    const paths = await fixture();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = join(temporary!, "claude");
    await runCli(["roots", "set", "claude-home", root], {}, paths);
    expect((await readLocalConfig(paths)).rootOverrides["claude-home"]).toBe(root);
    await updateLocalConfig((current) => ({ ...current, server: "https://hub.example", token: "secret" }), paths);
    await runCli(["logout"], {}, paths);
    expect((await readLocalConfig(paths)).token).toBeUndefined();
    await runCli(["roots", "reset", "claude-home"], {}, paths);
    expect((await readLocalConfig(paths)).rootOverrides["claude-home"]).toBeUndefined();
  });

  it("rejects relative roots and backup path traversal", async () => {
    const paths = await fixture();
    await expect(runCli(["roots", "set", "claude-home", "relative"], {}, paths)).rejects.toThrow("absolute");
    await expect(runCli(["backups", "restore", "../../outside"], {}, paths)).rejects.toThrow("Backup ID is invalid");
  });
});
