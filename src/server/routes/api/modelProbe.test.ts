import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Route-level contract for the active model probe API.
 *
 * Only the three run-service entry points are mocked; every constant stays real
 * so the redaction-coverage test below is checked against the canonical
 * `MODEL_PROBE_UPSTREAM_TEXT_FIELDS` list rather than a copy invented here.
 */
const {
  previewActiveModelProbeMock,
  queueActiveModelProbeMock,
  listActiveModelProbeResultsMock,
} = vi.hoisted(() => ({
  previewActiveModelProbeMock: vi.fn(),
  queueActiveModelProbeMock: vi.fn(),
  listActiveModelProbeResultsMock: vi.fn(),
}));

vi.mock('../../services/modelProbeRunService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/modelProbeRunService.js')>();
  return {
    ...actual,
    previewActiveModelProbe: previewActiveModelProbeMock,
    queueActiveModelProbe: queueActiveModelProbeMock,
    listActiveModelProbeResults: listActiveModelProbeResultsMock,
  };
});

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');
type RunServiceModule = typeof import('../../services/modelProbeRunService.js');
type BackgroundTaskModule = typeof import('../../services/backgroundTaskService.js');
type ApiServiceModule = typeof import('../../services/modelProbeApiService.js');

const CREDENTIAL = 'sk-live-secret-credential-value-0001';

function emptyPreview(overrides: Record<string, unknown> = {}) {
  return {
    sites: [],
    totalModels: 0,
    invalidPatterns: [],
    skipped: [],
    exceedsRunLimit: false,
    ...overrides,
  };
}

describe('model probe API routes', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let runService: RunServiceModule;
  let tasks: BackgroundTaskModule;
  let apiService: ApiServiceModule;
  let updateCenterRoutes: (app: FastifyInstance) => Promise<void>;
  let dataDir = '';
  let siteId = 0;
  let previousRoutingEnabled = false;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-probe-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const modelProbeRoutesModule = await import('./modelProbe.js');
    const taskRoutesModule = await import('./tasks.js');
    const updateCenterRoutesModule = await import('./updateCenter.js');
    updateCenterRoutes = updateCenterRoutesModule.updateCenterRoutes;
    runService = await import('../../services/modelProbeRunService.js');
    tasks = await import('../../services/backgroundTaskService.js');
    apiService = await import('../../services/modelProbeApiService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    previousRoutingEnabled = config.proxyRoutingEnabled;

    app = Fastify();
    await app.register(modelProbeRoutesModule.modelProbeRoutes);
    await app.register(taskRoutesModule.taskRoutes);
    await app.register(updateCenterRoutesModule.updateCenterRoutes);
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    const inserted = await db.insert(schema.sites).values({
      name: '主站',
      url: 'https://relay.example.com',
      platform: 'new-api',
      apiKey: 'site-api-key-should-never-be-served',
    }).returning({ id: schema.sites.id }).get();
    siteId = inserted.id;

    previewActiveModelProbeMock.mockReset();
    queueActiveModelProbeMock.mockReset();
    listActiveModelProbeResultsMock.mockReset();
    previewActiveModelProbeMock.mockResolvedValue(emptyPreview());
    listActiveModelProbeResultsMock.mockResolvedValue({ items: [], total: 0 });
    tasks.__resetBackgroundTasksForTests();
    config.proxyRoutingEnabled = previousRoutingEnabled;
  });

  afterAll(async () => {
    config.proxyRoutingEnabled = previousRoutingEnabled;
    tasks.__resetBackgroundTasksForTests();
    await app.close();
    // Windows keeps the SQLite file handle briefly after close; a failed temp-dir
    // cleanup must not fail an otherwise green suite.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
    delete process.env.DATA_DIR;
  });

  describe('GET /api/model-probe/config', () => {
    it('returns the normalized config plus the limits the UI needs to render bounds', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/model-probe/config' });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        success: boolean;
        config: { concurrency: number; timeoutMs: number; interestPatterns: string[]; syncToRouting: boolean };
        limits: { minConcurrency: number; maxConcurrency: number; confirmTargetThreshold: number; maxRunTargets: number };
      };
      expect(body.success).toBe(true);
      expect(body.config.interestPatterns).toEqual([]);
      expect(body.config.concurrency).toBe(1);
      expect(body.config.syncToRouting).toBe(false);
      expect(body.limits.minConcurrency).toBe(1);
      expect(body.limits.maxConcurrency).toBe(8);
      expect(body.limits.maxRunTargets).toBe(runService.MAX_ACTIVE_PROBE_RUN_TARGETS);
      expect(body.limits.confirmTargetThreshold).toBeGreaterThan(0);
    });
  });

  describe('PUT /api/model-probe/config', () => {
    it('merges a partial patch over the stored config instead of resetting omitted fields', async () => {
      const first = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/config',
        payload: { interestPatterns: ['^gpt-5'], concurrency: 3 },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/config',
        payload: { syncToRouting: true },
      });

      expect(second.statusCode).toBe(200);
      const body = second.json() as {
        config: { interestPatterns: string[]; concurrency: number; syncToRouting: boolean; prompts: string[] };
      };
      expect(body.config.interestPatterns).toEqual(['^gpt-5']);
      expect(body.config.concurrency).toBe(3);
      expect(body.config.syncToRouting).toBe(true);
      expect(body.config.prompts.length).toBeGreaterThan(0);

      const reread = await app.inject({ method: 'GET', url: '/api/model-probe/config' });
      expect((reread.json() as { config: { concurrency: number } }).config.concurrency).toBe(3);
    });

    it('maps an uncompilable interest pattern to 400 with the offending entries', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/config',
        payload: { interestPatterns: ['gpt-(5'] },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        success: boolean;
        message: string;
        invalidPatterns: Array<{ source: string; reason: string }>;
      };
      expect(body.success).toBe(false);
      expect(body.invalidPatterns).toHaveLength(1);
      expect(body.invalidPatterns[0]?.source).toBe('gpt-(5');
      expect(body.message).toContain('gpt-(5');
    });

    it('rejects unknown keys and out-of-range numbers', async () => {
      const unknownKey = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/config',
        payload: { interestPatterns: [], nope: 1 },
      });
      expect(unknownKey.statusCode).toBe(400);
      expect((unknownKey.json() as { message: string }).message).toContain('nope');

      const badConcurrency = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/config',
        payload: { concurrency: 99 },
      });
      expect(badConcurrency.statusCode).toBe(400);
      expect((badConcurrency.json() as { message: string }).message).toContain('concurrency');

      const badTimeout = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/config',
        payload: { timeoutMs: 10 },
      });
      expect(badTimeout.statusCode).toBe(400);
      expect((badTimeout.json() as { message: string }).message).toContain('timeoutMs');
    });
  });

  describe('site probe profiles', () => {
    it('lists sites with their probe profile and never leaks the site api key', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/model-probe/sites' });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        success: boolean;
        sites: Array<{ id: number; name: string; probeEndpointType: string; probeUserAgent: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.sites).toHaveLength(1);
      expect(body.sites[0]).toMatchObject({
        id: siteId,
        name: '主站',
        probeEndpointType: 'auto',
        probeUserAgent: '',
      });
      expect(response.payload).not.toContain('site-api-key-should-never-be-served');
      expect(Object.keys(body.sites[0] ?? {})).not.toContain('apiKey');
    });

    it('saves a per-site endpoint and user agent override', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/model-probe/sites/${siteId}`,
        payload: { probeEndpointType: 'messages', probeUserAgent: '  claude-cli/2.1.63  ' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { site: { probeEndpointType: string; probeUserAgent: string } };
      expect(body.site.probeEndpointType).toBe('messages');
      expect(body.site.probeUserAgent).toBe('claude-cli/2.1.63');

      const stored = await db.select({
        probeEndpointType: schema.sites.probeEndpointType,
        probeUserAgent: schema.sites.probeUserAgent,
      }).from(schema.sites).get();
      expect(stored?.probeEndpointType).toBe('messages');
      expect(stored?.probeUserAgent).toBe('claude-cli/2.1.63');
    });

    it('leaves the sibling field untouched when only one is supplied', async () => {
      await app.inject({
        method: 'PUT',
        url: `/api/model-probe/sites/${siteId}`,
        payload: { probeEndpointType: 'chat', probeUserAgent: 'codex_cli_rs/0.20.0' },
      });

      const response = await app.inject({
        method: 'PUT',
        url: `/api/model-probe/sites/${siteId}`,
        payload: { probeEndpointType: 'responses' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { site: { probeEndpointType: string; probeUserAgent: string } };
      expect(body.site.probeEndpointType).toBe('responses');
      expect(body.site.probeUserAgent).toBe('codex_cli_rs/0.20.0');
    });

    it('returns 404 for an unknown site', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/model-probe/sites/${siteId + 9999}`,
        payload: { probeEndpointType: 'chat' },
      });

      expect(response.statusCode).toBe(404);
      expect((response.json() as { success: boolean }).success).toBe(false);
    });

    it('rejects an unusable site id and an out-of-contract profile', async () => {
      const badId = await app.inject({
        method: 'PUT',
        url: '/api/model-probe/sites/abc',
        payload: { probeEndpointType: 'chat' },
      });
      expect(badId.statusCode).toBe(400);

      const badEndpoint = await app.inject({
        method: 'PUT',
        url: `/api/model-probe/sites/${siteId}`,
        payload: { probeEndpointType: 'response' },
      });
      expect(badEndpoint.statusCode).toBe(400);
      expect((badEndpoint.json() as { message: string }).message).toContain('probeEndpointType');

      const longUserAgent = await app.inject({
        method: 'PUT',
        url: `/api/model-probe/sites/${siteId}`,
        payload: { probeUserAgent: 'a'.repeat(513) },
      });
      expect(longUserAgent.statusCode).toBe(400);
    });
  });

  describe('POST /api/model-probe/preview', () => {
    it('returns the preview and never queues a run', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
        sites: [{
          siteId,
          siteName: '主站',
          source: 'live',
          credentialVerified: true,
          discoveredCount: 3,
          models: ['gpt-5', 'gpt-5-mini'],
          liveFailure: null,
          notes: [],
        }],
        totalModels: 2,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/model-probe/preview',
        payload: { siteIds: [siteId] },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        success: boolean;
        preview: { totalModels: number; sites: Array<{ models: string[]; credentialVerified: boolean }> };
      };
      expect(body.success).toBe(true);
      expect(body.preview.totalModels).toBe(2);
      expect(body.preview.sites[0]?.models).toEqual(['gpt-5', 'gpt-5-mini']);
      expect(body.preview.sites[0]?.credentialVerified).toBe(true);
      expect(previewActiveModelProbeMock).toHaveBeenCalledWith({ siteIds: [siteId] });
      expect(queueActiveModelProbeMock).not.toHaveBeenCalled();
    });

    it('treats an omitted scope as every site', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/model-probe/preview', payload: {} });

      expect(response.statusCode).toBe(200);
      expect(previewActiveModelProbeMock).toHaveBeenCalledWith({});
    });

    it('rejects an invalid scope', async () => {
      for (const payload of [{ siteIds: [] }, { siteIds: [0] }, { siteId: 1 }]) {
        const response = await app.inject({ method: 'POST', url: '/api/model-probe/preview', payload });
        expect(response.statusCode).toBe(400);
      }
      expect(previewActiveModelProbeMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/model-probe/run', () => {
    function queued(taskId: string, reused = false) {
      return { task: { id: taskId, status: 'pending' }, reused };
    }

    it('queues a small sweep and answers 202 with the task id', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 4 }));
      queueActiveModelProbeMock.mockReturnValue(queued('task-1'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/model-probe/run',
        payload: { siteIds: [siteId] },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json() as { success: boolean; taskId: string; reused: boolean; targetCount: number };
      expect(body).toMatchObject({ success: true, taskId: 'task-1', reused: false, targetCount: 4 });
      expect(queueActiveModelProbeMock).toHaveBeenCalledWith({ siteIds: [siteId] });
    });

    it('reports a joined run rather than starting a second one', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 1 }));
      queueActiveModelProbeMock.mockReturnValue(queued('task-existing', true));

      const response = await app.inject({ method: 'POST', url: '/api/model-probe/run', payload: {} });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ taskId: 'task-existing', reused: true });
    });

    it('refuses a sweep over the confirmation threshold until the operator echoes the count', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 51 }));

      const response = await app.inject({ method: 'POST', url: '/api/model-probe/run', payload: {} });

      expect(response.statusCode).toBe(409);
      const body = response.json() as {
        success: boolean;
        code: string;
        targetCount: number;
        confirmTargetThreshold: number;
        preview: { totalModels: number };
      };
      expect(body.success).toBe(false);
      expect(body.code).toBe('confirmation_required');
      expect(body.targetCount).toBe(51);
      expect(body.confirmTargetThreshold).toBe(50);
      expect(body.preview.totalModels).toBe(51);
      expect(queueActiveModelProbeMock).not.toHaveBeenCalled();
    });

    it('refuses when the echoed count no longer matches the freshly computed one', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 80 }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/model-probe/run',
        payload: { confirmedTargetCount: 51 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'confirmation_required', targetCount: 80 });
      expect(queueActiveModelProbeMock).not.toHaveBeenCalled();
    });

    it('queues once the echoed count matches', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 51 }));
      queueActiveModelProbeMock.mockReturnValue(queued('task-confirmed'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/model-probe/run',
        payload: { confirmedTargetCount: 51 },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ taskId: 'task-confirmed', targetCount: 51 });
      expect(queueActiveModelProbeMock).toHaveBeenCalledTimes(1);
    });

    it('does not demand confirmation at or below the threshold', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 50 }));
      queueActiveModelProbeMock.mockReturnValue(queued('task-50'));

      const response = await app.inject({ method: 'POST', url: '/api/model-probe/run', payload: {} });

      expect(response.statusCode).toBe(202);
      expect(queueActiveModelProbeMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a target set beyond the hard run cap without queueing', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
        totalModels: runService.MAX_ACTIVE_PROBE_RUN_TARGETS + 1,
        exceedsRunLimit: true,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/model-probe/run',
        payload: { confirmedTargetCount: runService.MAX_ACTIVE_PROBE_RUN_TARGETS + 1 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'run_limit_exceeded' });
      expect(queueActiveModelProbeMock).not.toHaveBeenCalled();
    });

    it('rejects an invalid body before touching the services', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/model-probe/run',
        payload: { siteIds: [siteId], models: ['gpt-5'] },
      });

      expect(response.statusCode).toBe(400);
      expect(previewActiveModelProbeMock).not.toHaveBeenCalled();
      expect(queueActiveModelProbeMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/model-probe/results', () => {
    it('forwards every normalized filter, sort and paging value', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/model-probe/results?model=%20GPT-5%20&siteId=${siteId}&status=unsupported`
          + '&sortBy=balance&order=asc&limit=20&offset=40&_t=1700000000000',
      });

      expect(response.statusCode).toBe(200);
      expect(listActiveModelProbeResultsMock).toHaveBeenCalledWith({
        model: 'GPT-5',
        siteId,
        status: 'unsupported',
        sortBy: 'balance',
        order: 'asc',
        limit: 20,
        offset: 40,
      });
      const body = response.json() as { success: boolean; items: unknown[]; total: number; query: { sortBy: string } };
      expect(body.success).toBe(true);
      expect(body.total).toBe(0);
      expect(body.query.sortBy).toBe('balance');
    });

    it('forwards nothing when a reset filter form sends blank params', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/model-probe/results?model=&siteId=&status=&sortBy=&order=&limit=&offset=',
      });

      expect(response.statusCode).toBe(200);
      expect(listActiveModelProbeResultsMock).toHaveBeenCalledWith({});
    });

    it('rejects an unknown sort field, status and non-numeric id', async () => {
      for (const query of ['sortBy=cost', 'order=ascending', 'status=maybe', 'siteId=abc', 'offset=-1']) {
        const response = await app.inject({ method: 'GET', url: `/api/model-probe/results?${query}` });
        expect(response.statusCode).toBe(400);
      }
      expect(listActiveModelProbeResultsMock).not.toHaveBeenCalled();
    });
  });

  describe('upstream text redaction at the HTTP boundary', () => {
    async function probeTaskWithUpstreamText(): Promise<string> {
      const started = tasks.startBackgroundTask(
        {
          type: runService.ACTIVE_MODEL_PROBE_TASK_TYPE,
          title: '主动模型测活（全部站点）',
          notifyOnSuccess: false,
          notifyOnFailure: false,
        },
        async () => ({
          siteCount: 1,
          probed: 0,
          supported: 0,
          unsupported: 0,
          inconclusive: 0,
          skipped: 0,
          disabled: 0,
          routingSynced: false,
          invalidPatterns: [],
          skippedSites: [{
            siteId,
            siteName: '主站',
            code: 'discovery_failed',
            message: `upstream refused key ${CREDENTIAL}`,
          }],
        }),
      );
      await tasks.waitForBackgroundTaskCompletion(started.task.id);
      tasks.appendBackgroundTaskLog(
        started.task.id,
        `跳过站点 主站（discovery_failed）：upstream refused key ${CREDENTIAL}`,
      );
      return started.task.id;
    }

    /**
     * One assertion per entry in the run service's canonical list of
     * upstream-authored fields, keyed by that exact path string. The final test in
     * this block asserts the keys here equal the exported list, so adding a field
     * there without redacting it fails this suite instead of shipping a leak.
     */
    const coverage: Record<string, () => Promise<void>> = {
      reason: async () => {
        listActiveModelProbeResultsMock.mockResolvedValue({
          items: [{
            id: 1,
            siteId,
            siteName: '主站',
            accountId: 2,
            accountUsername: 'ops',
            balance: 1.5,
            modelName: 'gpt-5',
            status: 'unsupported',
            latencyMs: 120,
            httpStatus: 401,
            failureKind: 'auth',
            reason: `upstream echoed ${CREDENTIAL}`,
            endpointUsed: 'chat',
            promptUsed: 'What is 2+3?',
            userAgentUsed: 'claude-cli/2.1.63',
            checkedAt: '2026-08-21T00:00:00.000Z',
          }],
          total: 1,
        });

        const response = await app.inject({ method: 'GET', url: '/api/model-probe/results' });
        expect(response.statusCode).toBe(200);
        expect(response.payload).not.toContain(CREDENTIAL);
        const body = response.json() as { items: Array<{ reason: string; modelName: string }> };
        expect(body.items[0]?.reason).toContain('[redacted]');
        expect(body.items[0]?.modelName).toBe('gpt-5');
      },
      notes: async () => {
        previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
          sites: [{
            siteId,
            siteName: '主站',
            source: 'cached',
            credentialVerified: false,
            discoveredCount: 0,
            models: [],
            liveFailure: { kind: 'empty_unknown', status: null, message: 'no models' },
            notes: [`实时模型发现未返回模型：refused ${CREDENTIAL}`],
          }],
        }));

        const response = await app.inject({ method: 'POST', url: '/api/model-probe/preview', payload: {} });
        expect(response.statusCode).toBe(200);
        expect(response.payload).not.toContain(CREDENTIAL);
        const body = response.json() as { preview: { sites: Array<{ notes: string[] }> } };
        expect(body.preview.sites[0]?.notes[0]).toContain('[redacted]');
      },
      'liveFailure.message': async () => {
        previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
          sites: [{
            siteId,
            siteName: '主站',
            source: 'cached',
            credentialVerified: false,
            discoveredCount: 1,
            models: ['gpt-5'],
            liveFailure: { kind: 'transport', status: 500, message: `boom for ${CREDENTIAL}` },
            notes: [],
          }],
          totalModels: 1,
        }));

        const response = await app.inject({ method: 'POST', url: '/api/model-probe/preview', payload: {} });
        expect(response.statusCode).toBe(200);
        expect(response.payload).not.toContain(CREDENTIAL);
        const body = response.json() as {
          preview: { sites: Array<{ liveFailure: { kind: string; status: number; message: string } }> };
        };
        expect(body.preview.sites[0]?.liveFailure.message).toContain('[redacted]');
        expect(body.preview.sites[0]?.liveFailure.kind).toBe('transport');
        expect(body.preview.sites[0]?.liveFailure.status).toBe(500);
      },
      'skipped.message': async () => {
        previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
          skipped: [{
            siteId,
            siteName: '主站',
            code: 'discovery_failed',
            message: `discovery failed for ${CREDENTIAL}`,
          }],
        }));

        const response = await app.inject({ method: 'POST', url: '/api/model-probe/preview', payload: {} });
        expect(response.statusCode).toBe(200);
        expect(response.payload).not.toContain(CREDENTIAL);
        const body = response.json() as {
          preview: { skipped: Array<{ code: string; message: string }> };
        };
        expect(body.preview.skipped[0]?.message).toContain('[redacted]');
        expect(body.preview.skipped[0]?.code).toBe('discovery_failed');
      },
      'skippedSites.message': async () => {
        const taskId = await probeTaskWithUpstreamText();

        const response = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
        expect(response.statusCode).toBe(200);
        expect(response.payload).not.toContain(CREDENTIAL);
        const body = response.json() as {
          task: {
            logs: Array<{ message: string }>;
            result: { skippedSites: Array<{ message: string; code: string }>; siteCount: number };
          };
        };
        expect(body.task.result.skippedSites[0]?.message).toContain('[redacted]');
        expect(body.task.result.skippedSites[0]?.code).toBe('discovery_failed');
        expect(body.task.result.siteCount).toBe(1);
      },
    };

    for (const [field, assertion] of Object.entries(coverage)) {
      it(`redacts ${field}`, assertion);
    }

    it('covers exactly the fields the run service marks as upstream-authored', () => {
      expect(Object.keys(coverage).sort()).toEqual([...runService.MODEL_PROBE_UPSTREAM_TEXT_FIELDS].sort());
    });

    it('redacts a background task log line that quotes an upstream discovery error', async () => {
      const taskId = await probeTaskWithUpstreamText();

      const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
      expect(detail.payload).not.toContain(CREDENTIAL);
      const detailBody = detail.json() as { task: { logs: Array<{ message: string; seq: number }> } };
      const skipLog = detailBody.task.logs.find((entry) => entry.message.includes('跳过站点'));
      expect(skipLog?.message).toContain('[redacted]');
      expect(skipLog?.message).toContain('主站');

      const list = await app.inject({ method: 'GET', url: '/api/tasks' });
      expect(list.payload).not.toContain(CREDENTIAL);
      const listBody = list.json() as { tasks: Array<{ id: string; logs: Array<{ message: string }> }> };
      const listed = listBody.tasks.find((entry) => entry.id === taskId);
      expect(listed?.logs.some((entry) => entry.message.includes('[redacted]'))).toBe(true);
    });

    it('masks secret shapes the probe never held while keeping the diagnosis readable', () => {
      const cases: Array<[string, string[]]> = [
        ['rejected key sk-proj-AbCdEf123456789 upstream', ['sk-proj-AbCdEf123456789']],
        ['Authorization: Bearer abc123def456ghi789', ['abc123def456ghi789']],
        ['token=ghp_ABCDEFGH123456789 expired', ['ghp_ABCDEFGH123456789']],
        ['{"api_key":"someLongSecretValue"}', ['someLongSecretValue']],
        ['bad jwt eyJhbGciOi.eyJzdWIi.SflKxwRJ', ['eyJhbGciOi.eyJzdWIi.SflKxwRJ']],
        ['"password": "hunter2hunter2"', ['hunter2hunter2']],
      ];

      for (const [input, secrets] of cases) {
        const redacted = apiService.redactUpstreamProbeText(input);
        for (const secret of secrets) {
          expect(redacted).not.toContain(secret);
        }
        expect(redacted).toContain('[redacted]');
      }

      // Idempotent, and no double mask for a scheme-prefixed header.
      const once = apiService.redactUpstreamProbeText('Authorization: Bearer abc123def456ghi789');
      expect(once).toBe('Authorization: Bearer [redacted]');
      expect(apiService.redactUpstreamProbeText(once)).toBe(once);
    });

    it('leaves ordinary upstream diagnosis text untouched', () => {
      for (const text of [
        '模型不存在：gpt-5-turbo',
        '{"error":{"message":"model not found","code":"model_not_found","type":"invalid_request_error"}}',
        'HTTP 429 上游负载已饱和，请稍后重试',
        '站点已停用，批量探测不会对其消耗配额',
      ]) {
        expect(apiService.redactUpstreamProbeText(text)).toBe(text);
      }
    });

    it('redacts the backfilled logs of a finished probe sweep on the generic stream', async () => {
      // `/api/update-center/tasks/:id/stream` resolves ANY task id, so it is a
      // second exit for the same log lines. This covers the backfill branch only —
      // the task is already finished, so the route returns before subscribing. The
      // live-tail branch has its own test below.
      const taskId = await probeTaskWithUpstreamText();

      const response = await app.inject({
        method: 'GET',
        url: `/api/update-center/tasks/${taskId}/stream`,
      });

      expect(response.payload).not.toContain(CREDENTIAL);
      expect(response.payload).toContain('[redacted]');
    });

    /**
     * The branch an operator actually watches: logs pushed while the sweep is still
     * running, through `subscribeToBackgroundTaskLogs`. `app.inject` cannot reach it
     * (it buffers until the response ends, and the route only subscribes for a task
     * that is still pending/running), so this drives a real listening server and
     * reads the stream incrementally.
     */
    it('redacts a probe log pushed live while the sweep is still running', async () => {
      let releaseTask: () => void = () => {};
      const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });

      const started = tasks.startBackgroundTask(
        {
          type: runService.ACTIVE_MODEL_PROBE_TASK_TYPE,
          title: '主动模型测活（全部站点）',
          notifyOnSuccess: false,
          notifyOnFailure: false,
        },
        async () => {
          await taskGate;
          return { probed: 0 };
        },
      );
      const taskId = started.task.id;

      // A line that exists before the request, so its arrival marks the point where
      // the route has drained the backfill and subscribed. Anything appended after
      // it can only reach the client through the live subscriber.
      tasks.appendBackgroundTaskLog(taskId, 'BACKFILL_SENTINEL');

      // A dedicated listening instance: the shared `app` is inject-only.
      const streamApp = Fastify();
      await streamApp.register(updateCenterRoutes);
      const address = await streamApp.listen({ port: 0, host: '127.0.0.1' });
      let received = '';
      try {
        const response = await fetch(`${address}/api/update-center/tasks/${taskId}/stream`, {
          headers: { Accept: 'text/event-stream' },
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        const readUntil = async (marker: string) => {
          const deadline = Date.now() + 10_000;
          while (!received.includes(marker)) {
            if (Date.now() > deadline) throw new Error(`stream never delivered ${marker}: ${received}`);
            const { done, value } = await reader.read();
            if (done) throw new Error(`stream closed before ${marker}: ${received}`);
            received += decoder.decode(value, { stream: true });
          }
        };

        await readUntil('BACKFILL_SENTINEL');
        tasks.appendBackgroundTaskLog(
          taskId,
          `跳过站点 主站（discovery_failed）：upstream refused key ${CREDENTIAL}`,
        );
        await readUntil('discovery_failed');
        await reader.cancel();
      } finally {
        releaseTask();
        await tasks.waitForBackgroundTaskCompletion(taskId);
        await streamApp.close();
      }

      expect(received).toContain('discovery_failed');
      expect(received).not.toContain(CREDENTIAL);
      expect(received).toContain('[redacted]');
    }, 30_000);

    it('keeps serving the logs of tasks that are not probe sweeps', async () => {
      const started = tasks.startBackgroundTask(
        { type: 'site-announcements-sync', title: '同步站点公告', notifyOnSuccess: false, notifyOnFailure: false },
        async () => ({ ok: true }),
      );
      await tasks.waitForBackgroundTaskCompletion(started.task.id);
      tasks.appendBackgroundTaskLog(started.task.id, '同步了 3 条公告');

      const response = await app.inject({ method: 'GET', url: `/api/tasks/${started.task.id}` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { task: { logs: Array<{ message: string }> } };
      expect(body.task.logs.some((entry) => entry.message === '同步了 3 条公告')).toBe(true);
    });

    it('never serializes a credential even if a future run structure carries one', async () => {
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
        sites: [{
          siteId,
          siteName: '主站',
          source: 'live',
          credentialVerified: true,
          discoveredCount: 1,
          models: ['gpt-5'],
          liveFailure: null,
          notes: [],
          credential: CREDENTIAL,
          account: { id: 2, apiToken: CREDENTIAL },
        }],
        totalModels: 1,
        credential: CREDENTIAL,
      }));

      const preview = await app.inject({ method: 'POST', url: '/api/model-probe/preview', payload: {} });
      expect(preview.statusCode).toBe(200);
      expect(preview.payload).not.toContain(CREDENTIAL);
      // The JSON key, not the word: `credentialVerified` is a legitimate field.
      expect(preview.payload).not.toContain('"credential"');
      expect(preview.payload).not.toContain('"apiToken"');
      expect(preview.payload).not.toContain('"account"');

      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({
        totalModels: 90,
        sites: [{
          siteId,
          siteName: '主站',
          source: 'live',
          credentialVerified: true,
          discoveredCount: 90,
          models: ['gpt-5'],
          liveFailure: null,
          notes: [],
          credential: CREDENTIAL,
        }],
      }));
      const conflict = await app.inject({ method: 'POST', url: '/api/model-probe/run', payload: {} });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.payload).not.toContain(CREDENTIAL);
      expect(conflict.payload).not.toContain('"credential"');
    });

    it('truncates an enormous upstream body instead of relaying it whole', async () => {
      listActiveModelProbeResultsMock.mockResolvedValue({
        items: [{
          id: 1,
          siteId,
          siteName: '主站',
          accountId: null,
          accountUsername: null,
          balance: null,
          modelName: 'gpt-5',
          status: 'inconclusive',
          latencyMs: null,
          httpStatus: 502,
          failureKind: 'network',
          reason: 'x'.repeat(5_000),
          endpointUsed: null,
          promptUsed: null,
          userAgentUsed: null,
          checkedAt: null,
        }],
        total: 1,
      });

      const response = await app.inject({ method: 'GET', url: '/api/model-probe/results' });
      const body = response.json() as { items: Array<{ reason: string }> };
      expect(body.items[0]?.reason.length).toBeLessThan(2_000);
    });
  });

  describe('routing independence', () => {
    it('serves every endpoint with PROXY_ROUTING_ENABLED=false', async () => {
      config.proxyRoutingEnabled = false;
      previewActiveModelProbeMock.mockResolvedValue(emptyPreview({ totalModels: 2 }));
      queueActiveModelProbeMock.mockReturnValue({ task: { id: 'task-no-routing' }, reused: false });

      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/api/model-probe/config' }),
        app.inject({ method: 'PUT', url: '/api/model-probe/config', payload: { concurrency: 2 } }),
        app.inject({ method: 'GET', url: '/api/model-probe/sites' }),
        app.inject({
          method: 'PUT',
          url: `/api/model-probe/sites/${siteId}`,
          payload: { probeEndpointType: 'chat' },
        }),
        app.inject({ method: 'POST', url: '/api/model-probe/preview', payload: {} }),
        app.inject({ method: 'GET', url: '/api/model-probe/results' }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }

      const run = await app.inject({ method: 'POST', url: '/api/model-probe/run', payload: {} });
      expect(run.statusCode).toBe(202);
      expect(run.json()).toMatchObject({ taskId: 'task-no-routing' });
    });

    it('keeps the routing stack out of the route and presenter import graphs', () => {
      const here = fileURLToPath(new URL('.', import.meta.url));
      const sources = [
        readFileSync(join(here, 'modelProbe.ts'), 'utf8'),
        readFileSync(join(here, '../../services/modelProbeApiService.ts'), 'utf8'),
      ];
      const forbidden = [
        'tokenRouter',
        'routeRefreshWorkflow',
        'routeDecision',
        'routeCooldownService',
        'modelService',
      ];

      for (const source of sources) {
        const staticImports = source.match(/^\s*import\s[^;]+;/gm) ?? [];
        for (const statement of staticImports) {
          for (const name of forbidden) {
            expect(statement).not.toContain(name);
          }
        }
      }
    });
  });
});
