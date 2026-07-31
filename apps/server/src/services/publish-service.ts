import { Readable } from "node:stream";

import { ulid } from "ulid";

import {
  adapterRegistry,
  assertAllowedTarget,
  assertNativeGeneratedTargetSeparation,
  type AdapterFile,
  type FileFormat,
  type GeneratedFile,
  type SharedResourceFile,
} from "@agent-config-hub/adapters";
import {
  AgentId,
  type Diagnostic,
  type LogicalTarget,
  ReleaseManifestV1,
  type ReleaseManifestV1 as ReleaseManifest,
} from "@agent-config-hub/protocol";

import type { DatabaseContext } from "../db/database.js";
import { replaceSecretScalars, scanInlineSecrets, type SecretFormat } from "../security/secret-replacement.js";
import type { EncryptedBlobStore } from "../storage/encrypted-blob-store.js";
import { RevisionConflictError } from "./draft-revision.js";
import { SecretBindingResolver, type ResolvedSecret } from "./secret-binding-resolver.js";

interface ConfigSetRow {
  id: string;
  name: string;
  slug: string;
  enabledAgents: string;
  draftRevision: number;
  currentReleaseId: string | null;
}

interface DraftFileRow {
  agentId: AgentId;
  rootId: LogicalTarget["root"];
  relativePath: string;
  blobSha256: string;
  mediaType: string;
  utf8: number;
  executable: number;
}

interface SelectedResourceRow {
  resourceId: string;
  kind: "instruction" | "skill";
  slug: string;
  name: string;
  revisionId: string;
  pinnedRevisionId: string | null;
  sortOrder: number;
  agentId: AgentId;
}

interface ResourceFileRow extends SharedResourceFile {
  resourceRevisionId: string;
}

interface CandidateFile {
  agentId: AgentId;
  target: LogicalTarget;
  mediaType: string;
  executable: boolean;
  format: FileFormat;
  text: string | null;
  sourceBlobSha256: string | null;
  sourceKind: "draft-file" | "generated";
}

interface PreparedOutput extends CandidateFile {
  blobSha256: string;
  size: number;
  sensitive: boolean;
}

interface FrozenOverlay {
  agentId: AgentId;
  target: LogicalTarget;
  blobSha256: string;
}

export interface PublishResult {
  readonly releaseId: string;
  readonly releaseNumber: number;
  readonly manifest: ReleaseManifest;
  readonly diagnostics: readonly Diagnostic[];
}

export class PublishValidationError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super("Release contains blocking diagnostics.");
    this.name = "PublishValidationError";
    this.diagnostics = diagnostics;
  }
}

function inferFormat(relativePath: string, utf8: boolean): FileFormat {
  if (!utf8) return "binary";
  const lower = relativePath.toLocaleLowerCase("en-US");
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".jsonc")) return "jsonc";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".env") || lower === ".env") return "dotenv";
  if (lower.endsWith(".md")) return "markdown";
  return "text";
}

function isUtf8MediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || [
    "application/json",
    "application/yaml",
    "application/toml",
  ].includes(mediaType);
}

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function secretFormat(format: FileFormat): SecretFormat | undefined {
  return ["json", "jsonc", "toml", "yaml", "dotenv"].includes(format)
    ? format as SecretFormat
    : undefined;
}

export class PublishService {
  readonly #database: DatabaseContext;
  readonly #blobStore: EncryptedBlobStore;
  readonly #secretBindings: SecretBindingResolver;

  constructor(database: DatabaseContext, blobStore: EncryptedBlobStore, secretBindings: SecretBindingResolver) {
    this.#database = database;
    this.#blobStore = blobStore;
    this.#secretBindings = secretBindings;
  }

  async publish(configSetId: string, expectedDraftRevision: number, notes?: string): Promise<PublishResult> {
    const configSet = this.#configSet(configSetId);
    if (configSet.draftRevision !== expectedDraftRevision) {
      throw new RevisionConflictError(expectedDraftRevision, configSet.draftRevision);
    }
    const enabledAgents = AgentId.array().parse(JSON.parse(configSet.enabledAgents));
    const diagnostics: Diagnostic[] = [];
    if (enabledAgents.length === 0) diagnostics.push({
      code: "NO_ENABLED_AGENTS",
      severity: "error",
      message: "At least one Agent must be enabled before publishing.",
    });
    const draftFiles = this.#draftFiles(configSetId).filter(({ agentId }) => enabledAgents.includes(agentId));
    const resources = this.#selectedResources(configSetId);
    const resourceFiles = this.#resourceFiles(resources.map(({ revisionId }) => revisionId));
    const overlayRows = this.#database.native.prepare(
      "SELECT agent_id AS agentId, markdown FROM agent_instruction_overlays WHERE config_set_id = ?",
    ).all(configSetId) as { agentId: AgentId; markdown: string }[];
    const overlays = new Map(overlayRows.map((row) => [row.agentId, row.markdown]));
    const candidates: CandidateFile[] = [];

    for (const row of draftFiles) {
      const adapter = adapterRegistry[row.agentId];
      const target = { root: row.rootId, relativePath: row.relativePath };
      try {
        assertAllowedTarget(adapter, target);
      } catch (error) {
        diagnostics.push({
          code: "TARGET_NOT_ALLOWED",
          severity: "error",
          message: error instanceof Error ? error.message : "Target is not allowed.",
          target,
        });
        continue;
      }
      const format = inferFormat(row.relativePath, Boolean(row.utf8));
      let text: string | null = null;
      if (row.utf8) text = (await consume(await this.#blobStore.open(row.blobSha256))).toString("utf8");
      else await this.#blobStore.verify(row.blobSha256);
      const adapterFile: AdapterFile = {
        agentId: row.agentId,
        target,
        mediaType: row.mediaType,
        format,
        text,
        executable: Boolean(row.executable),
      };
      diagnostics.push(...await adapter.validate(adapterFile));
      candidates.push({ ...adapterFile, sourceBlobSha256: row.blobSha256, sourceKind: "draft-file" });
    }

    for (const agentId of enabledAgents) {
      const adapter = adapterRegistry[agentId];
      const instructions: { slug: string; markdown: string }[] = [];
      const skills: { name: string; files: SharedResourceFile[] }[] = [];
      for (const resource of resources) {
        if (resource.agentId !== agentId) continue;
        const files = resourceFiles.filter(({ resourceRevisionId }) => resourceRevisionId === resource.revisionId);
        if (resource.kind === "instruction") {
          const markdown = files.find(({ relativePath }) => relativePath.toLocaleLowerCase("en-US").endsWith(".md"));
          if (!markdown) {
            diagnostics.push({ code: "INSTRUCTION_MARKDOWN_MISSING", severity: "error", message: `${resource.name} has no Markdown file.` });
          } else {
            instructions.push({
              slug: resource.slug,
              markdown: (await consume(await this.#blobStore.open(markdown.blobSha256))).toString("utf8"),
            });
          }
        } else {
          skills.push({ name: resource.slug, files });
        }
      }
      let generated: readonly GeneratedFile[] = [];
      try {
        generated = await adapter.renderSharedResources({
          instructions,
          instructionOverlay: overlays.get(agentId) ?? "",
          skills,
        });
      } catch (error) {
        diagnostics.push({
          code: "RESOURCE_RENDER_ERROR",
          severity: "error",
          message: error instanceof Error ? error.message : "Shared resource rendering failed.",
        });
      }
      for (const file of generated) {
        assertAllowedTarget(adapter, file.target, { allowReserved: true });
        if (file.source.kind === "text") {
          const format = inferFormat(file.target.relativePath, true);
          diagnostics.push(...await adapter.validate({
            agentId,
            target: file.target,
            mediaType: file.mediaType,
            format,
            text: file.source.text,
            executable: file.executable,
          }));
          candidates.push({
            agentId,
            target: file.target,
            mediaType: file.mediaType,
            executable: file.executable,
            format,
            text: file.source.text,
            sourceBlobSha256: null,
            sourceKind: "generated",
          });
        } else {
          const utf8 = isUtf8MediaType(file.mediaType);
          const format = inferFormat(file.target.relativePath, utf8);
          const text = utf8
            ? (await consume(await this.#blobStore.open(file.source.sha256))).toString("utf8")
            : null;
          diagnostics.push(...await adapter.validate({
            agentId,
            target: file.target,
            mediaType: file.mediaType,
            format,
            text,
            executable: file.executable,
          }));
          candidates.push({
            agentId,
            target: file.target,
            mediaType: file.mediaType,
            executable: file.executable,
            format,
            text,
            sourceBlobSha256: file.source.sha256,
            sourceKind: "generated",
          });
        }
      }
    }

    for (const agentId of enabledAgents) {
      const nativeTargets = candidates
        .filter((candidate) => candidate.agentId === agentId && candidate.sourceKind === "draft-file")
        .map(({ target }) => target);
      const generated = candidates
        .filter((candidate) => candidate.agentId === agentId && candidate.sourceKind === "generated")
        .map((candidate): GeneratedFile => ({
          target: candidate.target,
          mediaType: candidate.mediaType,
          executable: candidate.executable,
          source: candidate.sourceBlobSha256
            ? { kind: "blob", sha256: candidate.sourceBlobSha256 }
            : { kind: "text", text: candidate.text ?? "" },
        }));
      try {
        assertNativeGeneratedTargetSeparation(nativeTargets, generated);
      } catch (error) {
        diagnostics.push({
          code: "TARGET_COLLISION",
          severity: "error",
          message: error instanceof Error ? error.message : "Generated target collision.",
        });
      }
    }

    const slotsByAgent: Partial<Record<AgentId, string[]>> = {};
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const slots = [...candidate.text.matchAll(/\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g)]
        .flatMap((match) => match[1] ? [match[1]] : []);
      const combined = [...(slotsByAgent[candidate.agentId] ?? []), ...slots];
      slotsByAgent[candidate.agentId] = [...new Set(combined)].sort();
      if (slots.length > 0 && !secretFormat(candidate.format)) diagnostics.push({
        code: "SECRET_PLACEHOLDER_NOT_SCALAR",
        severity: "error",
        message: `Secret placeholders are not supported in ${candidate.format} files.`,
        target: candidate.target,
      });
      if (!secretFormat(candidate.format)) {
        diagnostics.push(...scanInlineSecrets(candidate.text).map((diagnostic) => ({
          ...diagnostic,
          target: candidate.target,
        })));
      }
    }

    const resolvedByAgent: Partial<Record<AgentId, Record<string, ResolvedSecret>>> = {};
    const credentialAgents = new Map<string, Set<AgentId>>();
    for (const agentId of enabledAgents) {
      const resolution = this.#secretBindings.resolve(configSetId, [agentId], slotsByAgent[agentId] ?? []);
      diagnostics.push(...resolution.diagnostics);
      const resolved = resolution.byAgent[agentId] ?? {};
      resolvedByAgent[agentId] = resolved;
      for (const secret of Object.values(resolved)) {
        const agents = credentialAgents.get(secret.credentialId) ?? new Set<AgentId>();
        agents.add(agentId);
        credentialAgents.set(secret.credentialId, agents);
      }
    }
    for (const agents of credentialAgents.values()) {
      if (agents.size > 1) diagnostics.push({
        code: "SHARED_CREDENTIAL_REDUCES_ATTRIBUTION",
        severity: "warning",
        message: `One credential is shared by ${[...agents].sort().join(", ")}.`,
      });
    }

    const rendered: { candidate: CandidateFile; text: string | null; sensitive: boolean }[] = [];
    for (const candidate of candidates) {
      const format = secretFormat(candidate.format);
      if (candidate.text !== null && format) {
        const replacement = await replaceSecretScalars(
          candidate.text,
          format,
          (slot) => resolvedByAgent[candidate.agentId]?.[slot]?.value,
        );
        diagnostics.push(...replacement.diagnostics.map((diagnostic) => ({ ...diagnostic, target: candidate.target })));
        rendered.push({ candidate, text: replacement.text, sensitive: replacement.sensitive });
      } else {
        rendered.push({ candidate, text: candidate.text, sensitive: false });
      }
    }
    if (diagnostics.some(({ severity }) => severity === "error")) throw new PublishValidationError(diagnostics);

    const prepared: PreparedOutput[] = [];
    for (const output of rendered) {
      if (output.text !== null) {
        const blob = await this.#blobStore.put(Readable.from(Buffer.from(output.text, "utf8")), output.candidate.mediaType);
        prepared.push({ ...output.candidate, blobSha256: blob.sha256, size: blob.size, sensitive: output.sensitive });
      } else {
        const sha256 = output.candidate.sourceBlobSha256!;
        const descriptor = await this.#blobStore.verify(sha256);
        prepared.push({
          ...output.candidate,
          blobSha256: sha256,
          size: descriptor.size,
          sensitive: false,
        });
      }
    }
    const frozenOverlays: FrozenOverlay[] = [];
    for (const overlay of overlayRows.filter(({ markdown }) => markdown.length > 0)) {
      const adapter = adapterRegistry[overlay.agentId];
      const target = (await adapter.renderSharedResources({
        instructions: [],
        instructionOverlay: overlay.markdown,
        skills: [],
      }))[0]?.target;
      if (!target) continue;
      const blob = await this.#blobStore.put(Readable.from(Buffer.from(overlay.markdown, "utf8")), "text/markdown");
      frozenOverlays.push({ agentId: overlay.agentId, target, blobSha256: blob.sha256 });
    }

    const releaseId = ulid();
    const committed = this.#database.native.transaction(() => {
      const current = this.#configSet(configSetId);
      if (current.draftRevision !== expectedDraftRevision) {
        throw new RevisionConflictError(expectedDraftRevision, current.draftRevision);
      }
      for (const resource of resources) {
        if (resource.pinnedRevisionId) continue;
        const row = this.#database.native.prepare(
          "SELECT current_revision_id AS revisionId FROM resources WHERE id = ?",
        ).get(resource.resourceId) as { revisionId: string } | undefined;
        if (row?.revisionId !== resource.revisionId) {
          throw new RevisionConflictError(expectedDraftRevision, current.draftRevision);
        }
      }
      for (const binding of Object.values(resolvedByAgent).flatMap((entries) => Object.values(entries ?? {}))) {
        if (binding.pinnedRevision) continue;
        const row = this.#database.native.prepare(
          "SELECT current_revision_id AS revisionId FROM credentials WHERE id = ?",
        ).get(binding.credentialId) as { revisionId: string } | undefined;
        if (row?.revisionId !== binding.credentialRevisionId) {
          throw new RevisionConflictError(expectedDraftRevision, current.draftRevision);
        }
      }
      const next = this.#database.native.prepare(
        "SELECT COALESCE(MAX(release_number), 0) + 1 AS number FROM releases WHERE config_set_id = ?",
      ).get(configSetId) as { number: number };
      const adapterRevisions = Object.fromEntries(
        Object.entries(adapterRegistry).map(([agentId, adapter]) => [agentId, adapter.revision]),
      );
      this.#database.native.prepare(`
        INSERT INTO releases (
          id, config_set_id, release_number, draft_revision, enabled_agents,
          notes, min_cli_version, adapter_revisions, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        releaseId,
        configSetId,
        next.number,
        expectedDraftRevision,
        JSON.stringify(enabledAgents),
        notes ?? null,
        "0.1.0",
        JSON.stringify(adapterRevisions),
        Date.now(),
      );
      const insertSource = this.#database.native.prepare(`
        INSERT INTO release_source_files (
          id, release_id, agent_id, source_kind, root_id, relative_path,
          template_blob_sha256, media_type, executable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of draftFiles) insertSource.run(
        ulid(), releaseId, source.agentId, "draft-file", source.rootId, source.relativePath,
        source.blobSha256, source.mediaType, source.executable,
      );
      for (const overlay of frozenOverlays) insertSource.run(
        ulid(), releaseId, overlay.agentId, "instruction-overlay", overlay.target.root,
        overlay.target.relativePath, overlay.blobSha256, "text/markdown", 0,
      );
      const insertOutput = this.#database.native.prepare(`
        INSERT INTO release_files (
          id, release_id, agent_id, root_id, relative_path, blob_sha256, size, executable, sensitive
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const manifestFiles: ReleaseManifest["files"] = [];
      for (const output of prepared.toSorted((left, right) =>
        `${left.agentId}/${left.target.root}/${left.target.relativePath}`.localeCompare(
          `${right.agentId}/${right.target.root}/${right.target.relativePath}`,
        ))) {
        const fileId = ulid();
        insertOutput.run(
          fileId, releaseId, output.agentId, output.target.root, output.target.relativePath,
          output.blobSha256, output.size, Number(output.executable), Number(output.sensitive),
        );
        manifestFiles.push({
          fileId,
          agentId: output.agentId,
          target: output.target,
          contentSha256: output.blobSha256,
          size: output.size,
          executable: output.executable,
          sensitive: output.sensitive,
        });
      }
      const insertResource = this.#database.native.prepare(`
        INSERT INTO release_resource_revisions (
          release_id, resource_revision_id, agent_id, sort_order
        ) VALUES (?, ?, ?, ?)
      `);
      for (const resource of resources) insertResource.run(
        releaseId, resource.revisionId, resource.agentId, resource.sortOrder,
      );
      const insertBinding = this.#database.native.prepare(`
        INSERT INTO release_secret_bindings (
          release_id, secret_slot_id, slot_name, agent_id, binding_source, credential_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [agentId, bindings] of Object.entries(resolvedByAgent) as [AgentId, Record<string, ResolvedSecret>][]) {
        for (const [slotName, binding] of Object.entries(bindings)) {
          const slot = this.#database.native.prepare(
            "SELECT id FROM secret_slots WHERE config_set_id = ? AND name = ?",
          ).get(configSetId, slotName) as { id: string };
          insertBinding.run(
            releaseId, slot.id, slotName, agentId, binding.bindingSource, binding.credentialRevisionId,
          );
        }
      }
      this.#database.native.prepare("UPDATE config_sets SET current_release_id = ? WHERE id = ?")
        .run(releaseId, configSetId);
      const manifest = ReleaseManifestV1.parse({
        protocolVersion: 1,
        releaseId,
        releaseNumber: next.number,
        configSet: { slug: configSet.slug, name: configSet.name },
        enabledAgents,
        selection: "all-enabled",
        includedAgents: enabledAgents,
        minCliVersion: "0.1.0",
        adapterRevisions,
        files: manifestFiles,
      });
      return { releaseNumber: next.number, manifest };
    })();
    return {
      releaseId,
      releaseNumber: committed.releaseNumber,
      manifest: committed.manifest,
      diagnostics,
    };
  }

  async rollback(
    configSetId: string,
    sourceReleaseId: string,
    expectedDraftRevision: number,
  ): Promise<{ releaseId: string; releaseNumber: number }> {
    const frozenOverlays = this.#database.native.prepare(`
      SELECT agent_id AS agentId, template_blob_sha256 AS blobSha256
      FROM release_source_files
      WHERE release_id = ? AND source_kind = 'instruction-overlay'
    `).all(sourceReleaseId) as { agentId: AgentId; blobSha256: string }[];
    const overlays = await Promise.all(frozenOverlays.map(async (overlay) => ({
      agentId: overlay.agentId,
      markdown: (await consume(await this.#blobStore.open(overlay.blobSha256))).toString("utf8"),
    })));

    return this.#database.native.transaction(() => {
      const current = this.#configSet(configSetId);
      if (current.draftRevision !== expectedDraftRevision) {
        throw new RevisionConflictError(expectedDraftRevision, current.draftRevision);
      }
      const source = this.#database.native.prepare(`
        SELECT release_number AS releaseNumber, enabled_agents AS enabledAgents
        FROM releases WHERE id = ? AND config_set_id = ?
      `).get(sourceReleaseId, configSetId) as { releaseNumber: number; enabledAgents: string } | undefined;
      if (!source) throw new Error(`Release ${sourceReleaseId} does not exist.`);
      const next = this.#database.native.prepare(
        "SELECT COALESCE(MAX(release_number), 0) + 1 AS number FROM releases WHERE config_set_id = ?",
      ).get(configSetId) as { number: number };
      const releaseId = ulid();
      const now = Date.now();
      const restoredDraftRevision = expectedDraftRevision + 1;
      this.#database.native.prepare(`
        INSERT INTO releases (
          id, config_set_id, release_number, draft_revision, enabled_agents,
          notes, min_cli_version, adapter_revisions, created_at
        ) SELECT ?, config_set_id, ?, ?, enabled_agents,
          ?, min_cli_version, adapter_revisions, ? FROM releases WHERE id = ?
      `).run(
        releaseId,
        next.number,
        restoredDraftRevision,
        `Rollback of release ${source.releaseNumber}`,
        now,
        sourceReleaseId,
      );

      this.#database.native.prepare("DELETE FROM draft_files WHERE config_set_id = ?").run(configSetId);
      const sourceFiles = this.#database.native.prepare(`
        SELECT agent_id AS agentId, root_id AS rootId, relative_path AS relativePath,
          template_blob_sha256 AS blobSha256, media_type AS mediaType, executable
        FROM release_source_files WHERE release_id = ? AND source_kind = 'draft-file'
      `).all(sourceReleaseId) as {
        agentId: AgentId;
        rootId: string;
        relativePath: string;
        blobSha256: string;
        mediaType: string;
        executable: number;
      }[];
      const insertDraft = this.#database.native.prepare(`
        INSERT INTO draft_files (
          id, config_set_id, agent_id, root_id, relative_path, blob_sha256,
          media_type, utf8, executable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of sourceFiles) insertDraft.run(
        ulid(), configSetId, file.agentId, file.rootId, file.relativePath, file.blobSha256,
        file.mediaType, Number(file.mediaType.startsWith("text/") || file.mediaType === "application/json"),
        file.executable, now, now,
      );

      this.#database.native.prepare("DELETE FROM agent_instruction_overlays WHERE config_set_id = ?").run(configSetId);
      const insertOverlay = this.#database.native.prepare(`
        INSERT INTO agent_instruction_overlays (id, config_set_id, agent_id, markdown, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const overlay of overlays) insertOverlay.run(ulid(), configSetId, overlay.agentId, overlay.markdown, now);

      this.#database.native.prepare("DELETE FROM config_set_resources WHERE config_set_id = ?").run(configSetId);
      this.#database.native.prepare(`
        INSERT INTO config_set_resources (
          config_set_id, resource_id, agent_id, resource_revision_id, sort_order
        )
        SELECT ?, revisions.resource_id, frozen.agent_id,
          frozen.resource_revision_id, frozen.sort_order
        FROM release_resource_revisions frozen
        JOIN resource_revisions revisions ON revisions.id = frozen.resource_revision_id
        WHERE frozen.release_id = ?
      `).run(configSetId, sourceReleaseId);

      const bindingRows = this.#database.native.prepare(`
        SELECT bindings.secret_slot_id AS slotId, bindings.slot_name AS slotName,
          bindings.agent_id AS agentId, bindings.binding_source AS bindingSource,
          bindings.credential_revision_id AS credentialRevisionId,
          revisions.credential_id AS credentialId
        FROM release_secret_bindings bindings
        JOIN credential_revisions revisions ON revisions.id = bindings.credential_revision_id
        WHERE bindings.release_id = ?
      `).all(sourceReleaseId) as {
        slotId: string;
        slotName: string;
        agentId: AgentId;
        bindingSource: "default" | "override";
        credentialId: string;
        credentialRevisionId: string;
      }[];
      const updateSlot = this.#database.native.prepare(
        "UPDATE secret_slots SET name = ?, updated_at = ? WHERE id = ? AND config_set_id = ?",
      );
      const updateDefault = this.#database.native.prepare(
        `UPDATE secret_slots
         SET default_credential_id = ?, default_credential_revision_id = ?, updated_at = ?
         WHERE id = ?`,
      );
      const deleteOverride = this.#database.native.prepare(
        "DELETE FROM secret_agent_overrides WHERE secret_slot_id = ? AND agent_id = ?",
      );
      const upsertOverride = this.#database.native.prepare(`
        INSERT INTO secret_agent_overrides (
          secret_slot_id, agent_id, credential_id, credential_revision_id
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (secret_slot_id, agent_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          credential_revision_id = excluded.credential_revision_id
      `);
      for (const binding of bindingRows) {
        updateSlot.run(binding.slotName, now, binding.slotId, configSetId);
        if (binding.bindingSource === "default") {
          updateDefault.run(binding.credentialId, binding.credentialRevisionId, now, binding.slotId);
          deleteOverride.run(binding.slotId, binding.agentId);
        } else {
          upsertOverride.run(binding.slotId, binding.agentId, binding.credentialId, binding.credentialRevisionId);
        }
      }

      const cloneSource = this.#database.native.prepare(`
        INSERT INTO release_source_files (
          id, release_id, agent_id, source_kind, root_id, relative_path,
          template_blob_sha256, media_type, executable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const allSources = this.#database.native.prepare(
        "SELECT * FROM release_source_files WHERE release_id = ?",
      ).all(sourceReleaseId) as Record<string, unknown>[];
      for (const file of allSources) cloneSource.run(
        ulid(), releaseId, file.agent_id, file.source_kind, file.root_id, file.relative_path,
        file.template_blob_sha256, file.media_type, file.executable,
      );
      const cloneOutput = this.#database.native.prepare(`
        INSERT INTO release_files (
          id, release_id, agent_id, root_id, relative_path, blob_sha256, size, executable, sensitive
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const outputs = this.#database.native.prepare(
        "SELECT * FROM release_files WHERE release_id = ?",
      ).all(sourceReleaseId) as Record<string, unknown>[];
      for (const file of outputs) cloneOutput.run(
        ulid(), releaseId, file.agent_id, file.root_id, file.relative_path,
        file.blob_sha256, file.size, file.executable, file.sensitive,
      );
      this.#database.native.prepare(`
        INSERT INTO release_secret_bindings (
          release_id, secret_slot_id, slot_name, agent_id, binding_source, credential_revision_id
        ) SELECT ?, secret_slot_id, slot_name, agent_id, binding_source, credential_revision_id
        FROM release_secret_bindings WHERE release_id = ?
      `).run(releaseId, sourceReleaseId);
      this.#database.native.prepare(`
        INSERT INTO release_resource_revisions (
          release_id, resource_revision_id, agent_id, sort_order
        )
        SELECT ?, resource_revision_id, agent_id, sort_order
        FROM release_resource_revisions WHERE release_id = ?
      `).run(releaseId, sourceReleaseId);
      this.#database.native.prepare(`
        UPDATE config_sets
        SET current_release_id = ?, enabled_agents = ?, draft_revision = ?, updated_at = ?
        WHERE id = ?
      `).run(releaseId, source.enabledAgents, restoredDraftRevision, now, configSetId);
      return { releaseId, releaseNumber: next.number };
    })();
  }

  deleteHistorical(configSetId: string, releaseId: string): void {
    this.#database.native.transaction(() => {
      const configSet = this.#configSet(configSetId);
      if (configSet.currentReleaseId === releaseId) throw new Error("CURRENT_RELEASE_CANNOT_BE_DELETED");
      const deletion = this.#database.native.prepare(
        "DELETE FROM releases WHERE id = ? AND config_set_id = ?",
      ).run(releaseId, configSetId);
      if (deletion.changes !== 1) throw new Error(`Release ${releaseId} does not exist.`);
    })();
  }

  #configSet(configSetId: string): ConfigSetRow {
    const row = this.#database.native.prepare(`
      SELECT id, name, slug, enabled_agents AS enabledAgents, draft_revision AS draftRevision,
        current_release_id AS currentReleaseId
      FROM config_sets WHERE id = ?
    `).get(configSetId) as ConfigSetRow | undefined;
    if (!row) throw new Error(`Config set ${configSetId} does not exist.`);
    return row;
  }

  #draftFiles(configSetId: string): DraftFileRow[] {
    return this.#database.native.prepare(`
      SELECT agent_id AS agentId, root_id AS rootId, relative_path AS relativePath,
        blob_sha256 AS blobSha256, media_type AS mediaType, utf8, executable
      FROM draft_files WHERE config_set_id = ?
      ORDER BY agent_id, root_id, relative_path
    `).all(configSetId) as DraftFileRow[];
  }

  #selectedResources(configSetId: string): SelectedResourceRow[] {
    return this.#database.native.prepare(`
      SELECT resources.id AS resourceId, resources.kind, resources.slug, resources.name,
        COALESCE(selected.resource_revision_id, resources.current_revision_id) AS revisionId,
        selected.resource_revision_id AS pinnedRevisionId, selected.agent_id AS agentId,
        selected.sort_order AS sortOrder
      FROM config_set_resources selected
      JOIN resources ON resources.id = selected.resource_id
      WHERE selected.config_set_id = ?
      ORDER BY selected.agent_id, selected.sort_order, resources.id
    `).all(configSetId) as SelectedResourceRow[];
  }

  #resourceFiles(revisionIds: readonly string[]): ResourceFileRow[] {
    if (revisionIds.length === 0) return [];
    const placeholders = revisionIds.map(() => "?").join(", ");
    const rows = this.#database.native.prepare(`
      SELECT resource_revision_id AS resourceRevisionId, relative_path AS relativePath,
        blob_sha256 AS blobSha256, media_type AS mediaType, executable
      FROM resource_revision_files
      WHERE resource_revision_id IN (${placeholders})
      ORDER BY relative_path
    `).all(...revisionIds) as (Omit<ResourceFileRow, "executable"> & { executable: number })[];
    return rows.map((row) => ({ ...row, executable: Boolean(row.executable) }));
  }
}
