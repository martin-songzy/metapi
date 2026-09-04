import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
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

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

describe('Accounts segmented connections view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows only apikey connections in the apikey segment and labels unnamed ones as API Key 连接', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        apiToken: 'sk-session',
        status: 'active',
        credentialMode: 'session',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
      {
        id: 2,
        username: '',
        accessToken: '',
        apiToken: 'sk-apikey',
        status: 'active',
        credentialMode: 'apikey',
        capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
        site: { id: 11, name: 'Key Site', platform: 'new-api', status: 'active', url: 'https://key.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
      { id: 11, name: 'Key Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('连接管理');
      expect(rendered).toContain('完整账号');
      expect(rendered).toContain('直连 Key');
      expect(rendered).toContain('令牌分发池');
      // The tooltips carry the distinction the labels only hint at: what credential
      // each segment needs, and what it can therefore do.
      expect(rendered).toContain('可签到、查余额');
      expect(rendered).toContain('不能签到也查不到余额');
      expect(rendered).toContain('由「同步站点令牌」拉取或手动新增');
      expect(rendered).toContain('Key Site');
      expect(rendered).not.toContain('仅代理');
      expect(rendered).not.toContain('session-user');

      const segmentButtons = root.root.findAll((node) => {
        if (node.type !== 'button') return false;
        const text = collectText(node);
        return text === '完整账号' || text === '直连 Key' || text === '令牌分发池';
      });
      expect(segmentButtons).toHaveLength(3);
      expect(segmentButtons[0]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[0]?.props['data-tooltip-align']).toBe('start');
      expect(segmentButtons[1]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[1]?.props['data-tooltip-align']).toBe('center');
      expect(segmentButtons[2]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[2]?.props['data-tooltip-align']).toBe('end');
    } finally {
      root?.unmount();
    }
  });

  it('uses existing-site guidance instead of asking to add a site when the segment is empty but sites exist', async () => {
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('暂无 Session 连接');
      expect(rendered).toContain('请为现有站点添加 Session 连接');
      expect(rendered).not.toContain('请先添加站点');
    } finally {
      root?.unmount();
    }
  });

  /**
   * The edit form used to render every field for every connection.
   *
   * 启用签到 was merely a lie on a 直连 Key — it persisted and the scheduler skipped
   * the account anyway, because check-in needs a session. Access Token was worse:
   * `isApiKeyConnection` on the server falls back to "access_token is empty" when
   * `extra_config.credentialMode` is absent (older rows), so typing into it moved the
   * connection out of this segment entirely.
   */
  describe('edit panel fields by credential kind', () => {
    const EDIT_SITES = [{ id: 11, name: 'Key Site', platform: 'new-api', status: 'active' }];

    function accountRow(overrides: Record<string, unknown>) {
      return {
        id: 2,
        username: 'keyholder',
        accessToken: '',
        apiToken: 'sk-apikey',
        status: 'active',
        credentialMode: 'apikey',
        capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
        site: { id: 11, name: 'Key Site', platform: 'new-api', status: 'active', url: 'https://key.example.com' },
        ...overrides,
      };
    }

    function findByTestId(root: ReactTestInstance, testId: string): ReactTestInstance {
      return root.find((node) => node.props['data-testid'] === testId);
    }

    function hasTestId(root: ReactTestInstance, testId: string): boolean {
      return root.findAll((node) => node.props['data-testid'] === testId).length > 0;
    }

    async function openEditPanel(account: Record<string, unknown>, segment: 'apikey' | 'session') {
      apiMock.getAccounts.mockResolvedValue([account]);
      apiMock.getSites.mockResolvedValue(EDIT_SITES);
      apiMock.getAccountTokens.mockResolvedValue([]);

      let root!: WebTestRenderer;
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={[`/accounts?segment=${segment}`]}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const editButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '编辑'
      ));
      await act(async () => {
        editButton.props.onClick({ stopPropagation() {} });
      });
      await flushMicrotasks();
      return root;
    }

    it('hides 启用签到 and Access Token while editing a 直连 Key', async () => {
      const root = await openEditPanel(accountRow({}), 'apikey');
      try {
        expect(JSON.stringify(root.toJSON())).toContain('编辑直连 Key');
        expect(hasTestId(root.root, 'account-edit-checkin-enabled')).toBe(false);
        expect(hasTestId(root.root, 'account-edit-access-token')).toBe(false);
        // The one credential such a connection does have stays editable, labelled as
        // the key it actually is rather than as an optional extra.
        expect(findByTestId(root.root, 'account-edit-api-token').props.placeholder).toBe('API Key');
      } finally {
        root.unmount();
      }
    });

    it('keeps both fields while editing a 完整账号', async () => {
      // Paired control: the gate keys off the connection, it does not simply delete
      // the fields for everyone.
      const root = await openEditPanel(
        accountRow({
          id: 1,
          username: 'session-user',
          accessToken: 'session-token',
          credentialMode: 'session',
          capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        }),
        'session',
      );
      try {
        expect(JSON.stringify(root.toJSON())).toContain('编辑完整账号');
        expect(hasTestId(root.root, 'account-edit-checkin-enabled')).toBe(true);
        expect(findByTestId(root.root, 'account-edit-access-token').props.value).toBe('session-token');
        expect(findByTestId(root.root, 'account-edit-api-token').props.placeholder).toBe('API Token（可选）');
      } finally {
        root.unmount();
      }
    });
  });
});
