ALTER TABLE `config_set_resources` ADD `resource_revision_id` text REFERENCES resource_revisions(id);--> statement-breakpoint
ALTER TABLE `secret_agent_overrides` ADD `credential_revision_id` text REFERENCES credential_revisions(id);--> statement-breakpoint
ALTER TABLE `secret_slots` ADD `default_credential_revision_id` text REFERENCES credential_revisions(id);