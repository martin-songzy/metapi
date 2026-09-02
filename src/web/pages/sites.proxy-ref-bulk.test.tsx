import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    batchUpdateSites: vi.fn(),
    getProxyPool: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Sites proxy bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Site A',
        url: 'https://a.example.com',
        platform: 'new-api',
        status: 'active',
        proxyRef: null,
      },
      {
        id: 2,
        name: 'Site B',
        url: 'https://b.example.com',
        platform: 'new-api',
        status: 'active',
        proxyRef: null,
      },
    ]);
    apiMock.getProxyPool.mockResolvedValue({
      success: true,
      entries: [{ id: 'px_aaaaaaaaaaaa', name: '香港', url: 'socks5://10.0.0.1:1080' }],
    });
    apiMock.batchUpdateSites.mockResolvedValue({
      success: true,
      successIds: [1, 2],
      failedItems: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends the selected site ids together with the chosen pool entry', async () => {
    let root!: WebTestRenderer;
    try {
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

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'site-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'site-select-2');

      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });

      const batchSelect = root.root.find((node) => node.props['data-testid'] === 'sites-batch-proxy-ref');
      await act(async () => {
        batchSelect.props.onChange({ target: { value: 'px_aaaaaaaaaaaa' } });
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateSites).toHaveBeenCalledWith({
        ids: [1, 2],
        action: 'setProxyRef',
        proxyRef: 'px_aaaaaaaaaaaa',
      });
    } finally {
      root?.unmount();
    }
  });

  // 不走代理 is a value in the same list, not a separate button: the batch bar has one
  // control, so there is no way to express "clear the proxy" that skips validation.
  it('sends a null ref when the operator picks 不走代理', async () => {
    let root!: WebTestRenderer;
    try {
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

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'site-select-1');
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
      });

      const batchSelect = root.root.find((node) => node.props['data-testid'] === 'sites-batch-proxy-ref');
      await act(async () => {
        batchSelect.props.onChange({ target: { value: '__direct__' } });
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateSites).toHaveBeenCalledWith({
        ids: [1],
        action: 'setProxyRef',
        proxyRef: null,
      });
    } finally {
      root?.unmount();
    }
  });

  it('selects a site when clicking the row instead of only the checkbox', async () => {
    let root!: WebTestRenderer;
    try {
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

      const row = root.root.find((node) => node.props['data-testid'] === 'site-row-1');
      await act(async () => {
        row.props.onClick({ target: { closest: () => null } });
      });
      await flushMicrotasks();

      const checkbox = root.root.find((node) => node.props['data-testid'] === 'site-select-1');
      expect(checkbox.props.checked).toBe(true);
    } finally {
      root?.unmount();
    }
  });
});
