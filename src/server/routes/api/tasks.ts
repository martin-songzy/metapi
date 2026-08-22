import { FastifyInstance } from 'fastify';
import { getBackgroundTask, listBackgroundTasks } from '../../services/backgroundTaskService.js';
import { redactBackgroundTaskForResponse } from '../../services/modelProbeApiService.js';

/**
 * Active model probe task logs and result summaries quote upstream error bodies
 * verbatim, and this route hands them to the browser. The redactor decides which
 * task types need masking; every task still flows through it so a new probe-like
 * task type is covered by changing one service, not every route.
 */
export async function taskRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>('/api/tasks', async (request) => {
    const limit = Number.parseInt(request.query.limit || '50', 10);
    return {
      tasks: listBackgroundTasks(limit).map(redactBackgroundTaskForResponse),
    };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = getBackgroundTask(request.params.id);
    if (!task) {
      return reply.code(404).send({ success: false, message: 'task not found' });
    }
    return {
      success: true,
      task: redactBackgroundTaskForResponse(task),
    };
  });
}
