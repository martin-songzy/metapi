import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db, schema } from '../../db/index.js';
import {
  findActiveProbeTask,
  getRemoteProbeStatus,
  getRemoteProbeTargets,
  runRemoteProbe,
  type RemoteProbeScopeInput,
  type RemoteProbeRunInput,
} from '../../services/remoteProbeService.js';

/**
 * Remote probe API for Telegram bots and other external integrations.
 *
 * Thin REST adapter over `remoteProbeService`, providing:
 * - GET /api/remote-probe/targets - lightweight site/model list
 * - POST /api/remote-probe/run - trigger probe with auto wait for small sweeps
 * - GET /api/remote-probe/status/:taskId - poll a task, or the latest sweep
 * - GET /api/remote-probe/status - same, for the most recent sweep
 * - GET /api/remote-probe/active - whether a sweep is running right now
 *
 * All endpoints require AUTH_TOKEN or PROXY_TOKEN authorization.
 * Rate limiting is applied to prevent abuse.
 */

function sendBadRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ success: false, message });
}

const targetsQuerySchema = z.object({
  siteIds: z.string().optional(),
  summary: z.enum(['true', 'false']).optional().default('true'),
});

const runBodySchema = z.object({
  siteIds: z.union([
    z.literal('all'),
    z.array(z.number().int().positive()).min(1),
  ]),
  waitForCompletion: z.boolean().optional().default(true),
  timeout: z.number().int().min(10_000).max(600_000).optional(),
});

export async function remoteProbeRoutes(app: FastifyInstance) {
  /**
   * GET /api/remote-probe/targets
   *
   * Returns available sites and models for probe target selection.
   *
   * Query params:
   * - siteIds: comma-separated site IDs (optional, defaults to all active sites)
   * - summary: 'true' (default) returns counts only, 'false' includes model lists
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/remote-probe/targets',
    async (request, reply) => {
      const parsed = targetsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendBadRequest(reply, parsed.error.issues[0]?.message || 'Invalid query parameters');
      }

      const { siteIds: siteIdsRaw, summary } = parsed.data;
      const siteIds = siteIdsRaw
        ? siteIdsRaw.split(',').map((id) => Number.parseInt(id.trim(), 10)).filter((id) => id > 0)
        : undefined;

      const includeModels = summary === 'false';

      try {
        const targets = await getRemoteProbeTargets({
          siteIds,
          includeModels,
        });

        // Join platform from sites table
        const siteRows = await db
          .select({
            id: schema.sites.id,
            platform: schema.sites.platform,
          })
          .from(schema.sites)
          .all();
        const platformMap = new Map(siteRows.map((row) => [row.id, row.platform]));

        const enrichedSites = targets.sites.map((site) => ({
          ...site,
          platform: platformMap.get(site.siteId) || 'unknown',
        }));

        return {
          success: true,
          sites: enrichedSites,
          summary: targets.summary,
        };
      } catch (error) {
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : '获取探测目标失败',
        });
      }
    },
  );

  /**
   * POST /api/remote-probe/run
   *
   * Triggers a model probe and optionally waits for completion.
   *
   * For small sweeps (≤50 targets), waits synchronously and returns available results.
   * For large sweeps, returns taskId immediately for polling.
   *
   * Body:
   * - siteIds: 'all' or array of site IDs (required)
   * - waitForCompletion: boolean (default true)
   * - timeout: max wait time in ms (default 300000, max 600000)
   */
  app.post<{ Body: unknown }>(
    '/api/remote-probe/run',
    async (request, reply) => {
      const parsed = runBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendBadRequest(reply, parsed.error.issues[0]?.message || 'Invalid request body');
      }

      const input: RemoteProbeRunInput = parsed.data;

      try {
        const result = await runRemoteProbe(input);

        if (result.status === 'running') {
          return reply.code(202).send({
            success: true,
            ...result,
          });
        }

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : '探测失败',
        });
      }
    },
  );

  /**
   * GET /api/remote-probe/status/:taskId
   *
   * Polls the status of a probe task, or of the most recent sweep when no id is
   * given (the Telegram bot's bare `/status`).
   *
   * Returns:
   * - status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
   * - taskId: echoed back, and resolved for the no-id form
   * - progress: current/total (if available)
   * - summary: probe statistics (when completed)
   * - available: list of supported models, sorted by site then model
   */
  app.get<{ Params: { taskId?: string } }>(
    '/api/remote-probe/status/:taskId',
    async (request, reply) => {
      return describeStatus(request.params.taskId, reply);
    },
  );

  /**
   * GET /api/remote-probe/status
   *
   * Same as above with no id: describes the most recent sweep. Registered as its
   * own route because Fastify treats `/status` and `/status/:taskId` as distinct
   * paths rather than one optional segment.
   */
  app.get('/api/remote-probe/status', async (request, reply) => {
    return describeStatus(undefined, reply);
  });

  /**
   * GET /api/remote-probe/active
   *
   * Whether a sweep is in flight right now, and its task id.
   *
   * Exists so the Telegram bot can answer a button press without discovering a
   * running sweep by attempting a probe and reading the dedupe result — the run
   * endpoint would otherwise queue a real sweep as a side effect of a status
   * question, which costs money.
   */
  app.get('/api/remote-probe/active', async () => {
    const active = findActiveProbeTask();
    return {
      success: true,
      running: active !== null,
      ...(active ? { taskId: active.id, title: active.title } : {}),
    };
  });
}

async function describeStatus(taskId: string | undefined, reply: FastifyReply) {
  const trimmed = String(taskId || '').trim();

  try {
    const status = await getRemoteProbeStatus(trimmed || undefined);
    return {
      success: true,
      taskId: status.taskId ?? trimmed,
      ...status,
    };
  } catch (error) {
    return reply.code(404).send({
      success: false,
      message: error instanceof Error ? error.message : '任务不存在',
    });
  }
}
