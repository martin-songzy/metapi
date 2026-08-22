import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectAllMock = vi.fn();
const selectGetMock = vi.fn();
const selectWhereMock = vi.fn();
const selectOrderByMock = vi.fn();
const dbInsertMock = vi.fn();
const dbUpdateMock = vi.fn();
const dbDeleteMock = vi.fn();

const requireSiteApiBaseUrlMock = vi.fn();
const getAdapterMock = vi.fn();
const resolvePlatformUserIdMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withAccountProxyOverrideMock = vi.fn();
const isUsableAccountTokenMock = vi.fn();
const isMaskedTokenValueMock = vi.fn();
const getOauthInfoFromAccountMock = vi.fn();

const getModelsMock = vi.fn();

vi.mock('../db/index.js', () => {
  const makeSelectChain = () => {
    let table = '';
    const chain: Record<string, unknown> = {
      from: (candidate: { __name?: string } | undefined) => {
        table = candidate?.__name || String(candidate);
        return chain;
      },
      innerJoin: () => chain,
      where: (...args: unknown[]) => {
        selectWhereMock(table, ...args);
        return chain;
      },
      orderBy: (...args: unknown[]) => {
        selectOrderByMock(table, ...args);
        return chain;
      },
      limit: () => chain,
      all: () => selectAllMock(table),
      get: () => selectGetMock(table),
    };
    return chain;
  };

  return {
    db: {
      select: () => makeSelectChain(),
      insert: (...args: unknown[]) => {
        dbInsertMock(...args);
        return { values: () => ({ run: () => ({}) }) };
      },
      update: (...args: unknown[]) => {
        dbUpdateMock(...args);
        return { set: () => ({ where: () => ({ run: () => ({}) }) }) };
      },
      delete: (...args: unknown[]) => {
        dbDeleteMock(...args);
        return { where: () => ({ run: () => ({}) }) };
      },
    },
    schema: {
      sites: { __name: 'sites', id: 'id', status: 'status', platform: 'platform' },
      accounts: {
        __name: 'accounts',
        id: 'id',
        siteId: 'siteId',
        status: 'status',
        isPinned: 'isPinned',
        sortOrder: 'sortOrder',
      },
      accountTokens: {
        __name: 'accountTokens',
        id: 'id',
        accountId: 'accountId',
        enabled: 'enabled',
        valueStatus: 'valueStatus',
      },
      modelAvailability: {
        __name: 'modelAvailability',
        accountId: 'accountId',
        modelName: 'modelName',
        available: 'available',
      },
    },
  };
});

vi.mock('./siteApiEndpointService.js', () => ({
  requireSiteApiBaseUrl: (...args: unknown[]) => requireSiteApiBaseUrlMock(...args),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapterMock(...args),
}));

vi.mock('./accountExtraConfig.js', () => ({
  resolvePlatformUserId: (...args: unknown[]) => resolvePlatformUserIdMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withAccountProxyOverride: (...args: unknown[]) => withAccountProxyOverrideMock(...args),
}));

vi.mock('./accountTokenService.js', () => ({
  ACCOUNT_TOKEN_VALUE_STATUS_READY: 'ready',
  isUsableAccountToken: (...args: unknown[]) => isUsableAccountTokenMock(...args),
  isMaskedTokenValue: (...args: unknown[]) => isMaskedTokenValueMock(...args),
}));

vi.mock('./oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: (...args: unknown[]) => getOauthInfoFromAccountMock(...args),
}));

const site = {
  id: 7,
  name: 'probe-site',
  url: 'https://probe.example.com',
  platform: 'new-api',
  status: 'active',
} as any;

function account(overrides: Record<string, unknown>) {
  return {
    siteId: 7,
    username: 'probe-user',
    accessToken: '',
    apiToken: null,
    status: 'active',
    isPinned: false,
    sortOrder: 0,
    extraConfig: null,
    ...overrides,
  } as any;
}

type TableRows = {
  accounts?: unknown[];
  accountTokens?: unknown[];
  modelAvailability?: unknown[];
};

function primeTables(rows: TableRows) {
  selectGetMock.mockImplementation((table: string) => (table === 'sites' ? site : undefined));
  selectAllMock.mockImplementation((table: string) => {
    if (table === 'accounts') return rows.accounts ?? [];
    if (table === 'accountTokens') return rows.accountTokens ?? [];
    if (table === 'modelAvailability') return rows.modelAvailability ?? [];
    return [];
  });
}

describe('discoverModelsForActiveProbe', () => {
  let insideProxyOverride = false;
  let observedInsideProxyOverride = false;
  let observedProxyUrl: unknown;

  beforeEach(() => {
    vi.resetModules();
    selectAllMock.mockReset();
    selectGetMock.mockReset();
    selectWhereMock.mockReset();
    selectOrderByMock.mockReset();
    dbInsertMock.mockReset();
    dbUpdateMock.mockReset();
    dbDeleteMock.mockReset();
    requireSiteApiBaseUrlMock.mockReset();
    getAdapterMock.mockReset();
    resolvePlatformUserIdMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withAccountProxyOverrideMock.mockReset();
    isUsableAccountTokenMock.mockReset();
    isMaskedTokenValueMock.mockReset();
    getOauthInfoFromAccountMock.mockReset();
    getModelsMock.mockReset();

    insideProxyOverride = false;
    observedInsideProxyOverride = false;
    observedProxyUrl = undefined;

    requireSiteApiBaseUrlMock.mockResolvedValue('https://api.probe.example.com');
    getAdapterMock.mockReturnValue({ platformName: 'new-api', getModels: getModelsMock });
    resolvePlatformUserIdMock.mockReturnValue(4242);
    resolveChannelProxyUrlMock.mockReturnValue('http://proxy.internal:8080');
    isUsableAccountTokenMock.mockReturnValue(true);
    isMaskedTokenValueMock.mockImplementation((value: string | null | undefined) => (
      typeof value === 'string' && value.includes('*')
    ));
    getOauthInfoFromAccountMock.mockReturnValue(null);
    withAccountProxyOverrideMock.mockImplementation(async (proxyUrl: unknown, fn: () => Promise<unknown>) => {
      observedProxyUrl = proxyUrl;
      insideProxyOverride = true;
      try {
        return await fn();
      } finally {
        insideProxyOverride = false;
      }
    });
    getModelsMock.mockImplementation(async () => {
      observedInsideProxyOverride = insideProxyOverride;
      return ['gpt-5.4'];
    });
    primeTables({});
  });

  it('selects the deterministic first active account by isPinned desc, sortOrder asc, id asc', async () => {
    primeTables({
      accounts: [
        account({ id: 3, sortOrder: 1, apiToken: 'sk-three' }),
        account({ id: 9, isPinned: true, sortOrder: 5, apiToken: 'sk-nine' }),
        account({ id: 2, isPinned: true, sortOrder: 5, apiToken: 'sk-two' }),
        account({ id: 1, isPinned: true, sortOrder: 2, apiToken: 'sk-one' }),
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.account.id).toBe(1);
    expect(result.credential).toBe('sk-one');
    expect(result.source).toBe('live');
  });

  it('pushes the active filter and the three-key ordering down into SQL', async () => {
    primeTables({ accounts: [account({ id: 1, apiToken: 'sk-one' })] });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    const accountOrderBy = selectOrderByMock.mock.calls.find((call) => call[0] === 'accounts');
    expect(accountOrderBy).toBeDefined();
    // isPinned desc, sortOrder asc, id asc — three ordering keys, not an unordered .get().
    expect(accountOrderBy!.slice(1)).toHaveLength(3);

    const accountWhere = selectWhereMock.mock.calls.find((call) => call[0] === 'accounts');
    expect(accountWhere).toBeDefined();
    expect(JSON.stringify(accountWhere![1])).toContain('active');
  });

  it('skips accounts without a usable credential and ignores inactive accounts', async () => {
    primeTables({
      accounts: [
        account({ id: 1, status: 'disabled', apiToken: 'sk-disabled' }),
        account({ id: 2, apiToken: '   ', accessToken: '' }),
        account({ id: 3, apiToken: 'sk-****1234', accessToken: '' }),
        account({ id: 4, apiToken: 'sk-usable' }),
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.account.id).toBe(4);
    expect(result.credential).toBe('sk-usable');
  });

  it('falls back to accessToken when no apiToken is present', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: null, accessToken: 'session-token' })],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.credential).toBe('session-token');
  });

  it('falls back to a managed ready account token when the account has no direct credential', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: null, accessToken: '' })],
      accountTokens: [
        { id: 20, accountId: 1, token: 'sk-managed-late', enabled: true, valueStatus: 'ready', isDefault: false },
        { id: 11, accountId: 1, token: 'sk-managed-first', enabled: true, valueStatus: 'ready', isDefault: false },
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.credential).toBe('sk-managed-first');
  });

  it('honors isUsableAccountToken when picking managed tokens', async () => {
    isUsableAccountTokenMock.mockImplementation((token: { id: number }) => token.id !== 11);
    primeTables({
      accounts: [account({ id: 1, apiToken: null, accessToken: '' })],
      accountTokens: [
        { id: 11, accountId: 1, token: 'sk-unusable', enabled: false, valueStatus: 'ready' },
        { id: 12, accountId: 1, token: 'sk-good', enabled: true, valueStatus: 'ready' },
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.credential).toBe('sk-good');
  });

  it('resolves the api base url and calls the adapter inside the account proxy override', async () => {
    primeTables({ accounts: [account({ id: 1, apiToken: 'sk-one', extraConfig: '{"proxyUrl":"x"}' })] });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(requireSiteApiBaseUrlMock).toHaveBeenCalledWith(site);
    expect(resolveChannelProxyUrlMock).toHaveBeenCalledWith(site, '{"proxyUrl":"x"}');
    expect(observedProxyUrl).toBe('http://proxy.internal:8080');
    expect(observedInsideProxyOverride).toBe(true);
    expect(getModelsMock).toHaveBeenCalledWith('https://api.probe.example.com', 'sk-one', 4242);
    expect(result.site).toBe(site);
  });

  it('trims and dedupes model names case-insensitively while keeping the first casing', async () => {
    primeTables({ accounts: [account({ id: 1, apiToken: 'sk-one' })] });
    getModelsMock.mockResolvedValue([
      '  GPT-5.4  ',
      'gpt-5.4',
      'Claude-Opus-5',
      '   ',
      'claude-opus-5',
      null,
      'gemini-3-pro',
    ]);

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.models).toEqual(['GPT-5.4', 'Claude-Opus-5', 'gemini-3-pro']);
    expect(result.source).toBe('live');
  });

  it('falls back to cached model availability when the live fetch returns nothing', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [
        { modelName: ' cached-model ' },
        { modelName: 'Cached-Model' },
        { modelName: 'other-model' },
      ],
    });
    getModelsMock.mockResolvedValue([]);

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.source).toBe('cached');
    expect(result.models).toEqual(['cached-model', 'other-model']);
  });

  it('falls back to cached model availability when the live fetch throws', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    getModelsMock.mockRejectedValue(new Error('HTTP 500: upstream exploded'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.source).toBe('cached');
    expect(result.models).toEqual(['cached-model']);
  });

  it('falls back to cached model availability when the live fetch exceeds the timeout budget', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    getModelsMock.mockImplementation(() => new Promise(() => {}));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const startedAt = Date.now();
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 30 });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.source).toBe('cached');
    expect(result.models).toEqual(['cached-model']);
  });

  it('throws an explicit error when the site does not exist', async () => {
    selectGetMock.mockReturnValue(undefined);

    const { discoverModelsForActiveProbe, ModelProbeDiscoveryError } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({
        name: 'ModelProbeDiscoveryError',
        code: 'site_not_found',
      });
    expect(ModelProbeDiscoveryError).toBeTypeOf('function');
  });

  it('throws an explicit error when no active account has a usable credential', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: null, accessToken: '' })],
      accountTokens: [],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({ code: 'no_credential' });
    expect(getModelsMock).not.toHaveBeenCalled();
  });

  it('throws an explicit error when the platform adapter is unavailable', async () => {
    getAdapterMock.mockReturnValue(undefined);
    primeTables({ accounts: [account({ id: 1, apiToken: 'sk-one' })] });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({ code: 'adapter_unavailable' });
  });

  it('throws an explicit error, not an empty list, when neither live nor cached models exist', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [],
    });
    getModelsMock.mockRejectedValue(new Error('HTTP 401: unauthorized'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({ code: 'no_models' });
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toThrow(/HTTP 401/);
  });

  it('reports the oauth cloud discovery limitation instead of pretending to succeed', async () => {
    getOauthInfoFromAccountMock.mockReturnValue({ provider: 'codex' });
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one', oauthProvider: 'codex' })],
      modelAvailability: [],
    });
    getModelsMock.mockResolvedValue([]);

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({ code: 'no_models', oauthProvider: 'codex' });
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toThrow(/codex/i);
  });

  it('notes the skipped oauth cloud discovery when cached models are served instead', async () => {
    getOauthInfoFromAccountMock.mockReturnValue({ provider: 'claude' });
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one', oauthProvider: 'claude' })],
      modelAvailability: [{ modelName: 'claude-opus-5' }],
    });
    getModelsMock.mockResolvedValue([]);

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.source).toBe('cached');
    expect(result.models).toEqual(['claude-opus-5']);
    expect(result.notes?.join(' ')).toMatch(/claude/i);
  });

  it('never writes to the database on the success path', async () => {
    primeTables({ accounts: [account({ id: 1, apiToken: 'sk-one' })] });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(dbUpdateMock).not.toHaveBeenCalled();
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });

  it('never writes to the database on the cached-fallback and failure paths', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    getModelsMock.mockRejectedValue(new Error('boom'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    primeTables({ accounts: [account({ id: 1, apiToken: null, accessToken: '' })] });
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 })).rejects.toThrow();

    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(dbUpdateMock).not.toHaveBeenCalled();
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });

  it('does not import the routing layer so it works with routing disabled', async () => {
    const moduleSource = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('./modelProbeDiscoveryService.ts', import.meta.url), 'utf8'));

    expect(moduleSource).not.toMatch(/tokenRouter/);
    expect(moduleSource).not.toMatch(/routeChannels|tokenRoutes/);
    expect(moduleSource).not.toMatch(/refreshModelsForAccount/);
    expect(moduleSource).not.toMatch(/db\.(insert|update|delete)\b/);
  });
});
