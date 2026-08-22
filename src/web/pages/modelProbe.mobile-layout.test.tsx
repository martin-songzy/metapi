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

const SOURCES = [
  'src/web/pages/ModelProbe.tsx',
  'src/web/pages/modelProbe/ModelProbeConfigPanel.tsx',
  'src/web/pages/modelProbe/ModelProbeSitesPanel.tsx',
  'src/web/pages/modelProbe/modelProbeTypes.ts',
];

describe('ModelProbe mobile architecture', () => {
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
});
