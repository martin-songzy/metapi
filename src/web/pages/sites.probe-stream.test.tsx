import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

/**
 * The probe SSE route emits a `complete` event even when the run was refused
 * (`success: false`), so the client has to read that flag. Without it, a fresh
 * install — where the model interest regex list is empty by default and therefore
 * matches nothing — renders a refusal as "探测完成：0 个模型可用" and the
 * actionable server-side reason never reaches the operator.
 */

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteDisabledModels: vi.fn(),
    getSiteAvailableModels: vi.fn(),
    updateSiteDisabledModels: vi.fn(),
    updateSite: vi.fn(),
    rebuildRoutes: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

vi.mock('../components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => toastMock,
}));

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

/** Builds a single-shot SSE body from `event:`/`data:` frames. */
function sseStream(frames: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = frames
    .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

describe('Sites probe stream result handling', () => {
  // Bare `typeof vi.spyOn` falls back to its generic defaults
  // (`(...args: unknown[]) => unknown`), which cannot hold fetch's overloaded
  // signature. Spelling out the spied function's own type fixes that; note
  // `typeof globalThis.fetch` does not work here, because this tsconfig's lib set
  // does not carry `fetch` as a key of the global object type.
  let fetchSpy: MockInstance<typeof fetch>;
  let addedLocalStorage = false;

  beforeEach(() => {
    vi.clearAllMocks();
    // handleProbeNow reads the auth token from localStorage, which this test
    // environment does not provide; without it the probe throws before any SSE
    // frame is handled.
    if (typeof globalThis.localStorage === 'undefined') {
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
          clear: () => {},
          key: () => null,
          length: 0,
        },
        configurable: true,
        writable: true,
      });
      addedLocalStorage = true;
    }
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Demo Site',
        url: 'https://example.com',
        platform: 'new-api',
        status: 'active',
      },
    ]);
    apiMock.getSiteDisabledModels.mockResolvedValue({ models: [] });
    apiMock.getSiteAvailableModels.mockResolvedValue({ models: [] });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (addedLocalStorage) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      addedLocalStorage = false;
    }
    vi.clearAllMocks();
  });

  async function openProbeCard(): Promise<ReturnType<typeof create>> {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/sites']}>
          <ToastProvider>
            <Sites />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const editButton = root.root.find((node: ReactTestInstance) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).trim() === '编辑'
    ));
    await act(async () => {
      editButton.props.onClick();
    });
    await flushMicrotasks();
    return root;
  }

  async function clickProbeNow(root: ReturnType<typeof create>) {
    const probeButton = root.root.find((node: ReactTestInstance) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).includes('立即探测')
    ));
    await act(async () => {
      await probeButton.props.onClick();
    });
    await flushMicrotasks();
  }

  it('surfaces a refused run as an error instead of a zero-model success', async () => {
    const refusal = '未配置模型兴趣正则：请先在模型探测设置中添加正则，否则不会探测任何模型';
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: sseStream([
        {
          event: 'complete',
          data: {
            success: false,
            error: refusal,
            scope: 'all',
            probed: 0,
            supported: 0,
            unsupported: 0,
            inconclusive: 0,
            skipped: 0,
            disabled: 0,
            routingSynced: false,
            details: [],
          },
        },
      ]),
    } as unknown as Response);

    let root!: ReturnType<typeof create>;
    try {
      root = await openProbeCard();
      await clickProbeNow(root);

      expect(toastMock.error).toHaveBeenCalledWith(refusal);
      expect(toastMock.success).not.toHaveBeenCalled();
      expect(collectText(root.root)).toContain(refusal);
      expect(collectText(root.root)).not.toContain('0 个模型可用');
    } finally {
      root?.unmount();
    }
  });

  it('reports a successful run with per-model endpoint and failure metadata', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: sseStream([
        {
          event: 'start',
          data: {
            scope: 'all',
            modelsCount: 1,
            modelsToProbe: ['ghost-model'],
            discoverySource: 'live',
            credentialVerified: true,
            discoveredCount: 3,
          },
        },
        {
          event: 'model',
          data: {
            modelName: 'ghost-model',
            status: 'unsupported',
            latencyMs: 120,
            reason: 'no such model',
            httpStatus: 404,
            failureKind: 'model_missing',
            endpointUsed: 'messages',
          },
        },
        {
          event: 'complete',
          data: {
            success: true,
            scope: 'all',
            probed: 1,
            supported: 0,
            unsupported: 1,
            inconclusive: 0,
            skipped: 0,
            disabled: 0,
            routingSynced: false,
            details: [],
          },
        },
      ]),
    } as unknown as Response);

    let root!: ReturnType<typeof create>;
    try {
      root = await openProbeCard();
      await clickProbeNow(root);

      const logText = collectText(root.root);
      expect(logText).toContain('ghost-model');
      expect(logText).toContain('端点 messages');
      expect(logText).toContain('HTTP 404');
      expect(logText).toContain('模型不存在');
      expect(logText).toContain('未同步到路由');
    } finally {
      root?.unmount();
    }
  });

  it('reports an inconclusive verdict as undetermined rather than unavailable', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: sseStream([
        {
          event: 'model',
          data: {
            modelName: 'flaky-model',
            status: 'inconclusive',
            latencyMs: null,
            reason: 'runtime model probe timeout (15s)',
            httpStatus: null,
            failureKind: 'timeout',
            endpointUsed: null,
          },
        },
        {
          event: 'complete',
          data: {
            success: true,
            scope: 'all',
            probed: 1,
            supported: 0,
            unsupported: 0,
            inconclusive: 1,
            skipped: 0,
            disabled: 0,
            routingSynced: false,
            details: [],
          },
        },
      ]),
    } as unknown as Response);

    let root!: ReturnType<typeof create>;
    try {
      root = await openProbeCard();
      await clickProbeNow(root);

      const logText = collectText(root.root);
      expect(logText).toContain('未确定');
      expect(logText).toContain('超时');
      expect(toastMock.info).toHaveBeenCalled();
      expect(toastMock.error).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
