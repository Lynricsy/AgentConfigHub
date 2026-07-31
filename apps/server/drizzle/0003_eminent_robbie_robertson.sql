PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_config_set_resources` (
	`config_set_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`resource_revision_id` text,
	`sort_order` integer NOT NULL,
	PRIMARY KEY(`config_set_id`, `resource_id`, `agent_id`),
	FOREIGN KEY (`config_set_id`) REFERENCES `config_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_revision_id`) REFERENCES `resource_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_config_set_resources`("config_set_id", "resource_id", "agent_id", "resource_revision_id", "sort_order")
SELECT old."config_set_id", old."resource_id", agents.value,
	old."resource_revision_id", old."sort_order"
FROM `config_set_resources` AS old, json_each(old."selected_agents") AS agents;--> statement-breakpoint
DROP TABLE `config_set_resources`;--> statement-breakpoint
ALTER TABLE `__new_config_set_resources` RENAME TO `config_set_resources`;--> statement-breakpoint
CREATE TABLE `__new_release_resource_revisions` (
	`release_id` text NOT NULL,
	`resource_revision_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	PRIMARY KEY(`release_id`, `resource_revision_id`, `agent_id`),
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_revision_id`) REFERENCES `resource_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_release_resource_revisions`("release_id", "resource_revision_id", "agent_id", "sort_order")
SELECT old."release_id", old."resource_revision_id", agents.value, old."sort_order"
FROM `release_resource_revisions` AS old, json_each(old."selected_agents") AS agents;--> statement-breakpoint
DROP TABLE `release_resource_revisions`;--> statement-breakpoint
ALTER TABLE `__new_release_resource_revisions` RENAME TO `release_resource_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;