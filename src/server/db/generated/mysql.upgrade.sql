ALTER TABLE `sites` ADD COLUMN `probe_endpoint_type` VARCHAR(191) NOT NULL DEFAULT 'auto';
ALTER TABLE `sites` ADD COLUMN `probe_user_agent` VARCHAR(191) NOT NULL DEFAULT '';
