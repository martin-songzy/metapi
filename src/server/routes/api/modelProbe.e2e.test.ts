import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * End-to-end coverage for the active model probe.
 *
 * Every other probe test mocks either the run service or the upstream fetch. This
 * one mocks NOTHING in the probe path: a listening Fastify instance carrying the
 * real `modelProbeRoutes` is driven over real HTTP, backed by a real migrated
 * SQLite file, and pointed at a real local HTTP server standing in for a relay.
 * Assertions are made on the requests that fake upstream actually received, so a
 * property "proved" here cannot be satisfied by a probe that never fired.
 *
 * The listening-instance harness follows `routes/proxy/responses.websocket.test.ts`
 * (`Fastify()` + `app.listen({ port: 0 })`), and the temp-database harness follows
 * `routes/api/modelProbe.test.ts` (`DATA_DIR` + `import('../../db/migrate.js')`).
 *
 * `PROXY_ROUTING_ENABLED=false` is set in the environment before the first import
 * of `config.js`, because the property this file exists to prove is that a full run
 * touches no routing state in the mode the operator actually runs.
 */

const PROBE_CREDENTIAL = 'probe-credential-abcdef1234567890';

type UpstreamRequestRecord = {
  method: string;
  /** Protocol path with the per-site prefix stripped, e.g. `/v1/messages`. */
  path: string;
  /** Full path including the per-site prefix, so a responder can tell sites apart. */
  rawPath: string;
  userAgent: string;
  authorization: string;
  body: Record<string, unknown> | null;
};

type UpstreamReply = { status: number; body: string; delayMs?: number };

/** Requests the fake relay received, in arrival order. Reset per test. */
let upstreamRequests: UpstreamRequestRecord[] = [];
/** Model ids the fake relay serves from GET /v1/models. */
let upstreamModels: string[] = [];
/** Decides the reply to a probe POST. Overridden per test. */
let probeResponder: (record: UpstreamRequestRecord) => UpstreamReply = () => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
});

function chatOk(content = 'ok'): UpstreamReply {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

function messagesOk(text = 'ok'): UpstreamReply {
  return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text }] }) };
}

/**
 * HTTP 200 carrying an error body — the exact relay behaviour this whole feature
 * exists to catch. A naive liveness check reads the 200 and reports the model up.
 */
function errorBodyWith200(message: string): UpstreamReply {
  return { status: 200, body: JSON.stringify({ error: { message, type: 'invalid_request_error' } }) };
}

/** Probe POSTs only, so a discovery GET can never be mistaken for probe traffic. */
function probePosts(): UpstreamRequestRecord[] {
  return upstreamRequests.filter((record) => record.method === 'POST');
}

function probePaths(): string[] {
  return probePosts().map((record) => record.path);
}

function startFakeUpstream(): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      let body: Record<string, unknown> | null = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }

      const record: UpstreamRequestRecord = {
        method: request.method || '',
        // Site urls carry a per-site prefix so several sites can share one port;
        // strip it so assertions read against the protocol path the probe chose.
        path: url.pathname.replace(/^\/site-[a-z]+/, ''),
        rawPath: url.pathname,
        userAgent: String(request.headers['user-agent'] ?? ''),
        authorization: String(request.headers.authorization ?? ''),
        body,
      };
      upstreamRequests.push(record);

      if (record.method === 'GET' && record.path === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: upstreamModels.map((id) => ({ id })) }));
        return;
      }

      const reply = probeResponder(record);
      const send = () => {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(reply.body);
      };
      if (reply.delayMs && reply.delayMs > 0) {
        setTimeout(send, reply.delayMs).unref?.();
        return;
      }
      send();
    });
  });

  return new Promise<Server>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

type ServerBundle = {
  app: FastifyInstance;
  baseUrl: string;
  db: (typeof import('../../db/index.js'))['db'];
  schema: (typeof import('../../db/index.js'))['schema'];
  config: (typeof import('../../config.js'))['config'];
  tasks: typeof import('../../services/backgroundTaskService.js');
};

/**
 * Boots a fresh module graph and a fresh listening instance against the temp
 * database. Called again by the restart test, which is why it re-imports rather
 * than closing over module state: a second call opens a NEW database handle to the
 * same file, so anything read back afterwards came off disk and not out of memory.
 */
async function bootServer(): Promise<ServerBundle> {
  vi.resetModules();
  await import('../../db/migrate.js');
  const dbModule = await import('../../db/index.js');
  const configModule = await import('../../config.js');
  const modelProbeRoutesModule = await import('./modelProbe.js');
  const taskRoutesModule = await import('./tasks.js');
  const tasks = await import('../../services/backgroundTaskService.js');

  const app = Fastify();
  await app.register(modelProbeRoutesModule.modelProbeRoutes);
  await app.register(taskRoutesModule.taskRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    db: dbModule.db,
    schema: dbModule.schema,
    config: configModule.config,
    tasks,
  };
}

describe('active model probe end to end', () => {
  let server: ServerBundle;
  let upstream: Server;
  let upstreamPort = 0;
  let dataDir = '';

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; payload: any }> {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    return { status: response.status, payload };
  }

  /** Site url points at the fake relay; the prefix keeps (platform, url) unique. */
  function siteUrlFor(slug: string): string {
    return `http://127.0.0.1:${upstreamPort}/site-${slug}`;
  }

  async function insertSite(input: {
    slug: string;
    name: string;
    probeEndpointType?: string;
    probeUserAgent?: string;
  }): Promise<number> {
    const inserted = await server.db.insert(server.schema.sites).values({
      name: input.name,
      url: siteUrlFor(input.slug),
      platform: 'openai',
      status: 'active',
      ...(input.probeEndpointType !== undefined ? { probeEndpointType: input.probeEndpointType } : {}),
      ...(input.probeUserAgent !== undefined ? { probeUserAgent: input.probeUserAgent } : {}),
    }).returning({ id: server.schema.sites.id }).get();
    return inserted.id;
  }

  async function insertAccount(
    siteId: number,
    // `balance` is nullable in the schema and null is a real production state (an
    // unknown balance), so the null case has to be expressible here.
    input?: { balance?: number | null; username?: string },
  ): Promise<number> {
    const inserted = await server.db.insert(server.schema.accounts).values({
      siteId,
      username: input?.username ?? 'probe-account',
      accessToken: '',
      apiToken: PROBE_CREDENTIAL,
      balance: input?.balance === undefined ? 0 : input.balance,
      status: 'active',
    }).returning({ id: server.schema.accounts.id }).get();
    return inserted.id;
  }

  /** PUT the config through the real API so normalization/validation is exercised. */
  async function putConfig(patch: Record<string, unknown>): Promise<any> {
    const result = await api('PUT', '/api/model-probe/config', patch);
    expect(result.status).toBe(200);
    return result.payload.config;
  }

  /**
   * Queues a run over the API and polls `GET /api/tasks/:id` until it settles, so
   * both the queueing and the observation of a run go over real HTTP the way the
   * operator's browser does.
   */
  async function runProbe(body: Record<string, unknown> = {}): Promise<any> {
    const queued = await api('POST', '/api/model-probe/run', body);
    expect(queued.status).toBe(202);
    const taskId = queued.payload.taskId;

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const polled = await api('GET', `/api/tasks/${taskId}`);
      expect(polled.status).toBe(200);
      const task = polled.payload.task;
      if (task.status !== 'pending' && task.status !== 'running') return task;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25).unref?.();
      });
    }
    throw new Error(`probe task ${taskId} did not settle in time`);
  }

  async function listResults(query = ''): Promise<any[]> {
    const result = await api('GET', `/api/model-probe/results${query}`);
    expect(result.status).toBe(200);
    return result.payload.items;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-probe-e2e-'));
    process.env.DATA_DIR = dataDir;
    // Read by `config.js` at import time. The whole point of this file is the
    // routing-disabled mode, so it is set from the environment rather than by
    // poking the config object: that way the assertions cover the real switch.
    process.env.PROXY_ROUTING_ENABLED = 'false';

    upstream = await startFakeUpstream();
    upstreamPort = (upstream.address() as AddressInfo).port;
    server = await bootServer();
    expect(server.config.proxyRoutingEnabled).toBe(false);
  }, 120_000);

  beforeEach(async () => {
    await server.db.delete(server.schema.modelProbeResults).run();
    await server.db.delete(server.schema.routeChannels).run();
    await server.db.delete(server.schema.tokenRoutes).run();
    await server.db.delete(server.schema.modelAvailability).run();
    await server.db.delete(server.schema.accounts).run();
    await server.db.delete(server.schema.sites).run();
    await server.db.delete(server.schema.settings).run();
    server.tasks.__resetBackgroundTasksForTests();

    upstreamRequests = [];
    upstreamModels = [];
    probeResponder = () => chatOk();
    server.config.proxyRoutingEnabled = false;
  });

  afterAll(async () => {
    server.tasks.__resetBackgroundTasksForTests();
    await server.app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    delete process.env.DATA_DIR;
    delete process.env.PROXY_ROUTING_ENABLED;
    // Windows holds the SQLite file handle briefly after close; a failed temp-dir
    // cleanup must not fail an otherwise green suite.
    try {
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  // Property 1.
  it('keeps the global probe config across a server restart', async () => {
    const saved = await putConfig({
      interestPatterns: ['^probe-restart-'],
      prompts: ['probe-restart-prompt'],
      errorKeywords: ['probe-restart-keyword'],
      userAgents: [{ id: 'restart-preset', label: 'Restart', value: 'metapi-restart-ua/1.0' }],
      defaultUserAgentId: 'restart-preset',
      concurrency: 3,
      timeoutMs: 21_000,
      syncToRouting: true,
    });
    expect(saved.concurrency).toBe(3);

    // Stop the instance and drop the whole module graph, then boot again. The new
    // graph opens a new database handle, so what comes back was read off disk.
    const previous = server;
    await previous.app.close();
    server = await bootServer();
    expect(server.app).not.toBe(previous.app);
    expect(server.db).not.toBe(previous.db);

    const reloaded = await api('GET', '/api/model-probe/config');
    expect(reloaded.status).toBe(200);
    expect(reloaded.payload.config).toMatchObject({
      interestPatterns: ['^probe-restart-'],
      prompts: ['probe-restart-prompt'],
      errorKeywords: ['probe-restart-keyword'],
      defaultUserAgentId: 'restart-preset',
      concurrency: 3,
      timeoutMs: 21_000,
      syncToRouting: true,
    });
    expect(reloaded.payload.config.userAgents).toEqual([
      { id: 'restart-preset', label: 'Restart', value: 'metapi-restart-ua/1.0' },
    ]);
    // The rebooted process must still be in routing-disabled mode.
    expect(server.config.proxyRoutingEnabled).toBe(false);
  }, 120_000);

  // Property 2.
  it('sends a messages-pinned site only to /v1/messages', async () => {
    const siteId = await insertSite({ slug: 'messages', name: 'Messages Site' });
    await insertAccount(siteId);
    await putConfig({ interestPatterns: ['^probe-model$'] });

    const configured = await api('PUT', `/api/model-probe/sites/${siteId}`, { probeEndpointType: 'messages' });
    expect(configured.status).toBe(200);
    expect(configured.payload.site.probeEndpointType).toBe('messages');

    upstreamModels = ['probe-model'];
    probeResponder = () => messagesOk();

    await runProbe();

    // The assertion that matters: what the relay actually received.
    expect(probePaths()).toEqual(['/v1/messages']);
    expect(probePaths()).not.toContain('/v1/chat/completions');
    expect(probePaths()).not.toContain('/v1/responses');

    const results = await listResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      modelName: 'probe-model',
      status: 'supported',
      endpointUsed: 'messages',
    });
  }, 60_000);

  // Property 3a.
  it('puts the per-site User-Agent on the wire', async () => {
    const siteId = await insertSite({ slug: 'ua', name: 'UA Site', probeEndpointType: 'chat' });
    await insertAccount(siteId);
    await putConfig({
      interestPatterns: ['^probe-model$'],
      userAgents: [{ id: 'global-preset', label: 'Global', value: 'metapi-global-ua/1.0' }],
      defaultUserAgentId: 'global-preset',
    });
    await api('PUT', `/api/model-probe/sites/${siteId}`, { probeUserAgent: 'metapi-site-ua/9.9' });

    upstreamModels = ['probe-model'];
    await runProbe();

    const posts = probePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.userAgent).toBe('metapi-site-ua/9.9');
    expect((await listResults())[0]?.userAgentUsed).toBe('metapi-site-ua/9.9');
  }, 60_000);

  // Property 3b: the inversion fixed in 6cdddd3 — blank means INHERIT, not "send none".
  it('inherits the global User-Agent preset when the per-site override is blank', async () => {
    const siteId = await insertSite({ slug: 'uablank', name: 'UA Blank Site', probeEndpointType: 'chat' });
    await insertAccount(siteId);
    await putConfig({
      interestPatterns: ['^probe-model$'],
      userAgents: [{ id: 'global-preset', label: 'Global', value: 'metapi-global-ua/1.0' }],
      defaultUserAgentId: 'global-preset',
    });
    // Explicitly blank, which is what the site editor stores for "inherit".
    const cleared = await api('PUT', `/api/model-probe/sites/${siteId}`, { probeUserAgent: '' });
    expect(cleared.payload.site.probeUserAgent).toBe('');

    upstreamModels = ['probe-model'];
    await runProbe();

    const posts = probePosts();
    expect(posts).toHaveLength(1);
    // Blank must NOT mean "no User-Agent": the global preset goes on the wire.
    expect(posts[0]?.userAgent).toBe('metapi-global-ua/1.0');
    expect(posts[0]?.userAgent).not.toBe('');
    expect((await listResults())[0]?.userAgentUsed).toBe('metapi-global-ua/1.0');
  }, 60_000);

  // Property 4: preview must spend nothing.
  it('makes zero probe requests on preview and lists only regex-matched models', async () => {
    const siteId = await insertSite({ slug: 'preview', name: 'Preview Site', probeEndpointType: 'chat' });
    await insertAccount(siteId);
    await putConfig({ interestPatterns: ['^probe-'] });

    upstreamModels = ['probe-alpha', 'probe-beta', 'other-gamma'];
    // Deliberately a VALID reply rather than a throw: if preview ever regresses
    // into probing, this must fail as a request-count assertion below, not as an
    // uncaught exception inside the fake relay.
    probeResponder = () => chatOk();

    const preview = await api('POST', '/api/model-probe/preview', {});
    expect(preview.status).toBe(200);
    expect(preview.payload.preview.sites).toHaveLength(1);
    expect(preview.payload.preview.sites[0]).toMatchObject({
      siteId,
      source: 'live',
      credentialVerified: true,
      discoveredCount: 3,
      models: ['probe-alpha', 'probe-beta'],
    });
    expect(preview.payload.preview.totalModels).toBe(2);

    // Zero probe traffic: the only upstream call is the discovery GET.
    expect(probePosts()).toHaveLength(0);
    expect(upstreamRequests.map((record) => `${record.method} ${record.path}`)).toEqual(['GET /v1/models']);

    // Zero writes: no results rows and no queued task.
    expect(await listResults()).toHaveLength(0);
    expect(server.tasks.listBackgroundTasks()).toHaveLength(0);
  }, 60_000);

  // Property 5: the reason this feature exists, proved in BOTH directions.
  it('classifies a 200 error body as unavailable and a genuine 200 as available', async () => {
    const siteId = await insertSite({ slug: 'classify', name: 'Classify Site', probeEndpointType: 'chat' });
    await insertAccount(siteId);
    await putConfig({ interestPatterns: ['^probe-'] });

    upstreamModels = ['probe-good', 'probe-error-key', 'probe-unknown-error', 'probe-keyword'];
    probeResponder = (record) => {
      const model = record.body?.model;
      if (model === 'probe-error-key') {
        // 200 + a top-level `error` object whose text names a configured keyword.
        return errorBodyWith200('no such model: probe-error-key');
      }
      if (model === 'probe-unknown-error') {
        // 200 + a top-level `error` object and deliberately NO configured keyword:
        // an account-level failure, which must read as unclear rather than absent.
        return errorBodyWith200('余额不足，请充值');
      }
      if (model === 'probe-keyword') {
        // 200 + a protocol-shaped but contentless body whose prose matches a
        // configured error keyword — the other independent path to `unsupported`.
        return {
          status: 200,
          body: JSON.stringify({
            choices: [{ message: { content: '' } }],
            detail: 'no such model',
          }),
        };
      }
      return chatOk('a genuine answer');
    };

    await runProbe();

    // All four were really probed at HTTP level.
    expect(probePosts()).toHaveLength(4);

    const results = await listResults();
    const byModel = new Map(results.map((item) => [item.modelName, item]));
    expect(byModel.get('probe-good')).toMatchObject({
      status: 'supported',
      httpStatus: 200,
      failureKind: null,
    });
    // The crux, twice over: HTTP 200, yet unavailable — once from a top-level
    // error naming a configured keyword, once from contentless prose naming one.
    // Two independent paths, so neither assertion can be passing on the other's
    // behalf.
    expect(byModel.get('probe-error-key')).toMatchObject({
      status: 'unsupported',
      httpStatus: 200,
      failureKind: 'error_body',
    });
    expect(byModel.get('probe-keyword')).toMatchObject({
      status: 'unsupported',
      httpStatus: 200,
      failureKind: 'error_body',
    });
    // And the fail-safe half, which is what keeps the row above honest: the SAME
    // 200-plus-error shape, differing only in whether a configured keyword matches,
    // must not be reported as unavailable. Otherwise an out-of-balance relay
    // condemns every model at the site.
    expect(byModel.get('probe-unknown-error')).toMatchObject({
      status: 'inconclusive',
      httpStatus: 200,
      failureKind: 'error_body',
    });
    expect(byModel.get('probe-unknown-error')?.status).not.toBe('supported');
  }, 60_000);

  // Property 6.
  it('sorts results by latency and by balance', async () => {
    const fastSiteId = await insertSite({ slug: 'fast', name: 'Fast Site', probeEndpointType: 'chat' });
    const slowSiteId = await insertSite({ slug: 'slow', name: 'Slow Site', probeEndpointType: 'chat' });
    // Balance order is deliberately the OPPOSITE of latency order, so neither
    // assertion below can be satisfied by a single shared ordering.
    await insertAccount(fastSiteId, { balance: 99, username: 'fast-account' });
    await insertAccount(slowSiteId, { balance: 1, username: 'slow-account' });
    await putConfig({ interestPatterns: ['^probe-model$'], concurrency: 2 });

    upstreamModels = ['probe-model'];
    // A real server-side delay on one site only, so the stored latencies are
    // genuinely measured and genuinely distinct rather than fixture values.
    probeResponder = (record) => (
      record.rawPath.startsWith('/site-slow')
        ? { ...chatOk(), delayMs: 300 }
        : chatOk()
    );

    await runProbe();
    expect(probePosts()).toHaveLength(2);

    const latencyAsc = await listResults('?sortBy=latency&order=asc');
    expect(latencyAsc).toHaveLength(2);
    const ascLatencies = latencyAsc.map((item) => item.latencyMs as number);
    // Genuinely distinct, so the ordering assertion is not vacuous.
    expect(ascLatencies[0]).toBeLessThan(ascLatencies[1] as number);

    const latencyDesc = await listResults('?sortBy=latency&order=desc');
    expect(latencyDesc.map((item) => item.latencyMs)).toEqual([...ascLatencies].reverse());

    // Fast site answered immediately, slow site after 300ms.
    expect(latencyAsc.map((item) => item.siteName)).toEqual(['Fast Site', 'Slow Site']);

    const balanceAsc = await listResults('?sortBy=balance&order=asc');
    expect(balanceAsc.map((item) => item.balance)).toEqual([1, 99]);
    expect(balanceAsc.map((item) => item.siteName)).toEqual(['Slow Site', 'Fast Site']);
    const balanceDesc = await listResults('?sortBy=balance&order=desc');
    expect(balanceDesc.map((item) => item.balance)).toEqual([99, 1]);
    // Balance order is the reverse of latency order, so neither assertion could
    // be passing on one shared default ordering.
    expect(balanceAsc.map((item) => item.siteName)).not.toEqual(latencyAsc.map((item) => item.siteName));
  }, 60_000);

  /**
   * Property 6, null half. The test above uses only measured latencies and known
   * balances, which is exactly why it could not see NULL placement — and NULL is
   * the common case on both columns: every skipped or timed-out probe stores a
   * null `latencyMs`, and `balance` is null whenever it is unknown.
   *
   * It matters here rather than only in the service test because the dialects
   * disagree: SQLite (this suite) and MySQL put NULLs first on `asc`, Postgres
   * (the operator's Supabase) puts them last on `asc` and first on `desc`. Without
   * an explicit placement this endpoint would answer differently in production
   * than in any test.
   *
   * The null rows are genuinely produced by a run rather than inserted as
   * fixtures: an `embedding` model is skipped before any request is made, which is
   * how a real sweep gets a row with no measurement.
   */
  it('sorts rows with no measurement last, not first, in both directions', async () => {
    const knownSiteId = await insertSite({ slug: 'known', name: 'Known Balance', probeEndpointType: 'chat' });
    const unknownSiteId = await insertSite({ slug: 'unknown', name: 'Unknown Balance', probeEndpointType: 'chat' });
    await insertAccount(knownSiteId, { balance: 5, username: 'known-account' });
    await insertAccount(unknownSiteId, { balance: null, username: 'unknown-account' });
    // `^probe-` matches both, so each site yields one measured row and one skipped
    // row.
    await putConfig({ interestPatterns: ['^probe-'], concurrency: 2 });

    upstreamModels = ['probe-model', 'probe-embedding'];
    probeResponder = () => chatOk();

    await runProbe();
    // The embedding models were skipped without a request: 2 sites, not 4 models.
    expect(probePosts()).toHaveLength(2);

    for (const order of ['asc', 'desc'] as const) {
      const byLatency = await listResults(`?sortBy=latency&order=${order}`);
      expect(byLatency).toHaveLength(4);
      const latencies = byLatency.map((item) => item.latencyMs);
      // Two measured rows first, then the two unmeasured ones — in BOTH
      // directions, because "never got a number" is neither fast nor slow.
      expect(latencies.slice(0, 2).every((value) => typeof value === 'number')).toBe(true);
      expect(latencies.slice(2)).toEqual([null, null]);
      expect(byLatency.slice(2).map((item) => item.modelName)).toEqual(['probe-embedding', 'probe-embedding']);

      const byBalance = await listResults(`?sortBy=balance&order=${order}`);
      expect(byBalance).toHaveLength(4);
      expect(byBalance.slice(0, 2).map((item) => item.balance)).toEqual([5, 5]);
      expect(byBalance.slice(2).map((item) => item.balance)).toEqual([null, null]);
      expect(byBalance.slice(2).map((item) => item.siteName)).toEqual(['Unknown Balance', 'Unknown Balance']);
    }

    // Page 1 of 「最快优先」 must carry measurements, which is the operator-visible
    // symptom: on SQLite's default the first page was all 「—」 placeholders.
    const firstPage = await listResults('?sortBy=latency&order=asc&limit=2&offset=0');
    expect(firstPage.map((item) => item.latencyMs).every((value) => typeof value === 'number')).toBe(true);
  }, 60_000);

  /**
   * Property 7, and the one this file exists for.
   *
   * The setup is deliberately the WORST case for the guard: `syncToRouting` is
   * ON, the verdict is `unsupported` (the only verdict that ever reaches the write
   * path), and a matching non-manual `model_availability` row exists — so
   * `PROXY_ROUTING_ENABLED=false` is the single thing standing between the run and
   * a routing write. Pre-existing rows in all three tables make the comparison
   * cover modification and deletion, not just insertion.
   *
   * The control below then flips routing on and shows the same run DOES write, so
   * a green assertion here cannot be explained by a write path that never works.
   */
  async function snapshotRoutingTables(): Promise<string> {
    const [availability, routes, channels] = await Promise.all([
      server.db.select().from(server.schema.modelAvailability).all(),
      server.db.select().from(server.schema.tokenRoutes).all(),
      server.db.select().from(server.schema.routeChannels).all(),
    ]);
    return JSON.stringify({ availability, routes, channels });
  }

  async function seedRoutingFixtures(accountId: number, modelName: string): Promise<void> {
    await server.db.insert(server.schema.modelAvailability).values({
      accountId,
      modelName,
      available: true,
      isManual: false,
    }).run();
    const route = await server.db.insert(server.schema.tokenRoutes).values({
      modelPattern: modelName,
      enabled: true,
    }).returning({ id: server.schema.tokenRoutes.id }).get();
    await server.db.insert(server.schema.routeChannels).values({
      routeId: route.id,
      accountId,
      sourceModel: modelName,
      enabled: true,
    }).run();
  }

  it('writes nothing to token_routes, route_channels or model_availability when routing is disabled', async () => {
    const siteId = await insertSite({ slug: 'routing', name: 'Routing Site', probeEndpointType: 'chat' });
    const accountId = await insertAccount(siteId);
    await putConfig({ interestPatterns: ['^probe-unsupported$'], syncToRouting: true });
    await seedRoutingFixtures(accountId, 'probe-unsupported');

    upstreamModels = ['probe-unsupported'];
    probeResponder = () => errorBodyWith200('no such model: probe-unsupported');

    const before = await snapshotRoutingTables();
    const task = await runProbe();

    // The property itself, asserted first: all three tables byte-identical.
    const after = await snapshotRoutingTables();
    expect(after).toBe(before);

    // The run really happened and really produced the one verdict that could write.
    expect(probePosts()).toHaveLength(1);
    expect(task.status).toBe('succeeded');
    expect(task.result).toMatchObject({ probed: 1, unsupported: 1, disabled: 0, routingSynced: false });

    // Stated explicitly as well, so a failure names which table moved.
    const availability = await server.db.select().from(server.schema.modelAvailability).all();
    expect(availability).toHaveLength(1);
    expect(availability[0]?.available).toBe(true);
    expect(await server.db.select().from(server.schema.tokenRoutes).all()).toHaveLength(1);
    expect(await server.db.select().from(server.schema.routeChannels).all()).toHaveLength(1);

    // The probe's own table did get written, so "nothing changed" is not because
    // the run was a no-op.
    expect(await listResults()).toHaveLength(1);
  }, 60_000);

  it('control: the same run does disable the model once routing is enabled', async () => {
    const siteId = await insertSite({ slug: 'control', name: 'Control Site', probeEndpointType: 'chat' });
    const accountId = await insertAccount(siteId);
    await putConfig({ interestPatterns: ['^probe-unsupported$'], syncToRouting: true });
    await seedRoutingFixtures(accountId, 'probe-unsupported');

    upstreamModels = ['probe-unsupported'];
    probeResponder = () => errorBodyWith200('no such model: probe-unsupported');

    // The ONLY difference from the test above.
    server.config.proxyRoutingEnabled = true;
    try {
      await runProbe();
    } finally {
      server.config.proxyRoutingEnabled = false;
    }

    const availability = await server.db.select().from(server.schema.modelAvailability).all();
    // Proves the routing-disabled assertion above was blocked by the gate rather
    // than by a write path that cannot fire in this harness at all.
    expect(availability[0]?.available).toBe(false);
  }, 120_000);

  /**
   * A sweep must be stoppable, over real HTTP, while it is genuinely spending.
   *
   * Every model answers after a delay and concurrency is 1, so the sweep is slow
   * enough to interrupt without racing: the cancel POST is only sent once the fake
   * relay has actually received a probe, which is what makes "it was in flight"
   * an observation rather than an assumption.
   */
  it('stops a running sweep on request and reports it as cancelled, not completed', async () => {
    const siteId = await insertSite({ slug: 'cancel', name: 'Cancel Site', probeEndpointType: 'chat' });
    await insertAccount(siteId);
    await putConfig({ interestPatterns: ['^probe-slow-'], concurrency: 1 });

    const modelCount = 8;
    upstreamModels = Array.from({ length: modelCount }, (_, index) => `probe-slow-${index}`);
    probeResponder = () => ({ ...chatOk(), delayMs: 200 });

    const queued = await api('POST', '/api/model-probe/run', {});
    expect(queued.status).toBe(202);
    const taskId = queued.payload.taskId as string;

    // Wait for real probe traffic before cancelling.
    const inFlightDeadline = Date.now() + 30_000;
    while (probePosts().length < 1 && Date.now() < inFlightDeadline) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 20).unref?.(); });
    }
    expect(probePosts().length).toBeGreaterThanOrEqual(1);

    const cancelled = await api('POST', `/api/model-probe/run/${taskId}/cancel`);
    expect(cancelled.status).toBe(202);
    expect(cancelled.payload).toMatchObject({ success: true, cancelled: true });

    const deadline = Date.now() + 60_000;
    let task: any = null;
    while (Date.now() < deadline) {
      const polled = await api('GET', `/api/tasks/${taskId}`);
      task = polled.payload.task;
      if (task.status !== 'pending' && task.status !== 'running') break;
      await new Promise<void>((resolve) => { setTimeout(resolve, 25).unref?.(); });
    }

    // Honest terminal state: marked cancelled, with the unprobed remainder named.
    expect(task.result).toMatchObject({ cancelled: true });
    expect(task.result.remaining).toBeGreaterThan(0);
    expect(task.result.probed).toBeLessThan(modelCount);
    // The quota property, measured at the relay rather than inferred from the
    // summary: the models after the cancel were never asked.
    expect(probePosts().length).toBe(task.result.probed);
    expect(probePosts().length).toBeLessThan(modelCount);

    // Partial results are kept and readable.
    expect(await listResults()).toHaveLength(task.result.probed);

    // Cancelling again reports that there is nothing left to stop.
    const again = await api('POST', `/api/model-probe/run/${taskId}/cancel`);
    expect(again.status).toBe(409);
    expect(again.payload).toMatchObject({ code: 'already_finished' });
  }, 120_000);

  // Bonus: the prompt comes from the configurable table, not a fixed string.
  it('draws the probe prompt from the configured random table', async () => {
    const siteId = await insertSite({ slug: 'prompts', name: 'Prompt Site', probeEndpointType: 'chat' });
    await insertAccount(siteId);
    const configuredPrompts = ['probe-prompt-alpha', 'probe-prompt-beta'];
    await putConfig({ interestPatterns: ['^probe-model-'], prompts: configuredPrompts, concurrency: 2 });

    upstreamModels = Array.from({ length: 8 }, (_, index) => `probe-model-${index}`);
    await runProbe();

    const posts = probePosts();
    expect(posts).toHaveLength(8);
    const observed = posts.map((record) => {
      const messages = record.body?.messages as Array<{ content?: unknown }> | undefined;
      return String(messages?.[0]?.content ?? '');
    });
    // Every prompt on the wire came from the configured table…
    for (const prompt of observed) {
      expect(configuredPrompts).toContain(prompt);
    }
    // …and never from the hardcoded fallbacks, which is what "configurable" buys.
    expect(observed).not.toContain('Reply with OK.');
    expect(observed).not.toContain('Reply with a single short word.');

    // The persisted `promptUsed` agrees with what the relay saw.
    const results = await listResults('?limit=500');
    for (const item of results) {
      expect(configuredPrompts).toContain(item.promptUsed);
    }
  }, 120_000);
});

