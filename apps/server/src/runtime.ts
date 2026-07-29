import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import type { DatabaseContext } from "./db/database.js";

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127;
}

export function validatePublicUrl(value: string | undefined): string {
  if (!value) throw new Error("AGENT_CONFIG_HUB_PUBLIC_URL is required.");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AGENT_CONFIG_HUB_PUBLIC_URL cannot contain credentials, query, or fragment.");
  }
  if (url.pathname !== "/") throw new Error("AGENT_CONFIG_HUB_PUBLIC_URL must not contain a path.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("AGENT_CONFIG_HUB_PUBLIC_URL must use HTTPS unless it is loopback.");
  }
  return url.toString().replace(/\/$/, "");
}

function assertProxyAddress(value: string): void {
  const separator = value.lastIndexOf("/");
  const address = separator < 0 ? value : value.slice(0, separator);
  const family = isIP(address);
  if (family === 0) throw new Error(`Invalid trusted proxy IP or CIDR: ${value}`);
  if (separator >= 0) {
    const prefix = Number(value.slice(separator + 1));
    const maximum = family === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`Invalid trusted proxy CIDR prefix: ${value}`);
    }
  }
}

export function parseTrustedProxies(value: string | undefined): string[] | false {
  if (!value?.trim()) return false;
  const proxies = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (proxies.length === 0) return false;
  for (const proxy of proxies) assertProxyAddress(proxy);
  return proxies;
}

export async function verifyLocalDataVolume(dataDirectory: string, database: DatabaseContext): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const metadata = await stat(dataDirectory);
  if (!metadata.isDirectory()) throw new Error("AGENT_CONFIG_HUB_DATA_DIR is not a directory.");
  await access(dataDirectory, constants.R_OK | constants.W_OK);
  if (database.native.readonly) throw new Error("SQLite database was opened read-only.");
  const quickCheck = database.native.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${String(quickCheck)}`);
  database.native.exec("BEGIN IMMEDIATE; ROLLBACK;");

  const identity = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const source = join(dataDirectory, `.volume-probe-${identity}.tmp`);
  const destination = join(dataDirectory, `.volume-probe-${identity}.ready`);
  const handle = await open(source, "wx", 0o600);
  try {
    await handle.writeFile("agent-config-hub-volume-probe", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(source, destination);
    if (process.platform !== "win32") {
      const directory = await open(dataDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await rm(source, { force: true });
    await rm(destination, { force: true });
  }
}
