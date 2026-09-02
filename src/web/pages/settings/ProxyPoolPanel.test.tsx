import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';

import ProxyPoolPanel from './ProxyPoolPanel.js';

/**
 * Replaces the old `settings.system-proxy` suite. That one covered a single global
 * address field, which is exactly the thing this feature removed: the pool is now the
 * only place an address is entered, so the coverage moves here.
 *
 * The delete case is the one that matters most. A pool entry is referenced by id from
 * rows this panel cannot see, and deleting it resets those referrers to 「不走代理」 —
 * so the panel has to name them BEFORE the confirm, or an operator agreeing to
 * "delete this proxy" silently unproxies sites they were not told about.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyPool: vi.fn(),
    createProxyPoolEntry: vi.fn(),
    updateProxyPoolEntry: vi.fn(),
    deleteProxyPoolEntry: vi.fn(),
    getProxyPoolReferrers: vi.fn(),
    testSystemProxy: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({
  api: apiMock,
}));

type WebTestRenderer = ReturnType<typeof create>;

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
  });
}

function findByTestId(root: ReactTestInstance, testId: string): ReactTestInstance {
  return root.find((node) => node.props?.['data-testid'] === testId);
}

const toasts: Array<{ kind: string; message: string }> = [];

function renderPanel() {
  return create(
    <ProxyPoolPanel
      inputStyle={{}}
      onToast={(kind, message) => { toasts.push({ kind, message }); }}
    />,
  );
}

describe('ProxyPoolPanel', () => {
  let confirmSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    toasts.length = 0;
    confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('window', { ...(globalThis as any).window, confirm: confirmSpy });
    apiMock.getProxyPool.mockResolvedValue({
      success: true,
      entries: [
        { id: 'px_aaaaaaaaaaaa', name: '香港', url: 'socks5://10.0.0.1:1080' },
      ],
    });
    apiMock.createProxyPoolEntry.mockResolvedValue({ success: true });
    apiMock.updateProxyPoolEntry.mockResolvedValue({ success: true });
    apiMock.deleteProxyPoolEntry.mockResolvedValue({ success: true });
    apiMock.getProxyPoolReferrers.mockResolvedValue({
      success: true,
      siteNames: [],
      accountLabels: [],
    });
    apiMock.testSystemProxy.mockResolvedValue({ success: true, latencyMs: 321 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists entries with their name and address', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('香港');
      expect(text).toContain('socks5://10.0.0.1:1080');
    } finally {
      root?.unmount();
    }
  });

  it('adds an entry and reloads the list', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      await act(async () => {
        findByTestId(root.root, 'proxy-pool-new-name').props.onChange({ target: { value: '日本' } });
      });
      await act(async () => {
        findByTestId(root.root, 'proxy-pool-new-url').props.onChange({ target: { value: 'http://10.0.0.2:7890' } });
      });
      await act(async () => {
        findByTestId(root.root, 'proxy-pool-add').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.createProxyPoolEntry).toHaveBeenCalledWith({
        url: 'http://10.0.0.2:7890',
        name: '日本',
      });
      // Reloaded rather than patched locally: the server assigns the id.
      expect(apiMock.getProxyPool).toHaveBeenCalledTimes(2);
    } finally {
      root?.unmount();
    }
  });

  it('refuses to add without an address', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      await act(async () => {
        findByTestId(root.root, 'proxy-pool-add').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.createProxyPoolEntry).not.toHaveBeenCalled();
      expect(toasts.some((item) => item.kind === 'error')).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('edits an entry in place, keeping its id so referrers follow', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      await act(async () => {
        findByTestId(root.root, 'proxy-pool-edit-px_aaaaaaaaaaaa').props.onClick();
      });
      await act(async () => {
        findByTestId(root.root, 'proxy-pool-edit-url').props.onChange({ target: { value: 'socks5://10.9.9.9:1080' } });
      });
      await act(async () => {
        findByTestId(root.root, 'proxy-pool-edit-save').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateProxyPoolEntry).toHaveBeenCalledWith('px_aaaaaaaaaaaa', {
        name: '香港',
        url: 'socks5://10.9.9.9:1080',
      });
    } finally {
      root?.unmount();
    }
  });

  it('names the affected sites and connections before deleting', async () => {
    apiMock.getProxyPoolReferrers.mockResolvedValue({
      success: true,
      siteNames: ['站点甲', '站点乙'],
      accountLabels: ['连接丙'],
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      await act(async () => {
        findByTestId(root.root, 'proxy-pool-delete-px_aaaaaaaaaaaa').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getProxyPoolReferrers).toHaveBeenCalledWith('px_aaaaaaaaaaaa');
      const confirmText = String(confirmSpy.mock.calls[0]?.[0] ?? '');
      expect(confirmText).toContain('站点甲');
      expect(confirmText).toContain('连接丙');
      expect(confirmText).toContain('不走代理');
      expect(apiMock.deleteProxyPoolEntry).toHaveBeenCalledWith('px_aaaaaaaaaaaa');
      expect(toasts.at(-1)?.message).toContain('3');
    } finally {
      root?.unmount();
    }
  });

  it('does not delete when the operator declines the confirm', async () => {
    confirmSpy.mockReturnValue(false);

    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      await act(async () => {
        findByTestId(root.root, 'proxy-pool-delete-px_aaaaaaaaaaaa').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.deleteProxyPoolEntry).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('tests one entry against its own address', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      await act(async () => {
        findByTestId(root.root, 'proxy-pool-test-px_aaaaaaaaaaaa').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.testSystemProxy).toHaveBeenCalledWith({ proxyUrl: 'socks5://10.0.0.1:1080' });
      expect(collectText(root.root)).toContain('321 ms');
    } finally {
      root?.unmount();
    }
  });

  it('shows the empty state when no proxy exists yet', async () => {
    apiMock.getProxyPool.mockResolvedValue({ success: true, entries: [] });

    let root!: WebTestRenderer;
    try {
      await act(async () => { root = renderPanel(); });
      await flushMicrotasks();

      expect(findByTestId(root.root, 'proxy-pool-empty')).toBeTruthy();
    } finally {
      root?.unmount();
    }
  });
});
