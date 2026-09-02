import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('sites batch routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-batch-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    await db.insert(schema.settings).values({
      key: 'proxy_pool_v1',
      value: JSON.stringify([{ id: 'px_hk', name: '香港', url: 'socks5://127.0.0.1:1080' }]),
    }).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('sets the proxy reference for selected sites and reports failures', async () => {
    await db.insert(schema.sites).values([
      {
        id: 1,
        name: 'site-1',
        url: 'https://site-1.example.com',
        platform: 'new-api',
        proxyRef: null,
      },
      {
        id: 2,
        name: 'site-2',
        url: 'https://site-2.example.com',
        platform: 'new-api',
        proxyRef: null,
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1, 2, 999],
        action: 'setProxyRef',
        proxyRef: 'px_hk',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      successIds?: number[];
      failedItems?: Array<{ id: number; message: string }>;
    };
    expect(body.successIds).toEqual([1, 2]);
    expect(body.failedItems).toHaveLength(1);
    expect(body.failedItems?.[0]?.id).toBe(999);

    const rows = await db.select().from(schema.sites).all();
    expect(rows.every((row) => row.proxyRef === 'px_hk')).toBe(true);
  });

  /**
   * A batch action with no target is a mistake, not a no-op.
   *
   * Defaulting an absent `proxyRef` to null would silently unproxy every selected
   * site, which is the most damaging thing this endpoint can do by accident.
   */
  it('rejects setProxyRef when the payload carries no reference', async () => {
    await db.insert(schema.sites).values({
      id: 1,
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
      proxyRef: 'px_hk',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'setProxyRef',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('proxyRef is required');

    const rows = await db.select().from(schema.sites).all();
    expect(rows[0]?.proxyRef).toBe('px_hk');
  });

  it('rejects setProxyRef when the reference is not in the pool', async () => {
    await db.insert(schema.sites).values({
      id: 1,
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'setProxyRef',
        proxyRef: 'px_gone',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('Unknown proxyRef');
  });

  it('clears the proxy reference for selected sites when given an explicit null', async () => {
    await db.insert(schema.sites).values({
      id: 1,
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
      proxyRef: 'px_hk',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'setProxyRef',
        proxyRef: null,
      },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(schema.sites).all();
    expect(rows[0]?.proxyRef).toBeNull();
  });

  it('rejects invalid sites batch action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'nope',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('action');
  });

  it('rejects non-number site ids at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: ['1'],
        action: 'enable',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Invalid ids. Expected number[].',
    });
  });
});

