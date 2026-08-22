import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

/**
 * Regression coverage for `probeSiteModels`.
 *
 * The behaviour under test is mostly about what must NOT be written: an
 * `inconclusive` verdict (timeout, rate limit, auth blip, network flake) used to
 * be folded into the same bucket as `unsupported` and permanently disabled a
 * perfectly usable model. These tests pin the safe semantics.
 */

const discoverModelsForActiveProbeMock = vi.fn();
const probeRuntimeModelMock = vi.fn();

vi.mock('./modelProbeDiscoveryService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelProbeDiscoveryService.js')>(
    './modelProbeDiscoveryService.js',
  );
  return {
    ...actual,
    discoverModelsForActiveProbe: (...args: unknown[]) => discoverModelsForActiveProbeMock(...args),
  };
});

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));


type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');
type ProbeConfigModule = typeof import('./modelProbeConfigService.js');

describe('probeSiteModels routing-independent semantics', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteModels: ModelServiceModule['probeSiteModels'];
  let saveModelProbeConfig: ProbeConfigModule['saveModelProbeConfig'];
  let getDefaultModelProbeConfig: ProbeConfigModule['getDefaultModelProbeConfig'];
  let config: typeof import('../config.js')['config'];
  let dataDir = '';
  let previousProxyRoutingEnabled = true;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    const probeConfigModule = await import('./modelProbeConfigService.js');
    const configModule = await import('../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteModels = modelService.probeSiteModels;
    saveModelProbeConfig = probeConfigModule.saveModelProbeConfig;
    getDefaultModelProbeConfig = probeConfigModule.getDefaultModelProbeConfig;
    config = configModule.config;
    previousProxyRoutingEnabled = config.proxyRoutingEnabled;
  });

  beforeEach(async () => {
    discoverModelsForActiveProbeMock.mockReset();
    probeRuntimeModelMock.mockReset();
    config.proxyRoutingEnabled = true;

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.proxyRoutingEnabled = previousProxyRoutingEnabled;
    delete process.env.DATA_DIR;
  });

  async function seedSite(overrides?: Partial<typeof schema.sites.$inferInsert>) {
    const site = await db.insert(schema.sites).values({
      name: 'probe-site',
      url: 'https://probe.example.com',
      platform: 'new-api',
      status: 'active',
      ...overrides,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'prober',
      accessToken: '',
      apiToken: 'sk-probe',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    return { site, account };
  }

  function mockDiscovery(
    site: typeof schema.sites.$inferSelect,
    account: typeof schema.accounts.$inferSelect,
    models: string[],
  ) {
    discoverModelsForActiveProbeMock.mockResolvedValue({
      site,
      account,
      credential: 'sk-probe',
      credentialKind: 'api_token',
      models,
      source: 'live',
    });
  }

  function probeResult(overrides: Record<string, unknown>) {
    return {
      status: 'supported',
      latencyMs: 120,
      reason: 'ok',
      httpStatus: 200,
      failureKind: null,
      endpointUsed: 'chat',
      ...overrides,
    };
  }

  async function enableRoutingSync() {
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
      syncToRouting: true,
    });
  }

  /**
   * A model that stays available no matter what the probe decides. A route
   * rebuild would turn it into a `token_routes` row, so the presence of that row
   * is direct evidence the rebuild ran — no spying on module internals needed.
   */
  async function seedRoutableKeeperModel(accountId: number) {
    await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'keeper-model',
      available: true,
    }).run();
  }

  async function routeCount() {
    const routes = await db.select().from(schema.tokenRoutes).all();
    return routes.length;
  }

  it('probes the live discovered models rather than stale model_availability rows', async () => {
    const { site, account } = await seedSite();
    // A stale row that live discovery no longer reports must not be probed.
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'retired-model',
      available: true,
    }).run();

    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['^gpt-'],
    });
    mockDiscovery(site, account, ['gpt-live-1', 'gpt-live-2']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({}));

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(true);
    expect(discoverModelsForActiveProbeMock).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: site.id }),
    );
    const probedNames = probeRuntimeModelMock.mock.calls.map((call) => (call[0] as { modelName: string }).modelName);
    expect(probedNames.sort()).toEqual(['gpt-live-1', 'gpt-live-2']);
    expect(probedNames).not.toContain('retired-model');
  });

  it('applies interest patterns before issuing any runtime probe', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['^claude-'],
    });
    mockDiscovery(site, account, ['claude-sonnet-4-5', 'gpt-4o', 'gemini-2.5-pro']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({}));

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(true);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect((probeRuntimeModelMock.mock.calls[0]![0] as { modelName: string }).modelName)
      .toBe('claude-sonnet-4-5');
  });

  it('never disables a model on an inconclusive verdict, even with routing sync fully enabled', async () => {
    const { site, account } = await seedSite();
    await enableRoutingSync();
    await seedRoutableKeeperModel(account.id);
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4o',
      available: true,
    }).run();

    mockDiscovery(site, account, ['gpt-4o']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({
      status: 'inconclusive',
      reason: 'runtime model probe timeout (15s)',
      httpStatus: null,
      failureKind: 'timeout',
      endpointUsed: null,
    }));

    const events: Array<{ type: string; action?: string }> = [];
    const result = await probeSiteModels(site.id, { scope: 'all' }, (event) => {
      events.push(event as { type: string; action?: string });
    });

    expect(result.success).toBe(true);
    expect(result.inconclusive).toBe(1);
    expect(result.unsupported).toBe(0);

    const disabled = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, site.id))
      .all();
    expect(disabled).toEqual([]);

    const availability = await db.select().from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, account.id),
        eq(schema.modelAvailability.modelName, 'gpt-4o'),
      ))
      .get();
    expect(availability?.available).toBe(true);

    // No verdict changed, so nothing justified a rebuild.
    expect(await routeCount()).toBe(0);
    expect(result.routingSynced).toBe(false);
    expect(events.some((event) => event.type === 'action' && event.action === 'disabled')).toBe(false);
  });

  it('writes nothing and rebuilds nothing when PROXY_ROUTING_ENABLED is false', async () => {
    config.proxyRoutingEnabled = false;
    const { site, account } = await seedSite();
    await enableRoutingSync();
    // Seeded so that a rebuild, if it wrongly ran, would leave a visible
    // token_routes row instead of an empty table either way.
    await seedRoutableKeeperModel(account.id);
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'ghost-model',
      available: true,
    }).run();

    mockDiscovery(site, account, ['ghost-model']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({
      status: 'unsupported',
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
    }));

    const accountBefore = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(true);
    expect(result.unsupported).toBe(1);
    expect(result.routingSynced).toBe(false);

    const disabled = await db.select().from(schema.siteDisabledModels).all();
    expect(disabled).toEqual([]);

    const availability = await db.select().from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, account.id),
        eq(schema.modelAvailability.modelName, 'ghost-model'),
      ))
      .get();
    expect(availability?.available).toBe(true);

    const accountAfter = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(accountAfter?.extraConfig).toBe(accountBefore?.extraConfig);

    expect(await routeCount()).toBe(0);
  });

  it('writes nothing when syncToRouting stays at its default of false', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
    });
    await seedRoutableKeeperModel(account.id);
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'ghost-model',
      available: true,
    }).run();

    mockDiscovery(site, account, ['ghost-model']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({
      status: 'unsupported',
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
    }));

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(true);
    expect(result.unsupported).toBe(1);
    expect(result.routingSynced).toBe(false);
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);
    expect(await routeCount()).toBe(0);
  });

  it('disables an unsupported model and rebuilds routes only when routing and sync are both on', async () => {
    const { site, account } = await seedSite();
    await enableRoutingSync();
    await seedRoutableKeeperModel(account.id);
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'ghost-model',
      available: true,
    }).run();

    mockDiscovery(site, account, ['ghost-model']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({
      status: 'unsupported',
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
    }));

    const events: Array<{ type: string; action?: string; modelName?: string }> = [];
    const result = await probeSiteModels(site.id, { scope: 'all' }, (event) => {
      events.push(event as { type: string; action?: string; modelName?: string });
    });

    expect(result.unsupported).toBe(1);
    expect(result.disabled).toBe(1);
    expect(result.routingSynced).toBe(true);

    const disabled = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, site.id))
      .all();
    expect(disabled.map((row) => row.modelName)).toEqual(['ghost-model']);

    const availability = await db.select().from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, account.id),
        eq(schema.modelAvailability.modelName, 'ghost-model'),
      ))
      .get();
    expect(availability?.available).toBe(false);

    // keeper-model is still available, so a rebuild that ran leaves its route
    // behind; ghost-model must not have produced one.
    const routes = await db.select().from(schema.tokenRoutes).all();
    expect(routes.map((row) => row.modelPattern)).toEqual(['keeper-model']);
    expect(events.some((event) => (
      event.type === 'action' && event.action === 'disabled' && event.modelName === 'ghost-model'
    ))).toBe(true);
  });

  it('never auto-disables a manual model even when it probes unsupported', async () => {
    const { site, account } = await seedSite();
    await enableRoutingSync();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'manual-model',
      available: true,
      isManual: true,
    }).run();

    mockDiscovery(site, account, ['manual-model']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({
      status: 'unsupported',
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
    }));

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.unsupported).toBe(1);
    expect(result.disabled).toBe(0);
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);

    const availability = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .get();
    expect(availability?.available).toBe(true);
  });

  it('counts unsupported and inconclusive separately', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
    });
    mockDiscovery(site, account, ['ok-model', 'ghost-model', 'flaky-model', 'embedding-model']);
    probeRuntimeModelMock.mockImplementation(async (input: { modelName: string }) => {
      if (input.modelName === 'ghost-model') {
        return probeResult({ status: 'unsupported', failureKind: 'model_missing', httpStatus: 404 });
      }
      if (input.modelName === 'flaky-model') {
        return probeResult({ status: 'inconclusive', failureKind: 'rate_limit', httpStatus: 429 });
      }
      if (input.modelName === 'embedding-model') {
        return probeResult({ status: 'skipped', latencyMs: null, httpStatus: null, endpointUsed: null });
      }
      return probeResult({});
    });

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.probed).toBe(4);
    expect(result.supported).toBe(1);
    expect(result.unsupported).toBe(1);
    expect(result.inconclusive).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('passes the per-site endpoint type and user agent through to the runtime probe', async () => {
    const { site, account } = await seedSite({
      probeEndpointType: 'responses',
      probeUserAgent: 'custom-site-agent/9.9',
    });
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
      prompts: ['只回一个词'],
      errorKeywords: ['no available channel'],
      timeoutMs: 9_000,
    });
    mockDiscovery(site, account, ['gpt-4o']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({}));

    await probeSiteModels(site.id, { scope: 'all' });

    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gpt-4o',
      forcedEndpoint: 'responses',
      userAgent: 'custom-site-agent/9.9',
      prompt: '只回一个词',
      errorKeywords: ['no available channel'],
      timeoutMs: 9_000,
      tokenValue: 'sk-probe',
    }));
  });

  it('lets a site with probeEndpointType auto keep automatic endpoint derivation', async () => {
    const { site, account } = await seedSite({ probeEndpointType: 'auto' });
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
    });
    mockDiscovery(site, account, ['gpt-4o']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({}));

    await probeSiteModels(site.id, { scope: 'all' });

    const passed = probeRuntimeModelMock.mock.calls[0]![0] as { forcedEndpoint?: unknown };
    expect(passed.forcedEndpoint).toBeUndefined();
  });

  it('emits endpoint and failure metadata on SSE model events', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
    });
    mockDiscovery(site, account, ['ghost-model']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({
      status: 'unsupported',
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
      endpointUsed: 'messages',
    }));

    const events: Array<Record<string, unknown>> = [];
    const result = await probeSiteModels(site.id, { scope: 'all' }, (event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const modelEvent = events.find((event) => event.type === 'model');
    expect(modelEvent).toMatchObject({
      modelName: 'ghost-model',
      status: 'unsupported',
      endpointUsed: 'messages',
      failureKind: 'model_missing',
      httpStatus: 404,
    });
    expect(result.details[0]).toMatchObject({
      modelName: 'ghost-model',
      endpointUsed: 'messages',
      failureKind: 'model_missing',
      httpStatus: 404,
    });
  });

  it('probes exactly the requested model for scope single, ignoring interest patterns', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['^claude-'],
    });
    mockDiscovery(site, account, ['claude-sonnet-4-5', 'gpt-4o']);
    probeRuntimeModelMock.mockResolvedValue(probeResult({}));

    const result = await probeSiteModels(site.id, { scope: 'single', modelName: 'gpt-4o' });

    expect(result.success).toBe(true);
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect((probeRuntimeModelMock.mock.calls[0]![0] as { modelName: string }).modelName).toBe('gpt-4o');
  });

  it('fails scope single when the requested model is not present upstream', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
    });
    mockDiscovery(site, account, ['claude-sonnet-4-5']);

    const result = await probeSiteModels(site.id, { scope: 'single', modelName: 'absent-model' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('absent-model');
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
  });

  it('reports a discovery failure without touching the database', async () => {
    const { site } = await seedSite();
    await enableRoutingSync();
    const { ModelProbeDiscoveryError } = await import('./modelProbeDiscoveryService.js');
    discoverModelsForActiveProbeMock.mockRejectedValue(
      new ModelProbeDiscoveryError('credential_invalid', '账号凭据已失效（HTTP 401）'),
    );

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('凭据已失效');
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
    expect(await routeCount()).toBe(0);
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);
  });

  it('surfaces an actionable error when no live model matches the interest patterns', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['^claude-'],
    });
    mockDiscovery(site, account, ['gpt-4o', 'gemini-2.5-pro']);

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
  });

  it('refuses scope single with no explicit model rather than probing an unmatched one', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['^claude-'],
    });
    mockDiscovery(site, account, ['gpt-4o', 'gemini-2.5-pro']);

    const result = await probeSiteModels(site.id, { scope: 'single' });

    expect(result.success).toBe(false);
    // Reaching past the interest filter to "any discovered model" would probe
    // something the operator never expressed interest in.
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
  });

  it('refuses a manual run whose interest regex matches more models than the per-run cap', async () => {
    const { site, account } = await seedSite();
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: ['.'],
    });
    const many = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    mockDiscovery(site, account, many);

    const result = await probeSiteModels(site.id, { scope: 'all' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('201');
    expect(result.error).toContain('200');
    expect(probeRuntimeModelMock).not.toHaveBeenCalled();
  });

  it('writes nothing when the run was aborted, even with routing sync enabled', async () => {
    const { site, account } = await seedSite();
    await enableRoutingSync();
    await seedRoutableKeeperModel(account.id);
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'ghost-model',
      available: true,
    }).run();

    mockDiscovery(site, account, ['ghost-model']);
    const controller = new AbortController();
    probeRuntimeModelMock.mockImplementation(async () => {
      // Abort mid-run, the way a client disconnect does.
      controller.abort();
      return probeResult({
        status: 'unsupported',
        reason: 'no such model',
        httpStatus: 404,
        failureKind: 'model_missing',
      });
    });

    const result = await probeSiteModels(site.id, { scope: 'all', signal: controller.signal });

    expect(result.routingSynced).toBe(false);
    expect(result.disabled).toBe(0);
    // The SSE route suppresses `complete` on abort, so a write here would change
    // site config with no confirmation ever shown.
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);
    expect(await routeCount()).toBe(0);
  });
});
