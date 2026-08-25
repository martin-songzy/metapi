import { describe, expect, it } from 'vitest';

import { GenericAdapter } from './generic.js';

/**
 * Overrides the one protected seam (`fetchJson`) the same way
 * `standardApiProvider.test.ts` does, so no network is touched and the adapter's
 * own error handling is what gets exercised.
 */
class TestGenericAdapter extends GenericAdapter {
  lastUrl = '';
  lastHeaders: Record<string, string> | undefined;
  respond: (url: string) => unknown = () => ({ data: [] });

  protected override async fetchJson<T>(url: string, options?: { headers?: Record<string, string> }): Promise<T> {
    this.lastUrl = url;
    this.lastHeaders = options?.headers;
    return this.respond(url) as T;
  }
}

describe('GenericAdapter', () => {
  it('is named generic', () => {
    expect(new GenericAdapter().platformName).toBe('generic');
  });

  /**
   * The single most important property in this file.
   *
   * This adapter's `getModels` succeeds against nearly any OpenAI-compatible
   * relay, which includes every New API / One API fork. If it could win
   * auto-detection it would claim those sites and cost them their real adapter's
   * check-in, balance and token-minting support. The URLs below are exactly the
   * ones other adapters answer true for.
   */
  it('never claims a site during auto-detection, whatever the URL looks like', async () => {
    const adapter = new GenericAdapter();
    const urls = [
      'https://api.openai.com',
      'https://api.anthropic.com',
      'https://relay.example.com',
      'https://anyrouter.example.com',
      'https://veloera.example.com',
      'https://sub2api.example.com',
      'https://newapi.example.com',
      '',
    ];

    for (const url of urls) {
      expect(await adapter.detect(url)).toBe(false);
    }
  });

  it('reads models from the standard endpoint with a bearer header', async () => {
    const adapter = new TestGenericAdapter();
    adapter.respond = () => ({ data: [{ id: 'gpt-5.4' }, { id: ' claude-sonnet-5 ' }, { id: '' }] });

    await expect(adapter.getModels('https://relay.example.com', 'sk-generic')).resolves.toEqual([
      'gpt-5.4',
      'claude-sonnet-5',
    ]);
    expect(adapter.lastUrl).toBe('https://relay.example.com/v1/models');
    expect(adapter.lastHeaders).toEqual({ Authorization: 'Bearer sk-generic' });
  });

  it('omits the auth header entirely when no credential is supplied', async () => {
    // A relay that needs no key must not receive a literal `Bearer `.
    const adapter = new TestGenericAdapter();
    await adapter.getModels('https://relay.example.com', '');
    expect(adapter.lastHeaders).toEqual({});
  });

  /**
   * The never-throws contract. `fetchModelsFromStandardEndpoint` deliberately
   * throws on an unmappable payload so a real provider's mapper bug stays visible;
   * a generic site has no agreed shape to get wrong, so the same condition is a
   * fact about the upstream and must read as "no models" instead. This is what
   * allows a connection to be created against a site that cannot be verified.
   */
  it.each([
    ['an unmappable object', () => ({ unexpected: true })],
    ['a bare array', () => ['gpt-5.4']],
    ['a string body', () => 'not json at all'],
    ['null', () => null],
    ['a thrown transport error', () => { throw new Error('ECONNREFUSED'); }],
  ])('reports no models rather than throwing for %s', async (_label, respond) => {
    const adapter = new TestGenericAdapter();
    adapter.respond = respond as (url: string) => unknown;

    await expect(adapter.getModels('https://relay.example.com', 'sk-generic')).resolves.toEqual([]);
  });

  /**
   * `balanceService` treats a THROWN balance error as evidence the account is
   * broken — it flips runtime health to unhealthy and can raise a token-expired
   * alert. A generic site can never report balance, which is a property of the
   * platform rather than a fault of the account, so these must resolve quietly.
   */
  it('answers unsupported for management features instead of throwing', async () => {
    const adapter = new GenericAdapter();

    await expect(adapter.login('https://relay.example.com', 'u', 'p')).resolves.toMatchObject({ success: false });
    await expect(adapter.checkin('https://relay.example.com', 'token')).resolves.toMatchObject({ success: false });
    await expect(adapter.getUserInfo('https://relay.example.com', 'token')).resolves.toBe(null);
    await expect(adapter.getBalance('https://relay.example.com', 'token')).resolves.toEqual({
      balance: 0,
      used: 0,
      quota: 0,
    });
    await expect(adapter.getApiToken('https://relay.example.com', 'token')).resolves.toBe(null);
    // `['default']` is the base class's repo-wide convention for "this platform
    // exposes no group concept", not a value this adapter chose. Asserted as-is so
    // the test documents the inherited contract rather than a wish.
    await expect(adapter.getUserGroups('https://relay.example.com', 'token')).resolves.toEqual(['default']);
    await expect(adapter.getSiteAnnouncements('https://relay.example.com', 'token')).resolves.toEqual([]);
  });

  /**
   * `verifyToken` is inherited. Its session branch needs `getUserInfo`, which is
   * null here, so it falls through to the API-key branch and reports `apikey` when
   * models come back. An unverifiable site reports `unknown` — which the account
   * creation path must be able to accept for a generic site rather than refuse.
   */
  it('verifies a credential as an api key when models come back, unknown when they do not', async () => {
    const working = new TestGenericAdapter();
    working.respond = () => ({ data: [{ id: 'gpt-5.4' }] });
    await expect(working.verifyToken('https://relay.example.com', 'sk-generic')).resolves.toMatchObject({
      tokenType: 'apikey',
      models: ['gpt-5.4'],
    });

    const silent = new TestGenericAdapter();
    silent.respond = () => ({ data: [] });
    await expect(silent.verifyToken('https://relay.example.com', 'sk-generic')).resolves.toMatchObject({
      tokenType: 'unknown',
    });
  });
});
