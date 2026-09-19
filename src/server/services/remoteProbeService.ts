import { getBackgroundTask, listBackgroundTasks, type BackgroundTask } from './backgroundTaskService.js';
import {
  ACTIVE_MODEL_PROBE_TASK_TYPE as PROBE_TASK_TYPE,
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

/** Counters shared by the run and status responses; `durationMs` only on run. */
export type RemoteProbeSummary = {
  totalProbed: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  durationMs?: number;
};

export type RemoteProbeRunResult = {
  status: 'completed' | 'running';
  taskId: string;
  summary?: RemoteProbeSummary;
  available?: RemoteProbeAvailableResult[];
  message?: string;
};

export type RemoteProbeStatusResult = {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** The task this describes — filled in even when the caller passed no id. */
  taskId?: string;
  progress?: {
    current: number;
    total: number;
  };
  summary?: RemoteProbeSummary;
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
 * Task-scope registry: maps a queued probe task id to the site ids that sweep
 * covers, so `/status` can report per-run results instead of the whole table.
 *
 * Kept here rather than inside the background task object on purpose — the task
 * shape is shared with other features and its `result` slot is owned by the
 * probe runner's summary. Entries die with their task: every read prunes scopes
 * whose task has already expired, and queueing prunes the whole registry, so a
 * leak would require unbounded operator-triggered probes with zero polls.
 */
const taskScopeByTaskId = new Map<string, number[]>();

function rememberTaskScope(taskId: string, siteIds: number[] | undefined) {
  // Lazy GC: drop scopes whose backing task is gone. Remote probes are
  // operator-triggered and rare, so a full pass per queue is cheap.
  for (const existingId of taskScopeByTaskId.keys()) {
    if (!getBackgroundTask(existingId)) taskScopeByTaskId.delete(existingId);
  }
  if (siteIds && siteIds.length > 0) {
    taskScopeByTaskId.set(taskId, siteIds);
  }
}

function getTaskScope(taskId: string): number[] | undefined {
  const scope = taskScopeByTaskId.get(taskId);
  if (scope && !getBackgroundTask(taskId)) {
    // Task expired between polls — the scope has nothing left to describe.
    taskScopeByTaskId.delete(taskId);
    return undefined;
  }
  return scope;
}

/**
 * Page through every result row for a scope, bypassing the page limit.
 *
 * `listActiveModelProbeResults` defaults to a 100-row page because it feeds a
 * paginated UI. The remote API reports on a WHOLE sweep, so the totals and the
 * available-model list would both be silently truncated for any real account
 * set. Paging through with `offset` is equivalent and keeps the shared query
 * function's contract (limit ≤ MAX_RESULTS_LIMIT) intact for its UI callers.
 *
 * The sort is fixed here (site, then model) rather than inherited from the UI's
 * "fastest first" default: the remote API answers "what can I use", which reads
 * as a directory, not a leaderboard. Callers must NOT re-sort by latency after
 * this — doing so would only reorder within a page and interleave sites.
 */
async function listAllResultsForScope(siteIds?: number[]): Promise<ModelProbeResultView[]> {
  const items: ModelProbeResultView[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const page = await listActiveModelProbeResults({
      ...(siteIds && siteIds.length > 0 ? { siteIds } : {}),
      sortBy: 'site',
      order: 'asc',
      limit: pageSize,
      offset,
    });
    items.push(...page.items);
    if (items.length >= page.total || page.items.length === 0) break;
    offset += page.items.length;
  }
  return items;
}

/**
 * Sort a scope's rows by site name, then model name.
 *
 * `sortBy: 'site'` already orders this way at the SQL level, but nothing in the
 * query type promises model-name order within a site (the ORDER BY tail is the
 * row id). Re-sorting in memory makes the contract explicit and survives a
 * future change to the shared query's tiebreakers.
 */
function sortBySiteThenModel(items: ModelProbeResultView[]): ModelProbeResultView[] {
  return [...items].sort((a, b) => (
    a.siteName.localeCompare(b.siteName) || a.modelName.localeCompare(b.modelName)
  ));
}

function buildScopeSummary(items: ModelProbeResultView[], durationMs?: number) {
  return {
    totalProbed: items.length,
    supported: items.filter((r) => r.status === 'supported').length,
    unsupported: items.filter((r) => r.status === 'unsupported').length,
    inconclusive: items.filter((r) => r.status === 'inconclusive').length,
    ...(durationMs !== undefined ? { durationMs } : {}),
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

  // The sites this sweep will actually touch, from the preview — the same
  // resolution the queued runner will do. Scope the result reporting to these
  // ids so a single-site probe does not read back the whole results table.
  const scopeSiteIds = preview.sites.map((site) => site.siteId);

  // Queue the task
  const { task } = queueActiveModelProbe({
    siteIds,
    authorizedTargetCount: preview.totalModels,
  });
  rememberTaskScope(task.id, scopeSiteIds);

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
      const items = await listAllResultsForScope(scopeSiteIds);

      return {
        status: 'completed',
        taskId: task.id,
        summary: buildScopeSummary(items, durationMs),
        available: sortBySiteThenModel(filterAvailableResults(items)).map(toRemoteProbeResult),
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
 * Get status of a probe task.
 *
 * `taskId` is optional: with no id the most recently queued sweep is described.
 * The Telegram bot uses that so `/status` on its own answers "how did my last
 * probe go?" — recalling a uuid is not something a chat user should have to do.
 * The lookup reuses the same scope registry, so a completed run reports the same
 * counters the original `/run` did.
 */
export async function getRemoteProbeStatus(taskId?: string): Promise<RemoteProbeStatusResult> {
  const trimmed = String(taskId || '').trim();
  const task = trimmed
    ? getBackgroundTask(trimmed)
    : findLatestProbeTask();

  if (!task) {
    throw new Error(trimmed ? '任务不存在或已过期' : '还没有执行过探测任务');
  }

  if (task.status === 'succeeded') {
    const scopeSiteIds = getTaskScope(task.id);
    const items = await listAllResultsForScope(scopeSiteIds);

    return {
      status: 'completed',
      taskId: task.id,
      summary: buildScopeSummary(items),
      available: sortBySiteThenModel(filterAvailableResults(items)).map(toRemoteProbeResult),
    };
  }

  return {
    status: task.status as any,
    taskId: task.id,
    progress: {
      current: 0, // TODO: extract from task logs if needed
      total: 0,
    },
  };
}

/**
 * Newest queued probe sweep, running or not.
 *
 * Filters on the task `type` rather than taking `listBackgroundTasks()[0]`
 * blindly: that list is shared with the update center and other background work,
 * so an unrelated task would otherwise be reported as "the last probe". Ties
 * break on `createdAt`, which the shared lister already sorts newest-first.
 */
function findLatestProbeTask(): BackgroundTask | null {
  const [latest] = listBackgroundTasks(200).filter((task) => task.type === PROBE_TASK_TYPE);
  return latest ?? null;
}

/**
 * The sweep in flight right now, if any.
 *
 * Only `pending` / `running` count: a `succeeded` task is history, and callers
 * use this to decide whether a new sweep would join an existing run or start
 * spending quota of its own.
 */
export function findActiveProbeTask(): BackgroundTask | null {
  return listBackgroundTasks(200).find(
    (task) => task.type === PROBE_TASK_TYPE && (task.status === 'pending' || task.status === 'running'),
  ) ?? null;
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
