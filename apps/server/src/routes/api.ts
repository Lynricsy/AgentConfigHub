import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AgentId, ReleaseManifestV1 } from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { AuthenticationError, AuthService } from "../services/auth-service.js";
import type { ConfigSetService } from "../services/config-set-service.js";
import type { DeviceTokenService } from "../services/device-token-service.js";
import { PublishValidationError } from "../services/publish-service.js";
import type { EncryptedBlobStore } from "../storage/encrypted-blob-store.js";
import { registerAdminApiRoutes, type AdminApiDependencies } from "./admin-api.js";
import { registerBlobRoutes } from "./blobs.js";
import { serializeConfigSet } from "./serialization.js";

export interface ApiDependencies {
  readonly database: DatabaseContext;
  readonly auth: AuthService;
  readonly devices: DeviceTokenService;
  readonly configSets: ConfigSetService;
  readonly blobStore: EncryptedBlobStore;
  readonly publicUrl: string;
  readonly admin?: AdminApiDependencies;
}

const SetupBody = z.object({ setupCode: z.string().min(1), password: z.string() }).strict();
const LoginBody = z.object({ password: z.string() }).strict();
const PasswordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
  revokePullTokens: z.boolean(),
}).strict();
const DeviceAuthorizationBody = z.object({
  deviceName: z.string().trim().min(1).max(120),
  cliVersion: z.string().trim().min(1).max(64),
}).strict();
const DevicePollBody = z.object({ deviceCode: z.string().min(1) }).strict();
const DeviceApprovalBody = z.object({ userCode: z.string().length(8) }).strict();
const AutomationTokenBody = z.object({ label: z.string().trim().min(1).max(120) }).strict();
const ConfigSetBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  enabledAgents: AgentId.array().min(1),
}).strict();

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function requireOrigin(request: FastifyRequest, publicUrl: string): void {
  const origin = request.headers.origin;
  if (!origin || origin !== new URL(publicUrl).origin) {
    throw new AuthenticationError("ORIGIN_INVALID", "Request origin is invalid.");
  }
}

function cookieOptions(publicUrl: string) {
  const url = new URL(publicUrl);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: !loopback,
    maxAge: 7 * 24 * 60 * 60,
  };
}

function releaseManifest(database: DatabaseContext, slug: string, requestedAgents: string | undefined) {
  const configSet = database.native.prepare(`
    SELECT id, name, slug, enabled_agents AS enabledAgents, current_release_id AS releaseId
    FROM config_sets WHERE slug = ?
  `).get(slug) as {
    id: string;
    name: string;
    slug: string;
    enabledAgents: string;
    releaseId: string | null;
  } | undefined;
  if (!configSet?.releaseId) throw new Error(`No published release exists for ${slug}.`);
  const enabledAgents = AgentId.array().parse(JSON.parse(configSet.enabledAgents));
  const includedAgents = requestedAgents
    ? AgentId.array().parse(requestedAgents.split(",").filter(Boolean))
    : enabledAgents;
  if (includedAgents.some((agent) => !enabledAgents.includes(agent))) {
    throw new Error("Requested Agent is not enabled for this configuration set.");
  }
  const release = database.native.prepare(`
    SELECT release_number AS releaseNumber, min_cli_version AS minCliVersion,
      adapter_revisions AS adapterRevisions
    FROM releases WHERE id = ?
  `).get(configSet.releaseId) as {
    releaseNumber: number;
    minCliVersion: string;
    adapterRevisions: string;
  };
  const placeholders = includedAgents.map(() => "?").join(", ");
  const files = includedAgents.length === 0 ? [] : database.native.prepare(`
    SELECT id AS fileId, agent_id AS agentId, root_id AS root, relative_path AS relativePath,
      blob_sha256 AS contentSha256, size, executable, sensitive
    FROM release_files
    WHERE release_id = ? AND agent_id IN (${placeholders})
    ORDER BY agent_id, root_id, relative_path
  `).all(configSet.releaseId, ...includedAgents).map((row) => {
    const file = row as {
      fileId: string;
      agentId: string;
      root: string;
      relativePath: string;
      contentSha256: string;
      size: number;
      executable: number;
      sensitive: number;
    };
    return {
      fileId: file.fileId,
      agentId: file.agentId,
      target: { root: file.root, relativePath: file.relativePath },
      contentSha256: file.contentSha256,
      size: file.size,
      executable: Boolean(file.executable),
      sensitive: Boolean(file.sensitive),
    };
  });
  return ReleaseManifestV1.parse({
    protocolVersion: 1,
    releaseId: configSet.releaseId,
    releaseNumber: release.releaseNumber,
    configSet: { slug: configSet.slug, name: configSet.name },
    enabledAgents,
    selection: requestedAgents ? "subset" : "all-enabled",
    includedAgents,
    minCliVersion: release.minCliVersion,
    adapterRevisions: JSON.parse(release.adapterRevisions),
    files,
  });
}

export function registerApiRoutes(server: FastifyInstance, dependencies: ApiDependencies): void {
  server.register(cookie);
  server.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  const requireAdmin = async (request: FastifyRequest) => {
    if (!dependencies.auth.authenticateSession(request.cookies.agch_session)) {
      throw new AuthenticationError("UNAUTHORIZED", "Authentication required.");
    }
  };
  const requireAdminMutation = async (request: FastifyRequest) => {
    await requireAdmin(request);
    requireOrigin(request, dependencies.publicUrl);
  };
  const requirePull = async (request: FastifyRequest) => {
    if (!dependencies.devices.authenticate(bearerToken(request))) {
      throw new AuthenticationError("UNAUTHORIZED", "Pull token is invalid.");
    }
  };

  server.get("/api/v1/setup", async () => ({ required: dependencies.auth.setupCode !== null }));
  server.post("/api/v1/setup", async (request, reply) => {
    requireOrigin(request, dependencies.publicUrl);
    const body = SetupBody.parse(request.body);
    await dependencies.auth.setup(body.setupCode, body.password);
    return reply.code(204).send();
  });

  registerBlobRoutes(server, dependencies.blobStore, requireAdmin, requireAdminMutation);
  if (dependencies.admin) {
    registerAdminApiRoutes(
      server,
      dependencies.admin,
      requireAdmin,
      (request) => requireOrigin(request, dependencies.publicUrl),
    );
  }
  server.post("/api/v1/login", async (request, reply) => {
    requireOrigin(request, dependencies.publicUrl);
    const body = LoginBody.parse(request.body);
    const token = await dependencies.auth.login(body.password, request.ip);
    return reply.setCookie("agch_session", token, cookieOptions(dependencies.publicUrl)).code(204).send();
  });
  server.post("/api/v1/logout", { preHandler: requireAdmin }, async (request, reply) => {
    requireOrigin(request, dependencies.publicUrl);
    dependencies.auth.logout(request.cookies.agch_session);
    return reply.clearCookie("agch_session", cookieOptions(dependencies.publicUrl)).code(204).send();
  });
  server.get("/api/v1/session", { preHandler: requireAdmin }, async () => ({ authenticated: true }));
  server.post("/api/v1/password", { preHandler: requireAdmin }, async (request, reply) => {
    requireOrigin(request, dependencies.publicUrl);
    const body = PasswordBody.parse(request.body);
    await dependencies.auth.changePassword(
      body.currentPassword,
      body.newPassword,
      body.revokePullTokens,
    );
    return reply.clearCookie("agch_session", cookieOptions(dependencies.publicUrl)).code(204).send();
  });

  server.post("/api/v1/device-authorizations", async (request, reply) => {
    const body = DeviceAuthorizationBody.parse(request.body);
    return reply.code(201).send(dependencies.devices.createAuthorization({ ...body, ip: request.ip }));
  });
  server.post("/api/v1/device-authorizations/token", async (request) => {
    const body = DevicePollBody.parse(request.body);
    return { token: dependencies.devices.poll(body.deviceCode, request.ip) };
  });
  server.post(
    "/api/v1/devices/approve",
    { preHandler: requireAdmin },
    async (request, reply) => {
      requireOrigin(request, dependencies.publicUrl);
      const body = DeviceApprovalBody.parse(request.body);
      dependencies.devices.approve(body.userCode);
      return reply.code(204).send();
    },
  );
  server.get("/api/v1/tokens", { preHandler: requireAdmin }, async () => dependencies.devices.list());
  server.post(
    "/api/v1/tokens/automation",
    { preHandler: requireAdmin },
    async (request, reply) => {
      requireOrigin(request, dependencies.publicUrl);
      const body = AutomationTokenBody.parse(request.body);
      return reply.code(201).send(dependencies.devices.createAutomationToken(body.label));
    },
  );
  server.delete<{ Params: { tokenId: string } }>(
    "/api/v1/tokens/:tokenId",
    { preHandler: requireAdmin },
    async (request, reply) => {
      requireOrigin(request, dependencies.publicUrl);
      dependencies.devices.revoke(request.params.tokenId);
      return reply.code(204).send();
    },
  );

  server.get("/api/v1/config-sets", { preHandler: requireAdmin }, async () => dependencies.database.native.prepare(`
    SELECT sets.id, sets.name, sets.slug, sets.enabled_agents AS enabledAgents,
      sets.draft_revision AS draftRevision, sets.current_release_id AS currentReleaseId,
      current.draft_revision AS currentReleaseRevision
    FROM config_sets sets
    LEFT JOIN releases current ON current.id = sets.current_release_id
    ORDER BY sets.name, sets.id
  `).all().map(serializeConfigSet));
  server.post(
    "/api/v1/config-sets",
    { preHandler: requireAdmin },
    async (request, reply) => {
      requireOrigin(request, dependencies.publicUrl);
      const created = dependencies.configSets.create(ConfigSetBody.parse(request.body));
      return reply.header("ETag", `"${created.revision}"`).code(201).send(created);
    },
  );

  server.get("/api/v1/cli/config-sets", { preHandler: requirePull }, async (_request, reply) => reply
    .header("Cache-Control", "no-store")
    .send(dependencies.database.native.prepare(`
      SELECT name, slug FROM config_sets WHERE current_release_id IS NOT NULL ORDER BY name, id
    `).all()));
  server.get<{
    Params: { slug: string };
    Querystring: { agents?: string };
  }>("/api/v1/cli/config-sets/:slug/releases/latest", { preHandler: requirePull }, async (request, reply) => reply
    .header("Cache-Control", "no-store")
    .send(releaseManifest(dependencies.database, request.params.slug, request.query.agents)));
  server.get<{
    Params: { releaseId: string; fileId: string };
  }>("/api/v1/cli/releases/:releaseId/files/:fileId", { preHandler: requirePull }, async (request, reply) => {
    const file = dependencies.database.native.prepare(`
      SELECT blob_sha256 AS sha256 FROM release_files WHERE release_id = ? AND id = ?
    `).get(request.params.releaseId, request.params.fileId) as { sha256: string } | undefined;
    if (!file) throw new Error("Release file does not exist.");
    const digest = Buffer.from(file.sha256, "hex").toString("base64");
    return reply
      .header("Cache-Control", "no-store")
      .header("Digest", `sha-256=${digest}`)
      .header("ETag", `"${file.sha256}"`)
      .type("application/octet-stream")
      .send(await dependencies.blobStore.open(file.sha256));
  });

  const errorCode = (error: unknown): string => {
    if (error instanceof AuthenticationError) return error.code;
    if (error instanceof z.ZodError) return "INVALID_REQUEST";
    if (error instanceof PublishValidationError) return "PUBLISH_VALIDATION_FAILED";
    if (error instanceof Error && error.message === "CURRENT_RELEASE_CANNOT_BE_DELETED") {
      return error.message;
    }
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return "INTERNAL_ERROR";
  };

  server.setErrorHandler((error, request, reply) => {
    const code = errorCode(error);
    const statusByCode: Record<string, number> = {
      AUTHORIZATION_PENDING: 202,
      CURRENT_RELEASE_CANNOT_BE_DELETED: 409,
      DEVICE_CODE_EXPIRED: 410,
      DEVICE_CODE_CONSUMED: 410,
      INVALID_CREDENTIALS: 401,
      INVALID_REQUEST: 400,
      ORIGIN_INVALID: 403,
      PASSWORD_TOO_SHORT: 400,
      RATE_LIMITED: 429,
      SLOW_DOWN: 429,
      PUBLISH_VALIDATION_FAILED: 422,
      REVISION_CONFLICT: 409,
      SETUP_ALREADY_COMPLETE: 409,
      SETUP_CODE_INVALID: 401,
      UNAUTHORIZED: 401,
    };
    const status = statusByCode[code] ?? 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(status).send({
      error: {
        code,
        message: status >= 500
          ? "Internal server error."
          : code === "INVALID_REQUEST"
            ? "Invalid request."
            : error instanceof Error ? error.message : "Request failed.",
        requestId: request.id,
        ...(error instanceof PublishValidationError ? { details: error.diagnostics } : {}),
      },
    });
  });
}
