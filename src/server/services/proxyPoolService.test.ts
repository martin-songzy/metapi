import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import { getProxyRefFromExtraConfig } from './accountExtraConfig.js';

/**
 * The proxy pool is the ONE place a proxy address is entered, so the properties
 * that matter most here are about references surviving edits:
 * - an id must never change or be reused, or "delete one entry" silently repoints
 *   every reference after it
 * - editing an address in place must keep the id, which is what makes "change it
 *   once, every site follows" work
 * - a reference to a deleted entry must read as "no proxy", never as some other
 *   entry — a site quietly using the WRONG proxy is worse than not proxying
 */

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./proxyPoolService.js');

describe('proxyPoolService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let service: ServiceModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-pool-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    service = await import('./proxyPoolService.js');
    // Migration plus this module graph exceeds the 10s default on a cold Windows
    // filesystem.
  }, 60_000);

  beforeEach(async () => {
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    if (typeof closeDbConnections === 'function') {
      await closeDbConnections();
    }
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  it('starts empty and round-trips an added entry', async () => {
    expect(await service.loadProxyPool()).toEqual([]);

    const entry = await service.addProxyPoolEntry({ name: '香港', url: 'socks5://127.0.0.1:7890' });
    expect(entry.id).toMatch(/^px_[0-9a-f]{12}$/);

    const pool = await service.loadProxyPool();
    expect(pool).toEqual([{ id: entry.id, name: '香港', url: 'socks5://127.0.0.1:7890' }]);
  });

  it('names an unnamed entry after its host:port rather than leaving it blank', async () => {
    const entry = await service.addProxyPoolEntry({ url: 'http://10.0.0.5:8080' });
    // A list of blank rows is unusable, and this is the same fallback migration
    // uses for addresses that were never named.
    expect(entry.name).toBe('10.0.0.5:8080');
  });

  it('refuses an address whose protocol cannot be proxied', async () => {
    await expect(service.addProxyPoolEntry({ url: 'ftp://10.0.0.5:8080' }))
      .rejects.toThrow(/代理地址无效/);
    await expect(service.addProxyPoolEntry({ url: '   ' })).rejects.toThrow(/代理地址无效/);
    expect(await service.loadProxyPool()).toEqual([]);
  });

  it('keeps the id when the address is edited, so every referrer follows', async () => {
    const entry = await service.addProxyPoolEntry({ name: '香港', url: 'socks5://127.0.0.1:7890' });
    const updated = await service.updateProxyPoolEntry(entry.id, { url: 'socks5://127.0.0.1:1080' });

    // The id is the whole contract with sites/connections: changing it here would
    // orphan every reference instead of redirecting it.
    expect(updated.id).toBe(entry.id);
    expect(updated.url).toBe('socks5://127.0.0.1:1080');
    expect(updated.name).toBe('香港');

    const pool = await service.loadProxyPool();
    expect(service.resolveProxyRef(entry.id, pool)).toBe('socks5://127.0.0.1:1080');
  });

  it('rejects an invalid edit without corrupting the stored entry', async () => {
    const entry = await service.addProxyPoolEntry({ name: '香港', url: 'socks5://127.0.0.1:7890' });
    await expect(service.updateProxyPoolEntry(entry.id, { url: 'nonsense' }))
      .rejects.toThrow(/代理地址无效/);

    const pool = await service.loadProxyPool();
    expect(pool[0]?.url).toBe('socks5://127.0.0.1:7890');
  });

  it('does not reuse an id after a delete, so a later entry cannot inherit references', async () => {
    const first = await service.addProxyPoolEntry({ name: 'a', url: 'http://10.0.0.1:1' });
    const second = await service.addProxyPoolEntry({ name: 'b', url: 'http://10.0.0.2:2' });
    await service.deleteProxyPoolEntry(first.id);
    const third = await service.addProxyPoolEntry({ name: 'c', url: 'http://10.0.0.3:3' });

    expect(third.id).not.toBe(first.id);
    // The surviving entry keeps its own id: deleting an earlier row must not
    // shift what any other reference points at.
    const pool = await service.loadProxyPool();
    expect(service.resolveProxyRef(second.id, pool)).toBe('http://10.0.0.2:2');
  });

  it('treats a reference to a deleted entry as no proxy, never as another entry', async () => {
    const gone = await service.addProxyPoolEntry({ name: 'gone', url: 'http://10.0.0.1:1' });
    const kept = await service.addProxyPoolEntry({ name: 'kept', url: 'http://10.0.0.2:2' });
    await service.deleteProxyPoolEntry(gone.id);

    const pool = await service.loadProxyPool();
    // Falling back to `kept` here would send traffic through a proxy the operator
    // never chose for that site — the one outcome worse than not proxying.
    expect(service.resolveProxyRef(gone.id, pool)).toBeNull();
    expect(service.isDanglingProxyRef(gone.id, pool)).toBe(true);
    expect(service.isDanglingProxyRef(kept.id, pool)).toBe(false);
  });

  it('distinguishes inherit from explicit-no-proxy', async () => {
    const entry = await service.addProxyPoolEntry({ name: 'a', url: 'http://10.0.0.1:1' });
    const pool = await service.loadProxyPool();

    // Both resolve to "no address", but the CALLER must be able to tell them
    // apart: undefined means "ask the layer above", null means "override it".
    expect(service.resolveProxyRef(undefined, pool)).toBeNull();
    expect(service.resolveProxyRef(null, pool)).toBeNull();
    expect(service.isDanglingProxyRef(undefined, pool)).toBe(false);
    expect(service.isDanglingProxyRef(null, pool)).toBe(false);
    expect(service.resolveProxyRef(entry.id, pool)).toBe('http://10.0.0.1:1');
  });

  it('allows two entries to share one address', async () => {
    // Legitimate: same host, two names, two independently-managed selections.
    // De-duplicating would merge two sites' choices into one.
    const first = await service.addProxyPoolEntry({ name: '香港-A', url: 'http://10.0.0.1:1' });
    const second = await service.addProxyPoolEntry({ name: '香港-B', url: 'http://10.0.0.1:1' });

    expect(first.id).not.toBe(second.id);
    expect(await service.loadProxyPool()).toHaveLength(2);
  });

  it('reports not_found rather than silently succeeding', async () => {
    await expect(service.deleteProxyPoolEntry('px_missing')).rejects.toThrow(/代理不存在/);
    await expect(service.updateProxyPoolEntry('px_missing', { name: 'x' })).rejects.toThrow(/代理不存在/);
  });

  it('drops corrupt rows one by one instead of failing the whole read', async () => {
    // Degrading one site to "no proxy" beats throwing on every page that renders
    // proxy state.
    const coerced = service.coerceProxyPool([
      { id: 'px_ok', name: 'ok', url: 'http://10.0.0.1:1' },
      { id: 'px_bad', name: 'bad', url: 'ftp://nope' },
      { id: '', name: 'no id', url: 'http://10.0.0.2:2' },
      { id: 'px_ok', name: 'duplicate id', url: 'http://10.0.0.3:3' },
      null,
      'not an object',
    ]);
    expect(coerced).toEqual([{ id: 'px_ok', name: 'ok', url: 'http://10.0.0.1:1' }]);
    expect(service.coerceProxyPool('not an array')).toEqual([]);
    expect(service.coerceProxyPool(null)).toEqual([]);
  });

  /**
   * The delete fix-up. `proxy_ref` cannot be a foreign key — the pool is a JSON
   * settings row, so there is no table to point at — which means nothing in the
   * database cleans up behind a delete. These are the tests standing in for the
   * cascade the schema cannot express.
   */
  describe('deleting an entry that is in use', () => {
    async function seedSite(name: string, proxyRef: string | null) {
      return db.insert(schema.sites).values({
        name,
        url: `https://${name}.example.com`,
        platform: 'new-api',
        status: 'active',
        proxyRef,
      }).returning().get();
    }

    async function seedAccount(siteId: number, username: string, extraConfig: string) {
      return db.insert(schema.accounts).values({
        siteId,
        username,
        accessToken: '',
        status: 'active',
        extraConfig,
      }).returning().get();
    }

    beforeEach(async () => {
      await db.delete(schema.accounts).run();
      await db.delete(schema.sites).run();
    });

    it('names every referrer before the operator commits', async () => {
      const entry = await service.addProxyPoolEntry({ name: '香港', url: 'http://10.0.0.1:1' });
      const other = await service.addProxyPoolEntry({ name: '日本', url: 'http://10.0.0.2:2' });
      const used = await seedSite('used', entry.id);
      await seedSite('untouched', other.id);
      await seedAccount(used.id, 'ops@example.com', JSON.stringify({ proxyRef: entry.id }));
      await seedAccount(used.id, 'other@example.com', JSON.stringify({ proxyRef: other.id }));

      const referrers = await service.listProxyPoolReferrers(entry.id);
      expect(referrers.siteNames).toEqual(['used']);
      expect(referrers.accountLabels).toEqual(['ops@example.com']);
    });

    it('resets every referrer to no-proxy instead of leaving a dangling ref', async () => {
      const entry = await service.addProxyPoolEntry({ name: '香港', url: 'http://10.0.0.1:1' });
      const kept = await service.addProxyPoolEntry({ name: '日本', url: 'http://10.0.0.2:2' });
      const site = await seedSite('used', entry.id);
      const keptSite = await seedSite('kept', kept.id);
      const account = await seedAccount(site.id, 'ops@example.com', JSON.stringify({ proxyRef: entry.id }));

      await service.deleteProxyPoolEntry(entry.id);

      const siteRows = await db.select().from(schema.sites).all();
      expect(siteRows.find((row) => row.id === site.id)?.proxyRef).toBeNull();
      // A site pointing at a DIFFERENT entry must not be touched.
      expect(siteRows.find((row) => row.id === keptSite.id)?.proxyRef).toBe(kept.id);

      const accountRow = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, account.id)).get();
      // Explicit null, not a removed key: the connection had chosen a specific
      // proxy, so it must not silently start following its site's choice.
      expect(getProxyRefFromExtraConfig(accountRow?.extraConfig)).toBeNull();
    });

    it('keeps unrelated extra_config keys when it resets a connection', async () => {
      const entry = await service.addProxyPoolEntry({ name: '香港', url: 'http://10.0.0.1:1' });
      const site = await seedSite('used', entry.id);
      const account = await seedAccount(site.id, 'ops@example.com', JSON.stringify({
        proxyRef: entry.id,
        credentialMode: 'apikey',
        platformUserId: 42,
      }));

      await service.deleteProxyPoolEntry(entry.id);

      const accountRow = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, account.id)).get();
      const parsed = JSON.parse(accountRow?.extraConfig || '{}');
      expect(parsed).toMatchObject({ proxyRef: null, credentialMode: 'apikey', platformUserId: 42 });
    });

    it('leaves an inheriting connection inheriting', async () => {
      const entry = await service.addProxyPoolEntry({ name: '香港', url: 'http://10.0.0.1:1' });
      const site = await seedSite('used', entry.id);
      // No `proxyRef` key at all: this connection said "follow the site". The
      // delete must not convert that into an explicit no-proxy, which would
      // permanently pin it away from whatever the site chooses next.
      const account = await seedAccount(site.id, 'inherits', JSON.stringify({ credentialMode: 'auto' }));

      await service.deleteProxyPoolEntry(entry.id);

      const accountRow = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, account.id)).get();
      expect(getProxyRefFromExtraConfig(accountRow?.extraConfig)).toBeUndefined();
    });
  });

  it('survives a settings row holding malformed JSON', async () => {
    await db.insert(schema.settings)
      .values({ key: service.PROXY_POOL_SETTING_KEY, value: '{not json' })
      .run();
    expect(await service.loadProxyPool()).toEqual([]);
  });
});
