ALTER TABLE "sites" ADD COLUMN "probe_endpoint_type" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "sites" ADD COLUMN "probe_user_agent" TEXT NOT NULL DEFAULT '';
