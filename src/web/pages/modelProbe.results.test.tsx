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
    clearModelProbeResults: vi.fn(),
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
      // Seven, not six, since the per-key column joined: this fixture sends no
      // `keyItems`, and an absent key breakdown is a placeholder like any other
      // null cell — it must not read as "one key, no verdict".
      expect(row.match(/—/g)).toHaveLength(7);
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

describe('ModelProbe results pagination', () => {
  it('hides both page buttons when everything fits on one page', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW, SKIPPED_ROW], undefined, 2));
    const root = await renderPage();
    try {
      expect(root.root.findAll((node) => node.props?.['data-testid'] === 'model-probe-results-next')).toHaveLength(0);
      expect(root.root.findAll((node) => node.props?.['data-testid'] === 'model-probe-results-prev')).toHaveLength(0);
    } finally {
      root.unmount();
    }
  });

  it('pages forward by the same page size it asked the server for', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW], undefined, 140));
    const root = await renderPage();
    try {
      // The first request's own limit is the page size; hard-coding 50 here would
      // keep passing if the panel and the server ever disagreed about it.
      const pageSize = Number(lastResultsQuery().limit);
      expect(pageSize).toBe(50);
      expect(lastResultsQuery()).toMatchObject({ offset: 0 });
      expect(findByTestId(root.root, 'model-probe-results-prev').props.disabled).toBe(true);

      await click(findByTestId(root.root, 'model-probe-results-next'));
      expect(lastResultsQuery()).toMatchObject({ limit: pageSize, offset: pageSize });

      await click(findByTestId(root.root, 'model-probe-results-next'));
      expect(lastResultsQuery()).toMatchObject({ offset: pageSize * 2 });

      await click(findByTestId(root.root, 'model-probe-results-prev'));
      expect(lastResultsQuery()).toMatchObject({ offset: pageSize });
    } finally {
      root.unmount();
    }
  });

  it('stops paging forward on the last page and never asks for a negative offset', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW], undefined, 60));
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-results-next'));
      // offset 50 of 60 is the last page: 50 + 50 >= 60.
      expect(findByTestId(root.root, 'model-probe-results-next').props.disabled).toBe(true);

      await click(findByTestId(root.root, 'model-probe-results-prev'));
      expect(lastResultsQuery()).toMatchObject({ offset: 0 });
      await click(findByTestId(root.root, 'model-probe-results-prev'));
      expect(Number(lastResultsQuery().offset)).toBe(0);
    } finally {
      root.unmount();
    }
  });

  it('returns to the first page when a filter changes', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW], undefined, 140));
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-results-next'));
      expect(Number(lastResultsQuery().offset)).toBeGreaterThan(0);

      const input = findByTestId(root.root, 'model-probe-results-model');
      await act(async () => {
        input.props.onChange({ target: { value: 'gpt-4o' } });
      });
      await click(findByTestId(root.root, 'model-probe-results-apply'));

      // Page 2 of the previous filter is meaningless, and silently keeping the
      // offset shows an empty table that reads as "no matches".
      expect(lastResultsQuery()).toMatchObject({ model: 'gpt-4o', offset: 0 });
    } finally {
      root.unmount();
    }
  });

  it('returns to the first page when the sort changes', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW], undefined, 140));
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-results-next'));
      expect(Number(lastResultsQuery().offset)).toBeGreaterThan(0);

      await click(findByTestId(root.root, 'model-probe-sort-latency'));
      expect(lastResultsQuery()).toMatchObject({ sortBy: 'latency', offset: 0 });
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

describe('ModelProbe results sort accessibility', () => {
  function headerWithText(root: ReactTestInstance, text: string): ReactTestInstance {
    return root.find((node) => node.type === 'th' && collectText(node).trim() === text);
  }

  it('reports the active sort direction as aria-sort on the column header', async () => {
    const root = await renderPage();
    try {
      // Default is 探测时间 descending.
      expect(headerWithText(root.root, '探测时间').props['aria-sort']).toBe('descending');
      expect(headerWithText(root.root, '响应').props['aria-sort']).toBe('none');
      expect(headerWithText(root.root, '余额').props['aria-sort']).toBe('none');

      await click(findByTestId(root.root, 'model-probe-sort-latency'));
      // 响应速度 starts ascending — fastest first.
      expect(headerWithText(root.root, '响应').props['aria-sort']).toBe('ascending');
      expect(headerWithText(root.root, '探测时间').props['aria-sort']).toBe('none');

      await click(findByTestId(root.root, 'model-probe-sort-latency'));
      expect(headerWithText(root.root, '响应').props['aria-sort']).toBe('descending');
    } finally {
      root.unmount();
    }
  });

  it('leaves aria-sort off columns that cannot be sorted', async () => {
    const root = await renderPage();
    try {
      // aria-sort on a non-sortable header would promise an interaction that
      // does not exist.
      for (const text of ['站点 / 账号', '模型', '状态', '接口', '原因']) {
        expect(headerWithText(root.root, text).props['aria-sort'], text).toBeUndefined();
      }
    } finally {
      root.unmount();
    }
  });

  it('states the direction in the sort button name, not only in the arrow glyph', async () => {
    const root = await renderPage();
    try {
      const active = findByTestId(root.root, 'model-probe-sort-checkedAt');
      // The ↑ / ↓ glyph is visual-only; the accessible name has to carry it.
      expect(active.props['aria-label']).toContain('降序');
      expect(active.props['aria-pressed']).toBe(true);

      const inactive = findByTestId(root.root, 'model-probe-sort-balance');
      expect(inactive.props['aria-pressed']).toBe(false);
      expect(inactive.props['aria-label']).not.toContain('当前');

      await click(findByTestId(root.root, 'model-probe-sort-checkedAt'));
      expect(findByTestId(root.root, 'model-probe-sort-checkedAt').props['aria-label']).toContain('升序');
    } finally {
      root.unmount();
    }
  });

  it('keeps aria-sort off the buttons, where it would be invalid ARIA', async () => {
    const root = await renderPage();
    try {
      // aria-sort is only valid on columnheader / rowheader / gridcell.
      for (const field of ['latency', 'balance', 'checkedAt']) {
        expect(findByTestId(root.root, `model-probe-sort-${field}`).props['aria-sort'], field).toBeUndefined();
      }
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


/**
 * Column visibility and width.
 *
 * The operator reported content cut off at both ends of the table, so the columns
 * became configurable. Two of them — 提示词 and User-Agent — are new and hidden by
 * default: probe prompts are drawn at random from a configurable pool, so "which
 * prompt produced this verdict?" was not answerable from the UI at all, but showing
 * them unasked would crowd a table already reported as too wide.
 */
describe('ModelProbe results column layout', () => {
  const STORAGE_KEY = 'metapi.modelProbe.results.columns.v1';
  let store: Record<string, string>;

  /**
   * Scoped inside this describe on purpose, and separate from the file's `click`
   * helper: these are checkboxes driven by `onChange`, while `click` calls
   * `onClick`, which the panel never supplies for them.
   */
  async function toggleColumn(root: ReactTestInstance, columnKey: string) {
    const box = findByTestId(root, `model-probe-results-column-${columnKey}`);
    await act(async () => {
      box.props.onChange({ target: { checked: !box.props.checked } });
    });
    await flushMicrotasks();
  }

  function headerCount(root: ReactTestInstance, columnKey: string): number {
    return root.findAll((node) => (
      node.props['data-testid'] === `model-probe-results-header-${columnKey}`
    )).length;
  }

  beforeEach(() => {
    // Deliberately NOT calling `vi.clearAllMocks()`: the file-level `beforeEach`
    // runs first and installs the config / sites / results mocks, and clearing them
    // again would strip those resolved values back to `undefined`.
    isMobileMock.mockReturnValue(false);
    store = {};
    // `localStorage` does not exist in this environment, and the panel reads it
    // through optional chaining — so without a stub the layout silently never
    // persists, and a persistence assertion would pass against a component that
    // stores nothing at all.
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; },
      key: () => null,
      length: 0,
    });
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides 提示词 and User-Agent by default, and shows them once toggled on', async () => {
    const root = await renderPage();
    try {
      expect(headerCount(root.root, 'prompt')).toBe(0);
      expect(headerCount(root.root, 'userAgent')).toBe(0);
      // Paired positive: a default-visible column IS rendered, so the absences
      // above cannot pass against a table that rendered no headers at all.
      expect(headerCount(root.root, 'model')).toBe(1);

      await click(findByTestId(root.root, 'model-probe-results-column-toggle'));
      await toggleColumn(root.root, 'prompt');

      expect(headerCount(root.root, 'prompt')).toBe(1);
      // The cell must arrive with the header — a header-only assertion would miss a
      // registry whose labels and cells disagree.
      expect(collectText(findByTestId(root.root, `model-probe-result-cell-prompt-${SUPPORTED_ROW.id}`)))
        .toContain('hi');
    } finally {
      root.unmount();
    }
  });

  it('persists a hidden column across a remount', async () => {
    const first = await renderPage();
    try {
      await click(findByTestId(first.root, 'model-probe-results-column-toggle'));
      await toggleColumn(first.root, 'balance');
      expect(headerCount(first.root, 'balance')).toBe(0);
    } finally {
      first.unmount();
    }

    expect(store[STORAGE_KEY]).toBeTruthy();

    const second = await renderPage();
    try {
      expect(headerCount(second.root, 'balance')).toBe(0);
      expect(headerCount(second.root, 'model')).toBe(1);
    } finally {
      second.unmount();
    }
  });

  it('falls back to defaults when the stored layout is malformed', async () => {
    for (const stored of ['not json at all', '{"hidden":"nope"}', 'null']) {
      store[STORAGE_KEY] = stored;
      const root = await renderPage();
      try {
        expect(headerCount(root.root, 'model')).toBe(1);
        expect(headerCount(root.root, 'reason')).toBe(1);
      } finally {
        root.unmount();
      }
    }
  });

  it('drops a stale column key instead of carrying it forward', async () => {
    // Rendering alone does not prove the sanitising: a build that KEEPS unknown keys
    // renders identically, since a hidden column that does not exist changes
    // nothing. Persistence is what makes it observable — whatever is written back
    // must no longer name a column this build does not have.
    store[STORAGE_KEY] = '{"hidden":["ghostColumn","balance"]}';
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-results-column-toggle'));
      await toggleColumn(root.root, 'prompt');

      const persisted = JSON.parse(store[STORAGE_KEY] as string) as { hidden: string[] };
      expect(persisted.hidden).not.toContain('ghostColumn');
      // ...while the legitimate key from the same stored value survives, so this
      // cannot pass by discarding the whole list.
      expect(persisted.hidden).toContain('balance');
    } finally {
      root.unmount();
    }
  });

  it('restores the default layout on demand', async () => {
    const root = await renderPage();
    try {
      await click(findByTestId(root.root, 'model-probe-results-column-toggle'));
      await toggleColumn(root.root, 'prompt');
      expect(headerCount(root.root, 'prompt')).toBe(1);

      await click(findByTestId(root.root, 'model-probe-results-column-reset'));

      expect(headerCount(root.root, 'prompt')).toBe(0);
      expect(headerCount(root.root, 'model')).toBe(1);
    } finally {
      root.unmount();
    }
  });

  it('keeps aria-sort on the sortable headers only', async () => {
    const root = await renderPage();
    try {
      // Regression guard for the registry rewrite: the sortable columns must keep
      // reporting sort state, and the rest must not start claiming it.
      expect(findByTestId(root.root, 'model-probe-results-header-checkedAt').props['aria-sort'])
        .toBe('descending');
      expect(findByTestId(root.root, 'model-probe-results-header-latency').props['aria-sort'])
        .toBe('none');
      expect(findByTestId(root.root, 'model-probe-results-header-model').props['aria-sort'])
        .toBeUndefined();
    } finally {
      root.unmount();
    }
  });

  it('exposes a resize handle that does not trigger sorting', async () => {
    const root = await renderPage();
    try {
      const handle = findByTestId(root.root, 'model-probe-results-resize-checkedAt');
      expect(typeof handle.props.onPointerDown).toBe('function');

      // The gesture must not also fire the header's sort toggle. Asserting that it
      // stops propagation is the testable half; the DRAG ITSELF needs real pointer
      // events on a real layout and is NOT covered by this suite.
      let propagationStopped = false;
      await act(async () => {
        handle.props.onPointerDown({
          clientX: 100,
          stopPropagation() { propagationStopped = true; },
        });
      });
      expect(propagationStopped).toBe(true);
      expect(lastResultsQuery().sortBy).toBe('checkedAt');
    } finally {
      root.unmount();
    }
  });
});

/**
 * 清空结果 — the operator-triggered wipe.
 *
 * There is no TTL and no background pruning, so without this the results table
 * grew forever. The delete is deliberately ALL results: the visible filters are
 * for viewing, and a filtered delete would let one misclick while a filter is
 * active destroy rows the operator believed untouched — which is why the confirm
 * copy names the blast radius instead of saying 当前筛选.
 */
describe('ModelProbe results clearing', () => {
  beforeEach(() => {
    isMobileMock.mockReturnValue(false);
    apiMock.clearModelProbeResults.mockResolvedValue({ success: true });
  });

  async function renderWithRows() {
    const root = await renderPage();
    // Positive control that rows exist before clearing: the button is disabled at
    // total===0, so an always-disabled button would fail the click below rather
    // than silently passing.
    expect(root.root.findAll((node) => (
      node.props['data-testid']?.toString().startsWith('model-probe-result-row-')
    )).length).toBeGreaterThan(0);
    return root;
  }

  it('clears after confirm and refreshes through the parent token', async () => {
    vi.stubGlobal('confirm', () => true);
    try {
      const root = await renderWithRows();
      try {
        const callsBefore = apiMock.getModelProbeResults.mock.calls.length;
        await click(findByTestId(root.root, 'model-probe-results-clear'));

        expect(apiMock.clearModelProbeResults).toHaveBeenCalledTimes(1);
        // The refresh must go through onResultsCleared → parent refreshToken, i.e.
        // a NEW fetch, not just local state mutation.
        expect(apiMock.getModelProbeResults.mock.calls.length).toBeGreaterThan(callsBefore);
      } finally {
        root.unmount();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not clear when the confirm is dismissed', async () => {
    vi.stubGlobal('confirm', () => false);
    try {
      const root = await renderWithRows();
      try {
        await click(findByTestId(root.root, 'model-probe-results-clear'));

        expect(apiMock.clearModelProbeResults).not.toHaveBeenCalled();
      } finally {
        root.unmount();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not refresh when the clear request fails', async () => {
    vi.stubGlobal('confirm', () => true);
    try {
      const root = await renderWithRows();
      try {
        apiMock.clearModelProbeResults.mockRejectedValue(new Error('db locked'));
        const callsBefore = apiMock.getModelProbeResults.mock.calls.length;
        await click(findByTestId(root.root, 'model-probe-results-clear'));

        // The rows the operator still sees must stay truthful: a failed wipe
        // must not trigger the reload that would look like "cleared".
        expect(apiMock.getModelProbeResults.mock.calls.length).toBe(callsBefore);
      } finally {
        root.unmount();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The per-key column and its filter.
 *
 * `keyItems` rides along with the results page rather than having its own endpoint,
 * and it is scoped to exactly the site×model pairs the page returned — so these
 * fixtures pair each key row with a `SUPPORTED_ROW`-shaped parent by (siteId,
 * modelName).
 */
describe('ModelProbe per-key results', () => {
  const PRIMARY_KEY_ROW = {
    id: 501,
    siteId: 4,
    accountId: 21,
    tokenId: 0,
    tokenName: '',
    isPrimary: true,
    modelName: 'gpt-4o',
    status: 'unsupported' as const,
    latencyMs: null,
    httpStatus: 404,
    failureKind: 'model_missing',
    reason: '无可用渠道',
    endpointUsed: null,
    checkedAt: '2026-08-21T02:30:00.000Z',
  };

  const BACKUP_KEY_ROW = {
    ...PRIMARY_KEY_ROW,
    id: 502,
    tokenId: 77,
    tokenName: 'group-b',
    isPrimary: false,
    status: 'supported' as const,
    latencyMs: 412,
    httpStatus: 200,
    failureKind: null,
    reason: null,
  };

  function withKeys(items: unknown[], keyItems: unknown[]) {
    return {
      ...resultsResponse(items),
      keyItems,
    };
  }

  it('names every key beside its own verdict, and labels the primary key', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(
      withKeys([SUPPORTED_ROW], [PRIMARY_KEY_ROW, BACKUP_KEY_ROW]),
    );
    const root = await renderPage();
    try {
      const primary = collectText(findByTestId(root.root, 'model-probe-key-result-501'));
      // The primary key stores an empty name — it lives on the account row — so the
      // panel must label it rather than render a blank cell.
      expect(primary).toContain('主 Key');
      expect(primary).toContain('不支持');

      const backup = collectText(findByTestId(root.root, 'model-probe-key-result-502'));
      expect(backup).toContain('group-b');
      expect(backup).toContain('可用');
      expect(backup).toContain('412');
    } finally {
      root.unmount();
    }
  });

  it('distinguishes a key that was never probed from one that reached nothing', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(withKeys([SUPPORTED_ROW], [
      PRIMARY_KEY_ROW,
      { ...BACKUP_KEY_ROW, id: 503, tokenId: 78, tokenName: 'switched-off', status: 'disabled', latencyMs: null },
      { ...BACKUP_KEY_ROW, id: 504, tokenId: 79, tokenName: 'masked', status: 'unavailable', latencyMs: null },
    ]));
    const root = await renderPage();
    try {
      // Both states are the point of Q21=B: without them a key that was switched
      // off is simply absent, which reads as 「这个 key 探不到任何模型」 — a claim no
      // probe ever tested.
      expect(collectText(findByTestId(root.root, 'model-probe-key-result-503'))).toContain('已停用');
      expect(collectText(findByTestId(root.root, 'model-probe-key-result-504'))).toContain('密钥不可用');
    } finally {
      root.unmount();
    }
  });

  it('falls back to the row id for an unnamed additional key', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(withKeys([SUPPORTED_ROW], [
      PRIMARY_KEY_ROW,
      { ...BACKUP_KEY_ROW, tokenName: '' },
    ]));
    const root = await renderPage();
    try {
      // Two nameless keys must stay tellable apart, so the id is shown rather than
      // an empty label.
      expect(collectText(findByTestId(root.root, 'model-probe-key-result-502'))).toContain('#77');
    } finally {
      root.unmount();
    }
  });

  it('shows the placeholder when the server sent no key breakdown at all', async () => {
    // An older server omits `keyItems` entirely. That must read as "no breakdown
    // available", never as "one key".
    apiMock.getModelProbeResults.mockResolvedValue(resultsResponse([SUPPORTED_ROW]));
    const root = await renderPage();
    try {
      const cell = collectText(findByTestId(root.root, 'model-probe-result-cell-keys-1'));
      expect(cell).toContain('—');
      expect(cell).not.toContain('主 Key');
    } finally {
      root.unmount();
    }
  });

  it('filters to rows only a backup key can serve, and counts them per page', async () => {
    const otherRow = { ...SUPPORTED_ROW, id: 3, modelName: 'gpt-5' };
    apiMock.getModelProbeResults.mockResolvedValue(withKeys([SUPPORTED_ROW, otherRow], [
      PRIMARY_KEY_ROW,
      BACKUP_KEY_ROW,
      // gpt-5: the primary key serves it, so it is NOT backup-only.
      { ...PRIMARY_KEY_ROW, id: 505, modelName: 'gpt-5', status: 'supported' },
      { ...BACKUP_KEY_ROW, id: 506, modelName: 'gpt-5', status: 'supported' },
    ]));
    const root = await renderPage();
    try {
      const box = findByTestId(root.root, 'model-probe-results-backup-only');
      // Labelled 本页, not a total: the comparison is over the returned page only.
      expect(collectText(box.parent!)).toContain('本页 1');

      await act(async () => {
        box.props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      const rows = root.root.findAll((node) => (
        node.props['data-testid']?.toString().startsWith('model-probe-result-row-')
      ));
      expect(rows).toHaveLength(1);
      expect(collectText(rows[0]!)).toContain('gpt-4o');
      // Filtered client-side, so it must not have refetched with a new query.
      expect(lastResultsQuery()).not.toHaveProperty('backupOnly');
    } finally {
      root.unmount();
    }
  });

  it('does not mark a row backup-only when there is no primary verdict to compare', async () => {
    apiMock.getModelProbeResults.mockResolvedValue(withKeys([SUPPORTED_ROW], [
      // Only an additional key reported. Calling this 「仅备用 Key 可用」 would claim
      // a comparison against the primary key that never happened.
      BACKUP_KEY_ROW,
    ]));
    const root = await renderPage();
    try {
      expect(collectText(findByTestId(root.root, 'model-probe-results-backup-only').parent!))
        .toContain('本页 0');
    } finally {
      root.unmount();
    }
  });
});
