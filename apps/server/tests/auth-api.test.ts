import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { buildServer } from "../src/index.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { AuthService } from "../src/services/auth-service.js";
import { ConfigSetService } from "../src/services/config-set-service.js";
import { CredentialService } from "../src/services/credential-service.js";
import { DeviceTokenService } from "../src/services/device-token-service.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";
import { PublishService } from "../src/services/publish-service.js";
import { ReleaseViewService } from "../src/services/release-view-service.js";
import { ResourceService } from "../src/services/resource-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { SecretSlotService } from "../src/services/secret-slot-service.js";

describe("authentication and pull API", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("enforces browser authentication and a one-time pairing exchange", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-auth-api-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobStore = new FileEncryptedBlobStore(database, masterKey, directory);
    const auth = new AuthService(database, { bootstrapToken: "setup-code", sleep: async () => {} });
    const publicUrl = "https://hub.example";
    const devices = new DeviceTokenService(database, publicUrl);
    const configSets = new ConfigSetService(database);
    const credentials = new CredentialService(database, masterKey);
    const resources = new ResourceService(database);
    const slots = new SecretSlotService(database);
    const publish = new PublishService(database, blobStore, new SecretBindingResolver(database, masterKey));
    const releases = new ReleaseViewService(database, blobStore);
    const server = buildServer({
      blobStore,
      api: {
        database,
        auth,
        devices,
        configSets,
        blobStore,
        publicUrl,
        admin: {
          database,
          configSets,
          credentials,
          resources,
          slots,
          publish,
          releases,
          verifyPassword: (password) => auth.verifyPassword(password),
        },
      },
    });

    const rejectedOrigin = await server.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setupCode: "setup-code", password: "correct-password" },
    });
    expect(rejectedOrigin.statusCode).toBe(403);
    expect(rejectedOrigin.json()).toMatchObject({ error: { code: "ORIGIN_INVALID" } });
    expect(rejectedOrigin.json().error.requestId).toEqual(expect.any(String));
    expect(rejectedOrigin.headers["cache-control"]).toBe("no-store");
    const invalidSetup = await server.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin: publicUrl },
      payload: {},
    });
    expect(invalidSetup.statusCode).toBe(400);
    expect(invalidSetup.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    expect((await server.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin: publicUrl },
      payload: { setupCode: "setup-code", password: "correct-password" },
    })).statusCode).toBe(204);
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/login",
      headers: { origin: publicUrl },
      payload: { password: "correct-password" },
    });
    expect(login.statusCode).toBe(204);
    const cookie = login.headers["set-cookie"] as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    const rejectedBlob = await server.inject({
      method: "PUT",
      url: "/api/v1/blobs",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("draft"),
    });
    expect(rejectedBlob.statusCode).toBe(403);
    const acceptedBlob = await server.inject({
      method: "PUT",
      url: "/api/v1/blobs",
      headers: { cookie, origin: publicUrl, "content-type": "application/octet-stream" },
      payload: Buffer.from("draft"),
    });
    expect(acceptedBlob.statusCode).toBe(201);
    const draftBlob = acceptedBlob.json<{ sha256: string }>();

    expect((await server.inject({
      method: "GET", url: "/api/v1/config-sets", headers: { authorization: "Bearer wrong-surface" },
    })).statusCode).toBe(401);

    const authorization = await server.inject({
      method: "POST",
      url: "/api/v1/device-authorizations",
      payload: { deviceName: "workstation", cliVersion: "0.1.0" },
    });
    expect(authorization.statusCode).toBe(201);
    const device = authorization.json<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
    }>();
    expect(device.verificationUri).toBe(`${publicUrl}/devices/approve?code=${device.userCode}`);

    const pending = await server.inject({
      method: "POST", url: "/api/v1/device-authorizations/token", payload: { deviceCode: device.deviceCode },
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({ error: { code: "AUTHORIZATION_PENDING" } });
    expect((await server.inject({
      method: "POST",
      url: "/api/v1/devices/approve",
      headers: { cookie, origin: publicUrl },
      payload: { userCode: device.userCode },
    })).statusCode).toBe(204);
    const exchange = await server.inject({
      method: "POST", url: "/api/v1/device-authorizations/token", payload: { deviceCode: device.deviceCode },
    });
    expect(exchange.statusCode).toBe(200);
    const deviceToken = exchange.json<{ token: string }>().token;
    expect(deviceToken).toMatch(/^agch_dev_/);
    expect((await server.inject({
      method: "POST", url: "/api/v1/device-authorizations/token", payload: { deviceCode: device.deviceCode },
    })).statusCode).toBe(410);

    const configSet = configSets.create({
      name: "Default",
      slug: "default",
      enabledAgents: ["claude-code"],
    });
    const configSetList = await server.inject({
      method: "GET", url: "/api/v1/config-sets", headers: { cookie },
    });
    expect(configSetList.json()).toMatchObject([{ enabledAgents: ["claude-code"] }]);
    const credentialResponse = await server.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: { cookie, origin: publicUrl },
      payload: { label: "Model key", provider: "Example", value: "top-secret-value" },
    });
    expect(credentialResponse.statusCode).toBe(201);
    const credential = credentialResponse.json<{ id: string }>();
    expect(credentialResponse.body).not.toContain("top-secret-value");
    expect((await server.inject({
      method: "POST",
      url: `/api/v1/credentials/${credential.id}/reveal`,
      headers: { cookie, origin: publicUrl },
      payload: { password: "wrong-password" },
    })).statusCode).toBe(401);
    const revealed = await server.inject({
      method: "POST",
      url: `/api/v1/credentials/${credential.id}/reveal`,
      headers: { cookie, origin: publicUrl },
      payload: { password: "correct-password" },
    });
    expect(revealed.json()).toEqual({ value: "top-secret-value" });
    expect(revealed.headers["cache-control"]).toBe("no-store");
    expect((await server.inject({
      method: "PUT",
      url: `/api/v1/config-sets/${configSet.id}/secret-slots/MODEL_API_KEY`,
      headers: { cookie, origin: publicUrl },
      payload: { credentialId: credential.id },
    })).statusCode).toBe(400);
    expect((await server.inject({
      method: "PUT",
      url: `/api/v1/config-sets/${configSet.id}/secret-slots/MODEL_API_KEY`,
      headers: { cookie, origin: publicUrl, "if-match": "\"1\"" },
      payload: { credentialId: credential.id },
    })).statusCode).toBe(200);
    expect((await server.inject({
      method: "PUT",
      url: `/api/v1/config-sets/${configSet.id}/files`,
      headers: { cookie, origin: publicUrl, "if-match": "\"2\"" },
      payload: {
        agentId: "claude-code",
        target: { root: "claude-home", relativePath: "settings.json" },
        blobSha256: draftBlob.sha256,
        mediaType: "application/octet-stream",
        utf8: false,
        executable: false,
      },
    })).statusCode).toBe(200);
    const detail = await server.inject({
      method: "GET", url: `/api/v1/config-sets/${configSet.id}`, headers: { cookie },
    });
    expect(detail.json()).toMatchObject({
      configSet: { enabledAgents: ["claude-code"], draftRevision: 3 },
      secretSlots: { slots: [{ name: "MODEL_API_KEY", defaultCredentialId: credential.id }] },
      files: [{ utf8: false, executable: false }],
    });
    expect(detail.headers.etag).toBe("\"3\"");
    const payload = Buffer.from("{\"model\":\"test\"}");
    const blob = await blobStore.put(Readable.from(payload), "application/json");
    const revisions = JSON.stringify({
      "claude-code": 1,
      codex: 1,
      opencode: 1,
      pi: 1,
      omp: 1,
      grok: 1,
    });
    database.native.prepare(`
      INSERT INTO releases (
        id, config_set_id, release_number, draft_revision, enabled_agents,
        min_cli_version, adapter_revisions, created_at
      ) VALUES ('release-1', ?, 1, 1, ?, '0.1.0', ?, ?)
    `).run(configSet.id, JSON.stringify(["claude-code"]), revisions, Date.now());
    database.native.prepare(`
      INSERT INTO release_files (
        id, release_id, agent_id, root_id, relative_path, blob_sha256, size, executable, sensitive
      ) VALUES ('file-1', 'release-1', 'claude-code', 'claude-home', 'settings.json', ?, ?, 0, 0)
    `).run(blob.sha256, blob.size);
    database.native.prepare("UPDATE config_sets SET current_release_id = 'release-1' WHERE id = ?")
      .run(configSet.id);
    const releaseList = await server.inject({
      method: "GET",
      url: `/api/v1/config-sets/${configSet.id}/releases`,
      headers: { cookie },
    });
    expect(releaseList.json()).toMatchObject([{
      enabledAgents: ["claude-code"],
      adapterRevisions: { "claude-code": 1, codex: 1, opencode: 1, pi: 1, omp: 1, grok: 1 },
    }]);

    const manifest = await server.inject({
      method: "GET",
      url: "/api/v1/cli/config-sets/default/releases/latest?agents=claude-code",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["cache-control"]).toBe("no-store");
    expect(manifest.json()).toMatchObject({
      releaseId: "release-1",
      selection: "subset",
      files: [{ fileId: "file-1", contentSha256: blob.sha256 }],
    });
    const download = await server.inject({
      method: "GET",
      url: "/api/v1/cli/releases/release-1/files/file-1",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(payload);
    expect(download.headers.etag).toBe(`"${blob.sha256}"`);
    expect(download.headers.digest).toBe(`sha-256=${Buffer.from(blob.sha256, "hex").toString("base64")}`);

    const automation = await server.inject({
      method: "POST",
      url: "/api/v1/tokens/automation",
      headers: { cookie, origin: publicUrl },
      payload: { label: "CI" },
    });
    expect(automation.statusCode).toBe(201);
    const automationToken = automation.json<{ id: string; token: string }>();
    expect(automationToken.token).toMatch(/^agch_auto_/);

    const deviceTokenId = devices.list().find((item) => {
      return typeof item === "object" && item !== null && "kind" in item && item.kind === "device";
    });
    expect(deviceTokenId).toBeDefined();
    if (!deviceTokenId || typeof deviceTokenId !== "object" || !( "id" in deviceTokenId)
      || typeof deviceTokenId.id !== "string") {
      throw new Error("Device token row is missing.");
    }
    expect((await server.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${deviceTokenId.id}`,
      headers: { cookie, origin: publicUrl },
    })).statusCode).toBe(204);
    expect((await server.inject({
      method: "GET",
      url: "/api/v1/cli/config-sets",
      headers: { authorization: `Bearer ${deviceToken}` },
    })).statusCode).toBe(401);

    const databaseBytes = await readFile(join(directory, "metadata.sqlite"));
    expect(databaseBytes.includes(Buffer.from(deviceToken))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(automationToken.token))).toBe(false);
    expect(databaseBytes.includes(Buffer.from("top-secret-value"))).toBe(false);
    await server.close();
    database.native.close();
  });
});
