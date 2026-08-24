import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { MODEL_PROBE_ENDPOINT_TYPES } from '../../shared/modelProbeEndpointTypes.js';
import {
  MODEL_PROBE_CUSTOM_UA_PRESET_ID,
  MODEL_PROBE_UA_SITE_CUSTOM,
  modelProbeUserAgentPresetChoice,
  siteUserAgentOptions,
} from './modelProbe/modelProbeTypes.js';
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
    siteConcurrency: 3,
    modelConcurrency: 2,
    timeoutMs: 15_000,
    maxTokens: 77,
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
  minSiteConcurrency: 1,
  maxSiteConcurrency: 10,
  minModelConcurrency: 1,
  maxModelConcurrency: 8,
  minTimeoutMs: 3_000,
  maxTimeoutMs: 60_000,
  minMaxTokens: 1,
  maxMaxTokens: 4_096,
  maxInterestPatterns: 50,
  maxInterestPatternLength: 200,
  maxPrompts: 50,
  maxErrorKeywords: 50,
  confirmTargetThreshold: 50,
  maxRunTargets: 300,
};

function buildLimits(overrides: Record<string, unknown> = {}) {
  return {
    minSiteConcurrency: 2,
    maxSiteConcurrency: 7,
    minModelConcurrency: 2,
    maxModelConcurrency: 6,
    minTimeoutMs: 4_000,
    maxTimeoutMs: 41_000,
    minMaxTokens: 2,
    maxMaxTokens: 999,
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

/**
 * Matches on the option's label element rather than the button's whole text: the
 * global User-Agent select also renders a description under each label, so a
 * whole-button equality check finds nothing there.
 */
function findSelectOption(select: ReactTestInstance, label: string): ReactTestInstance {
  return select.find((node) => (
    node.props.className?.startsWith?.('modern-select-option')
    && node.type === 'button'
    && node.findAll((child) => (
      child.props.className === 'modern-select-option-label'
      && collectText(child).trim() === label
    )).length === 1
  ));
}

/**
 * Selects a site in the desktop per-site panel.
 *
 * Needed because that panel shows ONE site at a time now — the operator asked for
 * the dropdown because listing every site ate the whole viewport. The selection
 * defaults to the first site, so only assertions about a non-first site need this.
 */
async function selectSite(root: ReactTestInstance, siteName: string) {
  const selector = findByTestId(root, 'model-probe-site-selector');
  const trigger = selector.find((node) => (
    node.type === 'button' && node.props.className === 'modern-select-trigger'
  ));
  await act(async () => {
    trigger.props.onClick({ stopPropagation() {}, preventDefault() {} });
  });
  await flushMicrotasks();

  const option = findByTestId(root, 'model-probe-site-selector').find((node) => (
    node.props.className?.startsWith?.('modern-select-option')
    && node.type === 'button'
    // Prefix match, not equality: a site with saved overrides carries a 「● 已自定义」
    // marker in its label, so an exact match would only ever find pristine sites.
    && node.findAll((child) => (
      child.props.className === 'modern-select-option-label'
      && collectText(child).trim().startsWith(siteName)
    )).length === 1
  ));
  await act(async () => {
    option.props.onClick({ stopPropagation() {}, preventDefault() {} });
  });
  await flushMicrotasks();
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
        siteConcurrency: 3,
        modelConcurrency: 2,
        timeoutMs: 15_000,
        maxTokens: 77,
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

  it('clamps both concurrency axes to the server-reported bounds, not hard-coded ones', async () => {
    const root = await renderPage();
    try {
      // Hard-coding the production bounds (1..10 sites, 1..8 models) would clamp
      // these differently — the fixture deliberately reports 2..7 / 2..6.
      expect((await saveWith(root.root, 'model-probe-site-concurrency', '99')).siteConcurrency).toBe(7);
      expect((await saveWith(root.root, 'model-probe-site-concurrency', '0')).siteConcurrency).toBe(2);
      expect((await saveWith(root.root, 'model-probe-model-concurrency', '99')).modelConcurrency).toBe(6);
      expect((await saveWith(root.root, 'model-probe-model-concurrency', '1')).modelConcurrency).toBe(2);
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

  /**
   * A cleared field is the absence of a value, not a request for the lowest legal
   * one. The earlier assertion here expected the reported MINIMUM and called that
   * "the server's floor"; the server's `clampInteger` returns the DEFAULT for a
   * blank input, and for `timeoutMs` that is 15000 against a 3000 minimum. So
   * clearing the timeout used to install a 3s probe timeout — short enough to
   * time out slow-but-working models and report them as unavailable.
   *
   * The fixture's saved config (site 3 / model 2, timeoutMs 15000) shares no value
   * with the fixture's bounds (2..7 / 2..6, 4000..41000), so falling back to either
   * bound, or to a hard-coded default, fails these.
   */
  it('keeps the saved value when a numeric field is cleared, rather than dropping to the minimum', async () => {
    const root = await renderPage();
    try {
      expect((await saveWith(root.root, 'model-probe-site-concurrency', '')).siteConcurrency).toBe(3);
      expect((await saveWith(root.root, 'model-probe-model-concurrency', '')).modelConcurrency).toBe(2);

      const timeout = (await saveWith(root.root, 'model-probe-timeout', '')).timeoutMs;
      expect(timeout).toBe(15_000);
      // Named explicitly: this is the value the old fallback produced, and it is
      // the one that manufactures false timeouts.
      expect(timeout).not.toBe(4_000);
      expect(timeout).not.toBe(3_000);
    } finally {
      root.unmount();
    }
  });

  it('keeps the saved value for a non-numeric field too', async () => {
    const root = await renderPage();
    try {
      expect((await saveWith(root.root, 'model-probe-timeout', 'abc')).timeoutMs).toBe(15_000);
      expect((await saveWith(root.root, 'model-probe-model-concurrency', '   ')).modelConcurrency).toBe(2);
    } finally {
      root.unmount();
    }
  });

  /**
   * `syncUnsupportedToRouting` (`src/server/services/modelProbeRunService.ts`)
   * flips `available` on existing `model_availability` rows and rebuilds routes.
   * Its docblock states it deliberately does NOT insert `site_disabled_models`,
   * because that table is keyed by SITE rather than by account and never
   * auto-clears. Copy that threatens the more destructive effect is wrong in the
   * direction that deters an operator from a setting safer than advertised —
   * the mirror image of the per-site UA placeholder fixed in 6cdddd3.
   */
  it('describes what syncing to routing actually writes, not 站点禁用模型', async () => {
    const root = await renderPage();
    try {
      const hint = collectText(findByTestId(root.root, 'model-probe-sync-to-routing-hint'));

      expect(hint).not.toContain('站点禁用模型');
      // Paired positives, so the assertion above cannot pass by rendering an
      // empty hint: the real effect and its second gate both have to be stated.
      expect(hint).toContain('不可用');
      expect(hint).toContain('路由');
      expect(hint).toContain('PROXY_ROUTING_ENABLED');
    } finally {
      root.unmount();
    }
  });

  it('lets the global 自定义 User-Agent carry a value instead of only meaning "send nothing"', async () => {
    const root = await renderPage();
    try {
      // Absent while a built-in preset is selected: those version strings are
      // maintained in the server source and must not be editable here.
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-default-user-agent-custom'
      ))).toHaveLength(0);

      const select = findByTestId(root.root, 'model-probe-default-user-agent');
      await act(async () => {
        findSelectOption(select, '自定义 / 不发送').props.onClick();
      });

      const input = findByTestId(root.root, 'model-probe-default-user-agent-custom');
      expect(input.props.value).toBe('');
      await act(async () => {
        input.props.onChange({ target: { value: 'probe-agent/9.9' } });
      });

      await act(async () => {
        findSaveConfigButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      const payload = apiMock.saveModelProbeConfig.mock.calls.at(-1)?.[0] as Record<string, any>;
      expect(payload.defaultUserAgentId).toBe('custom');
      expect(payload.userAgents).toEqual([
        { id: 'claude-code', label: 'Claude Code', value: 'claude-cli/2.1.63 (external, cli)' },
        { id: 'codex-cli', label: 'Codex CLI', value: 'codex_cli_rs/0.20.0' },
        { id: 'custom', label: '自定义 / 不发送', value: 'probe-agent/9.9' },
      ]);
    } finally {
      root.unmount();
    }
  });

  it('still lets the global 自定义 preset mean "send no User-Agent" when left blank', async () => {
    const root = await renderPage();
    try {
      const select = findByTestId(root.root, 'model-probe-default-user-agent');
      await act(async () => {
        findSelectOption(select, '自定义 / 不发送').props.onClick();
      });

      // The one way to send no UA at all must stay reachable, and the panel has
      // to say which of the two a blank field means.
      const panel = collectText(findByTestId(root.root, 'model-probe-config-panel'));
      expect(panel).toContain('不会带 User-Agent');

      await act(async () => {
        findSaveConfigButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      const payload = apiMock.saveModelProbeConfig.mock.calls.at(-1)?.[0] as Record<string, any>;
      expect(payload.userAgents.find((preset: any) => preset.id === 'custom').value).toBe('');
    } finally {
      root.unmount();
    }
  });

  it('mirrors the server preset id rather than inventing its own', () => {
    const serverSource = readFileSync(
      resolve(process.cwd(), 'src/server/services/modelProbeConfigService.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const webSource = readFileSync(
      resolve(process.cwd(), 'src/web/pages/modelProbe/modelProbeTypes.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    // Web code may not import from src/server, so the shared literal is pinned
    // from both ends. If the server renames the preset, the custom UA field would
    // otherwise silently stop appearing.
    expect(serverSource).toContain("{ id: 'custom', label: '自定义 / 不发送', value: '' }");
    expect(webSource).toContain("export const MODEL_PROBE_CUSTOM_UA_PRESET_ID = 'custom';");
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
      await selectSite(root.root, '站点乙');
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
      await selectSite(root.root, '站点乙');
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
      await selectSite(root.root, '站点乙');
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
      await selectSite(root.root, '站点乙');
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

/**
 * The state the global custom-UA field exists to create, and the one no test
 * covered: the `custom` preset carrying a VALUE.
 *
 * Its blank shipped value was the only thing keeping it out of the per-site
 * select (`selectableUserAgentPresets` drops blank-valued presets), and that
 * accident was the only thing keeping the preset id from colliding with the
 * per-site UI sentinel. Every assertion here is about that collision.
 */
describe('ModelProbe per-site User-Agent with a non-blank global custom preset', () => {
  const GLOBAL_CUSTOM_UA = 'operator-agent/9.9';
  const BUILT_IN_LABELS = ['继承全局', 'Claude Code', 'Codex CLI', '自定义'];

  function configWithCustomValue() {
    return buildConfig({
      userAgents: [
        { id: 'claude-code', label: 'Claude Code', value: 'claude-cli/2.1.63 (external, cli)' },
        { id: 'codex-cli', label: 'Codex CLI', value: 'codex_cli_rs/0.20.0' },
        { id: 'custom', label: '自定义 / 不发送', value: GLOBAL_CUSTOM_UA },
      ],
    });
  }

  /**
   * Found by exclusion rather than by its exact wording: the point of the test is
   * that selecting the global custom preset sends the global custom VALUE, and
   * pinning the label here would make the test fail for a wording change instead.
   */
  function findGlobalCustomPresetOption(select: ReactTestInstance): ReactTestInstance {
    const option = select.findAll((node) => (
      node.type === 'button'
      && node.props.className?.startsWith?.('modern-select-option')
      && !BUILT_IN_LABELS.includes(
        collectText(node.find((child) => child.props.className === 'modern-select-option-label')).trim(),
      )
    ));
    expect(option, 'exactly one option beyond the four built-ins').toHaveLength(1);
    return option[0]!;
  }

  function findSiteSave(root: ReactTestInstance, siteId: number): ReactTestInstance {
    return root.find((node) => (
      node.type === 'button'
      && node.props['data-testid'] === `model-probe-site-save-${siteId}`
    ));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProbeConfig.mockResolvedValue({
      success: true,
      config: configWithCustomValue(),
      limits: buildLimits(),
    });
    apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
    apiMock.getModelProbeResults.mockResolvedValue({
      success: true,
      items: [],
      total: 0,
      query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
    });
    apiMock.saveModelProbeSiteConfig.mockImplementation(async (siteId: number, patch: Record<string, unknown>) => ({
      success: true,
      site: { ...SITES.find((site) => site.id === siteId), ...patch },
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('gives every per-site option a distinct value, so no two mean different things', () => {
    const options = siteUserAgentOptions(configWithCustomValue().userAgents);

    // Five now: inherit, two built-in presets, the newly non-blank custom preset,
    // and the per-site custom sentinel.
    expect(options).toHaveLength(5);
    const values = options.map((option) => option.value);
    expect(new Set(values).size, `duplicate option values: ${values.join(', ')}`).toBe(values.length);
    // Paired positive control: the uniqueness assertion must not be passing
    // because an option was dropped. Both the global custom PRESET and the
    // per-site custom SENTINEL have to be present.
    expect(values).toContain(MODEL_PROBE_UA_SITE_CUSTOM);
    expect(values).toContain(modelProbeUserAgentPresetChoice(MODEL_PROBE_CUSTOM_UA_PRESET_ID));

    // Distinct VALUES are not enough on their own: the operator picks by label,
    // and the preset ships labelled 自定义 / 不发送, which sits next to the
    // per-site 自定义 sentinel and is false here anyway — a site can only inherit
    // or send something, never suppress the header.
    const labels = options.map((option) => option.label);
    expect(new Set(labels).size, `duplicate option labels: ${labels.join(', ')}`).toBe(labels.length);
    const globalCustom = options.find((option) => (
      option.value === modelProbeUserAgentPresetChoice(MODEL_PROBE_CUSTOM_UA_PRESET_ID)
    ))!;
    expect(globalCustom.label).not.toContain('不发送');
    // Its label no longer names a value, so the select has to show which UA it sends.
    expect(globalCustom.description).toBe(GLOBAL_CUSTOM_UA);
  });

  it('highlights exactly one option when a site uses the global custom preset', async () => {
    // The rendered consequence of a duplicate value: `ModernSelect` marks every
    // option whose value equals the current one, so a collision lights up two
    // entries at once and which of them the operator is looking at is undefined.
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [{ ...SITES[0], probeUserAgent: GLOBAL_CUSTOM_UA }],
    });
    const root = await renderPage();
    try {
      const select = findByTestId(root.root, 'model-probe-site-user-agent-4');
      const active = select.findAll((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.startsWith('modern-select-option')
        && node.props.className.includes('is-active')
      ));

      expect(active).toHaveLength(1);
      // Positive control on the same render: the select really does offer five
      // options, so "one active" is not one out of a list that lost an entry.
      expect(selectOptionLabels(select)).toHaveLength(5);
    } finally {
      root.unmount();
    }
  });

  it('sends the global custom value when a site picks the global custom preset', async () => {
    apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
    const root = await renderPage();
    try {
      const select = findByTestId(root.root, 'model-probe-site-user-agent-4');
      await act(async () => {
        findGlobalCustomPresetOption(select).props.onClick();
      });

      await act(async () => {
        findSiteSave(root.root, 4).props.onClick();
      });
      await flushMicrotasks();

      // Saving `''` here would mean "inherit the global default", which is
      // `claude-code` in this fixture — a different UA than the one selected.
      expect(apiMock.saveModelProbeSiteConfig).toHaveBeenCalledWith(4, {
        probeEndpointType: 'auto',
        probeUserAgent: GLOBAL_CUSTOM_UA,
      });
    } finally {
      root.unmount();
    }
  });

  it('keeps a stored UA that equals the global custom value across an unrelated edit', async () => {
    // The destructive half: this site HAS an override, and it happens to equal the
    // global custom preset's value.
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [{ ...SITES[0], probeUserAgent: GLOBAL_CUSTOM_UA }],
    });
    const root = await renderPage();
    try {
      // No empty custom box: the row is not a blank custom entry, it is a site
      // whose override matches a preset.
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-user-agent-custom-4'
      ))).toHaveLength(0);

      // An unrelated edit on the same row, which is what makes the save button live.
      const endpointSelect = findByTestId(root.root, 'model-probe-site-endpoint-4');
      await act(async () => {
        endpointSelect.find((node) => (
          node.type === 'button'
          && collectText(node).trim() === 'messages'
        )).props.onClick();
      });

      await act(async () => {
        findSiteSave(root.root, 4).props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.saveModelProbeSiteConfig).toHaveBeenCalledWith(4, {
        probeEndpointType: 'messages',
        probeUserAgent: GLOBAL_CUSTOM_UA,
      });
    } finally {
      root.unmount();
    }
  });

  it('still cannot express "send no User-Agent" for one site', async () => {
    // Accepted ledger limitation, asserted so a future edit cannot turn the
    // now-working custom preset into a per-site header suppressor by accident:
    // blank stays "inherit the global default".
    apiMock.getModelProbeSites.mockResolvedValue({ success: true, sites: SITES });
    const root = await renderPage();
    try {
      await selectSite(root.root, '站点乙');
      const select = findByTestId(root.root, 'model-probe-site-user-agent-9');
      await act(async () => {
        select.find((node) => (
          node.type === 'button'
          && node.props.className?.startsWith?.('modern-select-option')
          && collectText(node.find((child) => (
            child.props.className === 'modern-select-option-label'
          ))).trim() === '自定义'
        )).props.onClick();
      });

      const input = findByTestId(root.root, 'model-probe-site-user-agent-custom-9');
      await act(async () => {
        input.props.onChange({ target: { value: '  ' } });
      });
      await act(async () => {
        findSiteSave(root.root, 9).props.onClick();
      });
      await flushMicrotasks();

      const payload = apiMock.saveModelProbeSiteConfig.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(payload.probeUserAgent).toBe('');
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
      await selectSite(root.root, '站点乙');
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

/**
 * The desktop per-site panel shows ONE site at a time, selected from a dropdown.
 * The operator asked for this because a config block per site consumed the whole
 * viewport once more than a couple of sites existed.
 */
describe('ModelProbe per-site panel site selector', () => {
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

  it('renders only the selected site, and swaps when the selection changes', async () => {
    const root = await renderPage();
    try {
      // Site 4 is first, so it is the default selection...
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-4'
      ))).toHaveLength(1);
      // ...and the other site's block must be absent, which is the whole point of
      // the change. Paired with the positive assertion above so this cannot pass
      // against a panel that renders nothing at all.
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-9'
      ))).toHaveLength(0);

      await selectSite(root.root, '站点乙');

      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-9'
      ))).toHaveLength(1);
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-4'
      ))).toHaveLength(0);
    } finally {
      root.unmount();
    }
  });

  it('marks sites whose stored settings differ from the defaults', async () => {
    const root = await renderPage();
    try {
      const labels = selectOptionLabels(findByTestId(root.root, 'model-probe-site-selector'));
      // Site 9 stores probeEndpointType 'chat' and a literal UA; site 4 stores the
      // defaults ('auto' and ''), so exactly one option carries the marker.
      expect(labels.filter((label) => label.includes('已自定义'))).toHaveLength(1);
      expect(labels.find((label) => label.startsWith('站点乙'))).toContain('已自定义');
      expect(labels.find((label) => label.startsWith('站点甲'))).not.toContain('已自定义');

      const summary = collectText(findByTestId(root.root, 'model-probe-site-override-count'));
      expect(summary).toContain('1 个站点已自定义');
    } finally {
      root.unmount();
    }
  });

  it('says so plainly when no site has been customised', async () => {
    // Positive control for the marker: with both sites at their defaults the
    // count must flip, so a hard-coded 「1 个站点已自定义」 cannot pass both tests.
    apiMock.getModelProbeSites.mockResolvedValue({
      success: true,
      sites: [SITES[0], { ...SITES[1], probeEndpointType: 'auto', probeUserAgent: '' }],
    });
    const root = await renderPage();
    try {
      const labels = selectOptionLabels(findByTestId(root.root, 'model-probe-site-selector'));
      expect(labels.filter((label) => label.includes('已自定义'))).toHaveLength(0);
      expect(collectText(findByTestId(root.root, 'model-probe-site-override-count')))
        .toContain('所有站点都使用默认设置');
    } finally {
      root.unmount();
    }
  });

  it('keeps the selection valid when the keyword filter excludes it', async () => {
    const root = await renderPage();
    try {
      await selectSite(root.root, '站点乙');
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-9'
      ))).toHaveLength(1);

      // Filtering site 9 out must move the selection rather than leave a config
      // block mounted for a site the operator can no longer see in the dropdown.
      const keywordInput = findByTestId(root.root, 'model-probe-site-keyword');
      await act(async () => {
        keywordInput.props.onChange({ target: { value: '站点甲' } });
      });
      await flushMicrotasks();

      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-9'
      ))).toHaveLength(0);
      expect(root.root.findAll((node) => (
        node.props['data-testid'] === 'model-probe-site-config-4'
      ))).toHaveLength(1);
    } finally {
      root.unmount();
    }
  });
});
