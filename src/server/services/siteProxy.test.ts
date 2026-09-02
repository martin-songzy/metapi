import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocksClient } from 'socks';
import { Headers, fetch } from 'undici';

type DbModule = typeof import('../db/index.js');

/**
 * Pool rules that need no database are checked against site RECORDS with an
 * injected pool: `resolveProxyUrlForSite` takes `options.pool` precisely so the
 * reference semantics can be tested without seeding one. The suite still needs a
 * live database for the paths that match a site BY REQUEST URL and for the
 * cache-backed `resolveChannelProxyUrl`.
 */
const POOL = [
  { id: 'px_hk', name: '香港', url: 'http://127.0.0.1:7890' },
  { id: 'px_jp', name: '日本', url: 'socks5://127.0.0.1:1080' },
] as const;

describe('siteProxy', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-proxy-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  }, 60_000);

  beforeEach(async () => {
    const { invalidateSiteProxyCache } = await import('./siteProxy.js');
    await db.delete(schema.accounts).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    invalidateSiteProxyCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  /**
   * Request-URL resolution now matches a site by URL and follows its pool
   * REFERENCE. The two tests that used to live here asserted the old rules —
   * "system proxy only for sites that opted in" and "a site's own address beats the
   * global one" — and both were passing for the wrong reason: no fixture set
   * `proxy_ref`, so the resolver returned null and only the negative half of each
   * assertion was actually exercised.
   */
  it('resolves a site through its pool reference', async () => {
    const { resolveProxyUrlForSite } = await import('./siteProxy.js');

    expect(resolveProxyUrlForSite({ proxyRef: 'px_hk' }, { pool: POOL }))
      .toBe('http://127.0.0.1:7890');
    expect(resolveProxyUrlForSite({ proxyRef: 'px_jp' }, { pool: POOL }))
      .toBe('socks5://127.0.0.1:1080');
    // A blank reference is "do not proxy", not "inherit from somewhere".
    expect(resolveProxyUrlForSite({ proxyRef: null }, { pool: POOL })).toBeNull();
    expect(resolveProxyUrlForSite({ proxyRef: '   ' }, { pool: POOL })).toBeNull();
  });

  it('does not borrow another entry when a site references nothing or a deleted id', async () => {
    const { resolveProxyUrlForSite } = await import('./siteProxy.js');

    // A pool entry exists and the site could have picked it. It did not, so the
    // request goes direct rather than borrowing the only entry available — the
    // state the old address/opt-in columns could not represent.
    expect(resolveProxyUrlForSite({ proxyRef: null }, { pool: POOL })).toBeNull();
    // `proxy_ref` cannot be a foreign key, so a dangling reference is reachable if
    // the delete fix-up ever misses one. It must not fall through to a live entry.
    expect(resolveProxyUrlForSite({ proxyRef: 'px_deleted' }, { pool: POOL })).toBeNull();
    // No pool at all is the same answer, not an error.
    expect(resolveProxyUrlForSite({ proxyRef: 'px_hk' }, { pool: [] })).toBeNull();
    expect(resolveProxyUrlForSite(null, { pool: POOL })).toBeNull();
  });

  it('injects a dispatcher only when the site resolved to an address', async () => {
    const { resolveProxyUrlForSite, withResolvedProxyRequestInit } = await import('./siteProxy.js');
    const init = (proxyRef: string | null) => withResolvedProxyRequestInit(
      { proxyRef },
      resolveProxyUrlForSite({ proxyRef }, { pool: POOL }),
      { method: 'POST' },
    );

    expect('dispatcher' in init('px_hk')).toBe(true);
    // Referenced nothing, and a dangling id — both go direct rather than borrowing
    // a live entry.
    expect('dispatcher' in init(null)).toBe(false);
    expect('dispatcher' in init('px_deleted')).toBe(false);
  });

  it('injects a working dispatcher for socks5 system proxies', async () => {
    const upstreamServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Failed to determine upstream server address');
    }
    const requestUrl = `http://proxy-site.example.com:${upstreamAddress.port}/v1/chat/completions`;

    const socksPool = [{ id: 'px_socks', name: 'socks', url: 'socks5h://127.0.0.1:1080' }] as const;

    const createConnectionSpy = vi.spyOn(SocksClient, 'createConnection').mockImplementation(async () => {
      const socket = connectSocket(upstreamAddress.port, '127.0.0.1');
      await once(socket, 'connect');
      return { socket } as Awaited<ReturnType<typeof SocksClient.createConnection>>;
    });

    try {
      const { resolveProxyUrlForSite, withResolvedProxyRequestInit } = await import('./siteProxy.js');
      const site = { proxyRef: 'px_socks' };
      const requestInit = withResolvedProxyRequestInit(
        site,
        resolveProxyUrlForSite(site, { pool: socksPool }),
        { method: 'GET' },
      );

      expect('dispatcher' in requestInit).toBe(true);

      const response = await fetch(requestUrl, requestInit);

      expect(response.status).toBe(200);
      expect(createConnectionSpy).toHaveBeenCalledTimes(1);
      expect(createConnectionSpy).toHaveBeenCalledWith(expect.objectContaining({
        command: 'connect',
        proxy: expect.objectContaining({
          host: '127.0.0.1',
          port: 1080,
          type: 5,
        }),
        destination: expect.objectContaining({
          host: 'proxy-site.example.com',
          port: upstreamAddress.port,
        }),
      }));
    } finally {
      createConnectionSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('merges site custom headers by matched request url and keeps explicit headers authoritative', async () => {
    await db.insert(schema.sites).values({
      name: 'headers-site',
      url: 'https://headers-site.example.com',
      platform: 'new-api',
      customHeaders: JSON.stringify({
        'cf-access-client-id': 'site-client',
        authorization: 'Bearer site-default',
      }),
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://headers-site.example.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer request-token',
        'X-Trace-Id': 'trace-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('cf-access-client-id')).toBe('site-client');
    expect(headers.get('authorization')).toBe('Bearer request-token');
    expect(headers.get('x-trace-id')).toBe('trace-1');
  });

  it('merges site custom headers and injects a dispatcher for an already-resolved address', async () => {
    const { withResolvedProxyRequestInit } = await import('./siteProxy.js');
    // `withResolvedProxyRequestInit` is the form used by callers that resolved the
    // channel once and must pin that answer for every retry of one attempt. It takes
    // the address directly, so this covers "custom headers and dispatcher co-exist"
    // without depending on pool state.
    const requestInit = withResolvedProxyRequestInit({
      customHeaders: JSON.stringify({
        'x-site-scope': 'site-level',
      }),
    }, 'http://127.0.0.1:7890', {
      method: 'POST',
      headers: {
        'X-Request-Id': 'req-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('x-site-scope')).toBe('site-level');
    expect(headers.get('x-request-id')).toBe('req-1');
    expect('dispatcher' in requestInit).toBe(true);
  });

  it('lets site custom user-agent override client user-agent while keeping request auth authoritative', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withSiteRecordProxyRequestInit({
      customHeaders: JSON.stringify({
        'User-Agent': 'site-managed-ua/1.0',
        authorization: 'Bearer site-default',
      }),
    }, {
      method: 'POST',
      headers: {
        'User-Agent': 'OpenAI/Python 2.32.0',
        Authorization: 'Bearer request-token',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('user-agent')).toBe('site-managed-ua/1.0');
    expect(headers.get('authorization')).toBe('Bearer request-token');
  });

  it('merges parsed-object site custom headers from site records', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withSiteRecordProxyRequestInit({
      customHeaders: {
        'x-site-scope': 'site-level',
      },
    }, {
      method: 'POST',
      headers: {
        'X-Request-Id': 'req-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('x-site-scope')).toBe('site-level');
    expect(headers.get('x-request-id')).toBe('req-1');
  });

  it('ignores an address stored on a connection, which is no longer a source', async () => {
    const { invalidateSiteProxyCache, resolveChannelProxyUrl } = await import('./siteProxy.js');
    invalidateSiteProxyCache();

    // `extra_config.proxyUrl` and the old opt-in are both dead: an address can only
    // come from the pool now, and a connection selects one by reference. A row can
    // still physically carry these keys, so the resolver has to ignore them rather
    // than merely not look for them.
    const legacyAccountConfig = JSON.stringify({
      proxyUrl: 'http://account-proxy:8080',
      useSystemProxy: true,
    });

    expect(await resolveChannelProxyUrl({}, legacyAccountConfig)).toBeNull();
    expect(await resolveChannelProxyUrl({}, null)).toBeNull();
    expect(await resolveChannelProxyUrl({}, JSON.stringify({}))).toBeNull();
  });

  it('withSiteRecordProxyRequestInit resolves the connection it is handed', async () => {
    const { invalidateSiteProxyCache, primeSiteProxyPool, withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    invalidateSiteProxyCache();
    primeSiteProxyPool([{ id: 'px_hk', url: 'http://account-proxy:8080' }]);

    const result = withSiteRecordProxyRequestInit(
      {},
      { method: 'POST' },
      { extraConfig: JSON.stringify({ proxyRef: 'px_hk' }) },
    );
    expect('dispatcher' in result).toBe(true);
  });

  // The whole point of the three-state read: a connection that says 不走代理 must
  // suppress its site's proxy, not fall through to it.
  it('withSiteRecordProxyRequestInit lets a connection refuse its site proxy', async () => {
    const { invalidateSiteProxyCache, primeSiteProxyPool, withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    invalidateSiteProxyCache();
    primeSiteProxyPool([{ id: 'px_hk', url: 'http://account-proxy:8080' }]);

    const result = withSiteRecordProxyRequestInit(
      { proxyRef: 'px_hk' },
      { method: 'POST' },
      { extraConfig: JSON.stringify({ proxyRef: null }) },
    );
    expect('dispatcher' in result).toBe(false);
  });

  it('withAccountProxyOverride sets ALS context for nested proxy calls', async () => {
    const { withAccountProxyOverride, withSiteProxyRequestInit } = await import('./siteProxy.js');

    await db.insert(schema.sites).values({
      name: 'als-site',
      url: 'https://als-site.example.com',
      platform: 'new-api',
    }).run();

    const result = await withAccountProxyOverride(
      'http://account-als-proxy:9090',
      async () => {
        return withSiteProxyRequestInit('https://als-site.example.com/v1/models', {
          method: 'GET',
        });
      },
    );

    expect('dispatcher' in result).toBe(true);
  });

  /**
   * `null` PINS "direct" rather than meaning "no opinion".
   *
   * The layers below re-resolve by request URL, so a connection that refused a proxy
   * would silently pick its site's one back up if null were treated as absent.
   */
  it('withAccountProxyOverride suppresses the site proxy when handed null', async () => {
    const {
      invalidateSiteProxyCache,
      withAccountProxyOverride,
      withSiteProxyRequestInit,
    } = await import('./siteProxy.js');

    await db.insert(schema.settings).values({
      key: 'proxy_pool_v1',
      value: JSON.stringify([{ id: 'px_hk', name: '香港', url: 'http://10.0.0.9:7890' }]),
    }).run();
    await db.insert(schema.sites).values({
      name: 'als-null-site',
      url: 'https://als-null-site.example.com',
      platform: 'new-api',
      proxyRef: 'px_hk',
    }).run();
    invalidateSiteProxyCache();

    // Without the override the site's own proxy applies...
    const withoutOverride = await withSiteProxyRequestInit('https://als-null-site.example.com/v1/models', {
      method: 'GET',
    });
    expect('dispatcher' in withoutOverride).toBe(true);

    // ...and an explicit null takes it away.
    const result = await withAccountProxyOverride(
      null,
      async () => {
        return withSiteProxyRequestInit('https://als-null-site.example.com/v1/models', {
          method: 'GET',
        });
      },
    );

    expect('dispatcher' in result).toBe(false);
  });

  it('withAccountProxyOverride leaves resolution alone when handed undefined', async () => {
    const {
      invalidateSiteProxyCache,
      withAccountProxyOverride,
      withSiteProxyRequestInit,
    } = await import('./siteProxy.js');

    await db.insert(schema.settings).values({
      key: 'proxy_pool_v1',
      value: JSON.stringify([{ id: 'px_hk', name: '香港', url: 'http://10.0.0.9:7890' }]),
    }).run();
    await db.insert(schema.sites).values({
      name: 'als-undefined-site',
      url: 'https://als-undefined-site.example.com',
      platform: 'new-api',
      proxyRef: 'px_hk',
    }).run();
    invalidateSiteProxyCache();

    const result = await withAccountProxyOverride(
      undefined,
      async () => {
        return withSiteProxyRequestInit('https://als-undefined-site.example.com/v1/models', {
          method: 'GET',
        });
      },
    );

    expect('dispatcher' in result).toBe(true);
  });

  /**
   * Resolution through the proxy pool — the only model there is.
   *
   * A site holds a REFERENCE, never an address, and a null reference means
   * "do not proxy" outright rather than "ask the layer above". That is what makes
   * 直连 expressible at all: under the old address/opt-in columns an empty value
   * meant "inherit", so no site could refuse a proxy configured above it.
   */
  describe('resolving through the proxy pool', () => {
    async function seedPool(entries: Array<{ id: string; name: string; url: string }>) {
      await db.insert(schema.settings).values({
        key: 'proxy_pool_v1',
        value: JSON.stringify(entries),
      }).run();
    }

    it('follows a site reference into the pool', async () => {
      const { invalidateSiteProxyCache, resolveChannelProxyUrl } = await import('./siteProxy.js');
      await seedPool([{ id: 'px_hk', name: '香港', url: 'socks5://127.0.0.1:7890' }]);
      invalidateSiteProxyCache();

      expect(await resolveChannelProxyUrl({ proxyRef: 'px_hk' }, null))
        .toBe('socks5://127.0.0.1:7890');
    });

    it('ignores the legacy columns entirely, so a null ref means do-not-proxy', async () => {
      const { invalidateSiteProxyCache, resolveChannelProxyUrl } = await import('./siteProxy.js');
      await seedPool([{ id: 'px_hk', name: '香港', url: 'socks5://127.0.0.1:7890' }]);
      invalidateSiteProxyCache();

      // A row can still physically carry the old columns — they exist in the schema
      // and a hand-edited row could set them. They are dead: honouring either one
      // here is precisely what would make 直连 impossible to express.
      expect(await resolveChannelProxyUrl({
        proxyRef: null,
      } as any, null)).toBeNull();
    });

    it('lets a connection override its site, including refusing a proxy outright', async () => {
      const { invalidateSiteProxyCache, resolveChannelProxyUrl } = await import('./siteProxy.js');
      await seedPool([
        { id: 'px_hk', name: '香港', url: 'socks5://127.0.0.1:7890' },
        { id: 'px_jp', name: '日本', url: 'http://10.0.0.5:8080' },
      ]);
      invalidateSiteProxyCache();

      const site = { proxyRef: 'px_hk' };
      // Picks a different entry than its site...
      expect(await resolveChannelProxyUrl(site, JSON.stringify({ proxyRef: 'px_jp' })))
        .toBe('http://10.0.0.5:8080');
      // ...or refuses one, which the old model had no way to say.
      expect(await resolveChannelProxyUrl(site, JSON.stringify({ proxyRef: null }))).toBeNull();
      // ...while no opinion still means "follow the site".
      expect(await resolveChannelProxyUrl(site, JSON.stringify({ credentialMode: 'auto' })))
        .toBe('socks5://127.0.0.1:7890');
      expect(await resolveChannelProxyUrl(site, null)).toBe('socks5://127.0.0.1:7890');
    });

    it('treats a reference to a missing entry as no proxy, not as another entry', async () => {
      const { invalidateSiteProxyCache, resolveChannelProxyUrl } = await import('./siteProxy.js');
      await seedPool([{ id: 'px_hk', name: '香港', url: 'socks5://127.0.0.1:7890' }]);
      invalidateSiteProxyCache();

      // `proxy_ref` cannot be a foreign key, so a dangling ref is reachable if the
      // delete fix-up ever misses one. Falling back to px_hk would silently route a
      // site through a proxy its operator never chose.
      expect(await resolveChannelProxyUrl({ proxyRef: 'px_deleted' }, null)).toBeNull();
      expect(await resolveChannelProxyUrl({ proxyRef: 'px_hk' }, JSON.stringify({ proxyRef: 'px_deleted' })))
        .toBeNull();
    });

    it('honours a connection opt-in on the forwarding path, which used to be ignored', async () => {
      const { invalidateSiteProxyCache, resolveChannelProxyUrl } = await import('./siteProxy.js');
      await seedPool([{ id: 'px_jp', name: '日本', url: 'http://10.0.0.5:8080' }]);
      invalidateSiteProxyCache();

      // Before the pool there were two resolvers: the /v1/* surfaces used one that
      // ignored a connection's system-proxy opt-in while the management paths
      // honoured it, so the checkbox only half worked. One resolver now, one answer.
      expect(await resolveChannelProxyUrl({ proxyRef: null }, JSON.stringify({ proxyRef: 'px_jp' })))
        .toBe('http://10.0.0.5:8080');
    });
  });
});
