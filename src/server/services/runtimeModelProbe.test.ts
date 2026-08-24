import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveUpstreamEndpointCandidatesMock = vi.fn();
const buildUpstreamEndpointRequestMock = vi.fn();
const dispatchRuntimeRequestMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();
const getOauthInfoFromAccountMock = vi.fn();
const buildOauthProviderHeadersMock = vi.fn();

vi.mock('./upstreamEndpointRuntime.js', () => ({
  resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
  buildUpstreamEndpointRequest: (...args: unknown[]) => buildUpstreamEndpointRequestMock(...args),
}));

vi.mock('./runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('./oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: (...args: unknown[]) => getOauthInfoFromAccountMock(...args),
}));

vi.mock('./oauth/service.js', () => ({
  buildOauthProviderHeaders: (...args: unknown[]) => buildOauthProviderHeadersMock(...args),
}));

describe('probeRuntimeModel', () => {
  const site = {
    id: 1,
    name: 'probe-site',
    url: 'https://probe.example.com',
    platform: 'new-api',
    status: 'active',
  } as any;

  const account = {
    id: 1,
    siteId: 1,
    username: 'probe-user',
    accessToken: '',
    apiToken: 'sk-probe',
    status: 'active',
    extraConfig: null,
  } as any;

  beforeEach(() => {
    vi.resetModules();
    resolveUpstreamEndpointCandidatesMock.mockReset();
    buildUpstreamEndpointRequestMock.mockReset();
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset();
    getOauthInfoFromAccountMock.mockReset();
    buildOauthProviderHeadersMock.mockReset();

    getOauthInfoFromAccountMock.mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReturnValue({});
    buildUpstreamEndpointRequestMock.mockReturnValue({
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-5.4' },
      runtime: {
        executor: 'default',
        modelName: 'gpt-5.4',
        stream: false,
      },
    });
    resolveChannelProxyUrlMock.mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockImplementation(async (_site: unknown, init: RequestInit) => init);
  });

  it('returns an inconclusive result instead of throwing when endpoint resolution fails', async () => {
    resolveUpstreamEndpointCandidatesMock.mockRejectedValue(new Error('resolution failed'));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 10,
    });

    expect(result.status).toBe('inconclusive');
    expect(result.reason).toContain('resolution failed');
    expect(result.latencyMs).not.toBeNull();
  });

  it('classifies a non-empty chat response as supported with endpoint metadata', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'supported',
      httpStatus: 200,
      failureKind: null,
      endpointUsed: 'chat',
    });
    expect(result.latencyMs).not.toBeNull();
  });

  it('classifies a 2xx error body naming a configured keyword as unsupported', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'model unavailable' },
    }), { status: 200 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      errorKeywords: ['model unavailable'],
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      failureKind: 'error_body',
      httpStatus: 200,
      endpointUsed: 'chat',
    });
  });

  /**
   * Same body, same HTTP 200, only the keyword list differs — so this pair proves
   * the verdict is decided by the configured vocabulary rather than by the error
   * shape alone. It previously asserted `unsupported` while passing NO keywords,
   * which pinned the behaviour F1 identified as wrong: an out-of-balance relay
   * would mark every probed model unavailable.
   */
  it('leaves a 2xx error body no keyword recognizes inconclusive', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: '余额不足，请充值' },
    }), { status: 200 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      errorKeywords: ['model unavailable'],
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'error_body',
      httpStatus: 200,
      endpointUsed: 'chat',
    });
    expect(result.status).not.toBe('supported');
  });

  it('classifies an empty or unparseable 2xx body as inconclusive', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('{"choices":[]}', { status: 200 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'empty_content',
      httpStatus: 200,
      endpointUsed: 'chat',
    });
  });

  it('classifies a model-missing response as unsupported', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'no such model: gpt-5.4' },
    }), { status: 404 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      failureKind: 'model_missing',
      httpStatus: 404,
      endpointUsed: 'chat',
    });
  });

  it('keeps authentication failures inconclusive', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'auth',
      httpStatus: 401,
      endpointUsed: 'chat',
    });
  });

  /**
   * The cases below cover `nonSuccessVerdict`, which splits what a non-2xx means.
   *
   * The three tests above and below them pass no verdict, so they pin the
   * `conservative` DEFAULT — still the behaviour of the unattended post-refresh
   * path, which writes `site_disabled_models` on a per-site switch alone and must
   * not turn one rate-limited moment into a site-wide catalogue wipe. They were not
   * edited: they encoded a deliberate behaviour, not a bug, and it still holds.
   *
   * `strict` is what the operator-triggered sweep passes. It exists because the
   * keyword list only ever governed 2xx bodies, so a relay answering
   * `HTTP 503 {"error":{"message":"No available channel for model X"}}` came back
   * 「不确定」 no matter what keywords were configured — the status was not in the
   * 400/404/422 allowlist, and the hardcoded patterns wanted `not available`
   * where the upstream wrote `No available`.
   */
  it.each([
    [503, 'No available channel for model deepseek-v4-pro-0813'],
    [500, 'internal error'],
    [429, 'slow down'],
    [404, 'nothing here'],
    [400, 'bad request'],
  ])('treats HTTP %i as unsupported under the strict verdict', async (status, body) => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(body, { status }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      nonSuccessVerdict: 'strict',
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      failureKind: 'model_missing',
      httpStatus: status,
    });
  });

  it.each([401, 403])(
    'still defers on HTTP %i under the strict verdict',
    async (status) => {
      // The carve-out, and the reason `strict` is not simply `status >= 300`: a
      // rejected credential says the same thing about every model on the site, so
      // a per-model verdict would bury the thing that needs fixing.
      resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
      dispatchRuntimeRequestMock.mockResolvedValue(new Response('denied', { status }));

      const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
      const result = await probeRuntimeModel({
        site,
        account,
        modelName: 'gpt-5.4',
        timeoutMs: 100,
        nonSuccessVerdict: 'strict',
      });

      expect(result.status).toBe('inconclusive');
      expect(result.httpStatus).toBe(status);
    },
  );

  it('treats a thrown request as unsupported under the strict verdict', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockRejectedValue(new Error('socket closed'));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      nonSuccessVerdict: 'strict',
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      failureKind: 'model_missing',
      httpStatus: null,
    });
  });

  it('leaves a 2xx body to the keyword list even under the strict verdict', async () => {
    // Positive control for the split: `strict` must change only the non-2xx
    // reading. Without this, a change that made `strict` short-circuit every
    // response would satisfy all the cases above.
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      nonSuccessVerdict: 'strict',
    });

    expect(result.status).toBe('supported');
  });

  it('keeps rate limiting inconclusive', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('slow down', { status: 429 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'rate_limit',
      httpStatus: 429,
      endpointUsed: 'chat',
    });
  });

  it('reports a thrown request as an inconclusive network failure', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockRejectedValue(new Error('socket closed'));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'network',
      httpStatus: null,
      endpointUsed: 'chat',
    });
  });

  it('lets the dedicated probe user-agent override site custom headers', async () => {
    const siteWithCustomUserAgent = {
      ...site,
      customHeaders: JSON.stringify({ 'user-agent': 'site-agent' }),
    };
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    const sentinelBody = JSON.stringify({ retained: true });
    const sentinelSignal = new AbortController().signal;
    const sentinelDispatcher = { name: 'probe-dispatcher' };
    withSiteRecordProxyRequestInitMock.mockImplementation(async () => ({
      method: 'POST',
      headers: new Headers({
        authorization: 'Bearer x',
        'content-type': 'application/json',
        'user-agent': 'site-agent',
        'x-site': '1',
      }),
      body: sentinelBody,
      signal: sentinelSignal,
      dispatcher: sentinelDispatcher,
    }));
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      buildInit: (requestUrl: string, request: Record<string, unknown>) => Promise<RequestInit>;
      request: Record<string, unknown>;
      targetUrl?: string;
    }) => {
      const init = await input.buildInit(
        input.targetUrl || 'https://probe.example.com/v1/chat/completions',
        input.request,
      );
      const headers = new Headers(init.headers);
      expect(headers.get('user-agent')).toBe('probe-agent');
      expect(headers.get('authorization')).toBe('Bearer x');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-site')).toBe('1');
      expect(init.body).toBe(sentinelBody);
      expect(init.signal).toBe(sentinelSignal);
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBe(sentinelDispatcher);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' } }],
      }), { status: 200 });
    });

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    await probeRuntimeModel({
      site: siteWithCustomUserAgent,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      userAgent: 'probe-agent',
    });
  });

  it('does not report an endpoint when request building throws', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    buildUpstreamEndpointRequestMock.mockImplementation(() => {
      throw new Error('request builder failed');
    });

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'network',
      httpStatus: null,
      endpointUsed: null,
    });
  });

  it('keeps a 403 response inconclusive as an authentication failure', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('forbidden', { status: 403 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'auth',
      httpStatus: 403,
      endpointUsed: 'chat',
    });
  });

  it('keeps a 5xx response inconclusive as an upstream failure', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('gateway error', { status: 502 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'upstream',
      httpStatus: 502,
      endpointUsed: 'chat',
    });
  });

  it('reports an aborted request as a timeout and passes the probe abort signal', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    let observedSignal: AbortSignal | undefined;
    let dispatchEnteredResolve: (() => void) | undefined;
    const dispatchEntered = new Promise<void>((resolve) => {
      dispatchEnteredResolve = resolve;
    });
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      buildInit: (requestUrl: string, request: Record<string, unknown>) => Promise<RequestInit>;
      request: Record<string, unknown>;
      targetUrl?: string;
    }) => {
      const init = await input.buildInit(
        input.targetUrl || 'https://probe.example.com/v1/chat/completions',
        input.request,
      );
      const signal = init.signal as AbortSignal;
      observedSignal = signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      dispatchEnteredResolve?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unreachable');
    });

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const probe = probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 40,
    });
    await dispatchEntered;
    const result = await probe;

    expect(observedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: 'inconclusive',
      failureKind: 'timeout',
      httpStatus: null,
      endpointUsed: 'chat',
    });
  });

  it('uses prompt and user-agent options with a single forced endpoint candidate', async () => {
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'OK' }],
    }), { status: 200 }));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 100,
      prompt: '  Say hello.  ',
      userAgent: '  probe-agent  ',
      forcedEndpoint: 'messages',
    });

    expect(resolveUpstreamEndpointCandidatesMock).not.toHaveBeenCalled();
    expect(buildUpstreamEndpointRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'messages',
      downstreamHeaders: { 'user-agent': 'probe-agent' },
      openaiBody: expect.objectContaining({
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    }));
    expect(result).toMatchObject({
      status: 'supported',
      endpointUsed: 'messages',
      httpStatus: 200,
    });
  });

  it('uses the remaining timeout budget for the runtime request phase', async () => {
    resolveUpstreamEndpointCandidatesMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return ['chat'];
    });
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      buildInit: (requestUrl: string, request: Record<string, unknown>) => Promise<RequestInit>;
      request: Record<string, unknown>;
      targetUrl?: string;
    }) => {
      const init = await input.buildInit(input.targetUrl || 'https://probe.example.com/v1/chat/completions', input.request);
      const signal = init.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const startedAt = Date.now();
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 30,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe('inconclusive');
    expect(result.latencyMs).not.toBeNull();
    expect(elapsedMs).toBeLessThan(200);
  });

  /**
  * `max_tokens` used to be hard-coded to 8, which manufactured false
  * `empty_content` verdicts: the cap counts every token a model emits, thinking
  * tokens included, so a model that opens with a short preamble hit the ceiling
  * before producing any visible content. The probe then saw a protocol-shaped reply
  * with no extractable text and reported 「未确定」 — "could not tell" when the real
  * answer was "it works, we cut it off".
   */
  describe('output-token budget', () => {
    function dispatchedBody(): Record<string, unknown> {
      // The body reaches the transport through `buildUpstreamEndpointRequest`, which
      // this suite mocks, so its argument is where the budget is observable.
      const call = buildUpstreamEndpointRequestMock.mock.calls[0]?.[0] as
        { openaiBody?: Record<string, unknown> } | undefined;
      return call?.openaiBody ?? {};
    }

    beforeEach(() => {
      resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
      dispatchRuntimeRequestMock.mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' } }],
      }), { status: 200 }));
    });

    it('sends the configured budget', async () => {
      const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
      await probeRuntimeModel({
        site,
        account,
        modelName: 'gpt-5.4',
        timeoutMs: 100,
        maxTokens: 512,
      });

      expect(dispatchedBody().max_tokens).toBe(512);
    });

    it('falls back to the module default when none is given', async () => {
      const { probeRuntimeModel, RUNTIME_PROBE_FALLBACK_MAX_TOKENS } = await import('./runtimeModelProbe.js');
      await probeRuntimeModel({
        site,
        account,
        modelName: 'gpt-5.4',
        timeoutMs: 100,
      });

      expect(dispatchedBody().max_tokens).toBe(RUNTIME_PROBE_FALLBACK_MAX_TOKENS);
      // Pinned with a literal too: asserting only against the constant would pass for
      // any value it happened to hold, including the old 8 that caused the bug.
      expect(RUNTIME_PROBE_FALLBACK_MAX_TOKENS).toBe(64);
    });

    it.each([0, -5, Number.NaN])('ignores a nonsensical budget (%p) rather than sending it', async (value) => {
      const { probeRuntimeModel, RUNTIME_PROBE_FALLBACK_MAX_TOKENS } = await import('./runtimeModelProbe.js');
      await probeRuntimeModel({
        site,
        account,
        modelName: 'gpt-5.4',
        timeoutMs: 100,
        maxTokens: value,
      });

      // `max_tokens: 0` would make every probe return empty content, i.e. turn the
      // whole sweep into false 「未确定」 verdicts.
      expect(dispatchedBody().max_tokens).toBe(RUNTIME_PROBE_FALLBACK_MAX_TOKENS);
    });

    it('truncates a fractional budget to an integer', async () => {
      const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
      await probeRuntimeModel({
        site,
        account,
        modelName: 'gpt-5.4',
        timeoutMs: 100,
        maxTokens: 128.9,
      });

      expect(dispatchedBody().max_tokens).toBe(128);
    });
  });
});
