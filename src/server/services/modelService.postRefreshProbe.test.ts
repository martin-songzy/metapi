import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

/**
 * Safety coverage for the UNATTENDED probe that runs after every successful model
 * refresh (`runPostRefreshProbeIfEnabled`).
 *
 * This path is riskier than the manual one: nobody is watching, and it writes a
 * SITE-level disable, which removes the model for every account on that site. It
 * once folded `inconclusive` in with `unsupported`, so one upstream wobble during a
 * routine refresh permanently disabled a working model.
 *
 * Unlike the manual path it deliberately does NOT apply the model interest regex
 * (an empty list matches nothing and would silently disable a shipped feature) and
 * does not require `syncToRouting`. It compensates by refusing to disable on either
 * an inconclusive verdict or a latency breach.
 */

const probeRuntimeModelMock = vi.fn();
const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');
type ProbeConfigModule = typeof import('./modelProbeConfigService.js');

describe('post-refresh probe safety', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshModelsForAccount: ModelServiceModule['refreshModelsForAccount'];
  let saveModelProbeConfig: ProbeConfigModule['saveModelProbeConfig'];
  let getDefaultModelProbeConfig: ProbeConfigModule['getDefaultModelProbeConfig'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-post-refresh-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    const probeConfigModule = await import('./modelProbeConfigService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshModelsForAccount = modelService.refreshModelsForAccount;
    saveModelProbeConfig = probeConfigModule.saveModelProbeConfig;
    getDefaultModelProbeConfig = probeConfigModule.getDefaultModelProbeConfig;
  });

  beforeEach(async () => {
    probeRuntimeModelMock.mockReset();
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();
    getApiTokenMock.mockResolvedValue(null);

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
    delete process.env.DATA_DIR;
  });

  async function seedProbingSite(overrides?: Partial<typeof schema.sites.$inferInsert>) {
    const site = await db.insert(schema.sites).values({
      name: 'auto-probe-site',
      url: 'https://auto-probe.example.com',
      platform: 'new-api',
      status: 'active',
      postRefreshProbeEnabled: true,
      postRefreshProbeScope: 'all',
      ...overrides,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'auto-prober',
      accessToken: '',
      apiToken: 'sk-auto-probe',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    return { site, account };
  }

  it('does not disable a model when the unattended probe comes back inconclusive', async () => {
    const { account } = await seedProbingSite();
    getModelsMock.mockResolvedValue(['flaky-model']);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'inconclusive',
      latencyMs: null,
      reason: 'runtime model probe timeout (15s)',
      httpStatus: null,
      failureKind: 'timeout',
      endpointUsed: null,
    });

    const result = await refreshModelsForAccount(account.id);

    expect(result.status).toBe('success');
    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);

    const availability = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .get();
    expect(availability?.available).toBe(true);
  });

  it('still disables a model the unattended probe proves is missing', async () => {
    const { site, account } = await seedProbingSite();
    getModelsMock.mockResolvedValue(['ghost-model']);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'unsupported',
      latencyMs: 90,
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
      endpointUsed: 'chat',
    });

    await refreshModelsForAccount(account.id);

    const disabled = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, site.id))
      .all();
    expect(disabled.map((row) => row.modelName)).toEqual(['ghost-model']);
  });

  it('does not disable a working-but-slow model on the unattended path', async () => {
    const { account } = await seedProbingSite({ postRefreshProbeLatencyThresholdMs: 100 });
    getModelsMock.mockResolvedValue(['slow-model']);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'supported',
      latencyMs: 5_000,
      reason: 'ok',
      httpStatus: 200,
      failureKind: null,
      endpointUsed: 'chat',
    });

    const result = await refreshModelsForAccount(account.id);

    // Still reported as unsupported so the operator sees the breach...
    expect(result.status).toBe('success');
    expect(result.postProbeResult?.unsupported).toBe(1);
    // ...but slowness is a routing-preference signal, not proof the model is
    // absent, and this path writes a site-level disable unattended.
    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);

    const availability = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .get();
    expect(availability?.available).toBe(true);
  });

  it('never auto-disables a manual model on the unattended path', async () => {
    const { account } = await seedProbingSite();
    getModelsMock.mockResolvedValue(['manual-model']);
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'manual-model',
      available: true,
      isManual: true,
    }).run();
    probeRuntimeModelMock.mockResolvedValue({
      status: 'unsupported',
      latencyMs: 90,
      reason: 'no such model',
      httpStatus: 404,
      failureKind: 'model_missing',
      endpointUsed: 'chat',
    });

    await refreshModelsForAccount(account.id);

    expect(await db.select().from(schema.siteDisabledModels).all()).toEqual([]);
  });

  it('feeds the site request profile and global probe settings into the unattended probe', async () => {
    const { account } = await seedProbingSite({
      probeEndpointType: 'messages',
      probeUserAgent: 'auto-site-agent/1.0',
    });
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      prompts: ['自动路径提示词'],
      errorKeywords: ['no available channel'],
      timeoutMs: 11_000,
    });
    getModelsMock.mockResolvedValue(['gpt-4o']);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'supported',
      latencyMs: 80,
      reason: 'ok',
      httpStatus: 200,
      failureKind: null,
      endpointUsed: 'messages',
    });

    await refreshModelsForAccount(account.id);

    expect(probeRuntimeModelMock).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gpt-4o',
      forcedEndpoint: 'messages',
      userAgent: 'auto-site-agent/1.0',
      prompt: '自动路径提示词',
      errorKeywords: ['no available channel'],
      timeoutMs: 11_000,
    }));
  });

  it('probes every discovered model regardless of the interest regex', async () => {
    const { account } = await seedProbingSite();
    // An empty interest list matches nothing. Applying it here would silently
    // stop a feature that ships enabled, so the unattended path must ignore it.
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: [],
    });
    getModelsMock.mockResolvedValue(['gpt-4o', 'claude-sonnet-4-5']);
    probeRuntimeModelMock.mockResolvedValue({
      status: 'supported',
      latencyMs: 80,
      reason: 'ok',
      httpStatus: 200,
      failureKind: null,
      endpointUsed: 'chat',
    });

    await refreshModelsForAccount(account.id);

    expect(probeRuntimeModelMock).toHaveBeenCalledTimes(2);
  });
});
