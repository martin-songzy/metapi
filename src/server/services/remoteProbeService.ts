import { getBackgroundTask } from './backgroundTaskService.js';
import {
  listActiveModelProbeResults,
  previewActiveModelProbe,
  queueActiveModelProbe,
  type ModelProbeResultView,
} from './modelProbeRunService.js';

/**
 * Remote probe service for Telegram and other external integrations.
 *
 * Wraps the active model probe with a simplified, result-focused API:
 * - Targets endpoint returns a lightweight site/model summary
 * - Run endpoint waits for completion and returns ONLY available results
 * - Status endpoint polls a running task
 *
 * Design principles:
 * 1. Synchronous for small sweeps (≤50 targets), async for large ones
 * 2. Only return `supported` results by default to minimize payload
 * 3. Rate-limited to prevent abuse from external callers
 */

const MAX_SYNCHRONOUS_TARGETS = 50;
const DEFAULT_SYNC_TIMEOUT_MS = 300_000; // 5 minutes
const POLL_INTERVAL_MS = 1_000;

export type RemoteProbeTargetsSummary = {
  sites: Array<{
    siteId: number;
    siteName: string;
    platform: string;
    status: string;
    modelCount: number;
    models?: string[]; // Only when summary=false
  }>;
  summary: {
    totalSites: number;
    totalModels: number;
    estimatedTargets: number;
  };
};

export type RemoteProbeScopeInput = {
  siteIds?: number[] | 'all';
};

export type RemoteProbeRunInput = {
  siteIds: number[] | 'all';
  waitForCompletion?: boolean;
  timeout?: number;
};

export type RemoteProbeAvailableResult = {
  siteId: number;
  siteName: string;
  modelName: string;
  latencyMs: number | null;
  balance: number | null;
  keyName: string;
  isPrimary: boolean;
  checkedAt: string | null;
};

export type RemoteProbeRunResult = {
  status: 'completed' | 'running';
  taskId: string;
  summary?: {
    totalProbed: number;
    supported: number;
    unsupported: number;
    inconclusive: number;
    durationMs: number;
  };
  available?: RemoteProbeAvailableResult[];
  message?: string;
};

export type RemoteProbeStatusResult = {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: {
    current: number;
    total: number;
  };
  summary?: {
    totalProbed: number;
    supported: number;
    unsupported: number;
    inconclusive: number;
  };
  available?: RemoteProbeAvailableResult[];
};

/**
 * Get available probe targets with optional model list.
 */
export async function getRemoteProbeTargets(input: {
  siteIds?: number[];
  includeModels?: boolean;
}): Promise<RemoteProbeTargetsSummary> {
  const scope = input.siteIds ? { siteIds: input.siteIds } : undefined;
  const preview = await previewActiveModelProbe(scope);

  const sites = preview.sites.map((site) => ({
    siteId: site.siteId,
    siteName: site.siteName,
    platform: '', // Will be joined from sites table in route handler
    status: 'active',
    modelCount: site.models.length,
    ...(input.includeModels ? { models: site.models } : {}),
  }));

  return {
    sites,
    summary: {
      totalSites: preview.sites.length,
      totalModels: preview.sites.reduce((sum, site) => sum + site.models.length, 0),
      estimatedTargets: preview.totalModels,
    },
  };
}

/**
 * Trigger a probe run and optionally wait for completion.
 *
 * For small sweeps (≤50 targets), waits synchronously and returns results.
 * For large sweeps or when waitForCompletion=false, returns taskId immediately.
 */
export async function runRemoteProbe(input: RemoteProbeRunInput): Promise<RemoteProbeRunResult> {
  const siteIds = input.siteIds === 'all' ? undefined : input.siteIds;
  const waitForCompletion = input.waitForCompletion !== false;
  const timeout = input.timeout ?? DEFAULT_SYNC_TIMEOUT_MS;

  // Preview to get target count
  const preview = await previewActiveModelProbe(siteIds ? { siteIds } : undefined);

  // Queue the task
  const { task } = queueActiveModelProbe({
    siteIds,
    authorizedTargetCount: preview.totalModels,
  });

  const startTime = Date.now();

  // For large sweeps, return immediately
  if (preview.totalModels > MAX_SYNCHRONOUS_TARGETS || !waitForCompletion) {
    return {
      status: 'running',
      taskId: task.id,
      message: `探测范围过大（${preview.totalModels} 个目标），已在后台执行，请稍后查询结果`,
    };
  }

  // For small sweeps, wait for completion
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const currentTask = getBackgroundTask(task.id);
    if (!currentTask) break;

    if (currentTask.status === 'succeeded') {
      const durationMs = Date.now() - startTime;
      const results = await listActiveModelProbeResults({});
      const available = filterAvailableResults(results.items);

      const summary = {
        totalProbed: results.total,
        supported: results.items.filter((r) => r.status === 'supported').length,
        unsupported: results.items.filter((r) => r.status === 'unsupported').length,
        inconclusive: results.items.filter((r) => r.status === 'inconclusive').length,
        durationMs,
      };

      return {
        status: 'completed',
        taskId: task.id,
        summary,
        available: available.map(toRemoteProbeResult),
      };
    }

    if (currentTask.status === 'failed') {
      throw new Error('探测任务失败');
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout
  return {
    status: 'running',
    taskId: task.id,
    message: `探测仍在进行中，请使用 taskId 查询状态`,
  };
}

/**
 * Get status of a running or completed probe task.
 */
export async function getRemoteProbeStatus(taskId: string): Promise<RemoteProbeStatusResult> {
  const task = getBackgroundTask(taskId);
  if (!task) {
    throw new Error('任务不存在或已过期');
  }

  if (task.status === 'succeeded') {
    const results = await listActiveModelProbeResults({});
    const available = filterAvailableResults(results.items);

    return {
      status: 'completed',
      summary: {
        totalProbed: results.total,
        supported: results.items.filter((r) => r.status === 'supported').length,
        unsupported: results.items.filter((r) => r.status === 'unsupported').length,
        inconclusive: results.items.filter((r) => r.status === 'inconclusive').length,
      },
      available: available.map(toRemoteProbeResult),
    };
  }

  return {
    status: task.status as any,
    progress: {
      current: 0, // TODO: extract from task logs if needed
      total: 0,
    },
  };
}

function filterAvailableResults(items: ModelProbeResultView[]): ModelProbeResultView[] {
  return items.filter((item) => item.status === 'supported');
}

function toRemoteProbeResult(item: ModelProbeResultView): RemoteProbeAvailableResult {
  return {
    siteId: item.siteId,
    siteName: item.siteName,
    modelName: item.modelName,
    latencyMs: item.latencyMs,
    balance: item.balance,
    keyName: item.tokenName || '主 Key',
    isPrimary: item.isPrimary,
    checkedAt: item.checkedAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
