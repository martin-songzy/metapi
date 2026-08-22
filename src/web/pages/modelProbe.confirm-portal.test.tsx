// @vitest-environment jsdom
/**
 * The only file in the web suite that runs under jsdom, and it exists for one
 * reason: everywhere else `document` is undefined, so `CenteredModal` falls back
 * to rendering inline and `createPortal` never executes. The run panel's
 * confirmation gate is the last stop before a sweep spends real quota on the
 * operator's paid accounts, so "the buttons work in the fallback branch" is not
 * enough — the branch that actually ships has to be exercised too.
 *
 * Kept separate from `modelProbe.run.test.tsx` so the rest of the suite keeps the
 * cheaper Node environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModelProbe from './ModelProbe.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelProbeConfig: vi.fn(),
    saveModelProbeConfig: vi.fn(),
    getModelProbeSites: vi.fn(),
    saveModelProbeSiteConfig: vi.fn(),
    getModelProbeResults: vi.fn(),
    getModelProbeTasks: vi.fn(),
    getModelProbeTask: vi.fn(),
    previewModelProbe: vi.fn(),
    runModelProbe: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: () => false }));

/**
 * React 18 requires this opt-in before `act` will drive a `react-dom` root.
 * Without it every render logs "the current testing environment is not configured
 * to support act(...)" and updates can escape the act scope.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SITES = [
  {
    id: 4,
    name: '站点甲',
    url: 'https://a.example.com',
    platform: 'newapi',
    status: 'active',
    probeEndpointType: 'auto',
    probeUserAgent: '',
  },
];

/** Mirrors the wire shape `api.runModelProbe` returns for a 409: `{ status, data }`. */
function confirmationRequired() {
  return {
    status: 'conflict' as const,
    data: {
      success: false as const,
      code: 'confirmation_required' as const,
      message: '需要二次确认',
      targetCount: 42,
      confirmTargetThreshold: 11,
      maxRunTargets: 123,
      preview: null,
    },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPage() {
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/model-probe']}>
        <ToastProvider>
          <ModelProbe />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

async function clickTestId(testId: string) {
  const node = byTestId(testId);
  if (!node) throw new Error(`no element with data-testid="${testId}"`);
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

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
  apiMock.getModelProbeTasks.mockResolvedValue({ tasks: [] });
  apiMock.getModelProbeResults.mockResolvedValue({
    success: true,
    items: [],
    total: 0,
    query: { sortBy: 'checkedAt', order: 'desc', limit: 50, offset: 0 },
  });
  apiMock.runModelProbe.mockResolvedValue(confirmationRequired());
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ModelProbe confirmation gate through the real portal', () => {
  it('portals the dialog into document.body, outside the app container', async () => {
    await mountPage();
    await clickTestId('model-probe-run-button');

    const dialog = byTestId('model-probe-confirm-dialog');
    expect(dialog).not.toBeNull();
    // The point of the portal: the dialog escapes the panel's stacking context.
    // If it rendered inline it would still be findable, just not here.
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog!.closest('.modal-backdrop')).not.toBeNull();
    expect(dialog!.textContent).toContain('42');
    // Showing the gate must not have started anything beyond the refused attempt.
    expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
  });

  it('locks body scroll while the gate is open and releases it on cancel', async () => {
    await mountPage();
    await clickTestId('model-probe-run-button');
    expect(document.body.style.overflow).toBe('hidden');

    await clickTestId('model-probe-confirm-cancel');
    expect(byTestId('model-probe-confirm-dialog')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
  });

  it('cancelling through the portal spends nothing', async () => {
    await mountPage();
    await clickTestId('model-probe-run-button');
    await clickTestId('model-probe-confirm-cancel');

    expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
    expect(apiMock.runModelProbe).not.toHaveBeenCalledWith(
      expect.objectContaining({ confirmedTargetCount: expect.anything() }),
    );
  });

  it('confirming through the portal resends exactly once, with the server-reported count', async () => {
    apiMock.runModelProbe
      .mockResolvedValueOnce(confirmationRequired())
      .mockResolvedValueOnce({
        status: 'ok' as const,
        data: { success: true, taskId: 'task-1', reused: false, preview: null },
      });
    apiMock.getModelProbeTask.mockResolvedValue({
      task: { id: 'task-1', type: 'active-model-probe', status: 'running', logs: [], result: null },
    });

    await mountPage();
    await clickTestId('model-probe-run-button');
    await clickTestId('model-probe-confirm-accept');

    expect(apiMock.runModelProbe).toHaveBeenCalledTimes(2);
    expect(apiMock.runModelProbe).toHaveBeenNthCalledWith(2, expect.objectContaining({ confirmedTargetCount: 42 }));
    // A double-fire here would bill the operator twice for the same sweep.
    expect(byTestId('model-probe-confirm-dialog')).toBeNull();
  });

  it('closing the gate with the shared close button does not start a run', async () => {
    await mountPage();
    await clickTestId('model-probe-run-button');

    const closeButton = document.querySelector<HTMLElement>('button[aria-label="关闭弹框"]');
    expect(closeButton).not.toBeNull();
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(byTestId('model-probe-confirm-dialog')).toBeNull();
    expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
  });

  it('does not close the gate on a backdrop click', async () => {
    await mountPage();
    await clickTestId('model-probe-run-button');

    const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // A stray click next to a dialog that spends money must not dismiss it
    // silently — the operator has to say yes or no.
    expect(byTestId('model-probe-confirm-dialog')).not.toBeNull();
    expect(apiMock.runModelProbe).toHaveBeenCalledTimes(1);
  });
});
