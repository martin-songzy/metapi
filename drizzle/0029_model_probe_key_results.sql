CREATE TABLE `model_probe_key_results` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `site_id` integer NOT NULL,
  `account_id` integer NOT NULL,
  `token_id` integer NOT NULL,
  `token_name` text DEFAULT '' NOT NULL,
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
  FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `model_probe_key_results_model_name_idx` ON `model_probe_key_results` (`model_name`);
--> statement-breakpoint
CREATE INDEX `model_probe_key_results_site_id_idx` ON `model_probe_key_results` (`site_id`);
--> statement-breakpoint
CREATE INDEX `model_probe_key_results_account_id_idx` ON `model_probe_key_results` (`account_id`);
--> statement-breakpoint
CREATE INDEX `model_probe_key_results_token_id_idx` ON `model_probe_key_results` (`token_id`);
--> statement-breakpoint
CREATE INDEX `model_probe_key_results_status_idx` ON `model_probe_key_results` (`status`);
--> statement-breakpoint
CREATE INDEX `model_probe_key_results_checked_at_idx` ON `model_probe_key_results` (`checked_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_probe_key_results_account_token_model_unique` ON `model_probe_key_results` (`account_id`,`token_id`,`model_name`);
