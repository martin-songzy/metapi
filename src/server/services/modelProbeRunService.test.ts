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
 * The two collaborators the ADDITIONAL-key discovery path reaches, stubbed because
 * both make real network calls. `discoverProbeKeysForActiveProbe` itself is left
 * real on purpose: it owns the key-set selection this feature is about, so mocking
 * it would test the mock. Its primary-key leg still delegates to
 * `discoverModelsForActiveProbeMock` above.
 */
const requireSiteApiBaseUrlMock = vi.fn();
const fetchTokenAccessibleModelsMock = vi.fn();

/**
 * Stands in for `discoverProbeKeysForActiveProbe`. Assigned in `beforeAll` once the
 * real db module has been imported — `vi.mock` factories are hoisted above the
 * imports, so this cannot be built at module scope.
 */
let discoverProbeKeysForActiveProbeImpl: (...args: any[]) => Promise<unknown> = async () => {
  throw new Error('discoverProbeKeysForActiveProbe stub was not installed');
};

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

/**
 * BOTH discovery entry points are stubbed, and the per-key one is the load-bearing
 * stub.
 *
 * The run service calls `discoverProbeKeysForActiveProbe`, which reaches
 * `discoverModelsForActiveProbe` through a MODULE-LOCAL binding — replacing the
 * export here does not intercept that call, so a stub on the single-key function
 * alone leaves the real primary-key discovery running (adapter → network → a 15s
 * timeout per site, and zero targets).
 *
 * `discoverProbeKeysForActiveProbe` is therefore stubbed at the boundary the run
 * service actually crosses, and its body calls `discoverModelsForActiveProbeMock`
 * once per site so the existing "discovery ran for N sites" assertions keep their
 * meaning. Key SELECTION is `modelProbeDiscoveryService`'s own test's subject; what
 * this file owns is the run loop's traversal over whatever key set it is handed, so
 * the stub reads the real seeded `account_tokens` rows rather than inventing keys.
 */
vi.mock('./modelProbeDiscoveryService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelProbeDiscoveryService.js')>(
    './modelProbeDiscoveryService.js',
  );
  return {
    ...actual,
    discoverModelsForActiveProbe: (...args: unknown[]) => discoverModelsForActiveProbeMock(...args),
    discoverProbeKeysForActiveProbe: (...args: unknown[]) => (
      discoverProbeKeysForActiveProbeImpl(...args)
    ),
  };
});

vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: (...args: unknown[]) => probeRuntimeModelMock(...args),
}));

vi.mock('./siteApiEndpointService.js', async () => {
  const actual = await vi.importActual<typeof import('./siteApiEndpointService.js')>(
    './siteApiEndpointService.js',
  );
  return {
    ...actual,
    requireSiteApiBaseUrl: (...args: unknown[]) => requireSiteApiBaseUrlMock(...args),
  };
});

vi.mock('./modelProbeTokenModels.js', async () => {
  const actual = await vi.importActual<typeof import('./modelProbeTokenModels.js')>(
    './modelProbeTokenModels.js',
  );
  return {
    ...actual,
    fetchTokenAccessibleModels: (...args: unknown[]) => fetchTokenAccessibleModelsMock(...args),
  };
});

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
  let startBackgroundTask: BackgroundTaskModule['startBackgroundTask'];
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
    startBackgroundTask = backgroundTaskModule.startBackgroundTask;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;
    config = configModule.config;
    previousProxyRoutingEnabled = config.proxyRoutingEnabled;

    // Installed here rather than at module scope because it needs the real db, and
    // `vi.mock` factories are hoisted above every import.
    //
    // Mirrors the three rules from `selectProbeKeys` that the run loop depends on:
    // the primary key is FIRST in the array (position, never id, is the
    // discriminator), a key that will not be probed carries a `skipReason` with
    // a null credential, and a token row holding the primary key's own value is
    // dropped rather than probed twice. The site's `models` is the UNION across
    // keys (Q8=A).
    discoverProbeKeysForActiveProbeImpl = async (input: { siteId: number; timeoutMs: number }) => {
      const primary = await discoverModelsForActiveProbeMock(input) as {
        site: unknown; account: { id: number }; models: string[];
        source?: string; notes?: string[]; liveFailure?: unknown;
      };

      const tokens = await db.select()
        .from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, primary.account.id))
        .all();

      const keys: Array<Record<string, unknown>> = [{
        tokenId: 0,
        tokenName: '',
        credential: CREDENTIAL,
        credentialKind: 'api_token',
        skipReason: null,
        models: primary.models,
        source: primary.source ?? 'live',
        liveFailure: primary.liveFailure ?? null,
        notes: primary.notes ?? [],
      }];

      for (const token of [...tokens].sort((left, right) => (left.id ?? 0) - (right.id ?? 0))) {
        // Mirrors the value-level dedupe: a token row holding the primary key's own
        // value is the same key, so it contributes no entry here either.
        if ((token.token || '').trim() === CREDENTIAL) continue;
        const skipReason = token.enabled === false
          ? 'disabled'
          : (token.valueStatus === 'ready' ? null : 'credential_unavailable');
        if (skipReason !== null) {
          keys.push({
            tokenId: token.id,
            tokenName: token.name || '',
            credential: null,
            credentialKind: 'managed_token',
            skipReason,
            models: [],
            source: null,
            liveFailure: null,
            notes: [],
          });
          continue;
        }
        const models = await fetchTokenAccessibleModelsMock({
          baseUrl: await requireSiteApiBaseUrlMock(primary.site),
          credential: token.token,
          timeoutMs: input.timeoutMs,
        }) as string[] | null;
        keys.push({
          tokenId: token.id,
          tokenName: token.name || '',
          credential: token.token,
          credentialKind: 'managed_token',
          skipReason: null,
          models: models || [],
          source: 'live',
          liveFailure: null,
          notes: [],
        });
      }

      return {
        site: primary.site,
        account: primary.account,
        keys,
        models: [...new Set(keys.flatMap((key) => key.models as string[]))],
      };
    };
    // Migration plus the service module graph exceeds the 10s default on a cold
    // Windows filesystem.
  }, 60_000);

  beforeEach(async () => {
    discoverModelsForActiveProbeMock.mockReset();
    probeRuntimeModelMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockResolvedValue(undefined);
    requireSiteApiBaseUrlMock.mockReset();
    requireSiteApiBaseUrlMock.mockResolvedValue('https://api.probe.example.com');
    fetchTokenAccessibleModelsMock.mockReset();
    // Default: an additional key reaches nothing. Every test that cares about the
    // key axis overrides this, and one that does not must not silently acquire
    // extra paid targets from a leftover implementation.
    fetchTokenAccessibleModelsMock.mockResolvedValue([]);
    resetBackgroundTasks();
    config.proxyRoutingEnabled = true;

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelProbeResults).run();
    await db.delete(schema.modelProbeKeyResults).run();
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

  /**
   * Adds an `account_tokens` row — an "additional key" in the probe's vocabulary.
   *
   * `token` defaults to a value derived from the name so each key is distinguishable
   * in `fetchTokenAccessibleModels` stubs: the run loop must pass each key's OWN
   * credential, and a shared value would hide a bug that substitutes the primary.
   */
  async function seedToken(
    accountId: number,
    name: string,
    overrides?: Partial<typeof schema.accountTokens.$inferInsert>,
  ) {
    return db.insert(schema.accountTokens).values({
      accountId,
      name,
      token: `sk-${name}-value`,
      enabled: true,
      valueStatus: 'ready',
      ...overrides,
    }).returning().get();
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
    return saveModelProbeConfig({
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

    /**
     * The per-pattern checkboxes in the global panel store a DISABLE list, so an
     * operator can narrow one sweep to "just the opus rules" without deleting the
     * regexes they will want back next time.
     *
     * Asserted on the preview because that is the shared path: the run compiles the
     * same `resolveEnabledInterestPatterns` result, so a preview that respects the
     * toggle and a run that ignored it would reintroduce exactly the count
     * disagreement the per-key fix removed.
     */
    it('probes only the patterns still switched on, and keeps the others stored', async () => {
      const { site, account } = await seedSite();
      const stored = await setInterest(['^gpt-', '^claude-'], {
        disabledInterestPatterns: ['^gpt-'],
      });
      primeDiscovery([{ site, account, models: ['gpt-4o', 'claude-3', 'gemini-2.5-pro'] }]);

      const preview = await service.previewActiveModelProbe();

      expect(preview.sites[0]?.models).toEqual(['claude-3']);
      expect(preview.totalModels).toBe(1);
      // Switched off, not deleted: the regex is still there for the next sweep.
      expect(stored.interestPatterns).toEqual(['^gpt-', '^claude-']);
      expect(stored.disabledInterestPatterns).toEqual(['^gpt-']);
    });

    it('probes nothing when every pattern is switched off, exactly as when none is configured', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-', '^claude-'], {
        disabledInterestPatterns: ['^gpt-', '^claude-'],
      });
      primeDiscovery([{ site, account, models: ['gpt-4o', 'claude-3'] }]);

      const preview = await service.previewActiveModelProbe();

      // The panel warns about this state rather than treating an all-off list as
      // "no filter": an empty enabled set matches nothing, it does not match all.
      expect(preview.totalModels).toBe(0);
      expect(preview.sites[0]?.models).toEqual([]);
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

    it('never exceeds the configured per-site concurrency inside one site', async () => {
      const { site, account } = await seedSite({ name: 'one' });
      await setInterest(['^gpt-'], { modelConcurrency: 2 });
      primeDiscovery([{ site, account, models: ['gpt-a', 'gpt-b', 'gpt-c', 'gpt-d'] }]);

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

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(4);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(2);
    });

    it('fans out across sites while capping each site at its own axis', async () => {
      const first = await seedSite({ name: 'one' });
      const second = await seedSite({ name: 'two' });
      const third = await seedSite({ name: 'three' });
      await setInterest(['^gpt-'], { siteConcurrency: 2, modelConcurrency: 2 });
      primeDiscovery([
        { site: first.site, account: first.account, models: ['gpt-a', 'gpt-b'] },
        { site: second.site, account: second.account, models: ['gpt-c', 'gpt-d'] },
        { site: third.site, account: third.account, models: ['gpt-e', 'gpt-f'] },
      ]);

      let inFlight = 0;
      let totalPeak = 0;
      const sitesInFlight = new Set<string>();
      let distinctSitePeak = 0;
      const perSiteInFlight = new Map<string, number>();
      const perSitePeak = new Map<string, number>();
      const gates: Array<() => void> = [];
      probeRuntimeModelMock.mockImplementation(async (input: Record<string, unknown>) => {
        const siteName = String((input.site as { name?: string }).name);
        inFlight += 1;
        totalPeak = Math.max(totalPeak, inFlight);
        sitesInFlight.add(siteName);
        distinctSitePeak = Math.max(distinctSitePeak, sitesInFlight.size);
        const now = (perSiteInFlight.get(siteName) ?? 0) + 1;
        perSiteInFlight.set(siteName, now);
        perSitePeak.set(siteName, Math.max(perSitePeak.get(siteName) ?? 0, now));

        await new Promise<void>((resolve) => {
          gates.push(resolve);
          setTimeout(() => {
            const release = gates.shift();
            release?.();
          }, 0).unref?.();
        });

        inFlight -= 1;
        perSiteInFlight.set(siteName, (perSiteInFlight.get(siteName) ?? 1) - 1);
        if ((perSiteInFlight.get(siteName) ?? 0) === 0) sitesInFlight.delete(siteName);
        return probeResult();
      });

      await runProbe();

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(6);
      // Two of the three sites must genuinely overlap — the whole point of the
      // sites axis. Without this a broken grouper that serializes sites passes
      // every cap assertion.
      expect(distinctSitePeak).toBeGreaterThanOrEqual(2);
      // ...while no single site exceeds its own axis...
      for (const peak of perSitePeak.values()) {
        expect(peak).toBeLessThanOrEqual(2);
      }
      // ...and the global burst honours the product of both axes.
      expect(totalPeak).toBeLessThanOrEqual(4);
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
        tokenId: 0,
        tokenName: '',
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
        tokenId: 0,
        tokenName: '',
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
        tokenId: 0,
        tokenName: '',
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

    /**
     * LITERAL expected values, on purpose.
     *
     * The three behavioural tests above all derive `discovered` from
     * `modelProbeAuthorizedTargetCeiling` itself, so they pin the boundary
     * *relative to* the formula and the formula to nothing. An independent
     * reviewer changed the ratio from 0.1 to 3.9 and all 70 tests stayed green: an
     * authorization of 40 then permitted 196 probes, i.e. the confirmation gate was
     * unbound almost to the hard 300 cap — which is exactly what this slack exists
     * to prevent. The coarser mutants that WERE caught were caught incidentally, by
     * the derived `discovered` crossing `MAX_ACTIVE_PROBE_RUN_TARGETS`, not because
     * any test asserted the slack.
     *
     * A test that recomputes the implementation cannot detect a change to it.
     */
    it('allows a concrete, bounded overrun at each end of the range', () => {
      // 40 -> 50 is the absolute floor; 100 is the crossover where the two terms
      // agree; 200 -> 220 is the ratio. Together they pin BOTH terms and the point
      // control passes from one to the other.
      //
      // The reviewer's suggested literal for zero was `0 -> 10`, which documents the
      // behaviour its OWN next finding calls wrong: an authorization of nothing
      // licensed ten paid probes. Zero authorizes zero — see the function docblock.
      expect(service.modelProbeAuthorizedTargetCeiling(0)).toBe(0);
      expect(service.modelProbeAuthorizedTargetCeiling(1)).toBe(11);
      expect(service.modelProbeAuthorizedTargetCeiling(40)).toBe(50);
      expect(service.modelProbeAuthorizedTargetCeiling(60)).toBe(70);
      expect(service.modelProbeAuthorizedTargetCeiling(100)).toBe(110);
      expect(service.modelProbeAuthorizedTargetCeiling(101)).toBe(112);
      expect(service.modelProbeAuthorizedTargetCeiling(200)).toBe(220);

      // The slack must stay far below the failure it exists to stop — a whole site
      // reappearing between the gate and the sweep. Stated as a bound rather than
      // as an equality so it survives a deliberate, small retune of either term.
      for (const authorized of [0, 1, 40, 60, 100, 200, 300]) {
        const ceiling = service.modelProbeAuthorizedTargetCeiling(authorized);
        expect(ceiling, `ceiling(${authorized})`).toBeLessThanOrEqual(authorized + 30 + authorized * 0.25);
      }
    });

    it('clamps a fractional, negative or non-finite authorization before applying slack', () => {
      // Reached only by an internal caller: the HTTP path passes
      // `preview.totalModels`, a reduce over array lengths. Pinned anyway because
      // `length > NaN` is always false, so a NaN reaching the comparison would
      // silently disable the guard — failing OPEN on a paid operation — and
      // `Math.max(0, Math.trunc(NaN))` is NaN, not 0, so the existing clamp did not
      // stop it. Every degenerate input now licenses nothing.
      expect(service.modelProbeAuthorizedTargetCeiling(-5)).toBe(0);
      expect(service.modelProbeAuthorizedTargetCeiling(40.9)).toBe(50);
      expect(service.modelProbeAuthorizedTargetCeiling(Number.NaN)).toBe(0);
      expect(service.modelProbeAuthorizedTargetCeiling(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('refuses a sweep authorized for zero targets, before any probe', async () => {
      // The reachable scenario: every site's model-list request times out at gate
      // time, so `preview.totalModels` is 0, which is under the dialog threshold —
      // the run is queued with no confirmation. Discovery then recovers.
      const { finished } = await seedAuthorizedRun({ discovered: 4, authorized: 0 });

      expect(finished?.status).toBe('failed');
      // Quota is the property, not the status.
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
      expect(await db.select().from(schema.modelProbeResults).all()).toHaveLength(0);
    });

    it('still lets a zero-target sweep finish when discovery also finds nothing', async () => {
      // Paired with the refusal above: authorizing 0 and discovering 0 is a
      // consistent no-op, not an error. Without this, "zero authorizes zero" could
      // be implemented as "zero always fails".
      const { finished } = await seedAuthorizedRun({ discovered: 0, authorized: 0 });

      expect(finished?.status).toBe('succeeded');
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    /**
     * Before this a queued sweep could not be stopped at any layer, so a few
     * hundred serial paid requests ended only when someone restarted the server.
     * 不再跟随 stops the page following the task; it never stopped the task.
     *
     * The flag is checked BETWEEN models, so an already-issued request still
     * completes — bounded by the probe timeout. That is stated in the service
     * docblock and is why the assertion below is "one probe, not zero".
     */
    async function seedFourModelRun() {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-1', 'gpt-2', 'gpt-3', 'gpt-4'] }]);
    }

    it('stops between models, keeps what it probed, and reports itself cancelled', async () => {
      await seedFourModelRun();

      let taskId: string | null = null;
      let cancelOutcome = '';
      probeRuntimeModelMock.mockImplementation(async () => {
        // Cancel from inside the first probe, so the sweep is genuinely in flight
        // rather than cancelled before it started.
        if (probeRuntimeModelMock.mock.calls.length === 1 && taskId) {
          cancelOutcome = service.requestActiveModelProbeCancellation(taskId);
        }
        return probeResult();
      });

      const queued = service.queueActiveModelProbe();
      taskId = queued.task.id;
      const finished = await waitForBackgroundTaskCompletion(queued.task.id);

      expect(cancelOutcome).toBe('accepted');
      // The property that matters: the remaining three models cost nothing.
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
      expect(finished?.result).toMatchObject({
        cancelled: true,
        probed: 1,
        remaining: 3,
      });
      // Partial results are KEPT — the one model really did answer.
      const rows = await db.select().from(schema.modelProbeResults).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.modelName).toBe('gpt-1');
      expect(getBackgroundTask(queued.task.id)?.logs.some((entry) => entry.message.includes('取消'))).toBe(true);
    });

    it('reports an uncancelled sweep over the same models as not cancelled', async () => {
      // Pairs with the case above so neither can pass by probing nothing: same
      // fixture, no cancel, all four probed and `cancelled` false.
      await seedFourModelRun();
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      const { finished } = await runProbe();

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(4);
      expect(finished?.result).toMatchObject({ cancelled: false, probed: 4, remaining: 0 });
    });

    it('withholds the routing sync from a cancelled sweep even with both switches on', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      primeDiscovery([{ site, account, models: ['gpt-1', 'gpt-2'] }]);
      await db.insert(schema.modelAvailability).values([
        { accountId: account.id, modelName: 'gpt-1', available: true, isManual: false },
        { accountId: account.id, modelName: 'gpt-2', available: true, isManual: false },
      ]).run();

      let taskId: string | null = null;
      probeRuntimeModelMock.mockImplementation(async () => {
        if (probeRuntimeModelMock.mock.calls.length === 1 && taskId) {
          service.requestActiveModelProbeCancellation(taskId);
        }
        return probeResult({ status: 'unsupported', failureKind: 'error_body' });
      });

      const queued = service.queueActiveModelProbe();
      taskId = queued.task.id;
      const finished = await waitForBackgroundTaskCompletion(queued.task.id);

      // Cancellation withdraws the operator's authorization mid-flight, so a
      // partial sweep must not leave persistent routing effects behind. The
      // verdict itself is still recorded for inspection.
      expect(finished?.result).toMatchObject({ cancelled: true, disabled: 0, routingSynced: false });
      expect(rebuildTokenRoutesFromAvailabilityMock).not.toHaveBeenCalled();
      const availability = await db.select().from(schema.modelAvailability).all();
      expect(availability.every((row) => row.available === true)).toBe(true);
    });

    it('control: the same unsupported verdict does sync when the sweep completes', async () => {
      // Without this the assertion above could be satisfied by a sync path that
      // never fires in this fixture at all.
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      primeDiscovery([{ site, account, models: ['gpt-1'] }]);
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-1',
        available: true,
        isManual: false,
      }).run();
      probeRuntimeModelMock.mockResolvedValue(probeResult({ status: 'unsupported', failureKind: 'error_body' }));

      const { finished } = await runProbe();

      expect(finished?.result).toMatchObject({ cancelled: false, disabled: 1, routingSynced: true });
    });

    /**
     * The cancel path must not become a way to flag *any* background task. It
     * shares an id space with every other task type, and the flag it sets is only
     * ever read by the probe loop — so flagging a foreign task would silently do
     * nothing while telling the operator it worked.
     */
    it('refuses to cancel a background task that is not a probe sweep', async () => {
      let release: (() => void) | null = null;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const foreign = startBackgroundTask(
        { type: 'some-other-task', title: '别的后台任务' },
        async () => { await blocked; },
      );
      try {
        expect(foreign.task.status === 'pending' || foreign.task.status === 'running').toBe(true);
        expect(service.requestActiveModelProbeCancellation(foreign.task.id)).toBe('not_found');
        expect(service.isActiveModelProbeCancelled(foreign.task.id)).toBe(false);
      } finally {
        release?.();
        await waitForBackgroundTaskCompletion(foreign.task.id);
      }
    });

    it('refuses to cancel an unknown task or one that already finished', async () => {
      expect(service.requestActiveModelProbeCancellation('no-such-task')).toBe('not_found');

      await seedFourModelRun();
      probeRuntimeModelMock.mockResolvedValue(probeResult());
      const { queued } = await runProbe();

      // Terminal, so there is nothing left to stop; saying `accepted` here would
      // tell the operator a completed sweep was cancelled.
      expect(service.requestActiveModelProbeCancellation(queued.task.id)).toBe('already_finished');
    });

    /**
     * Pins that the cancellation flag is per-task state, not a module-level
     * boolean: implemented as a latch, a second sweep over the same scope would
     * stop before its first model and report itself cancelled.
     *
     * It also pins the cleanup directly. Because task ids are never reused, a
     * missing `finally` is not observable through a later run's behaviour at all —
     * only the flag itself shows it, so it is asserted rather than inferred.
     */
    it('clears a cancellation with its task and does not latch it across sweeps', async () => {
      await seedFourModelRun();

      let firstTaskId: string | null = null;
      probeRuntimeModelMock.mockImplementation(async () => {
        if (probeRuntimeModelMock.mock.calls.length === 1 && firstTaskId) {
          service.requestActiveModelProbeCancellation(firstTaskId);
        }
        return probeResult();
      });

      const first = service.queueActiveModelProbe();
      firstTaskId = first.task.id;
      // Positive control: while the sweep is being cancelled the flag is set, so
      // the cleared assertion below cannot pass by never having been set at all.
      await waitForBackgroundTaskCompletion(first.task.id);
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);
      expect(service.isActiveModelProbeCancelled(firstTaskId)).toBe(false);

      probeRuntimeModelMock.mockReset();
      probeRuntimeModelMock.mockResolvedValue(probeResult());
      const second = await runProbe();

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(4);
      expect(second.finished?.result).toMatchObject({ cancelled: false, probed: 4 });
    });

    /** The positive half of the assertion above, observed mid-flight. */
    it('reports the flag as set while the sweep is still winding down', async () => {
      await seedFourModelRun();

      let taskId: string | null = null;
      const flagDuringRun: boolean[] = [];
      probeRuntimeModelMock.mockImplementation(async () => {
        if (taskId) {
          if (probeRuntimeModelMock.mock.calls.length === 1) {
            service.requestActiveModelProbeCancellation(taskId);
          }
          flagDuringRun.push(service.isActiveModelProbeCancelled(taskId));
        }
        return probeResult();
      });

      const started = service.queueActiveModelProbe();
      taskId = started.task.id;
      await waitForBackgroundTaskCompletion(started.task.id);

      expect(flagDuringRun).toEqual([true]);
      expect(service.isActiveModelProbeCancelled(taskId)).toBe(false);
    });

    /**
     * The mirror of every case above, and the one they all miss: a cancel arriving
     * while the LAST model's probe is in flight. The flag is read after
     * `mapWithConcurrency` resolves, so such a cancel is observed by nothing except
     * the summary — every model was probed and every request was paid for, yet the
     * run reported `cancelled: true, remaining: 0` and withheld the routing sync.
     * The operator was shown 「已取消」 above 「还有 0 个模型没有被探测」 and had to
     * re-run the whole sweep at full quota cost to apply verdicts it had already
     * earned.
     *
     * The withholding is gated on the sweep being PARTIAL, which is what the
     * service's own comment says it is for. `remaining: 0` is not partial.
     *
     * The competing reading, recorded because it is not unreasonable: an operator
     * cancelling because the interest regex was wrong does not want those verdicts
     * applied at all. It loses on two counts — `model_availability` is a reversible
     * per-account flip rather than sticky site-wide state, and the verdicts are
     * accurate about the models that were actually probed — against a full re-spend
     * of real money on the other side.
     */
    it('applies the routing sync when the cancel lands after the final model', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-'], { syncToRouting: true });
      primeDiscovery([{ site, account, models: ['gpt-1', 'gpt-2'] }]);
      await db.insert(schema.modelAvailability).values([
        { accountId: account.id, modelName: 'gpt-1', available: true, isManual: false },
        { accountId: account.id, modelName: 'gpt-2', available: true, isManual: false },
      ]).run();

      let taskId: string | null = null;
      probeRuntimeModelMock.mockImplementation(async () => {
        // From inside the LAST probe, so nothing is left for the loop to skip.
        if (probeRuntimeModelMock.mock.calls.length === 2 && taskId) {
          service.requestActiveModelProbeCancellation(taskId);
        }
        return probeResult({ status: 'unsupported', failureKind: 'error_body' });
      });

      const queued = service.queueActiveModelProbe();
      taskId = queued.task.id;
      const finished = await waitForBackgroundTaskCompletion(queued.task.id);

      // `cancelled` stays true: the operator did press cancel, and reporting
      // otherwise would deny something that happened.
      expect(finished?.result).toMatchObject({
        cancelled: true,
        probed: 2,
        remaining: 0,
        disabled: 2,
        routingSynced: true,
      });
      expect(rebuildTokenRoutesFromAvailabilityMock).toHaveBeenCalledTimes(1);
      const availability = await db.select().from(schema.modelAvailability).all();
      expect(availability.every((row) => row.available === false)).toBe(true);
    });

    it('says the cancel changed nothing when it landed after the last model', async () => {
      // The log line is the operator's only account of what a cancel cost them, so
      // it must not claim an incomplete sweep when nothing was skipped.
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-1'] }]);

      let taskId: string | null = null;
      probeRuntimeModelMock.mockImplementation(async () => {
        if (taskId) service.requestActiveModelProbeCancellation(taskId);
        return probeResult();
      });

      const queued = service.queueActiveModelProbe();
      taskId = queued.task.id;
      await waitForBackgroundTaskCompletion(queued.task.id);

      const logs = getBackgroundTask(queued.task.id)?.logs.map((entry) => entry.message) ?? [];
      const terminal = logs.at(-1) ?? '';
      expect(terminal).toContain('取消');
      // Would have read 「另有 0 个未探测」.
      expect(terminal).not.toContain('另有 0 个');
      expect(terminal).toContain('全部目标都已探测完');
    });
  });

  describe('per-key traversal', () => {
    it('probes every key for every model and keeps the verdicts in separate rows', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o', 'gpt-5'] }]);
      const extra = await seedToken(account.id, 'group-b', { token: 'sk-extra-key' });
      // The additional key lists the same two models, so the target set is
      // 2 keys x 2 models. Q13=A: no dedupe across keys.
      fetchTokenAccessibleModelsMock.mockResolvedValue(['gpt-4o', 'gpt-5']);
      // Verdicts differ BY KEY, which is the whole point of the feature: if the
      // rows collided, one of these two answers would be lost.
      probeRuntimeModelMock.mockImplementation(async (input: { tokenValue: string }) => (
        probeResult(input.tokenValue === CREDENTIAL
          ? { status: 'unsupported', latencyMs: 10 }
          : { status: 'supported', latencyMs: 20 })
      ));

      await runProbe();

      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(4);
      const rows = await db.select().from(schema.modelProbeKeyResults).all();
      expect(rows).toHaveLength(4);
      expect(rows.map((row) => `${row.tokenId}:${row.modelName}:${row.status}`).sort()).toEqual([
        `0:gpt-4o:unsupported`,
        `0:gpt-5:unsupported`,
        `${extra.id}:gpt-4o:supported`,
        `${extra.id}:gpt-5:supported`,
      ]);
      // The primary key's verdict is the only one in the site-scoped table (Q15=B):
      // the additional key carries no proxy traffic, so its answer must not stand
      // in for the site.
      const siteRows = await db.select().from(schema.modelProbeResults).all();
      expect(siteRows).toHaveLength(2);
      expect(siteRows.every((row) => row.status === 'unsupported')).toBe(true);
      // Q7=C: availability follows the primary key alone. Taking the union would
      // have marked both models available and then failed every proxied request,
      // because forwarding uses the primary credential.
      const availability = await db.select().from(schema.modelAvailability).all();
      expect(availability.every((row) => row.available === false)).toBe(true);
    });

    /**
     * The reported failure, in miniature: every sweep was refused before spending
     * anything, and re-previewing produced the same two numbers again.
     *
     * `models` is the site-level UNION across keys — what an operator reads as
     * "which models will be probed here" — while the runner enqueues one probe per
     * (key, model). A site with three keys therefore recounted at up to 3x the
     * authorized number, `modelProbeAuthorizedTargetCeiling` refused it, and the
     * operator saw "confirmed 63, rediscovered 122" with no way to proceed.
     *
     * Sized so the OLD number is refused rather than merely different: 6 models x
     * 3 keys is 18 targets, and an authorization of 6 permits at most 16.
     */
    it('authorizes the per-key target count, not the site union, so a multi-key sweep can run', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      const models = Array.from({ length: 6 }, (_unused, index) => `gpt-${index}`);
      primeDiscovery([{ site, account, models }]);
      await seedToken(account.id, 'group-b', { token: 'sk-b' });
      await seedToken(account.id, 'group-c', { token: 'sk-c' });
      // Fully overlapping on purpose: the union stays 6 whatever the key axis does,
      // so preview and runner can only agree if BOTH count per key.
      fetchTokenAccessibleModelsMock.mockResolvedValue(models);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      const preview = await service.previewActiveModelProbe();
      expect(preview.sites[0]?.models).toHaveLength(6);
      expect(preview.sites[0]?.targetCount).toBe(18);
      // The per-key breakdown backs the number instead of asking the operator to
      // trust it: three probable keys, six models each.
      expect(preview.sites[0]?.keys.map((key) => key.modelCount)).toEqual([6, 6, 6]);
      expect(preview.totalModels).toBe(18);

      const { finished } = await runProbe({ authorizedTargetCount: preview.totalModels });

      expect(finished?.status).toBe('succeeded');
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(18);
    }, 30_000);

    it('still refuses a sweep authorized for the union alone, which is what the gate used to send', async () => {
      // Paired with the test above so the fix cannot be mistaken for loosening the
      // gate: the counter was wrong, the ceiling was not. An authorization that
      // genuinely covers only the union must still refuse a per-key sweep.
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      const models = Array.from({ length: 6 }, (_unused, index) => `gpt-${index}`);
      primeDiscovery([{ site, account, models }]);
      await seedToken(account.id, 'group-b', { token: 'sk-b' });
      await seedToken(account.id, 'group-c', { token: 'sk-c' });
      fetchTokenAccessibleModelsMock.mockResolvedValue(models);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      const { finished } = await runProbe({ authorizedTargetCount: models.length });

      expect(finished?.status).toBe('failed');
      expect(probeRuntimeModelMock).not.toHaveBeenCalled();
    });

    /**
     * A skipped key contributes no probes, so it must contribute nothing to the
     * number the gate authorizes either. Counting it would inflate the estimate and
     * make the confirm dialog overstate the spend — the opposite error from the one
     * above, and the reason preview and runner share one predicate rather than two
     * matching filters.
     */
    it('leaves a key that will be skipped out of the authorized count', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o', 'gpt-5'] }]);
      await seedToken(account.id, 'switched-off', { enabled: false });
      await seedToken(account.id, 'masked', { valueStatus: 'masked_pending' });
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      const preview = await service.previewActiveModelProbe();
      // Two models on the primary key alone; the two unusable keys add nothing.
      expect(preview.totalModels).toBe(2);
      expect(preview.sites[0]?.keys.filter((key) => key.skipReason !== null)).toHaveLength(2);

      const { finished } = await runProbe({ authorizedTargetCount: preview.totalModels });

      expect(finished?.status).toBe('succeeded');
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(2);
    });

    it('keeps two accounts\' primary keys apart despite the shared sentinel id', async () => {
      const alpha = await seedSite({ name: 'alpha' });
      const beta = await seedSite({ name: 'beta' });
      await setInterest(['^gpt-']);
      primeDiscovery([
        { site: alpha.site, account: alpha.account, models: ['gpt-4o'] },
        { site: beta.site, account: beta.account, models: ['gpt-4o'] },
      ]);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      await runProbe();

      // Both rows carry token_id 0 for the same model name. Keyed on
      // (token_id, model_name) alone — the version the design review corrected —
      // the second upsert would have overwritten the first.
      const rows = await db.select().from(schema.modelProbeKeyResults).all();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.tokenId === 0)).toBe(true);
      expect(rows.map((row) => row.accountId).sort()).toEqual(
        [alpha.account.id, beta.account.id].sort(),
      );
    });

    it('records a listed-but-never-probed key without spending a request on it', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      const off = await seedToken(account.id, 'switched-off', { enabled: false });
      const unusable = await seedToken(account.id, 'masked', {
        valueStatus: 'masked_pending',
      });
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      await runProbe();

      // Only the primary key was probed: a skipped key costs nothing (Q20=A).
      expect(probeRuntimeModelMock).toHaveBeenCalledTimes(1);

      const rows = await db.select().from(schema.modelProbeKeyResults).all();
      const byToken = new Map(rows.map((row) => [row.tokenId, row]));
      // Q21=B: both skipped keys still appear, each saying why. Omitting them would
      // read as "this key reaches no models" — a claim no probe ever tested.
      expect(byToken.get(off.id)?.status).toBe('disabled');
      expect(byToken.get(unusable.id)?.status).toBe('unavailable');
      expect(byToken.get(0)?.status).toBe('supported');
      // A never-probed row carries no latency and no prompt: nothing was sent.
      expect(byToken.get(off.id)?.latencyMs).toBeNull();
      expect(byToken.get(off.id)?.promptUsed).toBeNull();
      // ...and it must not move the summary counters, which report probes.
      const summary = await service.previewActiveModelProbe();
      expect(summary.totalModels).toBe(1);
    });

    it('clears the per-key table alongside the site-scoped one', async () => {
      const { site, account } = await seedSite();
      await setInterest(['^gpt-']);
      primeDiscovery([{ site, account, models: ['gpt-4o'] }]);
      await seedToken(account.id, 'group-b', { token: 'sk-extra-key' });
      fetchTokenAccessibleModelsMock.mockResolvedValue(['gpt-4o']);
      probeRuntimeModelMock.mockResolvedValue(probeResult());

      await runProbe();
      expect(await db.select().from(schema.modelProbeResults).all()).not.toHaveLength(0);
      expect(await db.select().from(schema.modelProbeKeyResults).all()).not.toHaveLength(0);

      await service.clearModelProbeResults();

      // Both tables, or the results page would keep rendering per-key rows for
      // verdicts the operator just cleared (Q18).
      expect(await db.select().from(schema.modelProbeResults).all()).toHaveLength(0);
      expect(await db.select().from(schema.modelProbeKeyResults).all()).toHaveLength(0);
    });
  });

  describe('probe failure isolation', () => {
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

      await db.insert(schema.modelProbeKeyResults).values([
        {
          siteId: alpha.site.id,
          accountId: alpha.account.id,
          tokenId: 0,
          tokenName: '',
          modelName: 'gpt-4o',
          status: 'supported',
          latencyMs: 300,
          checkedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          siteId: alpha.site.id,
          accountId: alpha.account.id,
          tokenId: 0,
          tokenName: '',
          modelName: 'claude-opus',
          status: 'unsupported',
          latencyMs: 100,
          checkedAt: '2026-08-03T00:00:00.000Z',
        },
        {
          siteId: beta.site.id,
          accountId: beta.account.id,
          tokenId: 0,
          tokenName: '',
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

    /**
     * Null rows are the COMMON case on both sortable columns, not an edge: every
     * timed-out or skipped probe stores a null `latencyMs`, and `balance` is null
     * whenever the probe account was deleted or its balance is unknown.
     *
     * The dialects disagree on where those rows land. SQLite and MySQL sort NULLs
     * FIRST on `asc`; Postgres sorts them LAST on `asc` and FIRST on `desc`. Every
     * test here runs on SQLite while production runs on Supabase, so without an
     * explicit placement the requirement "sortable by response speed and by
     * balance" behaves in production unlike in any test — and 「最快优先」 opens on a
     * page of 「—」 placeholders.
     */
    async function seedResultsWithNulls() {
      const measured = await seedSite({ name: 'measured-site' });
      const unmeasured = await seedSite({ name: 'unmeasured-site' });
      await db.update(schema.accounts).set({ balance: 7 })
        .where(eq(schema.accounts.id, measured.account.id)).run();
      await db.update(schema.accounts).set({ balance: null })
        .where(eq(schema.accounts.id, unmeasured.account.id)).run();

      await db.insert(schema.modelProbeKeyResults).values([
        {
          siteId: measured.site.id,
          accountId: measured.account.id,
          tokenId: 0,
          tokenName: '',
          modelName: 'fast-model',
          status: 'supported',
          latencyMs: 120,
          checkedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          siteId: measured.site.id,
          accountId: measured.account.id,
          tokenId: 0,
          tokenName: '',
          modelName: 'slow-model',
          status: 'supported',
          latencyMs: 900,
          checkedAt: '2026-08-02T00:00:00.000Z',
        },
        {
          // A timeout: recorded, but with no measurement to sort by.
          siteId: unmeasured.site.id,
          accountId: unmeasured.account.id,
          tokenId: 0,
          tokenName: '',
          modelName: 'timed-out-model',
          status: 'inconclusive',
          latencyMs: null,
          checkedAt: '2026-08-03T00:00:00.000Z',
        },
      ]).run();

      return { measured, unmeasured };
    }

    it('sorts unmeasured latency rows last in BOTH directions, not by dialect default', async () => {
      await seedResultsWithNulls();

      const asc = await service.listActiveModelProbeResults({ sortBy: 'latency', order: 'asc' });
      expect(asc.items.map((item) => item.latencyMs)).toEqual([120, 900, null]);

      const desc = await service.listActiveModelProbeResults({ sortBy: 'latency', order: 'desc' });
      expect(desc.items.map((item) => item.latencyMs)).toEqual([900, 120, null]);

      // The measured rows must still reverse, so the assertion above cannot pass
      // by ignoring `order` altogether.
      expect(asc.items[0]?.modelName).toBe('fast-model');
      expect(desc.items[0]?.modelName).toBe('slow-model');
    });

    it('sorts unknown balances last in BOTH directions', async () => {
      await seedResultsWithNulls();

      const asc = await service.listActiveModelProbeResults({ sortBy: 'balance', order: 'asc' });
      expect(asc.items.map((item) => item.balance)).toEqual([7, 7, null]);
      expect(asc.items.at(-1)?.siteName).toBe('unmeasured-site');

      const desc = await service.listActiveModelProbeResults({ sortBy: 'balance', order: 'desc' });
      expect(desc.items.map((item) => item.balance)).toEqual([7, 7, null]);
      expect(desc.items.at(-1)?.siteName).toBe('unmeasured-site');
    });

    it('keeps unmeasured rows off the first page rather than filling it', async () => {
      await seedResultsWithNulls();

      // The operator's own default is 「最快优先」. A first page of placeholders is
      // what the dialect default produces on SQLite, and it hides every real
      // measurement behind a page boundary.
      const page = await service.listActiveModelProbeResults({
        sortBy: 'latency',
        order: 'asc',
        limit: 2,
        offset: 0,
      });
      expect(page.items.map((item) => item.latencyMs)).toEqual([120, 900]);
      expect(page.total).toBe(3);
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

    /**
     * The behavioural sort tests above can only run on SQLite, so they cannot see
     * whether the ordering is even expressible on the operator's Postgres or on
     * MySQL. This renders the ordering through all three dialects instead.
     *
     * The load-bearing assertion is the MySQL one: `NULLS LAST` / `NULLS FIRST` is
     * ANSI SQL that Postgres and SQLite accept and MySQL rejects outright, so the
     * obvious fix for null placement would emit SQL that works on two dialects out
     * of three — and no test in this SQLite-only suite would notice.
     */
    it('renders identical NULL-last ordering on sqlite, postgres and mysql', async () => {
      const { PgDialect } = await import('drizzle-orm/pg-core');
      const { MySqlDialect } = await import('drizzle-orm/mysql-core');
      const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');

      const dialects = {
        postgres: new PgDialect(),
        mysql: new MySqlDialect(),
        sqlite: new SQLiteSyncDialect(),
      };

      for (const order of ['asc', 'desc'] as const) {
        const ordering = service.buildModelProbeResultOrdering(
          schema.modelProbeResults.latencyMs,
          order,
        );
        // Null placement, then the column, then `id` as the paging tie-break.
        expect(ordering).toHaveLength(3);

        const rendered = Object.fromEntries(
          Object.entries(dialects).map(([name, dialect]) => [
            name,
            ordering.map((part) => dialect.sqlToQuery(part.getSQL()).sql).join(', '),
          ]),
        );

        for (const [name, sqlText] of Object.entries(rendered)) {
          // MySQL has no NULLS clause at all; emitting one would throw at runtime
          // on the one dialect this suite cannot execute.
          expect(sqlText.toLowerCase(), name).not.toContain('nulls last');
          expect(sqlText.toLowerCase(), name).not.toContain('nulls first');
          // Positive control, so the two assertions above cannot pass by rendering
          // nothing at all.
          expect(sqlText.toLowerCase(), name).toContain('case when');
          expect(sqlText.toLowerCase(), name).toContain('is null');
          expect(sqlText.toLowerCase(), name).toContain(order);
        }

        // Identical modulo each dialect's identifier quoting, which is the only
        // thing that may legitimately differ.
        const normalized = Object.fromEntries(
          Object.entries(rendered).map(([name, sqlText]) => [name, sqlText.replace(/[`"]/g, '')]),
        );
        expect(normalized.mysql).toBe(normalized.postgres);
        expect(normalized.sqlite).toBe(normalized.postgres);
      }
    });

    it('applies that one ordering helper rather than ordering inline', async () => {
      const code = await readServiceCode();

      // Two ordering expressions would drift, and the cross-dialect test above
      // only covers the helper.
      expect(code).toContain('buildModelProbeResultOrdering(');
      expect(code).not.toMatch(/\.orderBy\(\s*direction\(/);
    });

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

    /**
     * Scoped deliberately to *this file's own* import list.
     *
     * It is not evidence that the routing stack is absent from the transitive
     * closure, and the closure does in fact reach it: `runtimeModelProbe` imports
     * `oauth/service.js`, which imports `modelService.js`, which imports
     * `tokenRouter.js`. That edge predates this feature. So the honest reading of
     * this assertion is narrow — this module names no routing module directly, and
     * the sync path is written as a dynamic import.
     *
     * What actually protects `PROXY_ROUTING_ENABLED=false` is asserted separately:
     * see the top-level-statement test below for "importing changes nothing", and
     * `modelProbe.e2e.test.ts` for "a real run writes no routing state unless the
     * operator turned the sync on".
     */
    it('names no routing module in its own import list, and reaches modelService only lazily', async () => {
      const code = await readServiceCode();
      const staticSpecifiers = [...code.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)]
        .map((match) => match[1]);

      expect(staticSpecifiers.length).toBeGreaterThan(0);
      for (const specifier of staticSpecifiers) {
        for (const forbidden of ['tokenRouter', 'routeRefresh', 'routeDecision', 'routeCooldown', 'modelService']) {
          expect(specifier).not.toContain(forbidden);
        }
      }

      // The sync path is written lazily. Note this is a code-shape property, not
      // an isolation one: by the time `syncUnsupportedToRouting` runs, the module
      // has almost always been loaded already via the chain above, so the dynamic
      // import resolves from a warm module cache. It keeps this file's own import
      // list clean; it does not keep `modelService` out of the process.
      expect(code).toMatch(/await import\('\.\/modelService\.js'\)/);
    });

    /**
     * The property that genuinely underwrites `PROXY_ROUTING_ENABLED=false`:
     * none of these eight modules *does* anything when it is imported, so no
     * routing state can be read or written until a caller calls something.
     *
     * Scoped to those eight files, and that scope matters — the wider closure is
     * NOT inert. `db/index.ts` runs `initDb()` at import (see its `let activeDb =
     * initDb()`), which opens the connection. That predates this feature and is
     * not what this test claims. The claim is narrower and is the one that counts
     * here: opening a database handle touches no routing table, and nothing in
     * these modules turns that handle into a routing read or write at import.
     */
    it('executes nothing at import time, here or in the routing modules it can reach', async () => {
      // `^` is the whole "top level" heuristic: these files indent every nested
      // statement, so column 0 means module scope.
      //
      // Three shapes, because one pattern anchored at column 0 only catches an
      // effect written as a bare statement. `const timer = setInterval(...)` and
      // `initSomething();` are equally import-time and were both missed before.
      const EFFECTS = String.raw`setInterval|setTimeout|setImmediate|queueMicrotask|process\.|db\.`;
      const importTimeEffects = [
        // `setTimeout(...)`, `await x`, `void x`, `process.on(...)`, `db.select(...)`
        new RegExp(String.raw`^(?:void |await |${EFFECTS})`, 'm'),
        // The same effects, hidden behind a binding.
        new RegExp(String.raw`^(?:export\s+)?(?:const|let|var)\s[^\n=]*=\s*(?:await\s+)?(?:${EFFECTS})`, 'm'),
        // A bare call at column 0, whatever it is called: `initSomething();`.
        /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*\(/m,
      ];

      const probeModules = [
        'modelProbeRunService.ts',
        'modelProbeDiscoveryService.ts',
        'modelProbeConfigService.ts',
        'runtimeModelProbe.ts',
      ];
      // The transitively reachable routing modules named in the chain above. If a
      // future edit gives one of these a top-level statement, the commitment breaks
      // and this test is where it surfaces.
      const reachableRoutingModules = [
        'tokenRouter.ts',
        'modelService.ts',
        'routeRefreshWorkflow.ts',
        'oauth/service.ts',
      ];

      for (const file of [...probeModules, ...reachableRoutingModules]) {
        const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
        expect(source.length).toBeGreaterThan(0);
        for (const pattern of importTimeEffects) expect(source).not.toMatch(pattern);
      }

      // Positive controls: the assertions above cannot be passing because a
      // pattern matches nothing. Every effect token is pinned in both the bare
      // and the assigned shape, so dropping one from `EFFECTS` fails here.
      for (const effect of [
        'setInterval(tick, 1000)',
        'setTimeout(tick, 1000)',
        'setImmediate(tick)',
        'queueMicrotask(tick)',
        'process.on("exit", tick)',
        'db.select()',
      ]) {
        expect(`${effect};\n`).toMatch(importTimeEffects[0]!);
        expect(`const handle = ${effect};\n`).toMatch(importTimeEffects[1]!);
      }
      expect('await bootstrap();\n').toMatch(importTimeEffects[0]!);
      expect('void bootstrap();\n').toMatch(importTimeEffects[0]!);
      expect('export const rows = await db.select();\n').toMatch(importTimeEffects[1]!);
      expect('initSomething();\n').toMatch(importTimeEffects[2]!);

      // Deliberately NOT flagged. `Symbol()` allocates and returns; it touches
      // nothing outside the module, so it cannot make importing observable. This
      // guard is about effects, not about "no executable statement at column 0" —
      // widening it to the latter would only add an allowlist for pure values.
      // `modelService.ts` has exactly this line, and it is fine.
      for (const pattern of importTimeEffects) {
        expect("const REFRESHED = Symbol('refreshed');\n").not.toMatch(pattern);
      }
    });
  });
});


