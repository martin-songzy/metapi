import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModelProbe from './ModelProbe.js';

const { apiMock, isMobileMock } = vi.hoisted(() => ({
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
  isMobileMock: vi.fn(() => false),
}));

vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: () => isMobileMock() }));

const RESULTS_PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/web/pages/modelProbe/ModelProbeResultsPanel.tsx'),
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

const SUPPORTED_ROW = {
  id: 1,
  siteId: 4,
  siteName: '站点甲',
  accountId: 21,
  accountUsername: 'ops@example.com',
  balance: 12.5,
  modelName: 'gpt-4o',
  status: 'supported' as const,
  latencyMs: 843,
  httpStatus: 200,
  failureKind: null,
  reason: null,
  endpointUsed: '/v1/chat/completions',
  promptUsed: 'hi',
  userAgentUsed: 'claude-cli/2.1.63',
  checkedAt: '2026-08-21T02:30:00.000Z',
};

/** A skipped row: every nullable column is genuinely null in normal operation. */
const SKIPPED_ROW = {
  id: 2,
  siteId: 9,
  siteName: '站点乙',
  accountId: null,
  accountUsername: null,
  balance: null,
  modelName: 'claude-3-5-sonnet',
  status: 'skipped' as const,
  latencyMs: null,
  httpStatus: null,
  failureKind: null,
  reason: null,
  endpointUsed: null,
  promptUsed: null,
  userAgentUsed: null,
  checkedAt: null,
};

function resultsResponse(
  items: unknown[],
  query: Record<string, unknown> = { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
  total = items.length,
) {
  return { success: true, items, total, query };
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

function lastResultsQuery(): Record<string, unknown> {
  const calls = apiMock.getModelProbeResults.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  isMobileMock.mockReturnValue(false);
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
    limits: {
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
    },
  });
  apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
  apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW, SKIPPED_ROW]));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ModelProbe results table', () => {
  it('shows endpoint, latency, balance, reason and check time for a probed row', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([
      { ...SUPPORTED_ROW, status: 'unsupported', reason: '该模型不存在', failureKind: 'model_missing' },
    ]));
    const root = await renderPage();
    try {
      const row = collectText(findByTestId(root.root, 'model-probe-result-row-1'));
      expect(row).toContain('站点甲');
      expect(row).toContain('gpt-4o');
      expect(row).toContain('/v1/chat/completions');
      expect(row).toContain('843');
      expect(row).toContain('12.5');
      expect(row).toContain('该模型不存在');
      expect(row).toContain('2026');
    } finally {
      root.unmount();
    }
  });

  it('renders a placeholder for every genuinely null column, never null or NaN', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SKIPPED_ROW]));
    const root = await renderPage();
    try {
      const row = collectText(findByTestId(root.root, 'model-probe-result-row-2'));
      expect(row).toContain('claude-3-5-sonnet');
      expect(row).not.toContain('null');
      expect(row).not.toContain('NaN');
      expect(row).not.toContain('undefined');

      // Coercing null to a number is worse than showing nothing: `0 ms` claims the
      // model answered instantly, `0.00` claims a zero balance, and an epoch date
      // claims it was checked in 1970. Every nullable cell must be the placeholder.
      expect(row).not.toContain('0 ms');
      expect(row).not.toContain('0.00');
      expect(row).not.toContain('1970');
      expect(row).not.toContain('Invalid Date');
      expect(row.match(/—/g)).toHaveLength(6);
    } finally {
      root.unmount();
    }
  });

  it('reports an empty result set as empty rather than as a healthy sweep', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([], undefined, 0));
    const root = await renderPage();
    try {
      expect(collectText(findByTestId(root.root, 'model-probe-results-empty'))).toContain('还没有');
    } finally {
      root.unmount();
    }
  });
});

function pickSelectOption(root: ReactTestInstance, testId: string, label: string) {
  const select = findByTestId(root, testId);
  return select.find((node) => node.type === 'button' && collectText(node).trim() === label);
}

describe('ModelProbe results filtering', () => {
  it('filters by model name', async () => {
    const root = await renderPage();
    try {
      const input = findByTestId(root.root, 'model-probe-results-model');
      await act(async () => {
        input.props.onChange({ target: { value: 'gpt-4o' } });
      });
      await click(findByTestId(root.root, 'model-probe-results-apply'));

      expect(lastResultsQuery()).toMatchObject({ model: 'gpt-4o' });
    } finally {
      root.unmount();
    }
  });

  it('filters by site', async () => {
    const root = await renderPage();
    try {
      await act(async () => {
        pickSelectOption(root.root, 'model-probe-results-site', '站点乙').props.onClick();
      });
      await flushMicrotasks();

      expect(lastResultsQuery()).toMatchObject({ siteId: 9 });
    } finally {
      root.unmount();
    }
  });

  it('drops the site filter again when 全部站点 is chosen', async () => {
    const root = await renderPage();
    try {
      await act(async () => {
        pickSelectOption(root.root, 'model-probe-results-site', '站点乙').props.onClick();
      });
      await flushMicrotasks();
      await act(async () => {
        pickSelectOption(root.root, 'model-probe-results-site', '全部站点').props.onClick();
      });
      await flushMicrotasks();

      expect(lastResultsQuery().siteId).toBeUndefined();
    } finally {
      root.unmount();
    }
  });

  it('filters by probe status', async () => {
    const root = await renderPage();
    try {
      await act(async () => {
        pickSelectOption(root.root, 'model-probe-results-status', '不支持').props.onClick();
      });
      await flushMicrotasks();

      expect(lastResultsQuery()).toMatchObject({ status: 'unsupported' });
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe results sorting', () => {
  it('sorts by response speed', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-sort-latency'));
      expect(lastResultsQuery()).toMatchObject({ sortBy: 'latency', order: 'asc' });
    } finally {
      root.unmount();
    }
  });

  it('sorts by site balance', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-sort-balance'));
      expect(lastResultsQuery()).toMatchObject({ sortBy: 'balance', order: 'desc' });
    } finally {
      root.unmount();
    }
  });

  it('toggles the direction when the same sort field is clicked again', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-sort-latency'));
      expect(lastResultsQuery()).toMatchObject({ sortBy: 'latency', order: 'asc' });
      await click(findByTestId(root.root, 'model-probe-sort-latency'));
      expect(lastResultsQuery()).toMatchObject({ sortBy: 'latency', order: 'desc' });
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe results applied-filter echo', () => {
  it('shows the filters the server says it applied, not the local draft', async () => {
    // The server normalized the request: a different model term, and a sort the
    // panel never asked for. What is on screen must be the server's answer.
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse(
      [SUPPORTED_ROW],
      { model: 'server-normalized', siteId: 9, status: 'supported', sortBy: 'balance', order: 'asc', limit: 25, offset: 0 },
      1,
    ));
    const root = await renderPage();
    try {
      const applied = collectText(findByTestId(root.root, 'model-probe-results-applied'));
      expect(applied).toContain('server-normalized');
      expect(applied).toContain('站点乙');
      expect(applied).toContain('余额');
      expect(applied).toContain('升序');
    } finally {
      root.unmount();
    }
  });

  it('says so when the server dropped a filter the operator typed', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse(
      [SUPPORTED_ROW],
      // No `model` key at all: the server did not apply one.
      { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
      1,
    ));
    const root = await renderPage();
    try {
      const input = findByTestId(root.root, 'model-probe-results-model');
      await act(async () => {
        input.props.onChange({ target: { value: '   ' } });
      });
      await click(findByTestId(root.root, 'model-probe-results-apply'));

      const applied = collectText(findByTestId(root.root, 'model-probe-results-applied'));
      expect(applied).toContain('全部模型');
    } finally {
      root.unmount();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((inner) => { resolve = inner; });
  return { promise, resolve };
}

describe('ModelProbe results staleness', () => {
  it('ignores a slow earlier response that lands after a newer one', async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    apiMock.getModelProbeResults
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    const root = await renderPage();
    try {
      // Second request issued while the first is still in flight.
      await click(findByTestId(root.root, 'model-probe-sort-latency'));

      await act(async () => {
        fast.resolve(resultsResponse(
          [{ ...SUPPORTED_ROW, id: 7, modelName: 'FRESH-MODEL' }],
          { sortBy: 'latency', order: 'asc', limit: 50, offset: 0 },
          1,
        ));
      });
      await flushMicrotasks();
      expect(collectText(root.root)).toContain('FRESH-MODEL');

      await act(async () => {
        slow.resolve(resultsResponse(
          [{ ...SUPPORTED_ROW, id: 8, modelName: 'STALE-MODEL' }],
          { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
          1,
        ));
      });
      await flushMicrotasks();

      // The superseded response must not repaint the table, or the rows would
      // disagree with the sort control that is rendered as active.
      const pageText = collectText(root.root);
      expect(pageText).not.toContain('STALE-MODEL');
      expect(pageText).toContain('FRESH-MODEL');
      expect(collectText(findByTestId(root.root, 'model-probe-results-applied'))).toContain('响应速度');
    } finally {
      root.unmount();
    }
  });

  it('keeps the newer error rather than a superseded success', async () => {
    const slow = deferred<unknown>();
    apiMock.getModelProbeResults
      .mockReturnValueOnce(slow.promise)
      .mockRejectedValueOnce(new Error('结果查询失败'));

    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-sort-balance'));
      expect(collectText(findByTestId(root.root, 'model-probe-results-error'))).toContain('结果查询失败');

      await act(async () => {
        slow.resolve(resultsResponse([{ ...SUPPORTED_ROW, id: 9, modelName: 'STALE-MODEL' }], undefined, 1));
      });
      await flushMicrotasks();

      expect(collectText(root.root)).not.toContain('STALE-MODEL');
      expect(collectText(findByTestId(root.root, 'model-probe-results-error'))).toContain('结果查询失败');
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe results safety and layout', () => {
  it('renders an upstream reason literally, never as markup', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([
      { ...SUPPORTED_ROW, status: 'unsupported', reason: '<img src=x onerror="alert(1)">上游拒绝' },
    ]));
    const root = await renderPage();
    try {
      const row = findByTestId(root.root, 'model-probe-result-row-1');
      expect(collectText(row)).toContain('<img src=x onerror="alert(1)">上游拒绝');
      expect(RESULTS_PANEL_SOURCE).not.toContain('dangerouslySetInnerHTML');
    } finally {
      root.unmount();
    }
  });

  it('keeps the desktop table inside a horizontally scrollable container', async () => {
    const root = await renderPage();
    try {
      const table = findByTestId(root.root, 'model-probe-results-table');
      expect(table.findAll((node) => node.type === 'table').length).toBeGreaterThan(0);
      expect(table.props.style?.overflowX).toBe('auto');
    } finally {
      root.unmount();
    }
  });

  it('uses shared mobile cards instead of a table on a narrow viewport', async () => {
    isMobileMock.mockReturnValue(true);
    const root = await renderPage();
    try {
      expect(root.root.findAll((node) => node.type === 'table')).toHaveLength(0);
      const cards = root.root.findAll((node) => (
        typeof node.props.className === 'string'
        && node.props.className.split(' ').includes('mobile-card')
      ));
      expect(cards.length).toBeGreaterThan(0);
      expect(collectText(root.root)).toContain('gpt-4o');
    } finally {
      root.unmount();
    }
  });

  it('reuses the shared primitives and imports no other top-level page', () => {
    expect(RESULTS_PANEL_SOURCE).toMatch(/import\s+ResponsiveFilterPanel\s+from\s+'\.\.\/\.\.\/components\/ResponsiveFilterPanel\.js'/);
    expect(RESULTS_PANEL_SOURCE).toMatch(/import\s+\{[^}]*MobileCard[^}]*\}\s+from\s+'\.\.\/\.\.\/components\/MobileCard\.js'/);
    expect(RESULTS_PANEL_SOURCE).toMatch(/import\s+ModernSelect\s+from\s+'\.\.\/\.\.\/components\/ModernSelect\.js'/);
    expect(RESULTS_PANEL_SOURCE).not.toContain('matchMedia');
    expect(RESULTS_PANEL_SOURCE).not.toContain('window.innerWidth');
    expect(RESULTS_PANEL_SOURCE).not.toContain('max-width:');

    const pageImports = RESULTS_PANEL_SOURCE
      .split('\n')
      .filter((line) => /from\s+'\.\.\/[A-Z][^/']*\.js'/.test(line));
    expect(pageImports).toEqual([]);
  });
});

