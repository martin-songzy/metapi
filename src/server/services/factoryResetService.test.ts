import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type ServiceModule = typeof import('./factoryResetService.js');

describe('factoryResetService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let performFactoryReset: ServiceModule['performFactoryReset'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-factory-reset-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./factoryResetService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    performFactoryReset = serviceModule.performFactoryReset;
    // Building the sqlite file plus these four dynamic imports runs past vitest's
    // 10s hook default on a cold Windows filesystem, which fails the suite before a
    // single assertion runs.
  }, 60_000);

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyVideoTasks).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();

    config.authToken = 'external-reset-token';
    config.dbType = 'postgres';
    config.dbUrl = 'postgres://user:pass@127.0.0.1:5432/metapi';
    config.dbSsl = true;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('clears current active data while preserving external runtime connectivity', async () => {
    await db.insert(schema.sites).values({
      name: 'External Runtime Site',
      url: 'https://external.example.com',
      platform: 'new-api',
    }).run();
    await db.insert(schema.settings).values([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
      { key: 'db_type', value: JSON.stringify('postgres') },
      { key: 'db_url', value: JSON.stringify('postgres://user:pass@127.0.0.1:5432/metapi') },
      { key: 'db_ssl', value: JSON.stringify(true) },
    ]).run();

    const switchRuntimeDatabase = vi.fn(async () => undefined);
    const runSqliteMigrations = vi.fn(() => undefined);
    const ensureDefaultSitesSeeded = vi.fn(async () => ({
      seeded: 0,
      alreadyMarked: false,
      hadExistingSites: false,
    }));

    await performFactoryReset({
      switchRuntimeDatabase,
      runSqliteMigrations,
      ensureDefaultSitesSeeded,
    });

    expect(switchRuntimeDatabase).toHaveBeenCalledWith('postgres', 'postgres://user:pass@127.0.0.1:5432/metapi', true);
    expect(runSqliteMigrations).not.toHaveBeenCalled();
    expect(ensureDefaultSitesSeeded).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.sites).all()).toHaveLength(0);
    expect(await db.select().from(schema.settings).all()).toEqual([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
      { key: 'proxy_token', value: JSON.stringify('change-me-proxy-sk-token') },
      { key: 'db_type', value: JSON.stringify('postgres') },
      { key: 'db_url', value: JSON.stringify('postgres://user:pass@127.0.0.1:5432/metapi') },
      { key: 'db_ssl', value: JSON.stringify(true) },
    ]);
  });

  it('preserves the proxy pool, which has no runtime mirror to restore from', async () => {
    const pool = [{ id: 'px_hk', name: '香港', url: 'socks5://127.0.0.1:7890' }];
    await db.insert(schema.settings).values([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
      { key: 'proxy_pool_v1', value: JSON.stringify(pool) },
      // Wiped like any other business setting, to prove the pool is preserved by
      // being on the allow list rather than by the wipe being incomplete.
      { key: 'checkin_cron', value: JSON.stringify('0 9 * * *') },
    ]).run();

    await performFactoryReset({
      switchRuntimeDatabase: vi.fn(async () => undefined),
      runSqliteMigrations: vi.fn(() => undefined),
      ensureDefaultSitesSeeded: vi.fn(async () => ({
        seeded: 0,
        alreadyMarked: false,
        hadExistingSites: false,
      })),
    });

    const rows = await db.select().from(schema.settings).all();
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    // The operator's ruling: a proxy is infrastructure. Losing it can leave an
    // instance unable to reach any upstream — including the one needed to fix it.
    expect(byKey.get('proxy_pool_v1')).toBe(JSON.stringify(pool));
    expect(byKey.has('checkin_cron')).toBe(false);
  });

  it('does not write a pool key when there was no pool to preserve', async () => {
    await db.insert(schema.settings).values([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
    ]).run();

    await performFactoryReset({
      switchRuntimeDatabase: vi.fn(async () => undefined),
      runSqliteMigrations: vi.fn(() => undefined),
      ensureDefaultSitesSeeded: vi.fn(async () => ({
        seeded: 0,
        alreadyMarked: false,
        hadExistingSites: false,
      })),
    });

    const keys = (await db.select().from(schema.settings).all()).map((row) => row.key);
    // A reset instance that never had a proxy must not come back holding an empty
    // pool row: the settings page renders the pool from this row, so an empty array
    // and an absent key would look the same there but differ on the next export.
    expect(keys).not.toContain('proxy_pool_v1');
  });
});
