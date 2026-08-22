import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { MODEL_PROBE_ENDPOINT_TYPES } from '../../shared/modelProbeEndpointTypes.js';
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

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    interestPatterns: [],
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
    ...overrides,
  };
}

// Deliberately not the production values (50 / 300): the page must render whatever
// the server reports instead of a hard-coded copy.
function buildLimits(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
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
    probeUserAgent: 'my-own-agent/1.0',
  },
];

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

function findByTestId(root: ReactTestInstance, testId: string): ReactTestInstance {
  return root.find((node) => node.props['data-testid'] === testId);
}

function selectOptionLabels(select: ReactTestInstance): string[] {
  return select
    .findAll((node) => node.props.className === 'modern-select-option-label')
    .map((label) => collectText(label).trim());
}

function findSaveConfigButton(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === '保存全局配置'
  ));
}

describe('ModelProbe navigation wiring', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('lazy-loads the page and routes /model-probe to it', () => {
    expect(appSource).toContain("const ModelProbe = lazy(() => import('./pages/ModelProbe.js'));");
    expect(appSource).toContain('<Route path="/model-probe" element={<ModelProbe />} />');
  });

  it('adds a sidebar entry right after 站点管理', () => {
    const sidebarEntry = "{ to: '/model-probe', label: '模型可用性'";
    expect(appSource).toContain(sidebarEntry);
    expect(appSource.indexOf("{ to: '/sites', label: '站点管理'")).toBeLessThan(appSource.indexOf(sidebarEntry));
  });
});

describe('ModelProbe global configuration panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProbeConfig.mockResolvedValue({
      success: true,
      config: buildConfig(),
      limits: buildLimits(),
    });
    apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
    apiMock.saveModelProbeConfig.mockImplementation(async (payload: Record<string, unknown>) => ({
      success: true,
      config: buildConfig(payload),
      limits: buildLimits(),
    }));
    apiMock.saveModelProbeSiteConfig.mockImplementation(async (siteId: number, patch: Record<string, unknown>) => ({
      success: true,
      site: { ...SITES.find((site) => site.id === siteId), ...patch },
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('warns that an empty pattern list probes nothing', async () => {
    const root = await renderPage();
    try {
      expect(collectText(root.root)).toContain('未配置匹配规则，不会探测任何模型');
    } finally {
      root.unmount();
    }
  });

  it('drops the empty-pattern warning once a pattern is typed', async () => {
    const root = await renderPage();
    try {
      const textarea = findByTestId(root.root, 'model-probe-interest-patterns');
      await act(async () => {
        textarea.props.onChange({ target: { value: 'gpt-4o' } });
      });

      expect(collectText(root.root)).not.toContain('未配置匹配规则，不会探测任何模型');
    } finally {
      root.unmount();
    }
  });

  it('marks each invalid pattern and refuses to save', async () => {
    const root = await renderPage();
    try {
      const textarea = findByTestId(root.root, 'model-probe-interest-patterns');
      await act(async () => {
        textarea.props.onChange({ target: { value: 'gpt-4o\n(unclosed\n[bad' } });
      });

      const issues = findByTestId(root.root, 'model-probe-pattern-issues');
      const issueText = collectText(issues);
      expect(issueText).toContain('(unclosed');
      expect(issueText).toContain('[bad');
      expect(issueText).not.toContain('gpt-4o');

      await act(async () => {
        findSaveConfigButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeConfig).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  });

  it('flags a pattern longer than the server-reported cap', async () => {
    const root = await renderPage();
    try {
      const tooLong = 'a'.repeat(41);
      const textarea = findByTestId(root.root, 'model-probe-interest-patterns');
      await act(async () => {
        textarea.props.onChange({ target: { value: tooLong } });
      });

      expect(collectText(findByTestId(root.root, 'model-probe-pattern-issues'))).toContain('40');

      await act(async () => {
        findSaveConfigButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeConfig).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  });

  it('sends the whole config on save because the server replaces it wholesale', async () => {
    const root = await renderPage();
    try {
      const textarea = findByTestId(root.root, 'model-probe-interest-patterns');
      await act(async () => {
        textarea.props.onChange({ target: { value: 'gpt-4o\n  \nclaude-.*-sonnet' } });
      });

      await act(async () => {
        findSaveConfigButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeConfig).toHaveBeenCalledTimes(1);
      expect(apiMock.saveModelProbeConfig).toHaveBeenCalledWith({
        interestPatterns: ['gpt-4o', 'claude-.*-sonnet'],
        prompts: ['hi'],
        userAgents: buildConfig().userAgents,
        defaultUserAgentId: 'claude-code',
        errorKeywords: ['no available channel'],
        concurrency: 1,
        timeoutMs: 15_000,
        syncToRouting: false,
      });
    } finally {
      root.unmount();
    }
  });

  it('reads the confirmation threshold and run cap from the server, never a local constant', async () => {
    const root = await renderPage();
    try {
      const limitsText = collectText(findByTestId(root.root, 'model-probe-run-limits'));
      expect(limitsText).toContain('11');
      expect(limitsText).toContain('123');

      const pageSource = readFileSync(
        resolve(process.cwd(), 'src/web/pages/modelProbe/ModelProbeConfigPanel.tsx'),
        'utf8',
      );
      expect(pageSource).not.toMatch(/confirmTargetThreshold\s*[:=]\s*\d/);
      expect(pageSource).not.toMatch(/maxRunTargets\s*[:=]\s*\d/);
    } finally {
      root.unmount();
    }
  });

  it('offers the default User-Agent presets the server sent', async () => {
    const root = await renderPage();
    try {
      const labels = selectOptionLabels(findByTestId(root.root, 'model-probe-default-user-agent'));
      expect(labels).toEqual(['Claude Code', 'Codex CLI', '自定义 / 不发送']);
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe per-site configuration panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProbeConfig.mockResolvedValue({
      success: true,
      config: buildConfig(),
      limits: buildLimits(),
    });
    apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
    apiMock.saveModelProbeSiteConfig.mockImplementation(async (siteId: number, patch: Record<string, unknown>) => ({
      success: true,
      site: { ...SITES.find((site) => site.id === siteId), ...patch },
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers exactly the four shared endpoint choices', async () => {
    const root = await renderPage();
    try {
      const labels = selectOptionLabels(findByTestId(root.root, 'model-probe-site-endpoint-4'));
      expect(labels).toEqual(['自动', 'chat', 'messages', 'responses']);
      expect(labels).toHaveLength(MODEL_PROBE_ENDPOINT_TYPES.length);
    } finally {
      root.unmount();
    }
  });

  it('imports the endpoint tuple from the shared module instead of mirroring it', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/web/pages/modelProbe/modelProbeTypes.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(source).toContain("from '../../../shared/modelProbeEndpointTypes.js'");
    expect(source).not.toMatch(/\[\s*'auto'\s*,\s*'chat'/);
  });

  it('offers inherit / Claude Code / Codex CLI / custom for the per-site User-Agent', async () => {
    const root = await renderPage();
    try {
      const labels = selectOptionLabels(findByTestId(root.root, 'model-probe-site-user-agent-4'));
      expect(labels).toEqual(['继承全局', 'Claude Code', 'Codex CLI', '自定义']);
    } finally {
      root.unmount();
    }
  });

  it('saves a preset User-Agent as its literal value together with the endpoint', async () => {
    const root = await renderPage();
    try {
      const endpointSelect = findByTestId(root.root, 'model-probe-site-endpoint-4');
      const messagesOption = endpointSelect.find((node) => (
        node.type === 'button'
        && collectText(node).trim() === 'messages'
      ));
      await act(async () => {
        messagesOption.props.onClick();
      });

      const uaSelect = findByTestId(root.root, 'model-probe-site-user-agent-4');
      const codexOption = uaSelect.find((node) => (
        node.type === 'button'
        && collectText(node).trim() === 'Codex CLI'
      ));
      await act(async () => {
        codexOption.props.onClick();
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-testid'] === 'model-probe-site-save-4'
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeSiteConfig).toHaveBeenCalledWith(4, {
        probeEndpointType: 'messages',
        probeUserAgent: 'codex_cli_rs/0.20.0',
      });
    } finally {
      root.unmount();
    }
  });

  it('treats a stored value that matches no preset as a custom entry and keeps it editable', async () => {
    const root = await renderPage();
    try {
      const uaSelect = findByTestId(root.root, 'model-probe-site-user-agent-9');
      const trigger = uaSelect.find((node) => (
        node.type === 'button'
        && node.props.className === 'modern-select-trigger'
      ));
      expect(collectText(trigger)).toContain('自定义');

      const customInput = findByTestId(root.root, 'model-probe-site-user-agent-custom-9');
      expect(customInput.props.value).toBe('my-own-agent/1.0');

      await act(async () => {
        customInput.props.onChange({ target: { value: 'edited-agent/2.0' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-testid'] === 'model-probe-site-save-9'
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeSiteConfig).toHaveBeenCalledWith(9, {
        probeEndpointType: 'chat',
        probeUserAgent: 'edited-agent/2.0',
      });
    } finally {
      root.unmount();
    }
  });

  it('says a blank custom User-Agent inherits the global preset, not that it sends none', async () => {
    const root = await renderPage();
    try {
      const customInput = findByTestId(root.root, 'model-probe-site-user-agent-custom-9');

      // The server treats a blank per-site override as "use the global default
      // preset" (`resolveModelProbeUserAgent`). Telling the operator it means
      // "send no User-Agent" is the inverse, and it is the exact setting they
      // reach for when a site rejects the global UA.
      expect(String(customInput.props.placeholder)).not.toContain('不发送');
      expect(String(customInput.props.placeholder)).toContain('继承');

      const panelText = collectText(findByTestId(root.root, 'model-probe-sites-panel'));
      expect(panelText).toContain('继承全局');
      // The one way to send no UA at all has to be discoverable.
      expect(panelText).toContain('自定义 / 不发送');
    } finally {
      root.unmount();
    }
  });

  it('warns in place that clearing the custom field will fall back to 继承全局', async () => {
    const root = await renderPage();
    try {
      const customInput = findByTestId(root.root, 'model-probe-site-user-agent-custom-9');
      await act(async () => {
        customInput.props.onChange({ target: { value: '   ' } });
      });

      // Without this, the select silently flipping back to 继承全局 after saving
      // reads as the panel having discarded the operator's choice.
      const notice = collectText(findByTestId(root.root, 'model-probe-site-user-agent-blank-9'));
      expect(notice).toContain('继承全局');
    } finally {
      root.unmount();
    }
  });

  it('saves an inherited User-Agent as an empty string', async () => {
    const root = await renderPage();
    try {
      const uaSelect = findByTestId(root.root, 'model-probe-site-user-agent-9');
      const inheritOption = uaSelect.find((node) => (
        node.type === 'button'
        && collectText(node).trim() === '继承全局'
      ));
      await act(async () => {
        inheritOption.props.onClick();
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-testid'] === 'model-probe-site-save-9'
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeSiteConfig).toHaveBeenCalledWith(9, {
        probeEndpointType: 'chat',
        probeUserAgent: '',
      });
    } finally {
      root.unmount();
    }
  });
});
