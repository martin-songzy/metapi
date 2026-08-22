import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModelProbe from './ModelProbe.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelProbeConfig: vi.fn(),
    saveModelProbeConfig: vi.fn(),
    getModelProbeSites: vi.fn(),
    saveModelProbeSiteConfig: vi.fn(),
    previewModelProbe: vi.fn(),
    runModelProbe: vi.fn(),
    cancelModelProbeRun: vi.fn(),
    getModelProbeTask: vi.fn(),
    getModelProbeTasks: vi.fn(),
    getModelProbeResults: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

const RUN_PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/web/pages/modelProbe/ModelProbeRunPanel.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const RUN_SERVICE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/server/services/modelProbeRunService.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

const PROBE_TYPES_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/web/pages/modelProbe/modelProbeTypes.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findByTestId(root: ReactTestInstance, testId: string): ReactTestInstance {
  return root.find((node) => node.props['data-testid'] === testId);
}

function queryByTestId(root: ReactTestInstance, testId: string): ReactTestInstance | null {
  const matches = root.findAll((node) => node.props['data-testid'] === testId);
  return matches[0] ?? null;
}

/**
 * Boolean form of `queryByTestId` for presence/absence assertions.
 *
 * `expect(queryByTestId(...)).toBeNull()` reports nothing useful when it fails:
 * vitest tries to serialise the matched `ReactTestInstance` into the diff, and
 * the resulting payload is large enough to kill the worker IPC channel with
 * `RangeError: Invalid array length` — so a genuine regression shows up as an
 * unhandled error with no test named. Comparing booleans keeps the diff to one
 * line, which is what makes these assertions verifiable.
 */
function hasTestId(root: ReactTestInstance, testId: string): boolean {
  return queryByTestId(root, testId) !== null;
}

async function click(node: ReactTestInstance) {
  await act(async () => {
    await node.props.onClick();
  });
  await flushMicrotasks();
}

const SITES = [
  {
    id: 4,
    name: '站点甲',
    url: 'https://a.example.com',
    platform: 'newapi',
    status: 'active',
    probeEndpointType: 'auto' as const,
    probeUserAgent: '',
  },
  {
    id: 9,
    name: '站点乙',
    url: 'https://b.example.com',
    platform: 'veloera',
    status: 'active',
    probeEndpointType: 'chat' as const,
    probeUserAgent: '',
  },
];

// Deliberately not the production 50 / 300: every threshold shown must come from
// the server payload, so a hard-coded copy fails these tests.
function buildLimits() {
  return {
    minConcurrency: 1,
    maxConcurrency: 8,
    minTimeoutMs: 3_000,
    maxTimeoutMs: 60_000,
    maxInterestPatterns: 7,
    maxInterestPatternLength: 40,
    maxPrompts: 50,
    maxErrorKeywords: 50,
    confirmTargetThreshold: 11,
    maxRunTargets: 123,
  };
}

function buildPreview(overrides: Record<string, unknown> = {}) {
  return {
    sites: [
      {
        siteId: 4,
        siteName: '站点甲',
        source: 'live' as const,
        credentialVerified: true,
        discoveredCount: 12,
        models: ['gpt-4o', 'gpt-4o-mini'],
        liveFailure: null,
        notes: [],
      },
      {
        siteId: 9,
        siteName: '站点乙',
        source: 'cached' as const,
        credentialVerified: false,
        discoveredCount: 5,
        models: ['claude-3-5-sonnet'],
        liveFailure: { kind: 'empty_unknown' as const, status: null, message: '实时模型列表为空' },
        notes: ['已回退到缓存模型列表'],
      },
    ],
    totalModels: 3,
    invalidPatterns: [],
    skipped: [],
    exceedsRunLimit: false,
    ...overrides,
  };
}

function buildSummary(overrides: Record<string, unknown> = {}) {
  return {
    siteCount: 2,
    probed: 3,
    supported: 2,
    unsupported: 1,
    inconclusive: 0,
    skipped: 0,
    disabled: 1,
    routingSynced: true,
    skippedSites: [],
    invalidPatterns: [],
    cancelled: false,
    remaining: 0,
    ...overrides,
  };
}

// `active-model-probe` is the literal the server stores and serialises; the
// earlier `active_model_probe` fixture never matched the wire value.
const PROBE_TASK_TYPE = 'active-model-probe';

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    type: PROBE_TASK_TYPE,
    title: '模型可用性探测',
    status: 'running' as const,
    message: '正在探测',
    error: null,
    result: null,
    createdAt: '2026-08-21T02:00:00.000Z',
    updatedAt: '2026-08-21T02:00:01.000Z',
    startedAt: '2026-08-21T02:00:00.500Z',
    finishedAt: null,
    logs: [],
    ...overrides,
  };
}

async function renderPage() {
  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/model-probe']}>
        <ToastProvider>
          <ModelProbe />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root;
}

/** Drives the 1s poll interval deterministically instead of waiting on wall clock. */
async function advanceMs(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flushMicrotasks();
}

function spinnerCount(root: ReactTestInstance): number {
  return root.findAll((node) => (
    typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('spinner')
  )).length;
}

function toastTypes(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => typeof node.props.className === 'string'
      && node.props.className.split(' ').includes('toast'))
    .map((node) => String(node.props.className));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  apiMock.getModelProbeConfig.mockResolvedValue({
    success: true,
    config: {
      interestPatterns: ['gpt-4o'],
      prompts: ['hi'],
      userAgents: [{ id: 'claude-code', label: 'Claude Code', value: 'claude-cli/2.1.63' }],
      defaultUserAgentId: 'claude-code',
      errorKeywords: ['no available channel'],
      concurrency: 1,
      timeoutMs: 15_000,
      syncToRouting: false,
    },
    limits: buildLimits(),
  });
  apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
  apiMock.previewModelProbe.mockResolvedValue({ success: true, preview: buildPreview() });
  apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
  apiMock.cancelModelProbeRun.mockResolvedValue({ status: 'accepted' });
  apiMock.getModelProbeResults.mockResolvedValue({
    success: true,
    items: [],
    total: 0,
    query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ModelProbe preview', () => {
  it('previews per-site and total model counts without ever queuing a run', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-preview-button'));

      expect(apiMock.previewModelProbe).toHaveBeenCalledTimes(1);
      expect(apiMock.runModelProbe).not.toHaveBeenCalled();

      const summary = collectText(findByTestId(root.root, 'model-probe-preview-summary'));
      expect(summary).toContain('3');

      expect(collectText(findByTestId(root.root, 'model-probe-preview-site-4'))).toContain('2');
      expect(collectText(findByTestId(root.root, 'model-probe-preview-site-9'))).toContain('1');
    } finally {
      root.unmount();
    }
  });

  it('marks a cached site as an unverified credential and a live site as verified', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-preview-button'));

      const cached = collectText(findByTestId(root.root, 'model-probe-preview-credential-9'));
      expect(cached).toContain('未验证凭据');

      const live = collectText(findByTestId(root.root, 'model-probe-preview-credential-4'));
      expect(live).toContain('已验证凭据');
      expect(live).not.toContain('未验证凭据');
    } finally {
      root.unmount();
    }
  });

  it('warns that an unverified list can hide a revoked key rather than only labelling it', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-preview-button'));

      const warning = collectText(findByTestId(root.root, 'model-probe-preview-unverified-warning'));
      expect(warning).toContain('站点乙');
      expect(warning).toContain('缓存');
    } finally {
      root.unmount();
    }
  });

  it('surfaces the live failure and notes behind a cached fallback', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-preview-button'));

      const site = collectText(findByTestId(root.root, 'model-probe-preview-site-9'));
      expect(site).toContain('实时模型列表为空');
      expect(site).toContain('已回退到缓存模型列表');
    } finally {
      root.unmount();
    }
  });

  it('reports preview-level invalid patterns and skipped sites', async () => {
    apiMock.previewModelProbe.mockResolvedValue({
      success: true,
      preview: buildPreview({
        invalidPatterns: [{ source: '(unclosed', reason: '不是合法的正则表达式' }],
        skipped: [{ siteId: 12, siteName: '站点丙', code: 'no_active_account', message: '没有可用账号' }],
      }),
    });
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-preview-button'));

      expect(collectText(findByTestId(root.root, 'model-probe-preview-invalid-patterns'))).toContain('(unclosed');
      const skipped = collectText(findByTestId(root.root, 'model-probe-preview-skipped'));
      expect(skipped).toContain('站点丙');
      expect(skipped).toContain('没有可用账号');
    } finally {
      root.unmount();
    }
  });
});

function conflict(code: 'confirmation_required' | 'run_limit_exceeded', message: string) {
  return {
    status: 'conflict' as const,
    data: {
      success: false as const,
      code,
      message,
      targetCount: 42,
      confirmTargetThreshold: buildLimits().confirmTargetThreshold,
      maxRunTargets: buildLimits().maxRunTargets,
      preview: buildPreview({ totalModels: 42 }),
    },
  };
}

describe('ModelProbe run gate', () => {
  it('asks for confirmation on confirmation_required and never auto-retries', async () => {
    apiMock.runModelProbe.mockResolvedValue(conflict('confirmation_required', '需要二次确认'));
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
      expect(apiMock.runModelProbe).toHaveBeenCalledWith({});

      const dialog = findByTestId(root.root, 'model-probe-confirm-dialog');
      expect(collectText(dialog)).toContain('42');

      // Time passing must not turn a pending confirmation into a run.
      await advanceMs(5_000);
      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  });

  it('resends with confirmedTargetCount only after an explicit confirm', async () => {
    apiMock.runModelProbe
      .mockResolvedValueOnce(conflict('confirmation_required', '需要二次确认'))
      .mockResolvedValueOnce({
        status: 'queued' as const,
        data: {
          success: true as const,
          queued: true as const,
          taskId: 'task-1',
          reused: false,
          targetCount: 42,
          preview: buildPreview({ totalModels: 42 }),
        },
      });
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask() });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-confirm-accept'));

      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(2);
      expect(apiMock.runModelProbe).toHaveBeenNthCalledWith(2, { confirmedTargetCount: 42 });
    } finally {
      root.unmount();
    }
  });

  it('cancelling the confirmation sends nothing at all', async () => {
    apiMock.runModelProbe.mockResolvedValue(conflict('confirmation_required', '需要二次确认'));
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-confirm-cancel'));

      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
      expect(queryByTestId(root.root, 'model-probe-confirm-dialog')).toBeNull();
    } finally {
      root.unmount();
    }
  });

  it('offers no confirm affordance for run_limit_exceeded, only the server message', async () => {
    apiMock.runModelProbe.mockResolvedValue(conflict('run_limit_exceeded', '超过单次上限，请收窄正则'));
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      // A dialog here would push the operator into an unwinnable retry loop.
      expect(queryByTestId(root.root, 'model-probe-confirm-dialog')).toBeNull();
      expect(queryByTestId(root.root, 'model-probe-confirm-accept')).toBeNull();

      const blocked = collectText(findByTestId(root.root, 'model-probe-run-blocked'));
      expect(blocked).toContain('超过单次上限，请收窄正则');

      await advanceMs(5_000);
      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
      expect(apiMock.runModelProbe).not.toHaveBeenCalledWith(
        expect.objectContaining({ confirmedTargetCount: expect.anything() }),
      );
    } finally {
      root.unmount();
    }
  });

  it('reads both thresholds from the 409 body rather than a local constant', async () => {
    apiMock.runModelProbe.mockResolvedValue(
      // A message with no digits: the numbers on screen can only come from the
      // `confirmTargetThreshold` / `maxRunTargets` fields.
      conflict('confirmation_required', '需要二次确认'),
    );
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      const thresholds = collectText(findByTestId(root.root, 'model-probe-confirm-thresholds'));
      expect(thresholds).toContain('11');
      expect(thresholds).toContain('123');
      expect(thresholds).not.toContain('50');
      expect(thresholds).not.toContain('300');

      expect(RUN_PANEL_SOURCE).not.toMatch(/confirmTargetThreshold\s*[:=]\s*\d/);
      expect(RUN_PANEL_SOURCE).not.toMatch(/maxRunTargets\s*[:=]\s*\d/);
    } finally {
      root.unmount();
    }
  });
});

function queued(overrides: Record<string, unknown> = {}) {
  return {
    status: 'queued' as const,
    data: {
      success: true as const,
      queued: true as const,
      taskId: 'task-1',
      reused: false,
      targetCount: 3,
      preview: buildPreview(),
      ...overrides,
    },
  };
}

describe('ModelProbe task progress', () => {
  it('polls about every second while running and stops once the task is terminal', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'pending' }) })
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({ status: 'succeeded', message: '探测完成', result: buildSummary() }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      const afterQueue = apiMock.getModelProbeTask.mock.calls.length;
      expect(afterQueue).toBeGreaterThan(0);
      // Motion while polling is genuinely alive — the counterpart to the
      // stopped-poll case, which must show none.
      expect(spinnerCount(findByTestId(root.root, 'model-probe-run-panel'))).toBeGreaterThan(0);

      await advanceMs(1_000);
      await advanceMs(1_000);
      const afterTerminal = apiMock.getModelProbeTask.mock.calls.length;

      // Terminal reached: further ticks must not keep hitting the endpoint.
      await advanceMs(5_000);
      expect(apiMock.getModelProbeTask.mock.calls.length).toBe(afterTerminal);
      expect(apiMock.getModelProbeTask).toHaveBeenCalledWith('task-1');
    } finally {
      root.unmount();
    }
  });

  it('stops polling on unmount instead of leaking the interval', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    await click(findByTestId(root.root, 'model-probe-run-button'));
    await advanceMs(1_000);
    const beforeUnmount = apiMock.getModelProbeTask.mock.calls.length;
    expect(beforeUnmount).toBeGreaterThan(0);

    await act(async () => {
      root.unmount();
    });
    await advanceMs(5_000);

    expect(apiMock.getModelProbeTask.mock.calls.length).toBe(beforeUnmount);
  });

  it('merges log entries by seq so a repeated or reordered poll cannot duplicate them', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({
        success: true,
        task: buildTask({
          logs: [
            { seq: 2, message: '第二条', createdAt: '2026-08-21T02:00:02.000Z' },
            { seq: 1, message: '第一条', createdAt: '2026-08-21T02:00:01.000Z' },
          ],
        }),
      })
      .mockResolvedValue({
        success: true,
        task: buildTask({
          status: 'succeeded',
          result: buildSummary(),
          logs: [
            { seq: 1, message: '第一条', createdAt: '2026-08-21T02:00:01.000Z' },
            { seq: 2, message: '第二条', createdAt: '2026-08-21T02:00:02.000Z' },
            { seq: 3, message: '第三条', createdAt: '2026-08-21T02:00:03.000Z' },
          ],
        }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(1_000);

      const logsText = collectText(findByTestId(root.root, 'model-probe-task-logs'));
      expect(logsText.match(/第一条/g)).toHaveLength(1);
      expect(logsText.match(/第二条/g)).toHaveLength(1);
      expect(logsText.match(/第三条/g)).toHaveLength(1);
      expect(logsText.indexOf('第一条')).toBeLessThan(logsText.indexOf('第二条'));
    } finally {
      root.unmount();
    }
  });

  it('says a reused sweep was joined rather than started', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued({ reused: true }));
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(collectText(findByTestId(root.root, 'model-probe-task-reused'))).toContain('已有');
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe terminal state honesty', () => {
  it('renders a failed task as a failure, never as a finished sweep', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({
        status: 'failed',
        message: '探测中断',
        error: '上游连接被拒绝',
        result: null,
      }),
    });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      const failure = collectText(findByTestId(root.root, 'model-probe-task-failure'));
      expect(failure).toContain('上游连接被拒绝');

      const pageText = collectText(root.root);
      expect(pageText).not.toContain('探测完成');
      expect(queryByTestId(root.root, 'model-probe-task-summary')).toBeNull();
      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('still reports a failure when a failed task happens to carry a summary', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({
        status: 'failed',
        error: '中途中断',
        // `status` outranks `result`: a partial summary on a failed task must not
        // be promoted into a successful sweep.
        result: buildSummary(),
      }),
    });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      expect(collectText(findByTestId(root.root, 'model-probe-task-failure'))).toContain('中途中断');
      expect(queryByTestId(root.root, 'model-probe-task-summary')).toBeNull();
      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('refuses to call a succeeded task with a null result a successful sweep', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({ status: 'succeeded', message: '结束', result: null }),
    });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      expect(collectText(findByTestId(root.root, 'model-probe-task-missing-summary'))).toContain('没有返回');
      expect(queryByTestId(root.root, 'model-probe-task-summary')).toBeNull();
      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('reads probed:0 as "nothing matched" and names the reasons, not as success', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({
        status: 'succeeded',
        message: '完成',
        result: buildSummary({
          probed: 0,
          supported: 0,
          unsupported: 0,
          disabled: 0,
          routingSynced: false,
          invalidPatterns: [{ source: '(unclosed', reason: '不是合法的正则表达式' }],
          skippedSites: [{ siteId: 12, siteName: '站点丙', code: 'no_active_account', message: '没有可用账号' }],
        }),
      }),
    });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      const empty = collectText(findByTestId(root.root, 'model-probe-task-nothing-probed'));
      expect(empty).toContain('没有匹配到任何模型');

      const invalid = collectText(findByTestId(root.root, 'model-probe-summary-invalid-patterns'));
      expect(invalid).toContain('(unclosed');
      const skipped = collectText(findByTestId(root.root, 'model-probe-summary-skipped-sites'));
      expect(skipped).toContain('站点丙');
      expect(skipped).toContain('没有可用账号');

      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('surfaces skippedSites and invalidPatterns even on an otherwise healthy sweep', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({
        status: 'succeeded',
        result: buildSummary({
          invalidPatterns: [{ source: '[bad', reason: '不是合法的正则表达式' }],
          skippedSites: [{ siteId: 7, siteName: '站点丁', code: 'disabled', message: '站点已停用' }],
        }),
      }),
    });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));

      const summary = collectText(findByTestId(root.root, 'model-probe-task-summary'));
      expect(summary).toContain('3');
      expect(collectText(findByTestId(root.root, 'model-probe-summary-invalid-patterns'))).toContain('[bad');
      expect(collectText(findByTestId(root.root, 'model-probe-summary-skipped-sites'))).toContain('站点丁');
    } finally {
      root.unmount();
    }
  });

  it('reports a polling failure instead of leaving the run looking alive forever', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockRejectedValue(new Error('任务查询失败'));

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(5_000);

      // After giving up, the banner is the terminal `poll-stopped` one rather
      // than the transient `poll-error` one.
      expect(collectText(findByTestId(root.root, 'model-probe-task-poll-stopped'))).toContain('任务查询失败');
      const stopped = apiMock.getModelProbeTask.mock.calls.length;
      await advanceMs(10_000);
      expect(apiMock.getModelProbeTask.mock.calls.length).toBe(stopped);
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe run scope', () => {
  it('narrows preview and run to the selected sites, which is the only fix for a run cap', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      const scopeToggle = findByTestId(root.root, 'model-probe-scope-site-9');
      await act(async () => {
        scopeToggle.props.onChange({ target: { checked: true } });
      });

      await click(findByTestId(root.root, 'model-probe-preview-button'));
      expect(apiMock.previewModelProbe).toHaveBeenCalledWith({ siteIds: [9] });

      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(apiMock.runModelProbe).toHaveBeenCalledWith({ siteIds: [9] });
    } finally {
      root.unmount();
    }
  });

  it('sends no siteIds when no site is selected, meaning every eligible site', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-preview-button'));
      expect(apiMock.previewModelProbe).toHaveBeenCalledWith({});
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe run lifecycle', () => {
  it('refuses to queue a second sweep while the tracked one is still running', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);

      // A mid-run scope change used to produce a *second* dedupe key, so this
      // click added a sweep rather than narrowing the first one — and the panel
      // then stopped mentioning the sweep still spending quota.
      await act(async () => {
        findByTestId(root.root, 'model-probe-scope-site-9').props.onChange({ target: { checked: true } });
      });
      await click(findByTestId(root.root, 'model-probe-run-button'));

      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(true);
      expect(collectText(findByTestId(root.root, 'model-probe-run-active-hint'))).toContain('正在进行');
    } finally {
      root.unmount();
    }
  });

  it('re-enables the run button once the tracked sweep reaches a terminal status', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({ status: 'succeeded', result: buildSummary() }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(true);

      await advanceMs(1_000);
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('keeps the poll failure on screen when 发起探测 is clicked again', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockRejectedValue(new Error('任务查询失败'));

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(5_000);

      const stopped = findByTestId(root.root, 'model-probe-task-poll-stopped');
      // The sweep may well still be running upstream, so the banner must not
      // imply the run stopped along with the polling.
      expect(collectText(stopped)).toContain('服务端');

      await click(findByTestId(root.root, 'model-probe-run-button'));

      // Previously this cleared logs/task/pollError and left `等待任务状态` with
      // neither a spinner nor an error — a UI that never updates again.
      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
      expect(collectText(findByTestId(root.root, 'model-probe-task-poll-stopped'))).toContain('任务查询失败');
      expect(collectText(root.root)).not.toContain('等待任务状态');
      // Status is unknown once polling has given up, not pending.
      expect(collectText(root.root)).toContain('状态未知');
      // A spinner next to a stopped poll animates forever over nothing. The
      // progress section must show no motion at all here.
      expect(spinnerCount(findByTestId(root.root, 'model-probe-run-panel'))).toBe(0);
    } finally {
      root.unmount();
    }
  });

  it('restarts polling for an unchanged task id when the operator retries', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockRejectedValue(new Error('任务查询失败'));

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(5_000);
      const gaveUp = apiMock.getModelProbeTask.mock.calls.length;
      await advanceMs(5_000);
      expect(apiMock.getModelProbeTask.mock.calls.length).toBe(gaveUp);

      apiMock.getModelProbeTask.mockResolvedValue({
        success: true,
        task: buildTask({ status: 'running', message: '继续探测' }),
      });
      await click(findByTestId(root.root, 'model-probe-task-poll-retry'));

      expect(apiMock.getModelProbeTask.mock.calls.length).toBeGreaterThan(gaveUp);
      expect(queryByTestId(root.root, 'model-probe-task-poll-stopped')).toBeNull();
      expect(queryByTestId(root.root, 'model-probe-task-poll-error')).toBeNull();

      // The interval itself must be re-armed, not just one extra shot fired.
      const afterRetry = apiMock.getModelProbeTask.mock.calls.length;
      await advanceMs(2_000);
      expect(apiMock.getModelProbeTask.mock.calls.length).toBeGreaterThan(afterRetry);
    } finally {
      root.unmount();
    }
  });

  it('lets the operator stop following an unreachable task and then run again', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockRejectedValue(new Error('任务查询失败'));

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(5_000);
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(true);

      // Without this escape hatch the run guard would turn a lost poll into a
      // permanently disabled button.
      await click(findByTestId(root.root, 'model-probe-task-detach'));

      expect(queryByTestId(root.root, 'model-probe-task-poll-stopped')).toBeNull();
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(false);

      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(2);
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe run cancellation', () => {
  it('offers a cancel button while a sweep is in flight and none when it is not', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      // Paired negative: before a sweep exists there is nothing to cancel, so a
      // button rendered unconditionally would make the positive case meaningless.
      expect(hasTestId(root.root, 'model-probe-cancel-button')).toBe(false);

      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(hasTestId(root.root, 'model-probe-cancel-button')).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it('asks the server to stop the tracked task and keeps following it', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      const beforeCancel = apiMock.getModelProbeTask.mock.calls.length;

      await click(findByTestId(root.root, 'model-probe-cancel-button'));

      expect(apiMock.cancelModelProbeRun).toHaveBeenCalledTimes(1);
      expect(apiMock.cancelModelProbeRun).toHaveBeenCalledWith('task-1');
      // Cancelling is a request, not an answer: the in-flight model still has to
      // finish, so the panel must keep polling until the task itself is terminal.
      await advanceMs(2_000);
      expect(apiMock.getModelProbeTask.mock.calls.length).toBeGreaterThan(beforeCancel);
      expect(collectText(findByTestId(root.root, 'model-probe-cancel-requested'))).toContain('取消');
    } finally {
      root.unmount();
    }
  });

  it('sends only one cancel request no matter how many times the button is clicked', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-cancel-button'));
      const button = queryByTestId(root.root, 'model-probe-cancel-button');
      if (button) await click(button);

      expect(apiMock.cancelModelProbeRun).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  });

  it('reports a cancelled sweep as cancelled, with its partial counts and remainder', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({
          status: 'succeeded',
          message: '已取消',
          result: buildSummary({
            probed: 3,
            supported: 2,
            unsupported: 1,
            disabled: 0,
            routingSynced: false,
            cancelled: true,
            remaining: 17,
          }),
        }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(1_000);

      const banner = collectText(findByTestId(root.root, 'model-probe-task-cancelled'));
      expect(banner).toContain('已取消');
      // The remainder is the honest part: 3 probed out of 20 is not "3 models
      // exist", it is "17 were never asked".
      expect(banner).toContain('17');

      // Partial results are kept and still readable.
      const summary = collectText(findByTestId(root.root, 'model-probe-task-summary'));
      expect(summary).toContain('3');

      // A cancelled sweep is not a completed one.
      expect(collectText(root.root)).not.toContain('探测完成');
      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('says unsupported verdicts were not written to routing when cancelled', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({
          status: 'succeeded',
          result: buildSummary({
            unsupported: 4,
            disabled: 0,
            routingSynced: false,
            cancelled: true,
            remaining: 9,
          }),
        }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(1_000);

      const banner = collectText(findByTestId(root.root, 'model-probe-task-cancelled'));
      // Asserted on the effect the run service actually withholds. The earlier
      // assertion looked for 未写入, which the banner reached by claiming the
      // verdicts were not written to 站点禁用模型 — a table
      // `syncUnsupportedToRouting` never writes on any path, cancelled or not, so
      // the wording implied a completed sweep would. The intent was right and the
      // mechanism named was wrong.
      expect(banner).toContain('未同步到路由');
      expect(banner).toContain('不会把任何模型标记为不可用');
      expect(banner).not.toContain('站点禁用模型');
    } finally {
      root.unmount();
    }
  });

  /**
   * A cancel that arrives while the LAST model's probe is in flight stops nothing:
   * every model was probed and every request was paid for. The banner used to
   * render 「这次探测已取消，不是一次完整的探测」 directly above 「还有 0 个模型没有被
   * 探测」 — self-contradictory on its face — and told the operator the verdicts
   * were not applied, when with `remaining: 0` the run service now applies them.
   */
  it('does not claim missed models when a cancel landed after the last one', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({
          status: 'succeeded',
          message: '已取消',
          result: buildSummary({
            probed: 2,
            supported: 0,
            unsupported: 2,
            disabled: 2,
            routingSynced: true,
            cancelled: true,
            remaining: 0,
          }),
        }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(1_000);

      const banner = collectText(findByTestId(root.root, 'model-probe-task-cancelled'));
      // Still says it was cancelled — the operator did press the button.
      expect(banner).toContain('已取消');
      // But not that anything was missed, and not that the verdicts were withheld.
      expect(banner).not.toContain('还有 0 个');
      expect(banner).not.toContain('不是一次完整的探测');
      expect(banner).not.toContain('未同步到路由');
      // Positive control, so the assertions above cannot pass on an empty banner:
      // it has to say what actually happened.
      expect(banner).toContain('全部');

      // Same for the toast, which carried the same 「0 个未探测」.
      const page = collectText(root.root);
      expect(page).not.toContain('0 个未探测');
      expect(page).toContain('没有省下请求');
      // Still not a success: the operator asked to stop and the request was too late.
      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('does not show a cancelled banner on a sweep that ran to completion', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({ status: 'succeeded', result: buildSummary() }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await advanceMs(1_000);

      expect(hasTestId(root.root, 'model-probe-task-cancelled')).toBe(false);
      expect(hasTestId(root.root, 'model-probe-task-summary')).toBe(true);
      // Control for the assertions above: a completed sweep does say so.
      expect(toastTypes(root.root).some((cls) => cls.includes('toast-success'))).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it('hides the cancel button once the sweep is terminal', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask
      .mockResolvedValueOnce({ success: true, task: buildTask({ status: 'running' }) })
      .mockResolvedValue({
        success: true,
        task: buildTask({ status: 'succeeded', result: buildSummary() }),
      });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      expect(hasTestId(root.root, 'model-probe-cancel-button')).toBe(true);

      await advanceMs(1_000);
      expect(hasTestId(root.root, 'model-probe-cancel-button')).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('treats an already-finished sweep as an ordinary race, not an error', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });
    apiMock.cancelModelProbeRun.mockResolvedValue({ status: 'already_finished' });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-cancel-button'));

      expect(toastTypes(root.root).some((cls) => cls.includes('toast-error'))).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('surfaces a failed cancel request and lets the operator try again', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });
    apiMock.cancelModelProbeRun.mockRejectedValue(new Error('取消请求失败'));

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-cancel-button'));

      expect(toastTypes(root.root).some((cls) => cls.includes('toast-error'))).toBe(true);
      // A failed cancel must not latch the button off: the sweep is still
      // spending, so the operator needs another shot at stopping it.
      expect(hasTestId(root.root, 'model-probe-cancel-button')).toBe(true);
      const retry = queryByTestId(root.root, 'model-probe-cancel-button');
      expect(retry!.props.disabled).toBe(false);
      await click(retry!);
      expect(apiMock.cancelModelProbeRun).toHaveBeenCalledTimes(2);
    } finally {
      root.unmount();
    }
  });

  it('does not carry a cancel request into the next sweep after one is cancelled', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-cancel-button'));
      expect(hasTestId(root.root, 'model-probe-cancel-requested')).toBe(true);

      // The first sweep reaches its cancelled terminal state normally.
      apiMock.getModelProbeTask.mockResolvedValue({
        success: true,
        task: buildTask({
          status: 'succeeded',
          result: buildSummary({ cancelled: true, remaining: 5 }),
        }),
      });
      await advanceMs(1_000);

      // Now a *second*, freshly authorised sweep. This is the path where the
      // request must not carry over: `startRun` assigns a new task id without
      // going through 不再跟随, so a sweep-agnostic flag would open the new sweep
      // already labelled cancelled, with its cancel button dead.
      apiMock.runModelProbe.mockResolvedValue(queued({ taskId: 'task-2' }));
      apiMock.getModelProbeTask.mockResolvedValue({
        success: true,
        task: buildTask({ id: 'task-2', status: 'running' }),
      });
      await click(findByTestId(root.root, 'model-probe-run-button'));

      expect(apiMock.runModelProbe).toHaveBeenCalledTimes(2);
      expect(hasTestId(root.root, 'model-probe-cancel-requested')).toBe(false);
      const button = queryByTestId(root.root, 'model-probe-cancel-button');
      expect(button).not.toBe(null);
      expect(button!.props.disabled).toBe(false);

      // And it can genuinely be cancelled in its own right.
      await click(button!);
      expect(apiMock.cancelModelProbeRun).toHaveBeenCalledTimes(2);
      expect(apiMock.cancelModelProbeRun).toHaveBeenLastCalledWith('task-2');
    } finally {
      root.unmount();
    }
  });

  it('does not carry a cancel request past 不再跟随', async () => {
    apiMock.runModelProbe.mockResolvedValue(queued());
    apiMock.getModelProbeTask.mockResolvedValue({ success: true, task: buildTask({ status: 'running' }) });

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-run-button'));
      await click(findByTestId(root.root, 'model-probe-cancel-button'));
      expect(hasTestId(root.root, 'model-probe-cancel-requested')).toBe(true);

      // Detaching drops the tracked sweep; a later one must start clean rather
      // than opening with someone else's cancel notice.
      apiMock.getModelProbeTask.mockRejectedValue(new Error('任务查询失败'));
      await advanceMs(5_000);
      await click(findByTestId(root.root, 'model-probe-task-detach'));

      apiMock.getModelProbeTask.mockResolvedValue({
        success: true,
        task: buildTask({ id: 'task-2', status: 'running' }),
      });
      apiMock.runModelProbe.mockResolvedValue(queued({ taskId: 'task-2' }));
      await click(findByTestId(root.root, 'model-probe-run-button'));

      expect(hasTestId(root.root, 'model-probe-cancel-requested')).toBe(false);
      expect(hasTestId(root.root, 'model-probe-cancel-button')).toBe(true);
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe run reattach', () => {
  it('adopts a probe sweep that was already running when the page mounted', async () => {
    apiMock.getModelProbeTasks.mockResolvedValue({
      tasks: [{ id: 'task-9', type: PROBE_TASK_TYPE, status: 'running', createdAt: '2026-08-21T02:00:00.000Z' }],
    });
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({ id: 'task-9', status: 'running', message: '正在探测' }),
    });

    const root = await renderPage();
    try {
      // Previously a remount lost the sweep entirely: zero polls, no progress
      // section, and the only discoverable recovery was the button the panel
      // warns spends real quota.
      expect(apiMock.getModelProbeTask).toHaveBeenCalledWith('task-9');
      expect(collectText(findByTestId(root.root, 'model-probe-task-reattached'))).toContain('已在运行');
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(true);

      const before = apiMock.getModelProbeTask.mock.calls.length;
      await advanceMs(1_000);
      expect(apiMock.getModelProbeTask.mock.calls.length).toBeGreaterThan(before);
      expect(apiMock.runModelProbe).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  });

  it('ignores finished sweeps and other task types', async () => {
    apiMock.getModelProbeTasks.mockResolvedValue({
      tasks: [
        { id: 'other-1', type: 'site-announcement-sync', status: 'running', createdAt: '2026-08-21T02:10:00.000Z' },
        { id: 'task-old', type: PROBE_TASK_TYPE, status: 'succeeded', createdAt: '2026-08-21T02:05:00.000Z' },
        { id: 'task-bad', type: PROBE_TASK_TYPE, status: 'failed', createdAt: '2026-08-21T02:04:00.000Z' },
      ],
    });

    const root = await renderPage();
    try {
      expect(apiMock.getModelProbeTask).not.toHaveBeenCalled();
      expect(queryByTestId(root.root, 'model-probe-task-reattached')).toBeNull();
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it('adopts the newest running sweep when several are listed', async () => {
    apiMock.getModelProbeTasks.mockResolvedValue({
      tasks: [
        { id: 'task-new', type: PROBE_TASK_TYPE, status: 'pending', createdAt: '2026-08-21T02:20:00.000Z' },
        { id: 'task-older', type: PROBE_TASK_TYPE, status: 'running', createdAt: '2026-08-21T02:00:00.000Z' },
      ],
    });
    apiMock.getModelProbeTask.mockResolvedValue({
      success: true,
      task: buildTask({ id: 'task-new', status: 'pending' }),
    });

    const root = await renderPage();
    try {
      expect(apiMock.getModelProbeTask).toHaveBeenCalledWith('task-new');
      expect(apiMock.getModelProbeTask).not.toHaveBeenCalledWith('task-older');
    } finally {
      root.unmount();
    }
  });

  it('stays usable when the task list cannot be read', async () => {
    apiMock.getModelProbeTasks.mockRejectedValue(new Error('任务列表不可用'));

    const root = await renderPage();
    try {
      // A failed reattach lookup must not block a fresh run, and must not
      // fabricate a progress section for a task it never found.
      expect(queryByTestId(root.root, 'model-probe-task-reattached')).toBeNull();
      expect(findByTestId(root.root, 'model-probe-run-button').props.disabled).toBe(false);
      expect(collectText(root.root)).not.toContain('任务列表不可用');
    } finally {
      root.unmount();
    }
  });

  it('explains up front that re-running an unchanged scope rejoins instead of adding a sweep', async () => {
    const root = await renderPage();
    try {
      // This is the copy that removes the trap: pressing 发起探测 for a scope
      // already running is safe, but nothing used to say so in advance.
      const hint = collectText(findByTestId(root.root, 'model-probe-run-dedupe-hint'));
      expect(hint).toContain('不会');
      expect(hint).toContain('跟随');
    } finally {
      root.unmount();
    }
  });

  it('never lets a slow task-list lookup steal the sweep the operator just started', async () => {
    // The mount-time lookup is in flight while the operator presses 发起探测.
    let resolveTasks!: (value: unknown) => void;
    apiMock.getModelProbeTasks.mockReturnValue(new Promise((resolve) => { resolveTasks = resolve; }));
    apiMock.runModelProbe.mockResolvedValue({
      status: 'ok' as const,
      data: { success: true, taskId: 'task-fresh', reused: false, preview: buildPreview() },
    });
    apiMock.getModelProbeTask.mockImplementation(async (id: string) => ({
      success: true,
      task: buildTask({ id, status: 'running', message: '正在探测' }),
    }));

    const root = await renderPage();
    try {
      await act(async () => {
        findByTestId(root.root, 'model-probe-run-button').props.onClick();
      });
      await flushMicrotasks();
      expect(collectText(root.root)).toContain('task-fresh');

      // Now the stale lookup lands, reporting a different sweep.
      await act(async () => {
        resolveTasks({
          tasks: [{ id: 'task-stale', type: PROBE_TASK_TYPE, status: 'running', createdAt: '2026-08-21T01:00:00.000Z' }],
        });
      });
      await flushMicrotasks();

      // Adopting it would silently redirect the panel to a different task, so the
      // operator would watch progress for a sweep they did not start while their
      // own keeps burning quota unobserved.
      expect(collectText(root.root)).toContain('task-fresh');
      expect(collectText(root.root)).not.toContain('task-stale');
      expect(apiMock.getModelProbeTask).not.toHaveBeenCalledWith('task-stale');
      expect(queryByTestId(root.root, 'model-probe-task-reattached')).toBeNull();
    } finally {
      root.unmount();
    }
  });

  it('pins the probe task type to the literal the server stores', () => {
    // The web cannot import from `src/server`, so this keeps the two copies of
    // the task type honest instead of letting them drift silently apart.
    expect(RUN_SERVICE_SOURCE).toContain("export const ACTIVE_MODEL_PROBE_TASK_TYPE = 'active-model-probe';");
    expect(PROBE_TYPES_SOURCE).toContain("export const MODEL_PROBE_TASK_TYPE = 'active-model-probe';");
  });
});

describe('ModelProbeRunPanel architecture', () => {
  it('keeps the panel off hand-rolled breakpoints and off other top-level pages', () => {
    expect(RUN_PANEL_SOURCE).not.toContain('matchMedia');
    expect(RUN_PANEL_SOURCE).not.toContain('window.innerWidth');
    expect(RUN_PANEL_SOURCE).not.toContain('max-width:');

    const pageImports = RUN_PANEL_SOURCE
      .split('\n')
      .filter((line) => /from\s+'\.\.\/[A-Z][^/']*\.js'/.test(line));
    expect(pageImports).toEqual([]);
    // Reusing the settings page's confirm modal would couple two page families.
    expect(RUN_PANEL_SOURCE).not.toContain('ModelAvailabilityProbeConfirmModal');
  });

  it('renders upstream-authored reasons as text, never as HTML', () => {
    expect(RUN_PANEL_SOURCE).not.toContain('dangerouslySetInnerHTML');
  });
});

