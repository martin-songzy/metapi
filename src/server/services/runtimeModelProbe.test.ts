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

  it('classifies an explicit 2xx error body as unsupported', async () => {
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
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      failureKind: 'error_body',
      httpStatus: 200,
      endpointUsed: 'chat',
    });
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
    withSiteRecordProxyRequestInitMock.mockImplementation(async (_site: unknown, init: RequestInit) => ({
      ...init,
      headers: { ...init.headers as Record<string, string>, 'user-agent': 'site-agent' },
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
      expect(new Headers(init.headers).get('user-agent')).toBe('probe-agent');
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
});
