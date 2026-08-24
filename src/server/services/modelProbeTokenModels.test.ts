import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseTokenModelsPayload,
  fetchTokenAccessibleModels,
  type FetchLike,
} from './modelProbeTokenModels.js';

describe('parseTokenModelsPayload', () => {
  it('reads the standard OpenAI list shape', () => {
    expect(parseTokenModelsPayload({
      object: 'list',
      data: [{ id: 'gpt-5.4' }, { id: 'claude-opus-4-8' }],
    })).toEqual(['gpt-5.4', 'claude-opus-4-8']);
  });

  it('accepts model/name as the identifier when id is absent', () => {
    expect(parseTokenModelsPayload({
      data: [{ model: 'glm-5.2' }, { name: 'deepseek-v4' }, {}],
    })).toEqual(['glm-5.2', 'deepseek-v4']);
  });

  it('accepts a bare top-level array', () => {
    expect(parseTokenModelsPayload(['m-a', 'm-b'])).toEqual(['m-a', 'm-b']);
  });

  it('skips non-string identifiers instead of failing the whole payload', () => {
    expect(parseTokenModelsPayload({
      data: [{ id: 'm-a' }, { id: 42 }, { id: null }, 'raw-string', { id: 'm-b' }],
    })).toEqual(['m-a', 'raw-string', 'm-b']);
  });

  it.each([
    ['returns null for a body with no data array', { object: 'list' }],
    ['returns null for data that is not an array', { data: 'gpt-5.4' }],
    ['returns null for a scalar payload', 42],
  ] as Array<[string, unknown]>)('%s', (_name, payload) => {
    expect(parseTokenModelsPayload(payload)).toBeNull();
  });

  it('distinguishes an authoritative empty list from a malformed one', () => {
    // The caller treats these oppositely: empty means "this key reaches nothing",
    // null means "the endpoint told us nothing usable" and triggers the adapter
    // fallback. Collapsing them would either fabricate targets or hide real ones.
    expect(parseTokenModelsPayload({ data: [] })).toEqual([]);
    expect(parseTokenModelsPayload({ error: 'nope' })).toBeNull();
  });
});

describe('fetchTokenAccessibleModels', () => {
  const BASE = 'https://relay.example.com';
  const KEY = 'sk-probe-key-value';

  function jsonResponder(status: number, body: unknown) {
    return vi.fn(async () => new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status },
    )) as FetchLike;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GETs /v1/models with the probe credential as Bearer', async () => {
    const fetchImpl = jsonResponder(200, { data: [{ id: 'm-a' }] });
    const result = await fetchTokenAccessibleModels({
      baseUrl: `${BASE}/`,
      credential: KEY,
      timeoutMs: 1_000,
      fetchImpl,
    });

    expect(result).toEqual(['m-a']);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/models`);
    expect((init as RequestInit).method).toBe('GET');
    expect(new Headers((init as RequestInit).headers).get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('lets the caller install its proxy dispatcher through buildRequestInit', async () => {
    const fetchImpl = jsonResponder(200, { data: [{ id: 'm-a' }] });
    await fetchTokenAccessibleModels({
      baseUrl: BASE,
      credential: KEY,
      timeoutMs: 1_000,
      fetchImpl,
      buildRequestInit: (init) => ({ ...init, headers: { ...(init.headers as HeadersInit), 'x-via': 'proxy' } }),
    });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get('x-via')).toBe('proxy');
  });

  it.each([
    ['https://relay.example.com', 'https://relay.example.com/v1/models'],
    ['https://relay.example.com/', 'https://relay.example.com/v1/models'],
    ['https://relay.example.com/v1', 'https://relay.example.com/v1/models'],
    ['https://relay.example.com/api/v1', 'https://relay.example.com/api/v1/models'],
  ])('joins %s without doubling the version segment', async (baseUrl, expected) => {
    const fetchImpl = jsonResponder(200, { data: [{ id: 'm-a' }] });
    await fetchTokenAccessibleModels({
      baseUrl,
      credential: KEY,
      timeoutMs: 1_000,
      fetchImpl,
    });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    // A doubled `/v1/v1/models` is the classic failure here — some sites configure
    // their base WITH the version suffix already.
    expect(url).toBe(expected);
    expect(url).not.toContain('/v1/v1/');
  });

  it.each([
    ['HTTP 404 when the site does not expose the endpoint', 404, 'not found'],
    ['HTTP 401 when the site locks the endpoint down', 401, 'unauthorized'],
    ['HTML instead of JSON', 200, '<html>login</html>'],
  ])('falls back to null on %s', async (_name, status, body) => {
    const result = await fetchTokenAccessibleModels({
      baseUrl: BASE,
      credential: KEY,
      timeoutMs: 1_000,
      fetchImpl: jsonResponder(status, body),
    });
    expect(result).toBeNull();
  });

  it('returns null instead of throwing when fetch rejects', async () => {
    const result = await fetchTokenAccessibleModels({
      baseUrl: BASE,
      credential: KEY,
      timeoutMs: 1_000,
      fetchImpl: (async () => { throw new Error('socket closed'); }) as FetchLike,
    });
    // The contract the discovery caller relies on: this function NEVER throws, so
    // the fallback path needs no try/catch of its own.
    expect(result).toBeNull();
  });

  it('gives up after the timeout rather than hanging the sweep', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    })) as FetchLike;

    const pending = fetchTokenAccessibleModels({
      baseUrl: BASE,
      credential: KEY,
      timeoutMs: 50,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBeNull();
  });

  it('refuses to send an empty credential', async () => {
    const fetchImpl = jsonResponder(200, { data: [{ id: 'm-a' }] });
    const result = await fetchTokenAccessibleModels({
      baseUrl: BASE,
      credential: '   ',
      timeoutMs: 1_000,
      fetchImpl,
    });
    expect(result).toBeNull();
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
