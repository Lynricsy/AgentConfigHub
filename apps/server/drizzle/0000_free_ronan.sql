CREATE TABLE `admin_account` (
	`id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_instruction_overlays` (
	`id` text PRIMARY KEY NOT NULL,
	`config_set_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`markdown` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`config_set_id`) REFERENCES `config_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instruction_overlays_set_agent_idx` ON `agent_instruction_overlays` (`config_set_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text,
	`label` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`plaintext_size` integer NOT NULL,
	`encrypted_path` text NOT NULL,
	`record_id` text NOT NULL,
	`key_id` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`wrap_nonce` text NOT NULL,
	`wrap_tag` text NOT NULL,
	`content_nonce` text NOT NULL,
	`content_tag` text NOT NULL,
	`media_type` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blobs_record_id_unique` ON `blobs` (`record_id`);--> statement-breakpoint
CREATE TABLE `config_set_resources` (
	`config_set_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`selected_agents` text NOT NULL,
	PRIMARY KEY(`config_set_id`, `resource_id`),
	FOREIGN KEY (`config_set_id`) REFERENCES `config_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `config_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`enabled_agents` text NOT NULL,
	`draft_revision` integer DEFAULT 1 NOT NULL,
	`current_release_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`current_release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_sets_slug_idx` ON `config_sets` (`slug`);--> statement-breakpoint
CREATE TABLE `credential_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`encrypted_value` text NOT NULL,
	`record_id` text NOT NULL,
	`key_id` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`wrap_nonce` text NOT NULL,
	`wrap_tag` text NOT NULL,
	`content_nonce` text NOT NULL,
	`content_tag` text NOT NULL,
	`plaintext_sha256` text NOT NULL,
	`plaintext_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_revisions_record_id_unique` ON `credential_revisions` (`record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credential_revisions_number_idx` ON `credential_revisions` (`credential_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`current_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`current_revision_id`) REFERENCES `credential_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `device_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`device_name` text NOT NULL,
	`cli_version` text NOT NULL,
	`requester_ip` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorizations_device_code_hash_unique` ON `device_authorizations` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_authorizations_user_code_unique` ON `device_authorizations` (`user_code`);--> statement-breakpoint
CREATE TABLE `draft_files` (
	`id` text PRIMARY KEY NOT NULL,
	`config_set_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`root_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`blob_sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`utf8` integer NOT NULL,
	`executable` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`config_set_id`) REFERENCES `config_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_sha256`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_files_target_idx` ON `draft_files` (`config_set_id`,`agent_id`,`root_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `pull_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_tokens_token_hash_unique` ON `pull_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `release_files` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`root_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`blob_sha256` text NOT NULL,
	`size` integer NOT NULL,
	`executable` integer NOT NULL,
	`sensitive` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_sha256`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_files_target_idx` ON `release_files` (`release_id`,`agent_id`,`root_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `release_resource_revisions` (
	`release_id` text NOT NULL,
	`resource_revision_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`selected_agents` text NOT NULL,
	PRIMARY KEY(`release_id`, `resource_revision_id`),
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_revision_id`) REFERENCES `resource_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `release_secret_bindings` (
	`release_id` text NOT NULL,
	`secret_slot_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`credential_revision_id` text NOT NULL,
	PRIMARY KEY(`release_id`, `secret_slot_id`, `agent_id`),
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`secret_slot_id`) REFERENCES `secret_slots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_revision_id`) REFERENCES `credential_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `release_source_files` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`root_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`template_blob_sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`executable` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_blob_sha256`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_source_files_target_idx` ON `release_source_files` (`release_id`,`agent_id`,`root_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`config_set_id` text NOT NULL,
	`release_number` integer NOT NULL,
	`draft_revision` integer NOT NULL,
	`enabled_agents` text NOT NULL,
	`notes` text,
	`min_cli_version` text NOT NULL,
	`adapter_revisions` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`config_set_id`) REFERENCES `config_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_set_number_idx` ON `releases` (`config_set_id`,`release_number`);--> statement-breakpoint
CREATE TABLE `resource_revision_files` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_revision_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`blob_sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`executable` integer NOT NULL,
	FOREIGN KEY (`resource_revision_id`) REFERENCES `resource_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_sha256`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_revision_files_path_idx` ON `resource_revision_files` (`resource_revision_id`,`relative_path`);--> statement-breakpoint
CREATE TABLE `resource_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_revisions_number_idx` ON `resource_revisions` (`resource_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`current_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`current_revision_id`) REFERENCES `resource_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_slug_idx` ON `resources` (`slug`);--> statement-breakpoint
CREATE TABLE `secret_agent_overrides` (
	`secret_slot_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`credential_id` text NOT NULL,
	PRIMARY KEY(`secret_slot_id`, `agent_id`),
	FOREIGN KEY (`secret_slot_id`) REFERENCES `secret_slots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secret_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`config_set_id` text NOT NULL,
	`name` text NOT NULL,
	`default_credential_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`config_set_id`) REFERENCES `config_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_slots_set_name_idx` ON `secret_slots` (`config_set_id`,`name`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_sessions_token_hash_unique` ON `web_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `web_sessions_expires_idx` ON `web_sessions` (`expires_at`);