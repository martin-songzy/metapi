CREATE TABLE `model_probe_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`account_id` integer,
	`model_name` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`http_status` integer,
	`failure_kind` text,
	`reason` text,
	`endpoint_used` text,
	`prompt_used` text,
	`user_agent_used` text,
	`checked_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_probe_results_site_model_unique` ON `model_probe_results` (`site_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `model_probe_results_model_name_idx` ON `model_probe_results` (`model_name`);--> statement-breakpoint
CREATE INDEX `model_probe_results_site_id_idx` ON `model_probe_results` (`site_id`);--> statement-breakpoint
CREATE INDEX `model_probe_results_account_id_idx` ON `model_probe_results` (`account_id`);--> statement-breakpoint
CREATE INDEX `model_probe_results_status_idx` ON `model_probe_results` (`status`);--> statement-breakpoint
CREATE INDEX `model_probe_results_checked_at_idx` ON `model_probe_results` (`checked_at`);
