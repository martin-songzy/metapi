import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import NotificationSettings from './NotificationSettings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRuntimeSettings: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    testNotification: vi.fn(),
    getProxyPool: vi.fn(),
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
  });
}

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getRuntimeSettings.mockResolvedValue({
      webhookUrl: '',
      barkUrl: '',
      webhookEnabled: true,
      barkEnabled: true,
      serverChanEnabled: false,
      telegramEnabled: true,
      telegramApiBaseUrl: 'https://tg-proxy.example.com',
      telegramChatId: '-1001234567890',
      telegramMessageThreadId: '77',
      telegramBotTokenMasked: '1234****token',
      telegramUseSystemProxy: false,
      smtpEnabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpFrom: '',
      smtpTo: '',
      notifyCooldownSec: 300,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({
      success: true,
      telegramApiBaseUrl: 'https://proxy.example.com/custom',
      telegramMessageThreadId: '88',
      telegramBotTokenMasked: '1234****token',
    });
    apiMock.testNotification.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads and saves telegram api base url and topic id', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const proxyInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '例如: https://your-proxy.example.com'
      ));
      expect(proxyInput.props.value).toBe('https://tg-proxy.example.com');

      const topicInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '例如: 77'
      ));
      expect(topicInput.props.value).toBe('77');

      await act(async () => {
        proxyInput.props.onChange({ target: { value: 'https://proxy.example.com/custom/' } });
        topicInput.props.onChange({ target: { value: '88' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存通知设置')
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        telegramApiBaseUrl: 'https://proxy.example.com/custom/',
        telegramMessageThreadId: '88',
      }));
    } finally {
      root?.unmount();
    }
  });

  it('loads and saves the telegram proxy choice', async () => {
    apiMock.getProxyPool.mockResolvedValue({
      success: true,
      entries: [{ id: 'px_hk', name: '香港', url: 'socks5://10.0.0.1:1080' }],
    });
    apiMock.getRuntimeSettings.mockResolvedValue({
      webhookUrl: '',
      barkUrl: '',
      webhookEnabled: true,
      barkEnabled: true,
      serverChanEnabled: false,
      telegramEnabled: true,
      telegramApiBaseUrl: 'https://api.telegram.org',
      telegramChatId: '-1001234567890',
      telegramBotTokenMasked: '1234****token',
      telegramProxyRef: '',
      smtpEnabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpFrom: '',
      smtpTo: '',
      notifyCooldownSec: 300,
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      // Telegram picks from the pool like everything else; there is no address field
      // here any more, and 不走代理 is the stored default.
      const proxySelect = root.root.find((node) => node.props?.['data-testid'] === 'telegram-proxy-select');
      expect(proxySelect.props.value).toBe('__direct__');

      await act(async () => {
        proxySelect.props.onChange({ target: { value: 'px_hk' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存通知设置')
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        telegramProxyRef: 'px_hk',
      }));
    } finally {
      root?.unmount();
    }
  });
});

