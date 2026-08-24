import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import {
  classifySuccessfulProbeResponse,
  type ModelProbeFailureKind,
} from './modelProbeResponseClassifier.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import { maskProxyCredentialsInText } from './modelProbeSecrets.js';
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
  /**
   * Output-token budget for the probe request. Omitted falls back to
   * `RUNTIME_PROBE_FALLBACK_MAX_TOKENS`.
   */
  maxTokens?: number;
  /**
   * How to read a response that is not 2xx.
   *
   * `'conservative'` (the DEFAULT, and the default deliberately) only calls a
   * failure `unsupported` when the status is 400/404/422 AND the body matches a
   * model-absence pattern; everything else is `inconclusive`. Omitting this option
   * therefore keeps the unattended `runPostRefreshProbeIfEnabled` path exactly as
   * it was — that path is gated only on a per-site switch, is NOT gated on
   * `PROXY_ROUTING_ENABLED`, does not apply the interest regex (so `scope: 'all'`
   * means every discovered model), and writes `site_disabled_models`, which is
   * keyed by SITE and never auto-clears. One rate-limited moment during a refresh
   * must not be able to disable a site's whole catalogue.
   *
   * `'strict'` treats any non-2xx — and a timeout or transport failure, which
   * carry no status at all — as `unsupported`, because from the operator's seat a
   * model the upstream refuses to serve is not usable. `401`/`403` stay
   * `inconclusive` even here: a rejected credential says the same thing about
   * every model on the site, so reporting it as a model verdict would bury the
   * thing that actually needs fixing. The operator-triggered sweep passes this,
   * where the verdict is gated behind both `PROXY_ROUTING_ENABLED` and the probe
   * config's own `syncToRouting`.
   */
  nonSuccessVerdict?: 'conservative' | 'strict';
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

/**
 * Statuses that describe the CREDENTIAL rather than the model.
 *
 * Held back from `strict` because a rejected key says exactly the same thing about
 * every model on the site: reporting it per-model would spray a credential problem
 * across the results as a catalogue of model verdicts and bury the one thing that
 * actually needs fixing.
 */
const CREDENTIAL_LEVEL_STATUSES = [401, 403];

/**
 * Whether a non-2xx response should read as `unsupported`.
 *
 * `conservative` keeps the original narrow rule — 400/404/422 plus a model-absence
 * phrase in the body. It is the default because the unattended post-refresh path
 * relies on it; see `nonSuccessVerdict` for why that path must stay narrow.
 *
 * `strict` is the operator's ruling for the manual sweep: an upstream that refuses
 * to serve the model means the model is not usable, whatever the status. It still
 * defers on 401/403.
 *
 * Note this makes the configured error-keyword list irrelevant on the `strict`
 * path — under it every non-2xx is already `unsupported`, so there is nothing left
 * for a keyword to promote. Keywords continue to decide 2xx bodies, which is the
 * shape they exist for: a relay answering HTTP 200 with an error payload.
 */
function isNonSuccessUnsupported(
  status: number,
  rawErrorText: string,
  verdict: 'conservative' | 'strict' | undefined,
): boolean {
  if (verdict !== 'strict') return classifyUnsupportedFailure(status, rawErrorText);
  if (CREDENTIAL_LEVEL_STATUSES.includes(status)) return false;
  return true;
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

/**
 * Fallback budget for callers that pass no `maxTokens`.
 *
 * Matches `MODEL_PROBE_DEFAULT_MAX_TOKENS` but is duplicated rather than imported:
 * this module is on the probe hot path and importing the config service — which
 * touches the db — would pull a database dependency into it. A test asserts the two
 * stay equal.
 */
export const RUNTIME_PROBE_FALLBACK_MAX_TOKENS = 64;

function buildProbeBody(
  modelName: string,
  prompt?: string,
  maxTokens?: number,
): Record<string, unknown> {
  const budget = Number.isFinite(maxTokens) && (maxTokens as number) > 0
    ? Math.trunc(maxTokens as number)
    : RUNTIME_PROBE_FALLBACK_MAX_TOKENS;
  return {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: prompt?.trim() || 'Reply with OK.',
      },
    ],
    // Counts EVERY token the model emits, reasoning included. A budget too small to
    // reach visible content turns a working model into a false `empty_content`
    // verdict, which is why this is configurable and no longer hard-coded to 8.
    max_tokens: budget,
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
    const openaiBody = buildProbeBody(input.modelName, input.prompt, input.maxTokens);
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
        buildInit: async (_requestUrl, requestForFetch) => {
          const init = await withSiteRecordProxyRequestInit(
            input.site,
            {
              method: 'POST',
              headers: requestForFetch.headers,
              body: JSON.stringify(requestForFetch.body),
              signal: abortController.signal,
            },
            channelProxyUrl,
          );
          const probeUserAgent = input.userAgent?.trim();
          if (!probeUserAgent) return init;

          const headers = new Headers(init.headers as HeadersInit | undefined);
          headers.set('user-agent', probeUserAgent);
          return { ...init, headers };
        },
      })
    );

    let result: Awaited<ReturnType<typeof executeEndpointFlow>>;
    try {
      result = await executeEndpointFlow({
        siteUrl: input.site.url,
        // Deliberately NOT passing `proxyUrl`. That option makes
        // `executeEndpointFlow` rewrite the request's BASE URL, which is a
        // different mechanism from proxying: the proxy is already installed as an
        // undici dispatcher by `withSiteRecordProxyRequestInit` in `buildInit`
        // above. Passing it here as well sent the request to
        // `socks5://user:pass@host:port/v1/chat/completions` — `buildUpstreamUrl`
        // preserves userinfo on purpose, and `fetch` then rejects the URL outright
        // ("Request cannot be constructed from a URL that includes credentials"),
        // so every probe failed on any site with a proxy configured. The three
        // proxy surfaces all omit this option for the same reason.
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

    const rawErrorText = maskProxyCredentialsInText(
      String(result.rawErrText || result.errText || '').trim(),
    );
    const status = result.status || 0;
    const unsupported = isNonSuccessUnsupported(
      status,
      rawErrorText,
      input.nonSuccessVerdict,
    );
    return {
      status: unsupported ? 'unsupported' : 'inconclusive',
      latencyMs,
      reason: rawErrorText || `probe failed with status ${status}`,
      httpStatus: status || null,
      failureKind: unsupported ? 'model_missing' : classifyFailureKind(status, rawErrorText),
      endpointUsed,
    };
  } catch (error) {
    // A thrown error means no HTTP response at all — a timeout, an aborted
    // request, or a transport failure. `strict` counts that as unsupported per the
    // operator's ruling; `conservative` cannot conclude anything from it.
    const strict = input.nonSuccessVerdict === 'strict';
    return {
      status: strict ? 'unsupported' : 'inconclusive',
      latencyMs: Date.now() - startedAt,
      reason: maskProxyCredentialsInText(
        error instanceof Error ? error.message : 'probe failed',
      ),
      ...emptyMetadata,
      failureKind: strict ? 'model_missing' : classifyFailureKind(0, '', error),
      endpointUsed,
    };
  }
}
