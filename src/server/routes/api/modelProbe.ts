import { FastifyInstance, FastifyReply } from 'fastify';

import {
  parseModelProbeConfigPayload,
  parseModelProbePreviewPayload,
  parseModelProbeResultsQuery,
  parseModelProbeRunPayload,
  parseModelProbeSiteConfigPayload,
} from '../../contracts/modelProbePayloads.js';
import {
  isModelProbeConfigValidationError,
  loadModelProbeConfig,
} from '../../services/modelProbeConfigService.js';
import {
  applyModelProbeConfigPatch,
  getModelProbeConfigLimits,
  listModelProbeSites,
  requestActiveModelProbeRun,
  toModelProbePreviewResponse,
  toModelProbeResultResponse,
  updateModelProbeSiteConfig,
} from '../../services/modelProbeApiService.js';
import {
  buildModelProbeRunLimitMessage,
  listActiveModelProbeResults,
  previewActiveModelProbe,
  requestActiveModelProbeCancellation,
} from '../../services/modelProbeRunService.js';

/**
 * Thin adapter for the active model probe. Every handler does exactly three
 * things: parse with a Zod contract, delegate to a service, shape the status code.
 *
 * No protocol conversion, no retry, no verdict logic, and no direct database
 * access live here — those belong to `services/modelProbeApiService.ts` and the
 * probe services it calls. This file's own import list names no routing module,
 * and every endpoint keeps working with `PROXY_ROUTING_ENABLED=false` — because
 * nothing on these paths calls into routing, not because the transitive import
 * closure excludes it (it does not; see `modelProbeRunService.ts` for the chain).
 */

function sendBadRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ success: false, message });
}

function parseSiteIdParam(raw: string): number | null {
  const siteId = Number.parseInt(raw, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) return null;
  return siteId;
}

export async function modelProbeRoutes(app: FastifyInstance) {
  app.get('/api/model-probe/config', async () => ({
    success: true,
    config: await loadModelProbeConfig(),
    limits: getModelProbeConfigLimits(),
  }));

  app.put<{ Body: unknown }>('/api/model-probe/config', async (request, reply) => {
    const parsed = parseModelProbeConfigPayload(request.body);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);

    try {
      return {
        success: true,
        config: await applyModelProbeConfigPatch(parsed.data),
        limits: getModelProbeConfigLimits(),
      };
    } catch (error) {
      // A regex the operator can fix is a 400, not a server fault.
      if (isModelProbeConfigValidationError(error)) {
        return reply.code(400).send({
          success: false,
          message: error.message,
          invalidPatterns: error.invalidPatterns,
        });
      }
      throw error;
    }
  });

  app.get('/api/model-probe/sites', async () => ({
    success: true,
    sites: await listModelProbeSites(),
  }));

  app.put<{ Params: { id: string }; Body: unknown }>('/api/model-probe/sites/:id', async (request, reply) => {
    const siteId = parseSiteIdParam(request.params.id);
    if (siteId === null) return sendBadRequest(reply, 'Invalid site id.');

    const parsed = parseModelProbeSiteConfigPayload(request.body);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);

    const site = await updateModelProbeSiteConfig(siteId, parsed.data);
    if (!site) {
      return reply.code(404).send({ success: false, message: 'site not found' });
    }
    return { success: true, site };
  });

  app.post<{ Body: unknown }>('/api/model-probe/preview', async (request, reply) => {
    const parsed = parseModelProbePreviewPayload(request.body);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);

    const scope = parsed.data.siteIds ? { siteIds: parsed.data.siteIds } : {};
    const preview = await previewActiveModelProbe(scope);
    return { success: true, preview: toModelProbePreviewResponse(preview) };
  });

  app.post<{ Body: unknown }>('/api/model-probe/run', async (request, reply) => {
    const parsed = parseModelProbeRunPayload(request.body);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);

    const decision = await requestActiveModelProbeRun(parsed.data);
    const limits = getModelProbeConfigLimits();

    if (decision.outcome === 'run_limit_exceeded') {
      return reply.code(409).send({
        success: false,
        code: decision.outcome,
        // Built by the run service, which owns the cap. A copy here would let
        // the 409 and the run service's own refusal describe the same limit
        // differently.
        message: buildModelProbeRunLimitMessage(decision.targetCount),
        targetCount: decision.targetCount,
        confirmTargetThreshold: limits.confirmTargetThreshold,
        maxRunTargets: limits.maxRunTargets,
        preview: decision.preview,
      });
    }

    if (decision.outcome === 'confirmation_required') {
      return reply.code(409).send({
        success: false,
        code: decision.outcome,
        message: `本次将探测 ${decision.targetCount} 个模型，超过 ${limits.confirmTargetThreshold} 个需要二次确认。`
          + '确认后请携带相同的目标数量重试。',
        targetCount: decision.targetCount,
        confirmTargetThreshold: limits.confirmTargetThreshold,
        maxRunTargets: limits.maxRunTargets,
        preview: decision.preview,
      });
    }

    return reply.code(202).send({
      success: true,
      queued: true,
      taskId: decision.taskId,
      reused: decision.reused,
      targetCount: decision.targetCount,
      preview: decision.preview,
    });
  });

  /**
   * Stops a running sweep. Lives here rather than under `/api/tasks` because
   * cancellation is implemented by the probe's own run service, not by the shared
   * background task service — `/api/tasks` stays read-only for every task type.
   *
   * The three outcomes get three status codes on purpose: 409 for a sweep that
   * already finished must not read like 202, or an operator is told a completed
   * sweep was stopped.
   */
  app.post<{ Params: { taskId: string } }>('/api/model-probe/run/:taskId/cancel', async (request, reply) => {
    const taskId = String(request.params.taskId || '').trim();
    if (!taskId) return sendBadRequest(reply, 'Invalid task id.');

    const outcome = requestActiveModelProbeCancellation(taskId);
    if (outcome === 'not_found') {
      return reply.code(404).send({
        success: false,
        code: outcome,
        message: '找不到这次探测任务，它可能已经过期或从未存在。',
      });
    }
    if (outcome === 'already_finished') {
      return reply.code(409).send({
        success: false,
        code: outcome,
        message: '这次探测已经结束，没有可以取消的内容。',
      });
    }

    return reply.code(202).send({
      success: true,
      cancelled: true,
      taskId,
      message: '已请求取消：正在进行的那个模型完成后不会再发出新的探测请求。',
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>('/api/model-probe/results', async (request, reply) => {
    const parsed = parseModelProbeResultsQuery(request.query);
    if (!parsed.success) return sendBadRequest(reply, parsed.error);

    // Blank params leave the key present with an `undefined` value, so build the
    // service query by testing `!== undefined` rather than by key presence.
    const query = parsed.data;
    const results = await listActiveModelProbeResults({
      ...(query.model !== undefined ? { model: query.model } : {}),
      ...(query.siteId !== undefined ? { siteId: query.siteId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      success: true,
      items: results.items.map(toModelProbeResultResponse),
      total: results.total,
      query,
    };
  });
}
