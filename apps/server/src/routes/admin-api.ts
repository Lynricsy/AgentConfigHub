import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import {
  ADAPTER_SCHEMA_SNAPSHOTS,
  builtInAdapters,
  getAdapter,
  type FileFormat,
} from "@agent-config-hub/adapters";
import { AgentId, LogicalTarget } from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { scanInlineSecrets } from "../security/secret-replacement.js";
import type { BlobGcService } from "../services/blob-gc-service.js";
import type { ConfigSetService } from "../services/config-set-service.js";
import { AuthenticationError } from "../services/auth-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { PublishService } from "../services/publish-service.js";
import type { ReleaseViewService } from "../services/release-view-service.js";
import type { ResourceService } from "../services/resource-service.js";
import type { SecretSlotService } from "../services/secret-slot-service.js";
import {
  parseAdapterRevisionJson,
  parseAgentJson,
  parseSqliteBoolean,
  serializeConfigSet,
} from "./serialization.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
function expectedDraftRevision(request: FastifyRequest): number {
  const value = z.string().regex(/^"[1-9]\d*"$/).parse(request.headers["if-match"]);
  return Number(value.slice(1, -1));
}

function expectedResourceRevision(request: FastifyRequest): string {
  const value = z.string().regex(/^"[^"]+"$/).parse(request.headers["if-match"]);
  return value.slice(1, -1);
}

function inferFileFormat(relativePath: string): FileFormat {
  const lower = relativePath.toLocaleLowerCase("en-US");
  if (lower.endsWith(".jsonc")) return "jsonc";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".env") || lower.includes("dotenv")) return "dotenv";
  return "text";
}

const ResourceFile = z.object({
  relativePath: z.string().min(1),
  blobSha256: Sha256,
  mediaType: z.string().min(1),
  executable: z.boolean(),
}).strict();
const DraftFileBody = z.object({
  target: LogicalTarget,
  blobSha256: Sha256,
  mediaType: z.string().min(1),
  utf8: z.boolean(),
  executable: z.boolean(),
}).strict();
const StoredDraftFile = z.object({
  id: z.string(),
  agentId: AgentId,
  root: z.string(),
  relativePath: z.string(),
  blobSha256: Sha256,
  mediaType: z.string(),
  utf8: z.union([z.literal(0), z.literal(1)]),
  executable: z.union([z.literal(0), z.literal(1)]),
  size: z.number().int().nonnegative(),
});
const StoredResourceFile = z.object({
  resourceId: z.string(),
  relativePath: z.string(),
  blobSha256: Sha256,
  mediaType: z.string(),
  executable: z.union([z.literal(0), z.literal(1)]),
});
const StoredResourceSelection = z.object({
  resourceId: z.string(),
  revisionId: z.string(),
  sortOrder: z.number().int().nonnegative(),
  agentId: AgentId,
});
const StoredRelease = z.object({
  id: z.string(),
  releaseNumber: z.number().int().positive(),
  draftRevision: z.number().int().positive(),
  enabledAgents: z.string(),
  notes: z.string().nullable(),
  minCliVersion: z.string(),
  adapterRevisions: z.string(),
  createdAt: z.number(),
});

export interface AdminApiDependencies {
  readonly database: DatabaseContext;
  readonly configSets: ConfigSetService;
  readonly credentials: CredentialService;
  readonly resources: ResourceService;
  readonly slots: SecretSlotService;
  readonly publish: PublishService;
  readonly releases: ReleaseViewService;
  readonly gc: BlobGcService;
  readonly verifyPassword: (password: string) => Promise<boolean>;
}

export function registerAdminApiRoutes(
  server: FastifyInstance,
  dependencies: AdminApiDependencies,
  authorize: preHandlerHookHandler,
  assertOrigin: (request: FastifyRequest) => void,
): void {
  const protectedMutation = { preHandler: authorize };

  server.get("/api/v1/adapters", protectedMutation, async () => builtInAdapters.map((adapter) => ({
    id: adapter.id,
    revision: adapter.revision,
    roots: adapter.roots,
    surfaces: adapter.surfaces,
    schemaSnapshot: ADAPTER_SCHEMA_SNAPSHOTS[adapter.id],
  })));
  server.post("/api/v1/validate-file", {
    ...protectedMutation,
    bodyLimit: 3 * 1024 * 1024,
  }, async (request) => {
    assertOrigin(request);
    const body = z.object({
      agentId: AgentId,
      target: LogicalTarget,
      mediaType: z.string().min(1),
      text: z.string().max(2 * 1024 * 1024),
      executable: z.boolean(),
    }).strict().parse(request.body);
    const adapter = getAdapter(body.agentId);
    const diagnostics = await adapter.validate({
      agentId: body.agentId,
      target: body.target,
      mediaType: body.mediaType,
      format: inferFileFormat(body.target.relativePath),
      text: body.text,
      executable: body.executable,
    });
    return {
      diagnostics: [
        ...diagnostics,
        ...scanInlineSecrets(body.text).map((diagnostic) => ({ ...diagnostic, target: body.target })),
      ],
    };
  });

  server.get<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId",
    protectedMutation,
    async (request, reply) => {
      const configSet = dependencies.database.native.prepare(`
        SELECT sets.id, sets.name, sets.slug, sets.enabled_agents AS enabledAgents,
          sets.draft_revision AS draftRevision, sets.current_release_id AS currentReleaseId,
          current.draft_revision AS currentReleaseRevision,
          current.release_number AS currentReleaseNumber
        FROM config_sets sets
        LEFT JOIN releases current ON current.id = sets.current_release_id
        WHERE sets.id = ?
      `).get(request.params.configSetId);
      if (!configSet) throw new Error("Configuration set does not exist.");
      const files = dependencies.database.native.prepare(`
        SELECT files.id, files.agent_id AS agentId, files.root_id AS root,
          files.relative_path AS relativePath, files.blob_sha256 AS blobSha256,
          files.media_type AS mediaType, files.utf8, files.executable,
          blobs.plaintext_size AS size
        FROM draft_files files
        JOIN blobs ON blobs.sha256 = files.blob_sha256
        WHERE files.config_set_id = ?
        ORDER BY files.agent_id, files.root_id, files.relative_path
      `).all(request.params.configSetId);
      const overlays = dependencies.database.native.prepare(`
        SELECT agent_id AS agentId, markdown FROM agent_instruction_overlays
        WHERE config_set_id = ? ORDER BY agent_id
      `).all(request.params.configSetId);
      const selectedResources = dependencies.database.native.prepare(`
        SELECT selected.resource_id AS resourceId,
          COALESCE(selected.resource_revision_id, resources.current_revision_id) AS revisionId,
          selected.agent_id AS agentId, selected.sort_order AS sortOrder
        FROM config_set_resources selected
        JOIN resources ON resources.id = selected.resource_id
        WHERE selected.config_set_id = ?
        ORDER BY selected.agent_id, selected.sort_order, selected.resource_id
      `).all(request.params.configSetId).map((row) => StoredResourceSelection.parse(row));
      const serializedConfigSet = serializeConfigSet(configSet);
      return reply.header("ETag", `"${serializedConfigSet.draftRevision}"`).send({
        configSet: serializedConfigSet,
        files: files.map((row) => {
          const file = StoredDraftFile.parse(row);
          return {
            ...file,
            utf8: parseSqliteBoolean(file.utf8),
            executable: parseSqliteBoolean(file.executable),
          };
        }),
        overlays,
        selectedResources,
        secretSlots: dependencies.slots.list(request.params.configSetId),
      });
    },
  );
  server.delete<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      dependencies.configSets.delete({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
      });
      return reply.code(204).send();
    },
  );
  server.post<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId/configs",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = z.object({ agentId: AgentId }).strict().parse(request.body);
      const revision = dependencies.configSets.createAgentConfig({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        agentId: body.agentId,
      });
      return reply.header("ETag", `"${revision}"`).code(201).send({ revision });
    },
  );


  server.post<{ Params: { configSetId: string; agentId: string } }>(
    "/api/v1/config-sets/:configSetId/configs/:agentId/files",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const revision = dependencies.configSets.createFile({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        agentId: AgentId.parse(request.params.agentId),
        ...DraftFileBody.parse(request.body),
      });
      return reply.header("ETag", `"${revision}"`).code(201).send({ revision });
    },
  );
  server.put<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId/files",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = DraftFileBody.extend({ agentId: AgentId }).parse(request.body);
      const revision = dependencies.configSets.saveFile({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        ...body,
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );
  server.delete<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId/files",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = z.object({ agentId: AgentId, target: LogicalTarget }).strict().parse(request.body);
      const revision = dependencies.configSets.deleteFile({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        ...body,
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );

  server.put<{ Params: { configSetId: string; agentId: string } }>(
    "/api/v1/config-sets/:configSetId/overlays/:agentId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const agentId = AgentId.parse(request.params.agentId);
      const body = z.object({ markdown: z.string() }).strict().parse(request.body);
      const revision = dependencies.configSets.saveInstructionOverlay({
        configSetId: request.params.configSetId,
        agentId,
        expectedRevision: expectedDraftRevision(request),
        ...body,
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );
  server.delete<{ Params: { configSetId: string; agentId: string } }>(
    "/api/v1/config-sets/:configSetId/overlays/:agentId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const revision = dependencies.configSets.deleteInstructionOverlay({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        agentId: AgentId.parse(request.params.agentId),
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );


  server.get("/api/v1/resources", protectedMutation, async () => {
    const resources = dependencies.database.native.prepare(`
      SELECT resources.id, resources.kind, resources.slug, resources.name,
        resources.current_revision_id AS revisionId, revisions.revision_number AS revisionNumber
      FROM resources JOIN resource_revisions revisions ON revisions.id = resources.current_revision_id
      ORDER BY resources.kind, resources.name, resources.id
    `).all();
    const files = dependencies.database.native.prepare(`
      SELECT revisions.resource_id AS resourceId, files.relative_path AS relativePath,
        files.blob_sha256 AS blobSha256, files.media_type AS mediaType, files.executable
      FROM resource_revision_files files
      JOIN resource_revisions revisions ON revisions.id = files.resource_revision_id
      JOIN resources ON resources.current_revision_id = revisions.id
      ORDER BY revisions.resource_id, files.relative_path
    `).all();
    return {
      resources,
      files: files.map((row) => {
        const file = StoredResourceFile.parse(row);
        return { ...file, executable: parseSqliteBoolean(file.executable) };
      }),
    };
  });
  server.post("/api/v1/resources", protectedMutation, async (request, reply) => {
    assertOrigin(request);
    const body = z.object({
      kind: z.enum(["instruction", "skill"]),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      name: z.string().trim().min(1).max(120),
      files: ResourceFile.array(),
    }).strict().parse(request.body);
    return reply.code(201).send(dependencies.resources.create(body));
  });
  server.put<{ Params: { resourceId: string } }>(
    "/api/v1/resources/:resourceId",
    protectedMutation,
    async (request) => {
      assertOrigin(request);
      const body = z.object({ files: ResourceFile.array() }).strict().parse(request.body);
      return {
        revisionId: dependencies.resources.mutate({
          resourceId: request.params.resourceId,
          expectedRevisionId: expectedResourceRevision(request),
          ...body,
        }),
      };
    },
  );
  server.put<{
    Params: { configSetId: string; agentId: string; resourceId: string };
  }>(
    "/api/v1/config-sets/:configSetId/configs/:agentId/resources/:resourceId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = z.object({ sortOrder: z.number().int().nonnegative() }).strict().parse(request.body);
      const revision = dependencies.resources.selectAgentForConfigSet({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        resourceId: request.params.resourceId,
        agentId: AgentId.parse(request.params.agentId),
        sortOrder: body.sortOrder,
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );
  server.delete<{
    Params: { configSetId: string; agentId: string; resourceId: string };
  }>(
    "/api/v1/config-sets/:configSetId/configs/:agentId/resources/:resourceId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const revision = dependencies.resources.deselectAgentForConfigSet({
        configSetId: request.params.configSetId,
        expectedRevision: expectedDraftRevision(request),
        resourceId: request.params.resourceId,
        agentId: AgentId.parse(request.params.agentId),
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );

  server.get("/api/v1/credentials", protectedMutation, async () => dependencies.credentials.list());
  server.post("/api/v1/credentials", protectedMutation, async (request, reply) => {
    assertOrigin(request);
    const body = z.object({
      label: z.string().trim().min(1).max(120),
      provider: z.string().trim().min(1).max(120),
      value: z.string().min(1),
    }).strict().parse(request.body);
    return reply.code(201).send(dependencies.credentials.create(body));
  });
  server.post<{ Params: { credentialId: string } }>(
    "/api/v1/credentials/:credentialId/rotate",
    protectedMutation,
    async (request) => {
      assertOrigin(request);
      const body = z.object({ value: z.string().min(1) }).strict().parse(request.body);
      return dependencies.credentials.rotate(request.params.credentialId, body.value);
    },
  );
  server.post<{ Params: { credentialId: string } }>(
    "/api/v1/credentials/:credentialId/reveal",
    protectedMutation,
    async (request) => {
      assertOrigin(request);
      const body = z.object({ password: z.string() }).strict().parse(request.body);
      if (!await dependencies.verifyPassword(body.password)) {
        throw new AuthenticationError("INVALID_CREDENTIALS", "Invalid credentials.");
      }
      return {
        value: await dependencies.credentials.reveal(
          request.params.credentialId,
          body.password,
          async () => true,
        ),
      };
    },
  );

  server.get<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId/secret-slots",
    protectedMutation,
    async (request) => dependencies.slots.list(request.params.configSetId),
  );
  server.put<{ Params: { configSetId: string; slotName: string } }>(
    "/api/v1/config-sets/:configSetId/secret-slots/:slotName",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = z.object({
        credentialId: z.string().min(1).nullable(),
      }).strict().parse(request.body);
      const revision = dependencies.slots.setDefault({
        configSetId: request.params.configSetId,
        slotName: request.params.slotName,
        ...body,
        expectedRevision: expectedDraftRevision(request),
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );
  server.put<{ Params: { configSetId: string; slotName: string; agentId: string } }>(
    "/api/v1/config-sets/:configSetId/secret-slots/:slotName/agents/:agentId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = z.object({
        credentialId: z.string().min(1).nullable(),
      }).strict().parse(request.body);
      const revision = dependencies.slots.setOverride({
        configSetId: request.params.configSetId,
        slotName: request.params.slotName,
        agentId: AgentId.parse(request.params.agentId),
        expectedRevision: expectedDraftRevision(request),
        ...body,
      });
      return reply.header("ETag", `"${revision}"`).send({ revision });
    },
  );

  server.get<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId/releases",
    protectedMutation,
    async (request) => dependencies.database.native.prepare(`
      SELECT id, release_number AS releaseNumber, draft_revision AS draftRevision,
        enabled_agents AS enabledAgents, notes, min_cli_version AS minCliVersion,
        adapter_revisions AS adapterRevisions, created_at AS createdAt
      FROM releases WHERE config_set_id = ? ORDER BY release_number DESC
    `).all(request.params.configSetId).map((row) => {
      const release = StoredRelease.parse(row);
      return {
        ...release,
        enabledAgents: parseAgentJson(release.enabledAgents),
        adapterRevisions: parseAdapterRevisionJson(release.adapterRevisions),
      };
    }),
  );
  server.post<{ Params: { configSetId: string } }>(
    "/api/v1/config-sets/:configSetId/releases",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      const body = z.object({
        notes: z.string().max(10_000).optional(),
      }).strict().parse(request.body);
      return reply.code(201).send(await dependencies.publish.publish(
        request.params.configSetId,
        expectedDraftRevision(request),
        body.notes,
      ));
    },
  );
  server.post<{ Params: { configSetId: string; releaseId: string } }>(
    "/api/v1/config-sets/:configSetId/releases/:releaseId/rollback",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      return reply.code(201).send(
        await dependencies.publish.rollback(
          request.params.configSetId,
          request.params.releaseId,
          expectedDraftRevision(request),
        ),
      );
    },
  );
  server.delete<{ Params: { configSetId: string; releaseId: string } }>(
    "/api/v1/config-sets/:configSetId/releases/:releaseId",
    protectedMutation,
    async (request, reply) => {
      assertOrigin(request);
      dependencies.publish.deleteHistorical(request.params.configSetId, request.params.releaseId);
      return reply.code(204).send();
    },
  );
  server.get("/api/v1/storage", protectedMutation, async () => dependencies.gc.stats());
  server.post("/api/v1/storage/gc", protectedMutation, async (request) => {
    assertOrigin(request);
    return await dependencies.gc.run();
  });

  server.get<{
    Params: { releaseId: string };
    Querystring: { before?: string };
  }>("/api/v1/releases/:releaseId/diff", protectedMutation, async (request) => ({
    entries: await dependencies.releases.diff(request.query.before ?? null, request.params.releaseId),
  }));
}
