import { describe, expect, it } from 'vitest';
import { classifyLegacyCompatMutation } from './legacySchemaCompat.js';

describe('legacy schema compat boundary', () => {
  it('allows only explicitly registered legacy upgrade shims', () => {
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN billing_details text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN is_stream integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN first_byte_latency_ms integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN client_app_id text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX proxy_logs_client_app_id_created_at_idx ON proxy_logs(client_app_id, created_at);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "global_weight" = 1 WHERE "global_weight" IS NULL OR "global_weight" <= 0')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN brand_new_column text;')).toBe('forbidden');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "brand_new_column" = 1')).toBe('forbidden');
    // The allowlist is derived from the compatibility specs, so retiring a shim
    // retires its permission too: these two columns were dropped with the proxy
    // pool rewrite, and re-adding them via a legacy shim is now forbidden rather
    // than silently tolerated.
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN proxy_url text;')).toBe('forbidden');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN use_system_proxy integer DEFAULT 0;')).toBe('forbidden');
  });
});
