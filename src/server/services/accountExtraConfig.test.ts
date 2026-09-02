import { describe, expect, it } from 'vitest';
import {
  buildStoredSub2ApiSubscriptionSummary,
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
  getPlatformUserIdFromExtraConfig,
  getProxyRefFromExtraConfig,
  parseConnectionProxyRefInput,
  PROXY_REF_INHERIT,
  withProxyRefInExtraConfig,
  getSub2ApiAuthFromExtraConfig,
  getSub2ApiSubscriptionFromExtraConfig,
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
  normalizeCredentialMode,
  resolvePlatformUserId,
  requiresManagedAccountTokens,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';

describe('accountExtraConfig', () => {
  it('reads platformUserId from extra config when present', () => {
    expect(getPlatformUserIdFromExtraConfig(JSON.stringify({ platformUserId: 11494 }))).toBe(11494);
    expect(getPlatformUserIdFromExtraConfig(JSON.stringify({ platformUserId: '7659' }))).toBe(7659);
    expect(getPlatformUserIdFromExtraConfig({ platformUserId: 2233 })).toBe(2233);
  });

  it('guesses platformUserId from username suffix digits', () => {
    expect(guessPlatformUserIdFromUsername('linuxdo_7659')).toBe(7659);
    expect(guessPlatformUserIdFromUsername('user11494')).toBe(11494);
    expect(guessPlatformUserIdFromUsername('abc')).toBeUndefined();
    expect(guessPlatformUserIdFromUsername('id_12')).toBeUndefined();
  });

  it('prefers configured user id over guessed user id', () => {
    expect(resolvePlatformUserId(JSON.stringify({ platformUserId: 5001 }), 'linuxdo_7659')).toBe(5001);
  });

  it('merges platformUserId into existing config without dropping keys', () => {
    const merged = mergeAccountExtraConfig(
      JSON.stringify({
        foo: 'bar',
        autoRelogin: { username: 'demo', passwordCipher: 'cipher' },
      }),
      { platformUserId: 7659 },
    );

    expect(merged).toBeTruthy();
    const parsed = JSON.parse(merged!);
    expect(parsed.foo).toBe('bar');
    expect(parsed.autoRelogin?.username).toBe('demo');
    expect(parsed.platformUserId).toBe(7659);
  });

  it('merges object extra config without dropping existing keys', () => {
    const merged = mergeAccountExtraConfig(
      {
        foo: 'bar',
        credentialMode: 'session',
        autoRelogin: { username: 'demo', passwordCipher: 'cipher' },
      },
      { platformUserId: 9001 },
    );

    expect(JSON.parse(merged)).toEqual(expect.objectContaining({
      foo: 'bar',
      credentialMode: 'session',
      platformUserId: 9001,
      autoRelogin: expect.objectContaining({
        username: 'demo',
        passwordCipher: 'cipher',
      }),
    }));
  });

  it('parses credential mode from extra config', () => {
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'apikey' }))).toBe('apikey');
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'session' }))).toBe('session');
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'AUTO' }))).toBe('auto');
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'unknown' }))).toBeUndefined();
  });

  it('normalizes credential mode input', () => {
    expect(normalizeCredentialMode(' apikey ')).toBe('apikey');
    expect(normalizeCredentialMode('session')).toBe('session');
    expect(normalizeCredentialMode('AUTO')).toBe('auto');
    expect(normalizeCredentialMode('abc')).toBeUndefined();
  });

  it('parses managed sub2api refresh token config from extra config', () => {
    expect(getSub2ApiAuthFromExtraConfig(JSON.stringify({
      sub2apiAuth: { refreshToken: 'refresh-1', tokenExpiresAt: 1760000000000 },
    }))).toEqual({
      refreshToken: 'refresh-1',
      tokenExpiresAt: 1760000000000,
    });
    expect(getSub2ApiAuthFromExtraConfig(JSON.stringify({
      sub2apiAuth: { refreshToken: '  ' },
    }))).toBeNull();
  });

  /**
   * The three-state read is the whole reason a connection can refuse a proxy its site
   * has set. Collapsing "key absent" into "explicitly direct" would make 跟随站点 and
   * 不走代理 the same answer, which is the gap the old address/opt-in pair had.
   */
  it('distinguishes absent, null and set proxyRef in extra config', () => {
    expect(getProxyRefFromExtraConfig(JSON.stringify({}))).toBeUndefined();
    expect(getProxyRefFromExtraConfig(JSON.stringify({ proxyRef: null }))).toBeNull();
    expect(getProxyRefFromExtraConfig(JSON.stringify({ proxyRef: 'px_hk' }))).toBe('px_hk');
    expect(getProxyRefFromExtraConfig(JSON.stringify({ proxyRef: '  px_hk  ' }))).toBe('px_hk');
  });

  // A corrupt value must read as "no opinion", never as an explicit direct connection:
  // garbage in the row must not silently override the site's choice.
  it('reads a garbage proxyRef as no opinion rather than as direct', () => {
    expect(getProxyRefFromExtraConfig(JSON.stringify({ proxyRef: '' }))).toBeUndefined();
    expect(getProxyRefFromExtraConfig(JSON.stringify({ proxyRef: '   ' }))).toBeUndefined();
    expect(getProxyRefFromExtraConfig(JSON.stringify({ proxyRef: 42 }))).toBeUndefined();
    expect(getProxyRefFromExtraConfig('invalid-json')).toBeUndefined();
    expect(getProxyRefFromExtraConfig(null)).toBeUndefined();
    expect(getProxyRefFromExtraConfig(undefined)).toBeUndefined();
  });

  it('writes the three states back, removing the key only for inherit', () => {
    expect(JSON.parse(withProxyRefInExtraConfig(JSON.stringify({ a: 1 }), 'px_hk'))).toEqual({ a: 1, proxyRef: 'px_hk' });
    expect(JSON.parse(withProxyRefInExtraConfig(JSON.stringify({ a: 1 }), null))).toEqual({ a: 1, proxyRef: null });
    expect(JSON.parse(withProxyRefInExtraConfig(JSON.stringify({ a: 1, proxyRef: 'px_hk' }), undefined))).toEqual({ a: 1 });
  });

  it('maps the wire sentinel onto the stored three states', () => {
    expect(parseConnectionProxyRefInput('px_hk')).toBe('px_hk');
    expect(parseConnectionProxyRefInput(null)).toBeNull();
    expect(parseConnectionProxyRefInput(PROXY_REF_INHERIT)).toBeUndefined();
    expect(parseConnectionProxyRefInput('')).toBeUndefined();
  });

  it('treats auto-mode api token connections as direct-account routable', () => {
    expect(supportsDirectAccountRoutingConnection({
      accessToken: '',
      apiToken: 'sk-demo',
      extraConfig: null,
    })).toBe(true);
    expect(requiresManagedAccountTokens({
      accessToken: '',
      apiToken: 'sk-demo',
      extraConfig: null,
    })).toBe(false);
  });

  it('treats oauth and session connections as non-managed-token direct routes only when intended', () => {
    expect(supportsDirectAccountRoutingConnection({
      accessToken: 'oauth-access-token',
      apiToken: null,
      extraConfig: JSON.stringify({ credentialMode: 'session', oauth: { provider: 'codex' } }),
    })).toBe(true);
    expect(requiresManagedAccountTokens({
      accessToken: 'oauth-access-token',
      apiToken: null,
      extraConfig: JSON.stringify({ credentialMode: 'session', oauth: { provider: 'codex' } }),
    })).toBe(false);
    expect(supportsDirectAccountRoutingConnection({
      accessToken: 'session-token',
      apiToken: 'sk-default',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toBe(false);
    expect(requiresManagedAccountTokens({
      accessToken: 'session-token',
      apiToken: 'sk-default',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toBe(true);
  });

  it('recognizes structured oauth provider columns even when extraConfig omits oauth.provider', () => {
    const structuredOauthAccount = {
      oauthProvider: 'codex',
      accessToken: 'oauth-access-token',
      apiToken: null,
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          email: 'oauth-user@example.com',
        },
      }),
    };

    expect(hasOauthProvider(structuredOauthAccount)).toBe(true);
    expect(supportsDirectAccountRoutingConnection(structuredOauthAccount)).toBe(true);
    expect(requiresManagedAccountTokens(structuredOauthAccount)).toBe(false);
  });

  it('parses stored sub2api subscription summary from extra config', () => {
    const extraConfig = mergeAccountExtraConfig(null, {
      sub2apiSubscription: buildStoredSub2ApiSubscriptionSummary({
        activeCount: 1,
        totalUsedUsd: 3.5,
        subscriptions: [
          {
            id: 7,
            groupName: 'Pro',
            expiresAt: '2026-04-01T00:00:00.000Z',
            monthlyUsedUsd: 3.5,
            monthlyLimitUsd: 20,
          },
        ],
      }, 1760000000000),
    });

    expect(getSub2ApiSubscriptionFromExtraConfig(extraConfig)).toEqual({
      activeCount: 1,
      totalUsedUsd: 3.5,
      subscriptions: [
        {
          id: 7,
          groupName: 'Pro',
          expiresAt: '2026-04-01T00:00:00.000Z',
          monthlyUsedUsd: 3.5,
          monthlyLimitUsd: 20,
        },
      ],
      updatedAt: 1760000000000,
    });
  });
});
