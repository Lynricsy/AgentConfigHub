import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const timestamp = (name: string) => integer(name, { mode: "number" }).notNull();
const nullableTimestamp = (name: string) => integer(name, { mode: "number" });

export const adminAccount = sqliteTable("admin_account", {
  id: id(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const webSessions = sqliteTable("web_sessions", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at"),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  idleExpiresAt: timestamp("idle_expires_at"),
}, (table) => [index("web_sessions_expires_idx").on(table.expiresAt)]);

export const deviceAuthorizations = sqliteTable("device_authorizations", {
  id: id(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  deviceName: text("device_name").notNull(),
  cliVersion: text("cli_version").notNull(),
  requesterIp: text("requester_ip").notNull(),
  status: text("status", { enum: ["pending", "approved", "consumed"] }).notNull(),
  createdAt: timestamp("created_at"),
  expiresAt: timestamp("expires_at"),
  approvedAt: nullableTimestamp("approved_at"),
  consumedAt: nullableTimestamp("consumed_at"),
});

export const pullTokens = sqliteTable("pull_tokens", {
  id: id(),
  kind: text("kind", { enum: ["device", "automation"] }).notNull(),
  label: text("label").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at"),
  lastUsedAt: nullableTimestamp("last_used_at"),
  revokedAt: nullableTimestamp("revoked_at"),
});

export const configSets = sqliteTable("config_sets", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  enabledAgents: text("enabled_agents", { mode: "json" }).$type<string[]>().notNull(),
  draftRevision: integer("draft_revision", { mode: "number" }).notNull().default(1),
  currentReleaseId: text("current_release_id").references((): AnySQLiteColumn => releases.id),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [uniqueIndex("config_sets_slug_idx").on(table.slug)]);

export const blobs = sqliteTable("blobs", {
  sha256: text("sha256").primaryKey(),
  plaintextSize: integer("plaintext_size", { mode: "number" }).notNull(),
  encryptedPath: text("encrypted_path").notNull(),
  recordId: text("record_id").notNull().unique(),
  keyId: text("key_id").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  wrapNonce: text("wrap_nonce").notNull(),
  wrapTag: text("wrap_tag").notNull(),
  contentNonce: text("content_nonce").notNull(),
  contentTag: text("content_tag").notNull(),
  mediaType: text("media_type"),
  createdAt: timestamp("created_at"),
});

export const draftFiles = sqliteTable("draft_files", {
  id: id(),
  configSetId: text("config_set_id").notNull().references(() => configSets.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  rootId: text("root_id").notNull(),
  relativePath: text("relative_path").notNull(),
  blobSha256: text("blob_sha256").notNull().references(() => blobs.sha256),
  mediaType: text("media_type").notNull(),
  utf8: integer("utf8", { mode: "boolean" }).notNull(),
  executable: integer("executable", { mode: "boolean" }).notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [uniqueIndex("draft_files_target_idx").on(
  table.configSetId,
  table.agentId,
  table.rootId,
  table.relativePath,
)]);

export const agentInstructionOverlays = sqliteTable("agent_instruction_overlays", {
  id: id(),
  configSetId: text("config_set_id").notNull().references(() => configSets.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  markdown: text("markdown").notNull(),
  updatedAt: timestamp("updated_at"),
}, (table) => [uniqueIndex("agent_instruction_overlays_set_agent_idx").on(table.configSetId, table.agentId)]);

export const resources = sqliteTable("resources", {
  id: id(),
  kind: text("kind", { enum: ["instruction", "skill"] }).notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  currentRevisionId: text("current_revision_id").references((): AnySQLiteColumn => resourceRevisions.id),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [uniqueIndex("resources_slug_idx").on(table.slug)]);

export const resourceRevisions = sqliteTable("resource_revisions", {
  id: id(),
  resourceId: text("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [uniqueIndex("resource_revisions_number_idx").on(table.resourceId, table.revisionNumber)]);

export const resourceRevisionFiles = sqliteTable("resource_revision_files", {
  id: id(),
  resourceRevisionId: text("resource_revision_id").notNull().references(() => resourceRevisions.id, { onDelete: "cascade" }),
  relativePath: text("relative_path").notNull(),
  blobSha256: text("blob_sha256").notNull().references(() => blobs.sha256),
  mediaType: text("media_type").notNull(),
  executable: integer("executable", { mode: "boolean" }).notNull(),
}, (table) => [uniqueIndex("resource_revision_files_path_idx").on(table.resourceRevisionId, table.relativePath)]);

export const configSetResources = sqliteTable("config_set_resources", {
  configSetId: text("config_set_id").notNull().references(() => configSets.id, { onDelete: "cascade" }),
  resourceId: text("resource_id").notNull().references(() => resources.id, { onDelete: "cascade" }),
  resourceRevisionId: text("resource_revision_id").references(() => resourceRevisions.id),
  sortOrder: integer("sort_order", { mode: "number" }).notNull(),
  selectedAgents: text("selected_agents", { mode: "json" }).$type<string[]>().notNull(),
}, (table) => [primaryKey({ columns: [table.configSetId, table.resourceId] })]);

export const credentials = sqliteTable("credentials", {
  id: id(),
  label: text("label").notNull(),
  provider: text("provider").notNull(),
  currentRevisionId: text("current_revision_id").references((): AnySQLiteColumn => credentialRevisions.id),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const credentialRevisions = sqliteTable("credential_revisions", {
  id: id(),
  credentialId: text("credential_id").notNull().references(() => credentials.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number", { mode: "number" }).notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  recordId: text("record_id").notNull().unique(),
  keyId: text("key_id").notNull(),
  wrappedDek: text("wrapped_dek").notNull(),
  wrapNonce: text("wrap_nonce").notNull(),
  wrapTag: text("wrap_tag").notNull(),
  contentNonce: text("content_nonce").notNull(),
  contentTag: text("content_tag").notNull(),
  plaintextSha256: text("plaintext_sha256").notNull(),
  plaintextSize: integer("plaintext_size", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [uniqueIndex("credential_revisions_number_idx").on(table.credentialId, table.revisionNumber)]);

export const secretSlots = sqliteTable("secret_slots", {
  id: id(),
  configSetId: text("config_set_id").notNull().references(() => configSets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  defaultCredentialId: text("default_credential_id").references(() => credentials.id),
  defaultCredentialRevisionId: text("default_credential_revision_id").references(() => credentialRevisions.id),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [uniqueIndex("secret_slots_set_name_idx").on(table.configSetId, table.name)]);

export const secretAgentOverrides = sqliteTable("secret_agent_overrides", {
  secretSlotId: text("secret_slot_id").notNull().references(() => secretSlots.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  credentialId: text("credential_id").notNull().references(() => credentials.id),
  credentialRevisionId: text("credential_revision_id").references(() => credentialRevisions.id),
}, (table) => [primaryKey({ columns: [table.secretSlotId, table.agentId] })]);

export const releases = sqliteTable("releases", {
  id: id(),
  configSetId: text("config_set_id").notNull().references(() => configSets.id, { onDelete: "cascade" }),
  releaseNumber: integer("release_number", { mode: "number" }).notNull(),
  draftRevision: integer("draft_revision", { mode: "number" }).notNull(),
  enabledAgents: text("enabled_agents", { mode: "json" }).$type<string[]>().notNull(),
  notes: text("notes"),
  minCliVersion: text("min_cli_version").notNull(),
  adapterRevisions: text("adapter_revisions", { mode: "json" }).$type<Record<string, number>>().notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [uniqueIndex("releases_set_number_idx").on(table.configSetId, table.releaseNumber)]);

export const releaseSourceFiles = sqliteTable("release_source_files", {
  id: id(),
  releaseId: text("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  sourceKind: text("source_kind", { enum: ["draft-file", "instruction-overlay"] }).notNull(),
  rootId: text("root_id").notNull(),
  relativePath: text("relative_path").notNull(),
  templateBlobSha256: text("template_blob_sha256").notNull().references(() => blobs.sha256),
  mediaType: text("media_type").notNull(),
  executable: integer("executable", { mode: "boolean" }).notNull(),
}, (table) => [uniqueIndex("release_source_files_target_idx").on(table.releaseId, table.agentId, table.rootId, table.relativePath)]);

export const releaseFiles = sqliteTable("release_files", {
  id: id(),
  releaseId: text("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  rootId: text("root_id").notNull(),
  relativePath: text("relative_path").notNull(),
  blobSha256: text("blob_sha256").notNull().references(() => blobs.sha256),
  size: integer("size", { mode: "number" }).notNull(),
  executable: integer("executable", { mode: "boolean" }).notNull(),
  sensitive: integer("sensitive", { mode: "boolean" }).notNull(),
}, (table) => [uniqueIndex("release_files_target_idx").on(table.releaseId, table.agentId, table.rootId, table.relativePath)]);

export const releaseSecretBindings = sqliteTable("release_secret_bindings", {
  releaseId: text("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  secretSlotId: text("secret_slot_id").notNull().references(() => secretSlots.id),
  slotName: text("slot_name").notNull(),
  agentId: text("agent_id").notNull(),
  bindingSource: text("binding_source", { enum: ["default", "override"] }).notNull(),
  credentialRevisionId: text("credential_revision_id").notNull().references(() => credentialRevisions.id),
}, (table) => [primaryKey({ columns: [table.releaseId, table.secretSlotId, table.agentId] })]);

export const releaseResourceRevisions = sqliteTable("release_resource_revisions", {
  releaseId: text("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  resourceRevisionId: text("resource_revision_id").notNull().references(() => resourceRevisions.id),
  sortOrder: integer("sort_order", { mode: "number" }).notNull(),
  selectedAgents: text("selected_agents", { mode: "json" }).$type<string[]>().notNull(),
}, (table) => [primaryKey({ columns: [table.releaseId, table.resourceRevisionId] })]);

export const auditEvents = sqliteTable("audit_events", {
  id: id(),
  kind: text("kind").notNull(),
  subjectId: text("subject_id"),
  label: text("label"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, string | number | boolean | null>>(),
  createdAt: timestamp("created_at"),
}, (table) => [index("audit_events_created_idx").on(table.createdAt)]);
