import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decryptBuffer, encryptBuffer } from "../src/security/envelope.js";
import { loadMasterKey } from "../src/security/master-key.js";

describe("master key envelope encryption", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("prefers a key file and rejects missing or malformed keys", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-key-"));
    const fileKey = randomBytes(32).toString("base64");
    const keyFile = join(directory, "master.key");
    await writeFile(keyFile, fileKey, { mode: 0o600 });
    const loaded = await loadMasterKey({
      AGENT_CONFIG_HUB_MASTER_KEY_FILE: keyFile,
      AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64"),
    });
    expect(loaded.bytes.toString("base64")).toBe(fileKey);
    await expect(loadMasterKey({})).rejects.toThrow("is required");
    await expect(loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: "short" })).rejects.toThrow("32-byte key");
  });

  it("authenticates both content and wrapped DEK metadata", async () => {
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const wrongKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const plaintext = Buffer.from("unique-envelope-sentinel");
    const sha256 = createHash("sha256").update(plaintext).digest("hex");
    const identity = { recordType: "credential", recordId: "record-1" } as const;
    const encrypted = encryptBuffer(plaintext, masterKey, identity, sha256);

    expect(decryptBuffer(
      encrypted.ciphertext,
      masterKey,
      identity,
      sha256,
      plaintext.length,
      encrypted.content,
      encrypted.wrapped,
    )).toEqual(plaintext);
    expect(() => decryptBuffer(
      encrypted.ciphertext,
      wrongKey,
      identity,
      sha256,
      plaintext.length,
      encrypted.content,
      encrypted.wrapped,
    )).toThrow();
  });
});
