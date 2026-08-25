import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `allowUnverified` lets a connection be created against a site this app cannot
 * verify, which is the whole point of the generic platform: a relay that serves
 * `/v1/chat/completions` but exposes no listable catalogue and no management API.
 *
 * The flag is scoped deliberately and every boundary below is asserted, because a
 * flag that quietly widened would turn a dead key into a silently-accepted account
 * on platforms where an empty catalogue really does mean the key is dead:
 *
 * - It only relaxes the "no models" / "unknown token type" verdicts. Any OTHER
 *   failure — a thrown adapter error, an unparseable proxy URL — still rejects.
 * - It never fabricates models. `model_availability` stays empty, so nothing
 *   downstream is told the key was proven to work.
 * - Absent or false, the original gates stand unchanged.
 * - Under session mode an unverifiable credential is stored as an API key rather
 *   than a session, so check-in is not enabled for a platform that cannot check in.
 */

const getModelsMock = vi.fn();
const verifyTokenMock = vi.fn();
const getApiTokensMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getModels: (...args: unknown[]) => getModelsMock(...args),
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts allowUnverified behavior', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-allow-unverified-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
    // Migration plus the accounts route graph exceeds vitest's 10s hook default
    // on a cold module cache; the neighbouring probe suites use the same budget.
  }, 60_000);

  beforeEach(async () => {
    getModelsMock.mockReset();
    verifyTokenMock.mockReset();
    getApiTokensMock.mockReset();
    getApiTokensMock.mockResolvedValue([]);

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch { }
    }
    delete process.env.DATA_DIR;
  });

  async function seedGenericSite() {
    return db.insert(schema.sites).values({
      name: 'Generic Relay',
      url: 'https://relay.example.com',
      platform: 'generic',
    }).returning().get();
  }

  it('creates an apikey connection when the catalogue is empty', async () => {
    // The shape a generic relay actually produces: the endpoint answers, and
    // answers with nothing.
    getModelsMock.mockResolvedValue([]);
    const site = await seedGenericSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-generic-key',
        credentialMode: 'apikey',
        allowUnverified: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiToken).toBe('sk-generic-key');

    // Discovery was ATTEMPTED, unlike `skipModelFetch` which never asks. That is
    // the difference between the two flags: this one wants the models when the
    // endpoint happens to serve them.
    expect(getModelsMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('records no models, so nothing downstream reads the key as proven', async () => {
    getModelsMock.mockResolvedValue([]);
    const site = await seedGenericSite();

    await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-generic-key',
        credentialMode: 'apikey',
        allowUnverified: true,
      },
    });

    expect(await db.select().from(schema.modelAvailability).all()).toHaveLength(0);
  });

  it('still rejects an empty catalogue when the flag is absent or false', async () => {
    getModelsMock.mockResolvedValue([]);
    const site = await seedGenericSite();

    const withoutFlag = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-no-flag',
        credentialMode: 'apikey',
      },
    });
    expect(withoutFlag.statusCode).toBe(400);
    expect(withoutFlag.json()).toMatchObject({ requiresVerification: true });

    const withFalseFlag = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-false-flag',
        credentialMode: 'apikey',
        allowUnverified: false,
      },
    });
    expect(withFalseFlag.statusCode).toBe(400);

    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
  });

  it('does not swallow a thrown adapter failure', async () => {
    // An empty list is a fact about the catalogue; a THROW is the upstream or the
    // network failing. The override speaks to the first only — otherwise a
    // misconfigured proxy would look like a successfully added connection.
    getModelsMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:443'));
    const site = await seedGenericSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-unreachable',
        credentialMode: 'apikey',
        allowUnverified: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
  });

  it('stores an unverifiable session-mode credential as an api key, with check-in off', async () => {
    // `GenericAdapter.getUserInfo` returns null by construction, so `verifyToken`
    // can only ever answer 'unknown' for such a site. Without the override that
    // makes a generic site unusable regardless of the credential supplied.
    verifyTokenMock.mockResolvedValue({ tokenType: 'unknown' });
    const site = await seedGenericSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-unknown-kind',
        allowUnverified: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    // Stored as an API key: the one credential kind such a site can use. Resolving
    // it to 'session' would switch on check-in for a platform that cannot check in.
    expect(accounts[0]?.apiToken).toBe('sk-unknown-kind');
    expect(accounts[0]?.accessToken).toBe('');
    expect(accounts[0]?.checkinEnabled).toBe(false);
  });

  it('still rejects an unknown token type when the flag is absent', async () => {
    verifyTokenMock.mockResolvedValue({ tokenType: 'unknown' });
    const site = await seedGenericSite();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-unknown-kind',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ requiresVerification: true });
    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
  });
});
