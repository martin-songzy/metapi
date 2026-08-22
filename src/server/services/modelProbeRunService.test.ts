import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

/**
 * Coverage for the cross-site active probe orchestrator.
 *
 * The properties that matter most here are negative ones:
 * - `previewActiveModelProbe` must issue zero writes and zero runtime probes, so
 *   the preview button can never spend upstream quota or mutate routing.
 * - an empty interest pattern list must mean "nothing", never "everything".
 * - a batch run must not silently spend quota on disabled sites.
 * - `inconclusive` must be recorded for diagnosis but must never reach
 *   `model_availability`.
 */

const discoverModelsForActiveProbeMock = vi.fn();
const probeRuntimeModelMock = vi.fn();
const rebuildTokenRoutesFromAvailabilityMock = vi.fn();
const dbWriteMock = vi.fn();

/**
 * Keeps the real SQLite database but records every write entry point.
 *
 * The exported `db` is a Proxy over an empty target, so `vi.spyOn(db, 'insert')`
 * cannot attach to it. Wrapping the module export is the only way to observe
 * "preview issues zero writes" across every table at once, including writes made
 * by the collaborators this service calls.
 */
vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js');
  const writeMethods = new Set(['insert', 'update', 'delete']);
  return {
    ...actual,
    db: new Proxy({}, {
      get(_target, prop) {
        const value = (actual.db as Record<string | symbol, unknown>)[prop];
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        if (!writeMethods.has(String(prop))) return method.bind(actual.db);
        return (...args: unknown[]) => {
          dbWriteMock(String(prop));
          return method.apply(actual.db, args);
        };
      },
    }),
  };
});

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

vi.mock('./modelService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelService.js')>('./modelService.js');
  return {
    ...actual,
    rebuildTokenRoutesFromAvailability: (...args: unknown[]) => (
      rebuildTokenRoutesFromAvailabilityMock(...args)
    ),
  };
});

type DbModule = typeof import('../db/index.js');
type RunServiceModule = typeof import('./modelProbeRunService.js');
type ProbeConfigModule = typeof import('./modelProbeConfigService.js');
type BackgroundTaskModule = typeof import('./backgroundTaskService.js');

const CREDENTIAL = 'sk-super-secret-credential';

describe('modelProbeRunService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: RunServiceModule;
  let saveModelProbeConfig: ProbeConfigModule['saveModelProbeConfig'];
  let getDefaultModelProbeConfig: ProbeConfigModule['getDefaultModelProbeConfig'];
  let waitForBackgroundTaskCompletion: BackgroundTaskModule['waitForBackgroundTaskCompletion'];
  let getBackgroundTask: BackgroundTaskModule['getBackgroundTask'];
  let listBackgroundTasks: BackgroundTaskModule['listBackgroundTasks'];
  let resetBackgroundTasks: BackgroundTaskModule['__resetBackgroundTasksForTests'];
  let config: typeof import('../config.js')['config'];
  let previousProxyRoutingEnabled = true;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-run-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    service = await import('./modelProbeRunService.js');
    const probeConfigModule = await import('./modelProbeConfigService.js');
    const backgroundTaskModule = await import('./backgroundTaskService.js');
    const configModule = await import('../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    saveModelProbeConfig = probeConfigModule.saveModelProbeConfig;
    getDefaultModelProbeConfig = probeConfigModule.getDefaultModelProbeConfig;
    waitForBackgroundTaskCompletion = backgroundTaskModule.waitForBackgroundTaskCompletion;
    getBackgroundTask = backgroundTaskModule.getBackgroundTask;
    listBackgroundTasks = backgroundTaskModule.listBackgroundTasks;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;
    config = configModule.config;
    previousProxyRoutingEnabled = config.proxyRoutingEnabled;
    // Migration plus the service module graph exceeds the 10s default on a cold
    // Windows filesystem.
  }, 60_000);

  beforeEach(async () => {
    discoverModelsForActiveProbeMock.mockReset();
    probeRuntimeModelMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockResolvedValue(undefined);
    resetBackgroundTasks();
    config.proxyRoutingEnabled = true;

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelProbeResults).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    config.proxyRoutingEnabled = previousProxyRoutingEnabled;
    resetBackgroundTasks();
    delete process.env.DATA_DIR;
  });

  async function seedSite(overrides?: Partial<typeof schema.sites.$inferInsert>) {
    const site = await db.insert(schema.sites).values({
      name: 'probe-site',
      url: `https://probe-${Math.random().toString(36).slice(2, 8)}.example.com`,
      platform: 'new-api',
      status: 'active',
      ...overrides,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'prober',
      accessToken: '',
      apiToken: CREDENTIAL,
      balance: 12.5,
      status: 'active',
    }).returning().get();

    return { site, account };
  }

  type DiscoveryStub = {
    site: typeof schema.sites.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    models: string[];
    source?: 'live' | 'cached';
    liveFailure?: { kind: string; status: number | null; message: string };
    notes?: string[];
  };

  /** Routes discovery answers by siteId so multi-site cases stay declarative. */
  function primeDiscovery(stubs: DiscoveryStub[], failures: Record<number, Error> = {}) {
    discoverModelsForActiveProbeMock.mockImplementation(async (input: { siteId: number }) => {
      const failure = failures[input.siteId];
      if (failure) throw failure;
      const stub = stubs.find((candidate) => candidate.site.id === input.siteId);
      if (!stub) throw new Error(`no discovery stub for site ${input.siteId}`);
      const source = stub.source ?? 'live';
      return {
        site: stub.site,
        account: stub.account,
        credential: CREDENTIAL,
        credentialKind: 'api_token',
        models: stub.models,
        source,
        ...(stub.notes ? { notes: stub.notes } : {}),
        ...(source === 'cached'
          ? {
            liveFailure: stub.liveFailure ?? {
              kind: 'empty_unknown',
              status: null,
              message: 'upstream returned an empty model list',
            },
          }
          : {}),
      };
    });
  }

  function probeResult(overrides: Record<string, unknown> = {}) {
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

  async function setInterest(patterns: string[], overrides: Record<string, unknown> = {}) {
    await saveModelProbeConfig({
      ...getDefaultModelProbeConfig(),
      interestPatterns: patterns,
      ...overrides,
    });
  }

  /**
   * Arms the write recorder. `preview` claims zero writes, and asserting on one
   * table only would let a stray write elsewhere through.
   */
  function watchWrites() {
    dbWriteMock.mockClear();
    return {
      expectNoWrites() {
        expect(dbWriteMock).not.toHaveBeenCalled();
      },
    };
  }

  async function runProbe(input?: Parameters<RunServiceModule['queueActiveModelProbe']>[0]) {
    const queued = service.queueActiveModelProbe(input);
    const finished = await waitForBackgroundTaskCompletion(queued.task.id);
    return { queued, finished, logs: getBackgroundTask(queued.task.id)?.logs ?? [] };
  }

  describe('previewActiveModelProbe', () => {
    it('runs discovery plus the interest filter without any write or runtime probe', async () => {
      const first = await seedSite({ name: 'alpha' });
      const second = await seedSite({ name: 'beta' });
      await setInterest(['^gpt-']);
      primeDiscovery([
        { site: first.site, account: first.account, models: ['gpt-4o', 'claude-3'] },
        { site: second.site, account: second.account, models: ['gpt-5', 'gemini-2.5-pro'] },
      ]);

      const writes = watchWrites();
      const preview = await service.previewActiveModelProbe();

      expect(discoverModelsForActiveProbeMock).toHaveBeenCalledTimes(2);
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
      writes.expectNoWrites();

      expect(preview.totalModels).toBe(2);
      expect(preview.sites.map((entry) => entry.models)).toEqual([['gpt-4o'], ['gpt-5']]);
      expect(preview.sites.map((entry) => entry.siteName)).toEqual(['alpha', 'beta']);
      expect(preview.sites.every((entry) => entry.source === 'live')).toBe(true);
    });

    it('returns zero targets when no interest pattern is configured', async () => {
      const { site, account } = await seedSite();
      await setInterest([]);
      primeDiscovery([{ site, account, models: ['gpt-4o', 'claude-3', 'gemini-2.5-pro'] }]);

      const writes = watchWrites();
      const preview = await service.previewActiveModelProbe();

      writes.expectNoWrites();
      expect(preview.totalModels).toBe(0);
      for (const entry of preview.sites) {
        expect(entry.models).toEqual([]);
      }
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
    });

    it('excludes disabled sites from a cross-site preview and says so', async () => {
      const enabled = await seedSite({ name: 'enabled-site' });
      const disabled = await seedSite({ name: 'disabled-site', status: 'disabled' });
      await setInterest(['gpt']);
      primeDiscovery([
        { site: enabled.site, account: enabled.account, models: ['gpt-4o'] },
        { site: disabled.site, account: disabled.account, models: ['gpt-4o'] },
      ]);

      const preview = await service.previewActiveModelProbe();

      expect(discoverModelsForActiveProbeMock).toHaveBeenCalledTimes(1);
      expect(preview.sites.map((entry) => entry.siteId)).toEqual([enabled.site.id]);
      expect(preview.skipped).toEqual([
        expect.objectContaining({ siteId: disabled.site.id, code: 'site_disabled' }),
      ]);
    });

    it('still skips a disabled site that was named explicitly', async () => {
      const disabled = await seedSite({ status: 'disabled' });
      await setInterest(['gpt']);
      primeDiscovery([{ site: disabled.site, account: disabled.account, models: ['gpt-4o'] }]);

      const preview = await service.previewActiveModelProbe({ siteIds: [disabled.site.id] });

      expect(discoverModelsForActiveProbeMock).not.toHaveBeenCalled();
      expect(preview.sites).toEqual([]);
      expect(preview.skipped[0]?.code).toBe('site_disabled');
    });

    it('reports a cached discovery as unverified instead of a clean success', async () => {
      const { site, account } = await seedSite();
      await setInterest(['gpt']);
      primeDiscovery([{
        site,
        account,
        models: ['gpt-4o'],
        source: 'cached',
        liveFailure: { kind: 'empty_unknown', status: null, message: 'empty list, adapter swallowed errors' },
        notes: ['models came from cache'],
      }]);

      const preview = await service.previewActiveModelProbe();

      const entry = preview.sites[0]!;
      expect(entry.source).toBe('cached');
      expect(entry.credentialVerified).toBe(false);
      expect(entry.liveFailure?.kind).toBe('empty_unknown');
    });

    it('marks a live discovery as verified', async () => {
      const { site, account } = await seedSite();
      await setInterest(['gpt']);
      primeDiscovery([{ site, account, models: ['gpt-4o'], source: 'live' }]);

      const preview = await service.previewActiveModelProbe();

      expect(preview.sites[0]?.credentialVerified).toBe(true);
      expect(preview.sites[0]?.liveFailure).toBeNull();
    });

    it('quarantines an invalid interest pattern and keeps filtering with the valid ones', async () => {
      const { site, account } = await seedSite();
      // Written straight to settings: saveModelProbeConfig rejects a bad regex, so
      // a stored-then-broken row is the only way this state arises in production.
      await db.insert(schema.settings).values({
        key: 'model_probe_config_v1',
        value: JSON.stringify({ ...getDefaultModelProbeConfig(), interestPatterns: ['^gpt-', '([unclosed'] }),
      }).run();
      primeDiscovery([{ site, account, models: ['gpt-4o', 'claude-3'] }]);

      const preview = await service.previewActiveModelProbe();

      expect(preview.invalidPatterns).toEqual([
        expect.objectContaining({ source: '([unclosed' }),
      ]);
      expect(preview.sites[0]?.models).toEqual(['gpt-4o']);
    });

    it('reports a discovery failure per site instead of failing the whole preview', async () => {
      const healthy = await seedSite({ name: 'healthy' });
      const broken = await seedSite({ name: 'broken' });
      await setInterest(['gpt']);
      const { ModelProbeDiscoveryError } = await import('./modelProbeDiscoveryService.js');
      primeDiscovery(
        [{ site: healthy.site, account: healthy.account, models: ['gpt-4o'] }],
        { [broken.site.id]: new ModelProbeDiscoveryError('credential_invalid', 'credential is dead') },
      );

      const preview = await service.previewActiveModelProbe();

      expect(preview.sites.map((entry) => entry.siteId)).toEqual([healthy.site.id]);
      expect(preview.skipped).toEqual([
        expect.objectContaining({ siteId: broken.site.id, code: 'credential_invalid' }),
      ]);
    });

    it('never exposes the credential anywhere in the preview payload', async () => {
      const { site, account } = await seedSite();
      await setInterest(['gpt']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);

      const preview = await service.previewActiveModelProbe();
      const serialized = JSON.stringify(preview);

      expect(serialized).not.toContain(CREDENTIAL);
      expect(serialized).not.toContain('credential"');
      expect(serialized).not.toContain('apiToken');
      expect(serialized).not.toContain('accessToken');
      expect(serialized).not.toContain('apiKey');
    });
  });

  /**
   * An explicit site selection that names nothing must probe NOTHING.
   *
   * The regression this pins: `normalizeSiteIds` used to return `null` for an
   * empty result and `resolveTargetSites` read `null` as "no filter, every
   * site", so `siteIds: []` (or `[0]`, or `[-1]`) ran the widest possible sweep
   * against real paid quota when asked for the narrowest. `undefined` still
   * legitimately means "every site", so all three cases are asserted together —
   * a fix that refused `undefined` too would be just as wrong.
   */
  describe('scope resolution', () => {
    const emptyScopes: Array<[string, number[]]> = [
      ['an empty list', []],
      ['a zero id', [0]],
      ['a negative id', [-1]],
      ['a non-integer id', [1.5]],
      ['ids that are all unusable', [0, -3]],
    ];

    for (const [label, siteIds] of emptyScopes) {
      it(`refuses a preview scoped by ${label} instead of previewing every site`, async () => {
        await seedSite({ name: 'must-not-be-touched' });
        await seedSite({ name: 'also-must-not-be-touched' });
        await setInterest(['gpt']);
        primeDiscovery([]);

        await expect(service.previewActiveModelProbe({ siteIds })).rejects.toThrow(
          service.ModelProbeScopeError,
        );
        expect(discoverModelsForActiveProbeMock).not.toHaveBeenCalled();
      });

      it(`refuses a run scoped by ${label} without queueing a task`, async () => {
        await seedSite();
        await setInterest(['gpt']);
        primeDiscovery([]);

        expect(() => service.queueActiveModelProbe({ siteIds })).toThrow(service.ModelProbeScopeError);
        // A refusal before the task exists: an empty run would otherwise report
        // `succeeded` over a scope the operator never chose.
        expect(listBackgroundTasks()).toHaveLength(0);
        expect(discoverModelsForActiveProbeMock).not.toHaveBeenCalled();
        expect(probeRuntimeModelMock).not.toHaveBeenCalled();
      });
    }

    it('refuses a partly unusable list rather than quietly narrowing it', async () => {
      const { site, account } = await seedSite();
      await setInterest(['gpt']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);

      // Dropping the bad entry and probing site N anyway would silently change
      // the scope the operator asked for; the payload contract 400s this too.
      await expect(service.previewActiveModelProbe({ siteIds: [site.id, 0] })).rejects.toThrow(
        service.ModelProbeScopeError,
      );
      expect(discoverModelsForActiveProbeMock).not.toHaveBeenCalled();
    });

    it('still treats an omitted scope as every site', async () => {
      const first = await seedSite({ name: 'one' });
      const second = await seedSite({ name: 'two' });
      await setInterest(['gpt']);
      primeDiscovery([
        { site: first.site, account: first.account, models: ['gpt-4o'] },
        { site: second.site, account: second.account, models: ['gpt-5'] },
      ]);

      const preview = await service.previewActiveModelProbe();

      expect(discoverModelsForActiveProbeMock).toHaveBeenCalledTimes(2);
      expect(preview.sites).toHaveLength(2);
    });

    it('keeps "all" and an explicit id list on distinct dedupe keys', () => {
      const all = service.buildActiveModelProbeDedupeKey(service.resolveModelProbeScope());
      const scoped = service.buildActiveModelProbeDedupeKey(
        service.resolveModelProbeScope([9, 3, 3]),
      );

      expect(all).toBe('active-model-probe:all');
      // Deduped and sorted, so one scope is always one key.
      expect(scoped).toBe('active-model-probe:3,9');
      expect(all).not.toBe(scoped);
    });
  });

  describe('queueActiveModelProbe', () => {
    it('derives the dedupe key from the sorted site ids, or "all"', async () => {
      const all = service.queueActiveModelProbe();
      expect(all.task.dedupeKey).toBe('active-model-probe:all');
      expect(all.reused).toBe(false);

      const scoped = service.queueActiveModelProbe({ siteIds: [9, 3, 3] });
      expect(scoped.task.dedupeKey).toBe('active-model-probe:3,9');

      await waitForBackgroundTaskCompletion(all.task.id);
      await waitForBackgroundTaskCompletion(scoped.task.id);
    });

    it('reuses the running task instead of starting a second sweep', async () => {
      const { site, account } = await seedSite();
      await setInterest(['gpt']);
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      discoverModelsForActiveProbeMock.mockImplementation(async () => {
        await gate;
        return {
          site,
          account,
          credential: CREDENTIAL,
          credentialKind: 'api_token',
          models: [],
          source: 'live',
        };
      });

      const first = service.queueActiveModelProbe();
      const second = service.queueActiveModelProbe();

      expect(second.reused).toBe(true);
      expect(second.task.id).toBe(first.task.id);

      release();
      await waitForBackgroundTaskCompletion(first.task.id);
      expect(discoverModelsForActiveProbeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('run orchestration', () => {
    it('chooses a configured prompt for every target and passes the resolved profile', async () => {
      const { site, account } = await seedSite({
        probeEndpointType: 'messages',
        probeUserAgent: 'custom-ua/1.0',
      });
      await setInterest(['^gpt-'], { prompts: ['only-prompt'] });
      primeDiscovery([{ site, account, models: ['gpt-4o', 'gpt-5'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      await runProbe();

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(2);
      for (const call of probeRuntimeModelMock.mock.calls) {
        const input = call[0] as Record<string, unknown>;
        expect(input.prompt).toBe('only-prompt');
        expect(input.userAgent).toBe('custom-ua/1.0');
        expect(input.forcedEndpoint).toBe('messages');
        expect(input.tokenValue).toBe(CREDENTIAL);
        expect(input.errorKeywords).toEqual(getDefaultModelProbeConfig().errorKeywords);
      }
    });

    it('never exceeds the configured concurrency across sites', async () => {
      const first = await seedSite({ name: 'one' });
      const second = await seedSite({ name: 'two' });
      await setInterest(['^gpt-'], { concurrency: 2 });
      primeDiscovery([
        { site: first.site, account: first.account, models: ['gpt-a', 'gpt-b', 'gpt-c'] },
        { site: second.site, account: second.account, models: ['gpt-d', 'gpt-e', 'gpt-f'] },
      ]);

      let inFlight = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      probeRuntimeModelMock.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          gates.push(resolve);
          // Release deferred probes on the next macrotask so several can pile up
          // if the limiter is broken.
          setTimeout(() => {
            const release = gates.shift();
            release?.();
          }, 0).unref?.();
        });
        inFlight -= 1;
        return probeResult();
      });

      await runProbe();

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(6);
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(2);
    });

    it('defaults concurrency to one probe at a time', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-a', 'gpt-b', 'gpt-c'] }]);

      let inFlight = 0;
      let peak = 0;
      probeRuntimeModelMock.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => { setTimeout(resolve, 0).unref?.(); });
        inFlight -= 1;
        return probeResult();
      });

      await runProbe();

      expect(peak).toBe(1);
    });

    it('upserts one row per (siteId, modelName) rather than appending history', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({ latencyMs: 111 }));

      await runProbe();
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'unsupported',
        latencyMs: 222,
        reason: 'no such model',
        httpStatus: 404,
        failureKind: 'model_missing',
      }));
      await runProbe();

      const rows = await db.select().from(schema.modelProbeResults)
        .where(eq(schema.modelProbeResults.siteId, site.id))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.modelName).toBe('gpt-4o');
      expect(rows[0]?.status).toBe('unsupported');
      expect(rows[0]?.latencyMs).toBe(222);
      expect(rows[0]?.httpStatus).toBe(404);
      expect(rows[0]?.accountId).toBe(account.id);
      expect(rows[0]?.promptUsed).toBeTruthy();
    });

    it('caps a persisted reason at 1000 characters', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'inconclusive',
        reason: 'x'.repeat(5_000),
        failureKind: 'upstream',
      }));

      await runProbe();

      const row = await db.select().from(schema.modelProbeResults)
        .where(eq(schema.modelProbeResults.siteId, site.id))
        .get();
      expect(row?.reason?.length).toBeLessThanOrEqual(1_000);
    });

    it('records an inconclusive verdict without touching model_availability', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-4o',
        available: true,
      }).run();
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'inconclusive',
        reason: 'runtime model probe timeout (15s)',
        httpStatus: null,
        failureKind: 'timeout',
        endpointUsed: null,
      }));

      await runProbe();

      const row = await db.select().from(schema.modelProbeResults)
        .where(eq(schema.modelProbeResults.siteId, site.id))
        .get();
      expect(row?.status).toBe('inconclusive');

      const availability = await db.select().from(schema.modelAvailability)
        .where(and(
          eq(schema.modelAvailability.accountId, account.id),
          eq(schema.modelAvailability.modelName, 'gpt-4o'),
        ))
        .get();
      expect(availability?.available).toBe(true);
      expect(rebuildTokenRoutesFromAvailabilityMock).not.toHaveBeenCalled();
    });

    it('writes nothing routing-related when PROXY_ROUTING_ENABLED is false', async () => {
      config.proxyRoutingEnabled = false;
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-4o',
        available: true,
      }).run();
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'unsupported',
        reason: 'no such model',
        httpStatus: 404,
        failureKind: 'model_missing',
      }));

      const { finished } = await runProbe();

      expect(finished?.status).toBe('succeeded');
      const availability = await db.select().from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, account.id))
        .get();
      expect(availability?.available).toBe(true);
      expect(rebuildTokenRoutesFromAvailabilityMock).not.toHaveBeenCalled();

      // The diagnostic result is still recorded, so results stay usable with
      // routing switched off.
      const row = await db.select().from(schema.modelProbeResults).get();
      expect(row?.status).toBe('unsupported');
    });

    it('leaves model_availability alone when syncToRouting is off, even with routing enabled', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-4o',
        available: true,
      }).run();
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'unsupported',
        reason: 'no such model',
        httpStatus: 404,
        failureKind: 'model_missing',
      }));

      await runProbe();

      const availability = await db.select().from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, account.id))
        .get();
      expect(availability?.available).toBe(true);
      expect(rebuildTokenRoutesFromAvailabilityMock).not.toHaveBeenCalled();
    });

    it('disables an unsupported model and rebuilds routes once when both switches are on', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      await db.insert(schema.modelAvailability).values([
        { accountId: account.id, modelName: 'gpt-dead', available: true },
        { accountId: account.id, modelName: 'gpt-alive', available: true },
      ]).run();
      primeDiscovery([{ site, account, models: ['gpt-dead', 'gpt-alive'] }]);
      probeRuntimeModelMock.mockImplementation(async (input: { modelName: string }) => (
        input.modelName === 'gpt-dead'
          ? probeResult({ status: 'unsupported', reason: 'no such model', httpStatus: 404, failureKind: 'model_missing' })
          : probeResult()
      ));

      const { finished } = await runProbe();

      expect(finished?.status).toBe('succeeded');
      const dead = await db.select().from(schema.modelAvailability)
        .where(and(
          eq(schema.modelAvailability.accountId, account.id),
          eq(schema.modelAvailability.modelName, 'gpt-dead'),
        ))
        .get();
      expect(dead?.available).toBe(false);

      const alive = await db.select().from(schema.modelAvailability)
        .where(and(
          eq(schema.modelAvailability.accountId, account.id),
          eq(schema.modelAvailability.modelName, 'gpt-alive'),
        ))
        .get();
      expect(alive?.available).toBe(true);
      expect(rebuildTokenRoutesFromAvailabilityMock).toHaveBeenCalledTimes(1);
    });

    it('never overrules a manually added model', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-manual',
        available: true,
        isManual: true,
      }).run();
      primeDiscovery([{ site, account, models: ['gpt-manual'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'unsupported',
        reason: 'no such model',
        httpStatus: 404,
        failureKind: 'model_missing',
      }));

      await runProbe();

      const row = await db.select().from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, account.id))
        .get();
      expect(row?.available).toBe(true);
      expect(rebuildTokenRoutesFromAvailabilityMock).not.toHaveBeenCalled();
    });

    it('skips disabled sites in a batch run', async () => {
      const enabled = await seedSite({ name: 'live-site' });
      const disabled = await seedSite({ name: 'off-site', status: 'disabled' });
      await setInterest(['^gpt-']);
      primeDiscovery([
        { site: enabled.site, account: enabled.account, models: ['gpt-4o'] },
        { site: disabled.site, account: disabled.account, models: ['gpt-4o'] },
      ]);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      await runProbe();

      const rows = await db.select().from(schema.modelProbeResults).all();
      expect(rows.map((row) => row.siteId)).toEqual([enabled.site.id]);
    });

    it('logs the discovery count, every model verdict and a final summary', async () => {
      const { site, account } = await seedSite({ name: 'log-site' });
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-ok', 'gpt-bad', 'gpt-huh'] }]);
      probeRuntimeModelMock.mockImplementation(async (input: { modelName: string }) => {
        if (input.modelName === 'gpt-bad') {
          return probeResult({ status: 'unsupported', reason: 'no such model', httpStatus: 404, failureKind: 'model_missing' });
        }
        if (input.modelName === 'gpt-huh') {
          return probeResult({ status: 'inconclusive', reason: 'timeout', httpStatus: null, failureKind: 'timeout' });
        }
        return probeResult();
      });

      const { finished, logs } = await runProbe();
      const text = logs.map((entry) => entry.message).join('\n');

      expect(finished?.status).toBe('succeeded');
      expect(text).toContain('log-site');
      expect(text).toMatch(/3/);
      for (const modelName of ['gpt-ok', 'gpt-bad', 'gpt-huh']) {
        expect(text).toContain(modelName);
      }
      expect(text).toMatch(/supported/);
      expect(text).toMatch(/unsupported/);
      expect(text).toMatch(/inconclusive/);

      const result = finished?.result as { supported: number; unsupported: number; inconclusive: number };
      expect(result.supported).toBe(1);
      expect(result.unsupported).toBe(1);
      expect(result.inconclusive).toBe(1);
    });

    it('never leaks the credential into task logs or the task result', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'inconclusive',
        reason: `upstream said: token ${CREDENTIAL} rejected`,
        failureKind: 'auth',
      }));

      const { finished, logs } = await runProbe();
      const serialized = `${JSON.stringify(finished?.result)}\n${logs.map((entry) => entry.message).join('\n')}`;

      expect(serialized).not.toContain(CREDENTIAL);
    });

    it('masks the credential out of an upstream reason before persisting it', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult({
        status: 'inconclusive',
        reason: `invalid api key: ${CREDENTIAL}`,
        failureKind: 'auth',
      }));

      await runProbe();

      const { MODEL_PROBE_CREDENTIAL_MASK } = await import('./modelProbeSecrets.js');
      const row = await db.select().from(schema.modelProbeResults).get();
      expect(row?.reason).not.toContain(CREDENTIAL);
      expect(row?.reason).toContain(MODEL_PROBE_CREDENTIAL_MASK);

      const served = await service.listActiveModelProbeResults({});
      expect(JSON.stringify(served)).not.toContain(CREDENTIAL);
    });

    /**
     * The server-side ceiling on one sweep, pinned independently of the API's
     * 409 gate.
     *
     * It is the last line of defence: the route refuses an oversized run using a
     * freshly computed preview, but this cap sits after discovery inside the run
     * itself, so it also covers the case where the model list grew between the
     * preview and the sweep. Its whole job is to spend NO quota, so the
     * assertion is that zero probes were issued — not merely that the task
     * failed.
     */
    it('refuses a sweep over the run-target cap before issuing a single probe', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      const models = Array.from(
        { length: service.MAX_ACTIVE_PROBE_RUN_TARGETS + 1 },
        (_unused, index) => `gpt-${index}`,
      );
      primeDiscovery([{ site, account, models }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      const { finished } = await runProbe();

      expect(finished?.status).toBe('failed');
      expect(finished?.error).toContain(String(service.MAX_ACTIVE_PROBE_RUN_TARGETS));
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
      expect(await db.select().from(schema.modelProbeResults).all()).toHaveLength(0);
    });

    it('runs a sweep sitting exactly on the cap', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      const models = Array.from(
        { length: service.MAX_ACTIVE_PROBE_RUN_TARGETS },
        (_unused, index) => `gpt-${index}`,
      );
      primeDiscovery([{ site, account, models }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      const { finished } = await runProbe();

      // The cap is a ceiling, not a fence one short of it: an off-by-one that
      // refused the allowed maximum would be caught here.
      expect(finished?.status).toBe('succeeded');
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(service.MAX_ACTIVE_PROBE_RUN_TARGETS);
    }, 30_000);

    it('flags a preview whose target set would be refused by the cap', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      const models = Array.from(
        { length: service.MAX_ACTIVE_PROBE_RUN_TARGETS + 1 },
        (_unused, index) => `gpt-${index}`,
      );
      primeDiscovery([{ site, account, models }]);

      const over = await service.previewActiveModelProbe();
      expect(over.totalModels).toBe(service.MAX_ACTIVE_PROBE_RUN_TARGETS + 1);
      expect(over.exceedsRunLimit).toBe(true);

      primeDiscovery([{ site, account, models: models.slice(0, service.MAX_ACTIVE_PROBE_RUN_TARGETS) }]);
      const atCap = await service.previewActiveModelProbe();
      expect(atCap.exceedsRunLimit).toBe(false);
    });

    /**
     * The confirmation gate lives in `modelProbeApiService`, which computes its own
     * preview. Before this, the number it gated on never reached the runner: the
     * runner re-ran discovery and was bounded only by the hard cap. So a
     * model-list request that timed out during the gate (contributing 0 targets,
     * total under the dialog threshold, no dialog shown) and then recovered before
     * the run turned an unconfirmed click into hundreds of real paid requests.
     *
     * These cases drive the discovered set independently of the authorized count,
     * which is the only way to observe the binding at all.
     */
    async function seedAuthorizedRun(input: { discovered: number; authorized?: number }) {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      const models = Array.from({ length: input.discovered }, (_unused, index) => `gpt-${index}`);
      primeDiscovery([{ site, account, models }]);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      return runProbe(
        input.authorized === undefined
          ? undefined
          : { authorizedTargetCount: input.authorized },
      );
    }

    it('refuses a sweep that materially exceeds the authorized count, before any probe', async () => {
      // The reported scenario: the gate saw 40 (under the 50-target dialog
      // threshold, so no confirmation was ever shown) and the runner's own
      // discovery then found a recovered site carrying far more.
      const { finished } = await seedAuthorizedRun({ discovered: 250, authorized: 40 });

      expect(finished?.status).toBe('failed');
      // Actionable: both numbers, so the operator knows the set moved rather than
      // that "something" was refused.
      expect(finished?.error).toContain('40');
      expect(finished?.error).toContain('250');
      // The property that matters is quota, not the status: nothing was spent.
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
      expect(await db.select().from(schema.modelProbeResults).all()).toHaveLength(0);
    });

    it('allows the discovered set to drift upward within the authorized slack', async () => {
      // Paired with the refusal above so neither can pass by refusing everything:
      // an exact-match rule would fail a run whenever a site legitimately gained
      // one model between the gate and the sweep, which is its own defect.
      const authorized = 60;
      const discovered = service.modelProbeAuthorizedTargetCeiling(authorized);
      const { finished } = await seedAuthorizedRun({ discovered, authorized });

      expect(finished?.status).toBe('succeeded');
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(discovered);
    }, 30_000);

    it('refuses one target past the authorized ceiling', async () => {
      const authorized = 60;
      const discovered = service.modelProbeAuthorizedTargetCeiling(authorized) + 1;
      const { finished } = await seedAuthorizedRun({ discovered, authorized });

      // Pins the boundary itself: an off-by-one either way would show up here and
      // not in the two tests above.
      expect(finished?.status).toBe('failed');
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
    });

    it('runs a set smaller than the authorized count without complaint', async () => {
      // Spending LESS than what was authorized needs no permission.
      const { finished } = await seedAuthorizedRun({ discovered: 3, authorized: 200 });

      expect(finished?.status).toBe('succeeded');
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(3);
    });

    it('records a probe throw as inconclusive rather than aborting the run', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-boom', 'gpt-fine'] }]);
      probeRuntimeModelMock.mockImplementation(async (input: { modelName: string }) => {
        if (input.modelName === 'gpt-boom') throw new Error('socket exploded');
        return probeResult();
      });

      const { finished } = await runProbe();

      expect(finished?.status).toBe('succeeded');
      const rows = await db.select().from(schema.modelProbeResults).all();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.modelName === 'gpt-boom')?.status).toBe('inconclusive');
    });
  });

  describe('listActiveModelProbeResults', () => {
    async function seedResults() {
      const alpha = await seedSite({ name: 'alpha-site' });
      const beta = await seedSite({ name: 'beta-site' });
      await db.update(schema.accounts).set({ balance: 1 })
        .where(eq(schema.accounts.id, alpha.account.id)).run();
      await db.update(schema.accounts).set({ balance: 99 })
        .where(eq(schema.accounts.id, beta.account.id)).run();

      await db.insert(schema.modelProbeResults).values([
        {
          siteId: alpha.site.id,
          accountId: alpha.account.id,
          modelName: 'gpt-4o',
          status: 'supported',
          latencyMs: 300,
          checkedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          siteId: alpha.site.id,
          accountId: alpha.account.id,
          modelName: 'claude-opus',
          status: 'unsupported',
          latencyMs: 100,
          checkedAt: '2026-08-03T00:00:00.000Z',
        },
        {
          siteId: beta.site.id,
          accountId: beta.account.id,
          modelName: 'gpt-5',
          status: 'inconclusive',
          latencyMs: 200,
          checkedAt: '2026-08-02T00:00:00.000Z',
        },
      ]).run();

      return { alpha, beta };
    }

    it('filters by model text, site and status', async () => {
      const { alpha } = await seedResults();

      const byModel = await service.listActiveModelProbeResults({ model: 'GPT' });
      expect(byModel.total).toBe(2);
      expect(byModel.items.map((item) => item.modelName).sort()).toEqual(['gpt-4o', 'gpt-5']);

      const bySite = await service.listActiveModelProbeResults({ siteId: alpha.site.id });
      expect(bySite.total).toBe(2);
      expect(bySite.items.every((item) => item.siteId === alpha.site.id)).toBe(true);

      const byStatus = await service.listActiveModelProbeResults({ status: 'unsupported' });
      expect(byStatus.total).toBe(1);
      expect(byStatus.items[0]?.modelName).toBe('claude-opus');
    });

    it('sorts by latency, balance and checkedAt in both directions', async () => {
      await seedResults();

      const latencyAsc = await service.listActiveModelProbeResults({ sortBy: 'latency', order: 'asc' });
      expect(latencyAsc.items.map((item) => item.latencyMs)).toEqual([100, 200, 300]);

      const latencyDesc = await service.listActiveModelProbeResults({ sortBy: 'latency', order: 'desc' });
      expect(latencyDesc.items.map((item) => item.latencyMs)).toEqual([300, 200, 100]);

      const balanceDesc = await service.listActiveModelProbeResults({ sortBy: 'balance', order: 'desc' });
      expect(balanceDesc.items[0]?.balance).toBe(99);

      const checkedAsc = await service.listActiveModelProbeResults({ sortBy: 'checkedAt', order: 'asc' });
      expect(checkedAsc.items.map((item) => item.modelName)).toEqual(['gpt-4o', 'gpt-5', 'claude-opus']);
    });

    it('defaults to the newest first', async () => {
      await seedResults();

      const page = await service.listActiveModelProbeResults({});

      expect(page.items.map((item) => item.modelName)).toEqual(['claude-opus', 'gpt-5', 'gpt-4o']);
    });

    it('paginates with limit and offset while total stays the unpaged count', async () => {
      await seedResults();

      const first = await service.listActiveModelProbeResults({ limit: 2, offset: 0, sortBy: 'latency', order: 'asc' });
      expect(first.total).toBe(3);
      expect(first.items.map((item) => item.latencyMs)).toEqual([100, 200]);

      const second = await service.listActiveModelProbeResults({ limit: 2, offset: 2, sortBy: 'latency', order: 'asc' });
      expect(second.total).toBe(3);
      expect(second.items.map((item) => item.latencyMs)).toEqual([300]);
    });

    it('joins the site name and account balance onto every row', async () => {
      const { alpha } = await seedResults();

      const page = await service.listActiveModelProbeResults({ siteId: alpha.site.id });

      expect(page.items.every((item) => item.siteName === 'alpha-site')).toBe(true);
      expect(page.items.every((item) => item.balance === 1)).toBe(true);
    });

    it('never returns a credential field', async () => {
      await seedResults();

      const serialized = JSON.stringify(await service.listActiveModelProbeResults({}));

      expect(serialized).not.toContain(CREDENTIAL);
      expect(serialized).not.toContain('credential');
      expect(serialized).not.toContain('apiToken');
      expect(serialized).not.toContain('accessToken');
    });
  });

  describe('module properties', () => {
    it('names the fields that carry upstream prose so the HTTP layer can redact them', () => {
      expect(service.MODEL_PROBE_UPSTREAM_TEXT_FIELDS).toEqual(
        expect.arrayContaining(['reason', 'notes', 'liveFailure.message', 'skipped.message']),
      );
    });

    async function readServiceCode() {
      const source = await readFile(new URL('./modelProbeRunService.ts', import.meta.url), 'utf8');
      // Strip comments: these assertions are about code, and the doc comments
      // legitimately name what they explain the absence of.
      return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    }

    it('masks credentials through the shared module instead of a private copy', async () => {
      const code = await readServiceCode();

      // One owner for value-based masking (`modelProbeSecrets.ts`). A second
      // local implementation is how the two drift apart — e.g. one keeping an
      // 8-character floor the other loses.
      expect(code).toContain("from './modelProbeSecrets.js'");
      expect(code).toContain('maskCredentialInText(');
      expect(code).not.toMatch(/function\s+maskCredential\s*\(/);
      expect(code).not.toContain('[redacted-credential]');
    });

    it('registers no interval timer of its own', async () => {
      // The whole point of an *active* probe is that an operator triggers it.
      // A timer here would turn it into the unattended periodic traffic this
      // feature exists to avoid.
      expect(await readServiceCode()).not.toContain('setInterval');
    });

    it('keeps the routing stack out of its static import graph', async () => {
      // Flipping process.env.PROXY_ROUTING_ENABLED in a test is a no-op (config.ts
      // reads it once at import), so assert the property structurally the way
      // modelProbeConfigService.test.ts does. Routing may only be reached through
      // the dynamic import inside the sync branch.
      const code = await readServiceCode();
      const staticSpecifiers = [...code.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)]
        .map((match) => match[1]);

      expect(staticSpecifiers.length).toBeGreaterThan(0);
      for (const specifier of staticSpecifiers) {
        for (const forbidden of ['tokenRouter', 'routeRefresh', 'routeDecision', 'routeCooldown', 'modelService']) {
          expect(specifier).not.toContain(forbidden);
        }
      }

      // modelService is reachable, but only lazily.
      expect(code).toMatch(/await import\('\.\/modelService\.js'\)/);
    });
  });
});
