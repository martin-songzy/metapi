import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectAllMock = vi.fn();
const selectGetMock = vi.fn();
const selectWhereMock = vi.fn();
const dbInsertMock = vi.fn();
const dbUpdateMock = vi.fn();
const dbDeleteMock = vi.fn();

const requireSiteApiBaseUrlMock = vi.fn();
const getAdapterMock = vi.fn();
const resolvePlatformUserIdMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withAccountProxyOverrideMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();
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
      orderBy: () => chain,
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
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
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
  let tokenCatalogFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    selectAllMock.mockReset();
    selectGetMock.mockReset();
    selectWhereMock.mockReset();
    dbInsertMock.mockReset();
    dbUpdateMock.mockReset();
    dbDeleteMock.mockReset();
    requireSiteApiBaseUrlMock.mockReset();
    getAdapterMock.mockReset();
    resolvePlatformUserIdMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withAccountProxyOverrideMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset();
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
    withSiteRecordProxyRequestInitMock.mockImplementation(
      async (_site: unknown, init: RequestInit) => init,
    );
    // Every account fixture carries an apiToken, so discovery now tries the
    // token-scoped `/v1/models` catalog before the adapter. Default the fetch stub
    // to a 404 so all pre-existing tests exercise the FALLBACK path deterministically
    // instead of attempting real DNS lookups against the fake hostname.
    tokenCatalogFetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', tokenCatalogFetchMock);
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

  // The JS re-sort exists purely to make NULL/undefined ordering identical across
  // SQLite/MySQL/Postgres, where NULL-under-DESC differs. These cases pin that
  // property: each one goes red if the null guards in compareAccountPriority are
  // dropped.
  it('treats a missing sortOrder as 0 when ordering', async () => {
    primeTables({
      accounts: [
        { ...account({ id: 1, apiToken: 'sk-one' }), sortOrder: 5 },
        { ...account({ id: 2, apiToken: 'sk-two' }), sortOrder: undefined },
        { ...account({ id: 3, apiToken: 'sk-three' }), sortOrder: null },
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    // id 2 (sortOrder undefined -> 0) and id 3 (null -> 0) both outrank id 1's 5,
    // and id 2 wins the id tiebreak.
    expect(result.account.id).toBe(2);
  });

  it('treats a missing isPinned as not pinned when ordering', async () => {
    primeTables({
      accounts: [
        { ...account({ id: 5, apiToken: 'sk-five' }), isPinned: undefined, sortOrder: 1 },
        { ...account({ id: 6, apiToken: 'sk-six' }), isPinned: true, sortOrder: 9 },
        { ...account({ id: 7, apiToken: 'sk-seven' }), isPinned: null, sortOrder: 0 },
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    // Only id 6 is genuinely pinned, so it wins despite the worst sortOrder.
    expect(result.account.id).toBe(6);
  });

  it('orders a mix of null, false and true isPinned with null and set sortOrder', async () => {
    primeTables({
      accounts: [
        { ...account({ id: 10, apiToken: 'sk-ten' }), isPinned: false, sortOrder: null },
        { ...account({ id: 11, apiToken: 'sk-eleven' }), isPinned: null, sortOrder: 0 },
        { ...account({ id: 12, apiToken: 'sk-twelve' }), isPinned: true, sortOrder: 5 },
        { ...account({ id: 13, apiToken: 'sk-thirteen' }), isPinned: true, sortOrder: null },
        { ...account({ id: 14, apiToken: 'sk-fourteen' }), isPinned: true, sortOrder: 0 },
      ],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    // Pinned group: 13 (null -> 0), 14 (0), 12 (5). 13 and 14 tie on sortOrder,
    // so the id tiebreak picks 13.
    expect(result.account.id).toBe(13);
    expect(result.credential).toBe('sk-thirteen');
  });

  it('treats a null status as active so legacy accounts stay previewable', async () => {
    primeTables({
      accounts: [{ ...account({ id: 1, apiToken: 'sk-legacy' }), status: null }],
    });

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.account.id).toBe(1);
    expect(result.credential).toBe('sk-legacy');

    // The SQL predicate must admit NULL too, otherwise the row never reaches the
    // JS filter on a real database.
    const accountWhere = selectWhereMock.mock.calls.find((call) => call[0] === 'accounts');
    expect(accountWhere).toBeDefined();
    expect(JSON.stringify(accountWhere![1])).toMatch(/is null/i);
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

  // Most adapters (newApi.ts:875, standardApiProvider.ts:75) do `catch { return [] }`,
  // so a revoked credential arrives here as an ordinary empty list. Only oneApi and
  // veloera propagate. A cached result therefore has to be self-describing as
  // unverified, whatever the adapter did.
  it('marks cached models from a silently-empty adapter as empty_unknown, not clean success', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-maybe-revoked' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    // Exactly what an error-swallowing adapter does on a revoked credential.
    getModelsMock.mockResolvedValue([]);

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.source).toBe('cached');
    expect(result.liveFailure).toBeDefined();
    expect(result.liveFailure!.kind).toBe('empty_unknown');
    // Must not read as a verified credential.
    expect(result.notes?.join(' ')).toMatch(/未验证/);
  });

  it('never returns a cached result without a reason, whatever the adapter did', async () => {
    const adapterBehaviours: Array<() => void> = [
      () => getModelsMock.mockResolvedValue([]),
      () => getModelsMock.mockResolvedValue(['   ', null as unknown as string]),
      () => getModelsMock.mockRejectedValue(new Error('HTTP 502: bad gateway')),
      () => getModelsMock.mockRejectedValue(new Error('fetch failed')),
    ];

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    for (const applyBehaviour of adapterBehaviours) {
      primeTables({
        accounts: [account({ id: 1, apiToken: 'sk-one' })],
        modelAvailability: [{ modelName: 'cached-model' }],
      });
      getModelsMock.mockReset();
      applyBehaviour();

      const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

      expect(result.source).toBe('cached');
      // The invariant: cached implies a stated, non-null reason.
      expect(result.liveFailure).not.toBeNull();
      expect(result.liveFailure).not.toBeUndefined();
      expect(result.liveFailure!.message.length).toBeGreaterThan(0);
    }
  });

  /**
   * Value-based credential masking.
   *
   * `platforms/base.ts` surfaces a failed management call as
   * `HTTP ${status}: ${body}` — the upstream response body verbatim — so a relay
   * that echoes the rejected key in a 401/500 body puts it straight into the text
   * this module builds. Shape-based redaction at the HTTP boundary cannot save us
   * here: the credential below is a Veloera/AnyRouter-style opaque session value
   * with no recognizable prefix, no delimiter and no label, which is exactly the
   * shape those relays issue. Masking by value is the only thing that catches it,
   * and every message this module produces is served to the browser.
   */
  describe('credential masking in discovery-authored text', () => {
    const OPAQUE_CREDENTIAL = 'MTcwMDAwMDAwMHxEdi1CQkFFQ180SUFBUkFC';

    it('masks the credential echoed back in a live failure message and notes', async () => {
      primeTables({
        accounts: [account({ id: 1, apiToken: OPAQUE_CREDENTIAL })],
        modelAvailability: [{ modelName: 'cached-model' }],
      });
      getModelsMock.mockRejectedValue(
        new Error(`HTTP 500: {"error":"session ${OPAQUE_CREDENTIAL} rejected"}`),
      );

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

      expect(result.source).toBe('cached');
      const serialized = JSON.stringify({ liveFailure: result.liveFailure, notes: result.notes });
      expect(serialized).not.toContain(OPAQUE_CREDENTIAL);
      expect(result.liveFailure!.message).toContain('[redacted-credential]');
      expect(result.notes?.join(' ')).toContain('[redacted-credential]');
      // The surrounding upstream wording survives, so the message is still useful.
      expect(result.liveFailure!.message).toContain('HTTP 500');
      // The credential itself is still returned for the probe to use; only the
      // human-readable text is masked.
      expect(result.credential).toBe(OPAQUE_CREDENTIAL);
    });

    it('masks the credential in the no_models error message', async () => {
      primeTables({
        accounts: [account({ id: 1, apiToken: OPAQUE_CREDENTIAL })],
        modelAvailability: [],
      });
      // 500, not 401/403: an auth status takes the `credential_invalid` branch
      // instead, which the next test covers.
      getModelsMock.mockRejectedValue(new Error(`HTTP 500: bad session=${OPAQUE_CREDENTIAL}`));

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
        .rejects.toThrow(/\[redacted-credential\]/);

      // Same call again to inspect the whole error rather than only the message.
      await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }).catch((error: unknown) => {
        const failure = error as { message: string; liveFailure: { message: string } | null };
        expect(failure.message).not.toContain(OPAQUE_CREDENTIAL);
        expect(failure.liveFailure?.message).not.toContain(OPAQUE_CREDENTIAL);
      });
    });

    it('masks the credential in the credential_invalid error raised on a 401', async () => {
      primeTables({
        accounts: [account({ id: 1, apiToken: OPAQUE_CREDENTIAL })],
        modelAvailability: [{ modelName: 'cached-model' }],
      });
      getModelsMock.mockRejectedValue(
        new Error(`HTTP 401: token ${OPAQUE_CREDENTIAL} is not valid`),
      );

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }).catch((error: unknown) => {
        const failure = error as {
          code: string;
          message: string;
          liveFailure: { message: string } | null;
        };
        expect(failure.code).toBe('credential_invalid');
        expect(JSON.stringify(failure.liveFailure)).not.toContain(OPAQUE_CREDENTIAL);
        expect(failure.message).not.toContain(OPAQUE_CREDENTIAL);
      });
    });

    it('masks the credential in the base_url_unavailable error message', async () => {
      primeTables({ accounts: [account({ id: 1, apiToken: OPAQUE_CREDENTIAL })] });
      requireSiteApiBaseUrlMock.mockRejectedValue(
        new Error(`probe https://relay/api/${OPAQUE_CREDENTIAL}/status failed`),
      );

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }).catch((error: unknown) => {
        const failure = error as { code: string; message: string };
        expect(failure.code).toBe('base_url_unavailable');
        expect(failure.message).not.toContain(OPAQUE_CREDENTIAL);
        expect(failure.message).toContain('[redacted-credential]');
      });
    });

    it('leaves a short placeholder credential alone so ordinary text survives', async () => {
      // Below the 8-character floor: blanket-replacing a 3-character "secret" would
      // shred unrelated words out of the upstream wording.
      primeTables({
        accounts: [account({ id: 1, apiToken: 'abc' })],
        modelAvailability: [{ modelName: 'cached-model' }],
      });
      isMaskedTokenValueMock.mockReturnValue(false);
      getModelsMock.mockRejectedValue(new Error('HTTP 500: abcdef alphabet soup'));

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

      expect(result.liveFailure!.message).toContain('abcdef alphabet soup');
      expect(result.liveFailure!.message).not.toContain('[redacted-credential]');
    });
  });

  it('attaches a reason to no_models even when the adapter failed silently', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [],
    });
    getModelsMock.mockResolvedValue([]);

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({
        code: 'no_models',
        liveFailure: { kind: 'empty_unknown' },
      });
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

  // A revoked credential must never be handed back with cached models: preview
  // would look successful while every probe in the run phase is doomed.
  it('refuses to serve cached models under a credential rejected with HTTP 401', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-revoked' })],
      modelAvailability: [{ modelName: 'stale-model' }],
    });
    getModelsMock.mockRejectedValue(new Error('HTTP 401: unauthorized'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({
        code: 'credential_invalid',
        liveFailure: { kind: 'auth', status: 401 },
      });
  });

  it('refuses to serve cached models under a credential rejected with HTTP 403', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-forbidden' })],
      modelAvailability: [{ modelName: 'stale-model' }],
    });
    getModelsMock.mockRejectedValue(new Error('HTTP 403: forbidden'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({
        code: 'credential_invalid',
        liveFailure: { kind: 'auth', status: 403 },
      });
  });

  it('reports a machine-readable liveFailure alongside cached models', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    getModelsMock.mockRejectedValue(new Error('HTTP 503: upstream unavailable'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.source).toBe('cached');
    expect(result.liveFailure).toEqual({
      kind: 'transport',
      status: 503,
      message: 'HTTP 503: upstream unavailable',
    });
  });

  it('classifies a timeout as a timeout rather than an auth failure', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    getModelsMock.mockImplementation(() => new Promise(() => {}));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 30 });

    expect(result.liveFailure?.kind).toBe('timeout');
    expect(result.liveFailure?.status).toBeNull();
  });

  it('does not mistake an upstream body that merely mentions unauthorized for an auth failure', async () => {
    primeTables({
      accounts: [account({ id: 1, apiToken: 'sk-one' })],
      modelAvailability: [{ modelName: 'cached-model' }],
    });
    getModelsMock.mockRejectedValue(new Error('HTTP 500: handler threw Unauthorized'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

    expect(result.source).toBe('cached');
    expect(result.liveFailure?.kind).toBe('transport');
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
    getModelsMock.mockRejectedValue(new Error('HTTP 502: bad gateway'));

    const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toMatchObject({
        code: 'no_models',
        liveFailure: { kind: 'transport', status: 502 },
      });
    await expect(discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 }))
      .rejects.toThrow(/HTTP 502/);
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

  /**
   * Read-only is pinned behaviourally by the test above (no insert/update/delete
   * on either path). This one adds the structural half: the write-path helpers and
   * routing modules are not named in this file's own import list.
   *
   * "routing-free" means exactly that — this file. The transitive closure of the
   * probe feature does reach routing via runtimeModelProbe -> oauth/service ->
   * modelService -> tokenRouter, so no per-file import check can establish the
   * closure property, and this one does not claim to.
   */
  it('stays read-only, and names no write-path or routing module in its own imports', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('./modelProbeDiscoveryService.ts', import.meta.url), 'utf8'));

    // Strip comments first: the doc comments legitimately name the very helpers
    // they explain the absence of, and documenting a trap should never be what
    // turns this test red.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const forbidden = [
      // Write-path model discovery: rewrites availability, health and routes.
      'refreshModelsForAccount',
      // Writes endpoint cooldown state; requireSiteApiBaseUrl is the read-only door.
      'runWithSiteApiEndpointPool',
      'recordSiteApiEndpoint',
      // Routing layer — must stay usable with PROXY_ROUTING_ENABLED=false.
      'tokenRouter',
      'routeRefresh',
      'routeDecision',
      'routeCooldown',
      'route_channels',
      'token_routes',
      'routeChannels',
      'tokenRoutes',
    ];

    const importSpecifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of importSpecifiers) {
      for (const name of forbidden) {
        expect(specifier).not.toContain(name);
      }
    }

    for (const name of forbidden) {
      expect(code).not.toContain(name);
    }

    // Read-only: no mutating query builder call, and no transaction wrapper that
    // could hide one.
    expect(code).not.toMatch(/db\.(insert|update|delete)\b/);
    expect(code).not.toMatch(/db\.transaction\b/);
  });

  /**
   * Token-scoped discovery.
   *
   * The adapter path lists what the USER can reach; the probe fires with a TOKEN,
   * and tokens sit in one group — so a listed model can be unreachable for the key
   * actually being used, and the sweep reported "failures" for models that work
   * through a different key on the same site. `/v1/models` authenticated AS the
   * probe key makes the list and the credential agree.
   */
  describe('token-scoped model catalog', () => {
    function primeApiTokenAccount() {
      primeTables({ accounts: [account({ id: 1, apiToken: 'sk-probe-key' })] });
    }

    it('prefers /v1/models answered to the probe key over the adapter listing', async () => {
      primeApiTokenAccount();
      tokenCatalogFetchMock.mockImplementation(async () => new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'm-in-group-a' }, { id: 'm-in-group-b' }],
      }), { status: 200 }));
      // The adapter would have listed a model the key cannot reach; if this ever
      // gets called the test below fails, which is the actual point.
      getModelsMock.mockResolvedValue(['m-in-group-a', 'm-not-for-this-key']);

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

      expect(result.source).toBe('live');
      expect(result.models).toEqual(['m-in-group-a', 'm-in-group-b']);
      expect(result.credential).toBe('sk-probe-key');
      expect(getModelsMock).not.toHaveBeenCalled();
      // The request must carry the SAME credential probing will use...
      const [url, init] = tokenCatalogFetchMock.mock.calls[0];
      expect(url).toBe('https://api.probe.example.com/v1/models');
      expect(new Headers((init as RequestInit).headers).get('authorization')).toBe('Bearer sk-probe-key');
    });

    it.each([
      ['a 404 from a platform without the endpoint', 404, 'nope'],
      ['malformed JSON', 200, '<html>login</html>'],
      ['an empty group', 200, JSON.stringify({ data: [] })],
    ])('falls back to the adapter on %s', async (_name, status, body) => {
      primeApiTokenAccount();
      tokenCatalogFetchMock.mockImplementation(async () => new Response(body, { status }));

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

      expect(result.source).toBe('live');
      expect(result.models).toEqual(['gpt-5.4']);
      expect(getModelsMock).toHaveBeenCalledTimes(1);
    });

    it('does not try the token catalog for session-style credentials', async () => {
      // An access token is not a Bearer key; hitting /v1/models with it is noise.
      // The empty-array branch of the mock matters: `[]` and null are distinct in
      // the helper, and neither may trigger an attempt here.
      primeTables({ accounts: [account({ id: 1, accessToken: 'session-token-value' })] });
      getModelsMock.mockResolvedValue(['gpt-5.4']);

      const { discoverModelsForActiveProbe } = await import('./modelProbeDiscoveryService.js');
      const result = await discoverModelsForActiveProbe({ siteId: 7, timeoutMs: 500 });

      expect(tokenCatalogFetchMock).not.toHaveBeenCalled();
      expect(result.models).toEqual(['gpt-5.4']);
    });
  });
});
