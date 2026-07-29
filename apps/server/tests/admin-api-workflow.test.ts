import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { buildServer } from "../src/index.js";
import { loadMasterKey } from "../src/security/master-key.js";
import { AuthService } from "../src/services/auth-service.js";
import { BlobGcService } from "../src/services/blob-gc-service.js";
import { ConfigSetService } from "../src/services/config-set-service.js";
import { CredentialService } from "../src/services/credential-service.js";
import { DeviceTokenService } from "../src/services/device-token-service.js";
import { PublishService } from "../src/services/publish-service.js";
import { ReleaseViewService } from "../src/services/release-view-service.js";
import { ResourceService } from "../src/services/resource-service.js";
import { SecretBindingResolver } from "../src/services/secret-binding-resolver.js";
import { SecretSlotService } from "../src/services/secret-slot-service.js";
import { FileEncryptedBlobStore } from "../src/storage/encrypted-blob-store.js";

describe("management API workflow", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  it("covers revisioned config, resource, credential, and release mutations", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-config-hub-admin-api-"));
    const database = openDatabase(directory);
    migrateDatabase(database);
    const masterKey = await loadMasterKey({ AGENT_CONFIG_HUB_MASTER_KEY: randomBytes(32).toString("base64") });
    const blobStore = new FileEncryptedBlobStore(database, masterKey, directory);
    const auth = new AuthService(database, { bootstrapToken: "setup-code", sleep: async () => {} });
    const publicUrl = "https://hub.example";
    const configSets = new ConfigSetService(database);
    const credentials = new CredentialService(database, masterKey);
    const resources = new ResourceService(database);
    const slots = new SecretSlotService(database);
    const publish = new PublishService(database, blobStore, new SecretBindingResolver(database, masterKey));
    const releases = new ReleaseViewService(database, blobStore);
    const gc = new BlobGcService(database, blobStore);
    const server = buildServer({
      blobStore,
      api: {
        database,
        auth,
        devices: new DeviceTokenService(database, publicUrl),
        configSets,
        blobStore,
        publicUrl,
        admin: {
          database, configSets, credentials, resources, slots, publish, releases, gc,
          verifyPassword: (password) => auth.verifyPassword(password),
        },
      },
    });
    await server.inject({
      method: "POST", url: "/api/v1/setup", headers: { origin: publicUrl },
      payload: { setupCode: "setup-code", password: "correct-password" },
    });
    const login = await server.inject({
      method: "POST", url: "/api/v1/login", headers: { origin: publicUrl },
      payload: { password: "correct-password" },
    });
    const cookie = login.headers["set-cookie"] as string;
    const headers = (revision?: string) => ({
      cookie,
      origin: publicUrl,
      ...(revision ? { "if-match": `"${revision}"` } : {}),
    });
    const upload = async (content: string, mediaType: string) => {
      const response = await server.inject({
        method: "PUT", url: "/api/v1/blobs",
        headers: { ...headers(), "content-type": mediaType }, payload: Buffer.from(content),
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ sha256: string }>().sha256;
    };

    const created = await server.inject({
      method: "POST", url: "/api/v1/config-sets", headers: headers(),
      payload: { name: "Default", slug: "default", enabledAgents: ["claude-code"] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe("\"1\"");
    const configSetId = created.json<{ id: string }>().id;
    expect((await server.inject({
      method: "PATCH", url: `/api/v1/config-sets/${configSetId}`, headers: headers("1"),
      payload: { name: "Primary", enabledAgents: ["claude-code"] },
    })).statusCode).toBe(200);
    const stale = await server.inject({
      method: "PATCH", url: `/api/v1/config-sets/${configSetId}`, headers: headers("1"),
      payload: { name: "Stale", enabledAgents: ["claude-code"] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });

    expect((await server.inject({
      method: "PUT", url: `/api/v1/config-sets/${configSetId}/overlays/claude-code`, headers: headers("2"),
      payload: { markdown: "Overlay one" },
    })).statusCode).toBe(200);
    expect((await server.inject({
      method: "DELETE", url: `/api/v1/config-sets/${configSetId}/overlays/claude-code`, headers: headers("3"),
    })).statusCode).toBe(200);

    const instructionSha = await upload("Shared instruction", "text/markdown");
    const resourceCreate = await server.inject({
      method: "POST", url: "/api/v1/resources", headers: headers(),
      payload: {
        kind: "instruction", slug: "shared", name: "Shared",
        files: [{ relativePath: "instruction.md", blobSha256: instructionSha, mediaType: "text/markdown", executable: false }],
      },
    });
    expect(resourceCreate.statusCode).toBe(201);
    const resource = resourceCreate.json<{ id: string; revisionId: string }>();
    const changedInstructionSha = await upload("Changed instruction", "text/markdown");
    const resourceUpdate = await server.inject({
      method: "PUT", url: `/api/v1/resources/${resource.id}`, headers: headers(resource.revisionId),
      payload: {
        files: [{ relativePath: "instruction.md", blobSha256: changedInstructionSha, mediaType: "text/markdown", executable: false }],
      },
    });
    expect(resourceUpdate.statusCode).toBe(200);
    const changedResourceRevision = resourceUpdate.json<{ revisionId: string }>().revisionId;
    const staleResource = await server.inject({
      method: "PUT", url: `/api/v1/resources/${resource.id}`, headers: headers(resource.revisionId),
      payload: {
        files: [{ relativePath: "instruction.md", blobSha256: instructionSha, mediaType: "text/markdown", executable: false }],
      },
    });
    expect(staleResource.statusCode).toBe(409);
    expect(staleResource.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await server.inject({
      method: "GET", url: "/api/v1/resources", headers: { cookie },
    })).json()).toMatchObject({
      files: [{ resourceId: resource.id, executable: false }],
    });

    expect((await server.inject({
      method: "PUT", url: `/api/v1/config-sets/${configSetId}/resources/${resource.id}`,
      headers: headers("4"), payload: { sortOrder: 0, selectedAgents: ["claude-code"] },
    })).statusCode).toBe(200);
    expect((await server.inject({
      method: "DELETE", url: `/api/v1/config-sets/${configSetId}/resources/${resource.id}`,
      headers: headers("5"),
    })).statusCode).toBe(200);
    expect((await server.inject({
      method: "PUT", url: `/api/v1/config-sets/${configSetId}/resources/${resource.id}`,
      headers: headers("6"), payload: { sortOrder: 0, selectedAgents: ["claude-code"] },
    })).statusCode).toBe(200);

    const credentialCreate = await server.inject({
      method: "POST", url: "/api/v1/credentials", headers: headers(),
      payload: { label: "Model key", provider: "Example", value: "first-secret" },
    });
    const credentialId = credentialCreate.json<{ id: string }>().id;
    const rotated = await server.inject({
      method: "POST", url: `/api/v1/credentials/${credentialId}/rotate`, headers: headers(),
      payload: { value: "second-secret" },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({ revision: 2, maskedValue: "••••••••" });
    expect(rotated.body).not.toContain("second-secret");
    expect((await server.inject({
      method: "PUT", url: `/api/v1/config-sets/${configSetId}/secret-slots/MODEL_API_KEY`,
      headers: headers("7"), payload: { credentialId },
    })).statusCode).toBe(200);

    const configSha = await upload("{}", "application/json");
    expect((await server.inject({
      method: "PUT", url: `/api/v1/config-sets/${configSetId}/files`, headers: headers("8"),
      payload: {
        agentId: "claude-code",
        target: { root: "claude-home", relativePath: "settings.json" },
        blobSha256: configSha,
        mediaType: "application/json",
        utf8: true,
        executable: false,
      },
    })).statusCode).toBe(200);

    const firstPublish = await server.inject({
      method: "POST", url: `/api/v1/config-sets/${configSetId}/releases`, headers: headers("9"),
      payload: { notes: "First" },
    });
    expect(firstPublish.statusCode).toBe(201);
    const firstReleaseId = firstPublish.json<{ releaseId: string }>().releaseId;
    expect((await server.inject({
      method: "PUT", url: `/api/v1/config-sets/${configSetId}/overlays/claude-code`, headers: headers("9"),
      payload: { markdown: "Release two overlay" },
    })).statusCode).toBe(200);
    const secondPublish = await server.inject({
      method: "POST", url: `/api/v1/config-sets/${configSetId}/releases`, headers: headers("10"),
      payload: { notes: "Second" },
    });
    expect(secondPublish.statusCode).toBe(201);
    const secondReleaseId = secondPublish.json<{ releaseId: string }>().releaseId;
    const diff = await server.inject({
      method: "GET",
      url: `/api/v1/releases/${secondReleaseId}/diff?before=${firstReleaseId}`,
      headers: { cookie },
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ entries: [{ action: "change", sensitive: false }] });

    const staleRollback = await server.inject({
      method: "POST",
      url: `/api/v1/config-sets/${configSetId}/releases/${firstReleaseId}/rollback`,
      headers: headers("9"),
    });
    expect(staleRollback.statusCode).toBe(409);
    const rollback = await server.inject({
      method: "POST",
      url: `/api/v1/config-sets/${configSetId}/releases/${firstReleaseId}/rollback`,
      headers: headers("10"),
    });
    expect(rollback.statusCode).toBe(201);
    const rollbackReleaseId = rollback.json<{ releaseId: string }>().releaseId;
    expect((await server.inject({
      method: "DELETE",
      url: `/api/v1/config-sets/${configSetId}/releases/${secondReleaseId}`,
      headers: headers(),
    })).statusCode).toBe(204);
    const deleteCurrent = await server.inject({
      method: "DELETE",
      url: `/api/v1/config-sets/${configSetId}/releases/${rollbackReleaseId}`,
      headers: headers(),
    });
    expect(deleteCurrent.statusCode).toBe(409);
    expect(deleteCurrent.json()).toMatchObject({ error: { code: "CURRENT_RELEASE_CANNOT_BE_DELETED" } });

    const storage = await server.inject({
      method: "GET", url: "/api/v1/storage", headers: { cookie },
    });
    expect(storage.statusCode).toBe(200);
    expect(storage.json()).toMatchObject({
      blobs: expect.any(Number),
      plaintextBytes: expect.any(Number),
      unreferencedBlobs: expect.any(Number),
    });
    const manualGc = await server.inject({
      method: "POST", url: "/api/v1/storage/gc", headers: headers(),
    });
    expect(manualGc.statusCode).toBe(200);
    expect(manualGc.json()).toMatchObject({ scanned: expect.any(Number), deleted: expect.any(Number) });

    const detail = await server.inject({
      method: "GET", url: `/api/v1/config-sets/${configSetId}`, headers: { cookie },
    });
    expect(detail.json()).toMatchObject({
      configSet: { name: "Primary", draftRevision: 11, currentReleaseRevision: 11 },
      selectedResources: [{ resourceId: resource.id, revisionId: changedResourceRevision, selectedAgents: ["claude-code"] }],
    });
    await server.close();
    database.native.close();
  });
});
