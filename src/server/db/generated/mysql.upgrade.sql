CREATE TABLE IF NOT EXISTS `model_probe_key_results` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `account_id` INT NOT NULL, `token_id` INT NOT NULL, `token_name` VARCHAR(191) NOT NULL DEFAULT '', `model_name` TEXT NOT NULL, `status` TEXT NOT NULL, `latency_ms` INT, `http_status` INT, `failure_kind` TEXT, `reason` TEXT, `endpoint_used` TEXT, `prompt_used` TEXT, `user_agent_used` TEXT, `checked_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
ALTER TABLE `sites` ADD COLUMN `proxy_ref` TEXT;
CREATE UNIQUE INDEX `model_probe_key_results_account_token_model_unique` ON `model_probe_key_results` (`account_id`, `token_id`, `model_name`(191));
CREATE INDEX `model_probe_key_results_account_id_idx` ON `model_probe_key_results` (`account_id`);
CREATE INDEX `model_probe_key_results_checked_at_idx` ON `model_probe_key_results` (`checked_at`);
CREATE INDEX `model_probe_key_results_model_name_idx` ON `model_probe_key_results` (`model_name`(191));
CREATE INDEX `model_probe_key_results_site_id_idx` ON `model_probe_key_results` (`site_id`);
CREATE INDEX `model_probe_key_results_status_idx` ON `model_probe_key_results` (`status`(191));
CREATE INDEX `model_probe_key_results_token_id_idx` ON `model_probe_key_results` (`token_id`);
