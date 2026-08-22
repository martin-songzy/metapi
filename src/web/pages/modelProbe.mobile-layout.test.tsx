import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
    /**
     * The run and results panels mount with the rest of the page. Leaving them out
     * of this mock does not skip them — it makes them call `undefined`, so the
     * results panel lands in its error branch and renders zero mobile rows while
     * this file's "renders mobile cards" assertion still passes off the sites panel.
     * Every api method the page can reach has to be here.
     */
    getModelProbeResults: vi.fn(),
    getModelProbeTasks: vi.fn(),
    getModelProbeTask: vi.fn(),
    previewModelProbe: vi.fn(),
    runModelProbe: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const PANEL_DIR = 'src/web/pages/modelProbe';

/**
 * Derived from the filesystem, not hand-listed. A previous version of this file
 * enumerated the panels by hand and silently stopped covering the run and results
 * panels when they were added — the rules below only bind files someone remembered
 * to type. Reading the directory means a new panel is covered the moment it lands.
 */
const SOURCES = [
  'src/web/pages/ModelProbe.tsx',
  ...readdirSync(resolve(process.cwd(), PANEL_DIR))
    .filter((name) => /\.tsx?$/.test(name))
    .sort()
    .map((name) => `${PANEL_DIR}/${name}`),
];

describe('ModelProbe mobile architecture', () => {
  it('derives its file list from the panel directory so a new panel cannot be missed', () => {
    // Guards the derivation itself: a broken glob would leave every rule below
    // asserting over an empty list and passing for the wrong reason.
    expect(SOURCES.length).toBeGreaterThanOrEqual(5);
    for (const known of [
      'src/web/pages/ModelProbe.tsx',
      `${PANEL_DIR}/ModelProbeConfigPanel.tsx`,
      `${PANEL_DIR}/ModelProbeSitesPanel.tsx`,
      `${PANEL_DIR}/ModelProbeRunPanel.tsx`,
      `${PANEL_DIR}/ModelProbeResultsPanel.tsx`,
    ]) {
      expect(SOURCES, known).toContain(known);
    }
  });

  it('reuses the shared mobile primitives instead of hand-rolled breakpoints', () => {
    const shell = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelProbe.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const sitesPanel = readFileSync(
      resolve(process.cwd(), 'src/web/pages/modelProbe/ModelProbeSitesPanel.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(shell).toContain("import { useIsMobile } from '../components/useIsMobile.js'");
    expect(sitesPanel).toMatch(/import\s+ResponsiveFilterPanel\s+from\s+'\.\.\/\.\.\/components\/ResponsiveFilterPanel\.js'/);
    expect(sitesPanel).toMatch(/import\s+\{[^}]*MobileCard[^}]*\}\s+from\s+'\.\.\/\.\.\/components\/MobileCard\.js'/);

    for (const file of SOURCES) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
      expect(source, file).not.toContain('matchMedia');
      expect(source, file).not.toContain('window.innerWidth');
      expect(source, file).not.toContain('max-width:');
      expect(source, file).not.toContain('MobileFilterSheet');
    }
  });

  it('never imports another top-level page', () => {
    for (const file of SOURCES) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
      const pageImports = source
        .split('\n')
        .filter((line) => /from\s+'\.\.?\/[A-Z][^/']*\.js'/.test(line));
      expect(pageImports, file).toEqual([]);
    }
  });
});

describe('ModelProbe mobile rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProbeConfig.mockResolvedValue({
      success: true,
      config: {
        interestPatterns: ['gpt-4o'],
        prompts: ['hi'],
        userAgents: [
          { id: 'claude-code', label: 'Claude Code', value: 'claude-cli/2.1.63 (external, cli)' },
          { id: 'codex-cli', label: 'Codex CLI', value: 'codex_cli_rs/0.20.0' },
          { id: 'custom', label: '自定义 / 不发送', value: '' },
        ],
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
        maxInterestPatterns: 50,
        maxInterestPatternLength: 200,
        maxPrompts: 50,
        maxErrorKeywords: 50,
        confirmTargetThreshold: 50,
        maxRunTargets: 300,
      },
    });
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [
        {
          id: 4,
          name: '站点甲',
          url: 'https://a.example.com',
          platform: 'newapi',
          status: 'active',
          probeEndpointType: 'auto',
          probeUserAgent: '',
        },
      ],
    });
    apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
    apiMock.getModelProbeResults.mockResolvedValue({
      success: true,
      total: 1,
      query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
      items: [
        {
          id: 31,
          siteId: 4,
          siteName: '站点甲',
          accountId: 21,
          accountUsername: 'ops@example.com',
          balance: 12.5,
          modelName: 'gpt-4o',
          status: 'supported',
          latencyMs: 843,
          httpStatus: 200,
          failureKind: null,
          reason: null,
          endpointUsed: '/v1/chat/completions',
          promptUsed: 'hi',
          userAgentUsed: 'claude-cli/2.1.63',
          checkedAt: '2026-08-21T02:30:00.000Z',
        },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders site rows as mobile cards behind a filter sheet trigger, never a table', async () => {
    let root!: WebTestRenderer;
    try {
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

      expect(root.root.findAll((node) => node.type === 'table')).toHaveLength(0);
      expect(root.root.findAll((node) => (
        typeof node.props.className === 'string'
        && node.props.className.split(' ').includes('mobile-card')
      )).length).toBeGreaterThan(0);
      expect(collectText(root.root)).toContain('站点甲');
      expect(collectText(root.root)).toContain('筛选');
    } finally {
      root?.unmount();
    }
  });

  it('renders result rows as mobile cards, with the results panel out of its error branch', async () => {
    let root!: WebTestRenderer;
    try {
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

      // Without this the panel's error branch renders no rows at all, and the
      // sites panel's cards alone would satisfy a "has mobile cards" assertion.
      expect(root.root.findAll((node) => node.props?.['data-testid'] === 'model-probe-results-error')).toHaveLength(0);
      expect(root.root.findAll((node) => node.props?.['data-testid'] === 'model-probe-results-empty')).toHaveLength(0);
      expect(root.root.findAll((node) => node.props?.['data-testid'] === 'model-probe-result-row-31')).toHaveLength(1);
      expect(root.root.findAll((node) => node.props?.['data-testid'] === 'model-probe-results-table')).toHaveLength(0);
      expect(collectText(root.root)).toContain('gpt-4o');
      expect(apiMock.getModelProbeResults).toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
