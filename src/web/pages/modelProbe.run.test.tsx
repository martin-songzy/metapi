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
    getModelProbeTask: vi.fn(),
    getModelProbeResults: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

const RUN_PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/web/pages/modelProbe/ModelProbeRunPanel.tsx'),
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
    ...overrides,
  };
}

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    type: 'active_model_probe',
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

      expect(collectText(findByTestId(root.root, 'model-probe-task-poll-error'))).toContain('任务查询失败');
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

