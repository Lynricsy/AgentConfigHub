import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface MasterKey {
  readonly bytes: Buffer;
  readonly keyId: string;
}

function parseMasterKey(encoded: string, source: string): MasterKey {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) {
    throw new Error(`${source} must contain exactly one base64-encoded 32-byte key.`);
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== normalized) {
    throw new Error(`${source} must contain exactly one base64-encoded 32-byte key.`);
  }
  return {
    bytes,
    keyId: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  };
}

export async function loadMasterKey(environment: NodeJS.ProcessEnv = process.env): Promise<MasterKey> {
  const keyFile = environment.AGENT_CONFIG_HUB_MASTER_KEY_FILE;
  if (keyFile) return parseMasterKey(await readFile(keyFile, "utf8"), "AGENT_CONFIG_HUB_MASTER_KEY_FILE");
  const encoded = environment.AGENT_CONFIG_HUB_MASTER_KEY;
  if (encoded) return parseMasterKey(encoded, "AGENT_CONFIG_HUB_MASTER_KEY");
  throw new Error("AGENT_CONFIG_HUB_MASTER_KEY_FILE or AGENT_CONFIG_HUB_MASTER_KEY is required.");
}
