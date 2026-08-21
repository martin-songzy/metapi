import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');

type SiteProbeProfileResponse = {
  id: number;
  probeEndpointType?: string | null;
  probeUserAgent?: string | null;
};

describe('sites per-site probe request profile', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-probe-profile-'));
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
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function createSite(payload: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'probe-profile-site',
        url: 'https://probe-profile-site.example.com',
        platform: 'new-api',
        ...payload,
      },
    });
    return response;
  }

  it('defaults an existing-style site to auto with no user agent override', async () => {
    const created = await createSite();
    expect(created.statusCode).toBe(200);

    const body = created.json() as SiteProbeProfileResponse;
    expect(body.probeEndpointType).toBe('auto');
    expect(body.probeUserAgent).toBe('');

    const row = await db.select().from(schema.sites).where(eq(schema.sites.id, body.id)).get();
    expect(row?.probeEndpointType).toBe('auto');
    expect(row?.probeUserAgent).toBe('');
  });

  it('persists the probe profile supplied at creation time', async () => {
    const created = await createSite({
      probeEndpointType: 'responses',
      probeUserAgent: '  codex_cli_rs/0.20.0  ',
    });

    expect(created.statusCode).toBe(200);
    const body = created.json() as SiteProbeProfileResponse;
    expect(body.probeEndpointType).toBe('responses');
    expect(body.probeUserAgent).toBe('codex_cli_rs/0.20.0');
  });

  it('updates the probe profile on an existing site', async () => {
    const created = await createSite();
    expect(created.statusCode).toBe(200);
    const { id } = created.json() as SiteProbeProfileResponse;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/sites/${id}`,
      payload: {
        probeEndpointType: 'messages',
        probeUserAgent: 'claude-cli/2.1.63 (external, cli)',
      },
    });

    expect(updated.statusCode).toBe(200);
    const body = updated.json() as SiteProbeProfileResponse;
    expect(body.probeEndpointType).toBe('messages');
    expect(body.probeUserAgent).toBe('claude-cli/2.1.63 (external, cli)');
  });

  it('leaves a stored probe profile untouched when the update omits the fields', async () => {
    const created = await createSite({
      probeEndpointType: 'chat',
      probeUserAgent: 'codex_cli_rs/0.20.0',
    });
    expect(created.statusCode).toBe(200);
    const { id } = created.json() as SiteProbeProfileResponse;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/sites/${id}`,
      payload: { name: 'renamed-probe-site' },
    });

    expect(updated.statusCode).toBe(200);
    const body = updated.json() as SiteProbeProfileResponse & { name?: string };
    expect(body.name).toBe('renamed-probe-site');
    expect(body.probeEndpointType).toBe('chat');
    expect(body.probeUserAgent).toBe('codex_cli_rs/0.20.0');
  });

  it('clears the user agent override with an empty string', async () => {
    const created = await createSite({ probeUserAgent: 'codex_cli_rs/0.20.0' });
    expect(created.statusCode).toBe(200);
    const { id } = created.json() as SiteProbeProfileResponse;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/sites/${id}`,
      payload: { probeUserAgent: '   ' },
    });

    expect(updated.statusCode).toBe(200);
    expect((updated.json() as SiteProbeProfileResponse).probeUserAgent).toBe('');
  });

  it('rejects an unsupported endpoint type at the route boundary', async () => {
    const created = await createSite({ probeEndpointType: 'response' });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error?: string }).error).toContain('probeEndpointType');

    const site = await createSite();
    expect(site.statusCode).toBe(200);
    const { id } = site.json() as SiteProbeProfileResponse;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/sites/${id}`,
      payload: { probeEndpointType: 'response' },
    });
    expect(updated.statusCode).toBe(400);
    expect((updated.json() as { error?: string }).error).toContain('probeEndpointType');
  });

  it('rejects a user agent longer than 512 characters', async () => {
    const created = await createSite({ probeUserAgent: 'a'.repeat(513) });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error?: string }).error).toContain('probeUserAgent');
  });
});
