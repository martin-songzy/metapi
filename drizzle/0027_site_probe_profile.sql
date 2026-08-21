ALTER TABLE `sites` ADD `probe_endpoint_type` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `probe_user_agent` text DEFAULT '' NOT NULL;
