import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import {
  classifySuccessfulProbeResponse,
  type ModelProbeFailureKind,
} from './modelProbeResponseClassifier.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import type { schema } from '../db/index.js';

export type RuntimeModelProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

export type RuntimeModelProbeResult = {
  status: RuntimeModelProbeStatus;
  latencyMs: number | null;
  reason: string;
  httpStatus: number | null;
  failureKind: ModelProbeFailureKind | null;
  endpointUsed: UpstreamEndpoint | null;
};

export type RuntimeModelProbeOptions = {
  prompt?: string;
  userAgent?: string;
  forcedEndpoint?: UpstreamEndpoint;
  errorKeywords?: string[];
};

const NON_CONVERSATION_MODEL_PATTERNS = [
  /(^|[-_/])embedding(s)?($|[-_/])/i,
  /(^|[-_/])rerank($|[-_/])/i,
  /(^|[-_/])moderation($|[-_/])/i,
  /(^|[-_/])whisper($|[-_/])/i,
  /(^|[-_/])tts($|[-_/])/i,
  /(^|[-_/])transcribe|transcription/i,
  /(^|[-_/])dall-e($|[-_/])/i,
  /(^|[-_/])imagen($|[-_/])/i,
  /(^|[-_/])veo($|[-_/])/i,
  /(^|[-_/])cogvideo($|[-_/])/i,
];

const DEFINITE_UNSUPPORTED_PATTERNS = [
  /no such model/i,
  /unknown model/i,
  /unsupported model/i,
  /invalid model/i,
  /model[^]{0,80}(does not exist|not found|not available|unavailable|unsupported|invalid|disabled)/i,
  /(does not exist|not found|not available|unavailable|unsupported|invalid|disabled)[^]{0,40}model/i,
  /模型[^]{0,40}(不存在|不可用|不支持|无效|禁用|未开通|未开放)/,
  /(不存在|不可用|不支持|无效|禁用)[^]{0,20}模型/,
  /model[^]{0,80}(access denied|permission|forbidden|not allowed)/i,
  /模型[^]{0,40}(无权限|未授权|禁止访问)/,
];

function isLikelyConversationModel(modelName: string): boolean {
  const normalized = String(modelName || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('__')) return false;
  return !NON_CONVERSATION_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyUnsupportedFailure(status: number, rawErrorText: string): boolean {
  if (![400, 404, 422].includes(status)) return false;
  const normalized = String(rawErrorText || '').trim();
  if (!normalized) return false;
  return DEFINITE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyFailureKind(status: number, rawErrorText: string, error?: unknown): ModelProbeFailureKind {
  const message = error instanceof Error ? error.message : '';
  if (/timeout|aborted|abort/i.test(message) || status === 408) return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (classifyUnsupportedFailure(status, rawErrorText)) return 'model_missing';
  if (status >= 500) return 'upstream';
  if (status > 0) return 'upstream';
  return 'network';
}

function buildProbeBody(modelName: string, prompt?: string): Record<string, unknown> {
  return {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: prompt?.trim() || 'Reply with OK.',
      },
    ],
    max_tokens: 8,
    stream: false,
  };
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveRemainingTimeoutMs(deadlineAtMs: number, timeoutLabel: string): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutLabel);
  }
  return remainingMs;
}

export async function probeRuntimeModel(input: {
  site: typeof schema.sites.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  modelName: string;
  timeoutMs: number;
  tokenValue?: string | null;
} & RuntimeModelProbeOptions): Promise<RuntimeModelProbeResult> {
  const emptyMetadata = {
    httpStatus: null,
    failureKind: null,
    endpointUsed: null,
  } as const;

  if (!isLikelyConversationModel(input.modelName)) {
    return {
      status: 'skipped',
      latencyMs: null,
      reason: 'skipped non-conversation model probe',
      ...emptyMetadata,
    };
  }

  const oauth = getOauthInfoFromAccount(input.account);
  const tokenValue = String(
    input.tokenValue
    || (oauth ? input.account.accessToken : input.account.apiToken)
    || '',
  ).trim();
  if (!tokenValue) {
    return {
      status: 'inconclusive',
      latencyMs: null,
      reason: 'missing credential for probe',
      ...emptyMetadata,
    };
  }

  const startedAt = Date.now();
  const deadlineAtMs = startedAt + Math.max(1, input.timeoutMs);
  let endpointUsed: UpstreamEndpoint | null = null;
  try {
    const endpointCandidates = input.forcedEndpoint
      ? [input.forcedEndpoint]
      : await withTimeout(
        () => resolveUpstreamEndpointCandidates(
          {
            site: input.site,
            account: input.account,
          },
          input.modelName,
          'openai',
          input.modelName,
        ),
        resolveRemainingTimeoutMs(
          deadlineAtMs,
          `runtime model probe candidate resolution timeout (${Math.round(input.timeoutMs / 1000)}s)`,
        ),
        `runtime model probe candidate resolution timeout (${Math.round(input.timeoutMs / 1000)}s)`,
      );
    if (endpointCandidates.length <= 0) {
      return {
        status: 'inconclusive',
        latencyMs: Date.now() - startedAt,
        reason: 'no compatible probe endpoint candidates',
        ...emptyMetadata,
      };
    }

    const downstreamHeaders = input.userAgent?.trim()
      ? { 'user-agent': input.userAgent.trim() }
      : {};
    const providerHeaders = buildOauthProviderHeaders({
      account: input.account,
      downstreamHeaders,
    });
    const openaiBody = buildProbeBody(input.modelName, input.prompt);
    const channelProxyUrl = resolveChannelProxyUrl(input.site, input.account.extraConfig);
    const abortController = new AbortController();
    const remainingExecutionTimeoutMs = resolveRemainingTimeoutMs(
      deadlineAtMs,
      `runtime model probe timeout (${Math.round(input.timeoutMs / 1000)}s)`,
    );
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`runtime model probe timeout (${Math.round(input.timeoutMs / 1000)}s)`));
    }, remainingExecutionTimeoutMs);
    abortTimer.unref?.();

    const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
      const request = buildUpstreamEndpointRequest({
        endpoint,
        modelName: input.modelName,
        stream: false,
        tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: input.site.platform,
        siteUrl: input.site.url,
        openaiBody,
        downstreamFormat: 'openai',
        downstreamHeaders,
        providerHeaders,
      });
      endpointUsed = endpoint;
      return {
        endpoint,
        path: request.path,
        headers: request.headers,
        body: request.body as Record<string, unknown>,
        runtime: request.runtime,
      };
    };
    const dispatchRequest = async (
      request: BuiltEndpointRequest,
      targetUrl: string,
    ) => (
      dispatchRuntimeRequest({
        siteUrl: input.site.url,
        targetUrl,
        request,
        buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
          input.site,
          {
            method: 'POST',
            headers: {
              ...requestForFetch.headers,
              ...(input.userAgent?.trim() ? { 'user-agent': input.userAgent.trim() } : {}),
            },
            body: JSON.stringify(requestForFetch.body),
            signal: abortController.signal,
          },
          channelProxyUrl,
        ),
      })
    );

    let result: Awaited<ReturnType<typeof executeEndpointFlow>>;
    try {
      result = await executeEndpointFlow({
        siteUrl: input.site.url,
        proxyUrl: channelProxyUrl,
        endpointCandidates,
        buildRequest,
        dispatchRequest,
        onAttemptSuccess: (context) => {
          endpointUsed = context.request.endpoint;
        },
        onAttemptFailure: (context) => {
          endpointUsed = context.request.endpoint;
        },
      });
    } finally {
      clearTimeout(abortTimer);
    }
    const latencyMs = Date.now() - startedAt;

    if (result.ok) {
      const rawBody = await readRuntimeResponseText(result.upstream);
      const classification = classifySuccessfulProbeResponse({
        endpoint: endpointUsed || 'chat',
        rawBody,
        errorKeywords: input.errorKeywords,
      });
      return {
        status: classification.status,
        latencyMs,
        reason: classification.reason,
        httpStatus: result.upstream.status,
        failureKind: classification.failureKind,
        endpointUsed,
      };
    }

    const rawErrorText = String(result.rawErrText || result.errText || '').trim();
    const status = result.status || 0;
    const unsupported = classifyUnsupportedFailure(status, rawErrorText);
    return {
      status: unsupported ? 'unsupported' : 'inconclusive',
      latencyMs,
      reason: rawErrorText || `probe failed with status ${status}`,
      httpStatus: status || null,
      failureKind: unsupported ? 'model_missing' : classifyFailureKind(status, rawErrorText),
      endpointUsed,
    };
  } catch (error) {
    return {
      status: 'inconclusive',
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : 'probe failed',
      ...emptyMetadata,
      failureKind: classifyFailureKind(0, '', error),
      endpointUsed,
    };
  }
}
