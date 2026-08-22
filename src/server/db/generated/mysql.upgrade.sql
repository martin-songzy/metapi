CREATE TABLE IF NOT EXISTS `model_probe_results` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `account_id` INT, `model_name` TEXT NOT NULL, `status` TEXT NOT NULL, `latency_ms` INT, `http_status` INT, `failure_kind` TEXT, `reason` TEXT, `endpoint_used` TEXT, `prompt_used` TEXT, `user_agent_used` TEXT, `checked_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE SET NULL, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
CREATE UNIQUE INDEX `model_probe_results_site_model_unique` ON `model_probe_results` (`site_id`, `model_name`(191));
CREATE INDEX `model_probe_results_account_id_idx` ON `model_probe_results` (`account_id`);
CREATE INDEX `model_probe_results_checked_at_idx` ON `model_probe_results` (`checked_at`);
CREATE INDEX `model_probe_results_model_name_idx` ON `model_probe_results` (`model_name`(191));
CREATE INDEX `model_probe_results_site_id_idx` ON `model_probe_results` (`site_id`);
CREATE INDEX `model_probe_results_status_idx` ON `model_probe_results` (`status`(191));
