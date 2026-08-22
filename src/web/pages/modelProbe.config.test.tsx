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
    // The run and results panels mount with the page; omitting these makes them
    // call `undefined` and sit in their error branches while this file's
    // assertions still pass off the config panel.
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
    concurrency: 3,
    timeoutMs: 15_000,
    syncToRouting: false,
    ...overrides,
  };
}

/**
 * Every value here differs from the production default, so hard-coding any one
 * of them in the panel fails a test. The earlier fixture reused production
 * values for six of the ten, which let `clampDraftInteger`'s bounds and the
 * prompt / keyword / concurrency / timeout hints be hard-coded silently.
 */
const PRODUCTION_LIMITS = {
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
};

function buildLimits(overrides: Record<string, unknown> = {}) {
  return {
    minConcurrency: 2,
    maxConcurrency: 6,
    minTimeoutMs: 4_000,
    maxTimeoutMs: 41_000,
    maxInterestPatterns: 3,
    maxInterestPatternLength: 40,
    maxPrompts: 9,
    maxErrorKeywords: 13,
    confirmTargetThreshold: 11,
    maxRunTargets: 123,
    ...overrides,
  };
}

it('uses a fixture that shares no value with the production limits', () => {
  const fixture = buildLimits() as Record<string, number>;
  for (const [key, production] of Object.entries(PRODUCTION_LIMITS)) {
    expect(fixture[key], key).not.toBe(production);
  }
  expect(Object.keys(fixture).sort()).toEqual(Object.keys(PRODUCTION_LIMITS).sort());
});

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
    apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
    apiMock.getModelProbeResults.mockResolvedValue({
      success: true,
      items: [],
      total: 0,
      query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
    });
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
        concurrency: 3,
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

  async function saveWith(root: ReactTestInstance, testId: string, value: string) {
    const input = findByTestId(root, testId);
    await act(async () => {
      input.props.onChange({ target: { value } });
    });
    await act(async () => {
      findSaveConfigButton(root).props.onClick();
    });
    await flushMicrotasks();
    const calls = apiMock.saveModelProbeConfig.mock.calls;
    return calls[calls.length - 1][0] as Record<string, number>;
  }

  it('clamps concurrency to the server-reported bounds, not to hard-coded ones', async () => {
    const root = await renderPage();
    try {
      // Hard-coding 1..8 would clamp these to 8 and 1 instead, saving a value
      // the operator never chose and never saw.
      expect((await saveWith(root.root, 'model-probe-concurrency', '9')).concurrency).toBe(6);
      expect((await saveWith(root.root, 'model-probe-concurrency', '1')).concurrency).toBe(2);
      // Blank falls back to the reported minimum, matching the server's floor.
      expect((await saveWith(root.root, 'model-probe-concurrency', '')).concurrency).toBe(2);
    } finally {
      root.unmount();
    }
  });

  it('clamps the timeout to the server-reported bounds, not to hard-coded ones', async () => {
    const root = await renderPage();
    try {
      expect((await saveWith(root.root, 'model-probe-timeout', '999999')).timeoutMs).toBe(41_000);
      expect((await saveWith(root.root, 'model-probe-timeout', '100')).timeoutMs).toBe(4_000);
    } finally {
      root.unmount();
    }
  });

  it('flags patterns beyond the server-reported count cap', async () => {
    const root = await renderPage();
    try {
      const textarea = findByTestId(root.root, 'model-probe-interest-patterns');
      await act(async () => {
        textarea.props.onChange({ target: { value: 'one\ntwo\nthree\nfour' } });
      });

      const issues = collectText(findByTestId(root.root, 'model-probe-pattern-issues'));
      expect(issues).toContain('four');
      expect(issues).toContain('3');
      expect(issues).not.toContain('50');
      // The first three are within the cap and must not be flagged.
      expect(issues).not.toContain('one');

      await act(async () => {
        findSaveConfigButton(root.root).props.onClick();
      });
      await flushMicrotasks();
      expect(apiMock.saveModelProbeConfig).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  });

  it('shows the prompt, keyword, concurrency and timeout caps the server reported', async () => {
    const root = await renderPage();
    try {
      const panel = collectText(findByTestId(root.root, 'model-probe-config-panel'));
      for (const shown of ['9', '13', '2', '6', '4000', '41000']) {
        expect(panel, shown).toContain(shown);
      }
      // The production values must appear nowhere on the panel.
      for (const hardCoded of ['3000', '60000']) {
        expect(panel, hardCoded).not.toContain(hardCoded);
      }
    } finally {
      root.unmount();
    }
  });

  it('marks the pattern field invalid for assistive technology, not only in prose', async () => {
    const root = await renderPage();
    try {
      const textarea = findByTestId(root.root, 'model-probe-interest-patterns');
      expect(textarea.props['aria-invalid']).toBe(false);

      await act(async () => {
        textarea.props.onChange({ target: { value: '(unclosed' } });
      });

      // Removing this left 15/15 green while a screen-reader user lost the
      // field-level invalid signal entirely.
      const marked = findByTestId(root.root, 'model-probe-interest-patterns');
      expect(marked.props['aria-invalid']).toBe(true);
      expect(marked.props.style?.borderColor).toBe('var(--color-danger)');
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

describe('ModelProbe disabled site visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProbeConfig.mockResolvedValue({
      success: true,
      config: buildConfig(),
      limits: buildLimits(),
    });
    apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
    apiMock.getModelProbeResults.mockResolvedValue({
      success: true,
      items: [],
      total: 0,
      query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks a non-active site as one the sweep will skip', async () => {
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [SITES[0], { ...SITES[1], status: 'disabled' }],
    });
    const root = await renderPage();
    try {
      // `modelProbeRunService` skips any site whose status is not 'active'. Fetching
      // that status and never showing it lets an operator tune settings for a site
      // that will never be probed.
      const badge = findByTestId(root.root, 'model-probe-site-inactive-9');
      expect(collectText(badge)).toContain('已停用');
      expect(collectText(badge)).toContain('跳过');
      expect(root.root.findAll((node) => node.props['data-testid'] === 'model-probe-site-inactive-4')).toHaveLength(0);
    } finally {
      root.unmount();
    }
  });

  it('treats a missing status as active rather than as disabled', async () => {
    const { status: _status, ...withoutStatus } = SITES[1] as Record<string, unknown>;
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [SITES[0], withoutStatus],
    });
    const root = await renderPage();
    try {
      // Matches the server's own `(row.status || 'active')` default; warning here
      // would train the operator to ignore the badge.
      expect(root.root.findAll((node) => (
        typeof node.props['data-testid'] === 'string'
        && node.props['data-testid'].startsWith('model-probe-site-inactive-')
      ))).toHaveLength(0);
    } finally {
      root.unmount();
    }
  });

  it('still lets a disabled site be configured, so it is ready when re-enabled', async () => {
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [{ ...SITES[1], status: 'disabled' }],
    });
    apiMock.saveModelProbeSiteConfig.mockResolvedValue({
      success: true,
      site: { ...SITES[1], status: 'disabled' },
    });
    const root = await renderPage();
    try {
      const findSave = () => root.root.find((node) => (
        node.type === 'button'
        && node.props['data-testid'] === 'model-probe-site-save-9'
      ));
      // Pristine drafts are disabled for every site, active or not — that is the
      // panel's normal behaviour, not a consequence of the status.
      expect(findSave().props.disabled).toBe(true);

      const input = findByTestId(root.root, 'model-probe-site-user-agent-custom-9');
      await act(async () => {
        input.props.onChange({ target: { value: 'changed-agent/2.0' } });
      });
      await flushMicrotasks();

      // A disabled site is still configurable, so its settings are ready the
      // moment someone re-enables it in 站点管理.
      expect(findSave().props.disabled).toBe(false);
      await act(async () => {
        findSave().props.onClick();
      });
      await flushMicrotasks();
      expect(apiMock.saveModelProbeSiteConfig).toHaveBeenCalledWith(9, expect.objectContaining({
        probeUserAgent: 'changed-agent/2.0',
      }));
    } finally {
      root.unmount();
    }
  });
});

describe('ModelProbe refresh failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProbeConfig.mockResolvedValue({
      success: true,
      config: buildConfig(),
      limits: buildLimits(),
    });
    apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
    apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
    apiMock.getModelProbeResults.mockResolvedValue({
      success: true,
      items: [],
      total: 0,
      query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function findRefreshButton(root: ReactTestInstance): ReactTestInstance {
    return root.find((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).trim() === '刷新'
    ));
  }

  it('keeps the last good page when a background refresh fails', async () => {
    const root = await renderPage();
    try {
      // Sanity: the good view is on screen before the failing refresh.
      expect(collectText(root.root)).toContain('站点甲');

      apiMock.getModelProbeSites.mockRejectedValueOnce(new Error('网络错误'));
      await act(async () => {
        findRefreshButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      // Blanking the page here would discard an unsaved scope selection and hide
      // results from a sweep the operator already paid for.
      expect(collectText(root.root)).toContain('站点甲');
      expect(root.root.findAll((node) => node.props['data-testid'] === 'model-probe-refresh-error')).toHaveLength(1);
      expect(collectText(findByTestId(root.root, 'model-probe-refresh-error'))).toContain('网络错误');
    } finally {
      root.unmount();
    }
  });

  it('clears the refresh notice once a later refresh succeeds', async () => {
    const root = await renderPage();
    try {
      apiMock.getModelProbeSites.mockRejectedValueOnce(new Error('网络错误'));
      await act(async () => {
        findRefreshButton(root.root).props.onClick();
      });
      await flushMicrotasks();
      expect(root.root.findAll((node) => node.props['data-testid'] === 'model-probe-refresh-error')).toHaveLength(1);

      await act(async () => {
        findRefreshButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      expect(root.root.findAll((node) => node.props['data-testid'] === 'model-probe-refresh-error')).toHaveLength(0);
    } finally {
      root.unmount();
    }
  });

  it('still blanks the page when the first load fails, since there is no good view to keep', async () => {
    apiMock.getModelProbeConfig.mockRejectedValueOnce(new Error('首次加载失败'));
    const root = await renderPage();
    try {
      const text = collectText(root.root);
      expect(text).toContain('首次加载失败');
      expect(text).not.toContain('站点甲');
      expect(root.root.findAll((node) => node.props['data-testid'] === 'model-probe-refresh-error')).toHaveLength(0);
    } finally {
      root.unmount();
    }
  });
});
