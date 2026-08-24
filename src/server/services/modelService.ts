import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getAdapter } from './platforms/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  ensureDefaultTokenForAccount,
  getPreferredAccountToken,
  isMaskedTokenValue,
  isUsableAccountToken,
} from './accountTokenService.js';
import {
  getCredentialModeFromExtraConfig,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
  requiresManagedAccountTokens,
  resolvePlatformUserId,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';
import { invalidateTokenRouterCache, matchesModelPattern } from './tokenRouter.js';
import { getBlockedBrandRules, isModelBlockedByBrand } from './brandMatcher.js';
import { config } from '../config.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { clearAllRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { isCodexPlatform } from './oauth/codexAccount.js';
import { buildStoredOauthStateFromAccount, getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { refreshOauthAccessTokenSingleflight } from './oauth/refreshSingleflight.js';
import { listEnabledOauthRouteUnitsWithMembers } from './oauth/routeUnitService.js';
import { requireSiteApiBaseUrl } from './siteApiEndpointService.js';
import {
  discoverAntigravityModelsFromCloud,
  discoverClaudeModelsFromCloud,
  discoverCodexModelsFromCloud,
  validateGeminiCliOauthConnection,
} from './platformDiscoveryRegistry.js';
import { probeRuntimeModel, type RuntimeModelProbeStatus } from './runtimeModelProbe.js';
import type { ModelProbeFailureKind } from './modelProbeResponseClassifier.js';
import type { UpstreamEndpoint } from './upstreamEndpointRuntime.js';
import {
  ModelProbeDiscoveryError,
  discoverModelsForActiveProbe,
  type ModelProbeDiscoverySource,
  type ModelProbeDiscoveryTarget,
} from './modelProbeDiscoveryService.js';
import { loadModelProbeConfig, resolveModelProbeUserAgent } from './modelProbeConfigService.js';
import { compileInterestPatterns, matchesInterest } from './modelInterestFilter.js';
import { chooseModelProbePrompt } from './modelProbePrompts.js';
import { normalizeModelProbeEndpointType } from '../../shared/modelProbeEndpointTypes.js';

/**
 * Ceiling on how many models one manual `scope: 'all'` probe run may target.
 *
 * Probes run at concurrency 1 by default and each one is a real billed request, so
 * an over-broad interest regex would otherwise turn one button press into a very
 * long serial run against upstream quota. Exceeding this is reported as a
 * caller-fixable error rather than silently truncated, because probing an
 * arbitrary subset would produce verdicts for models the operator did not choose.
 */
const MAX_MANUAL_PROBE_TARGETS = 200;

const API_TOKEN_DISCOVERY_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 12_000;
const MODEL_REFRESH_BATCH_SIZE = 3;
const GEMINI_CLI_STATIC_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];
let inFlightRefreshModelsAndRebuildRoutes: Promise<{
  refresh: ModelRefreshResult[];
  rebuild: Awaited<ReturnType<typeof rebuildTokenRoutesFromAvailability>>;
}> | null = null;

type ModelRefreshErrorCode = 'timeout' | 'unauthorized' | 'empty_models' | 'unknown';
type ModelRefreshSkipCode = 'site_disabled' | 'adapter_or_status';

export type ModelRefreshAccountNotFoundResult = {
  accountId: number;
  refreshed: false;
  status: 'failed';
  errorCode: 'account_not_found';
  errorMessage: '账号不存在';
  modelCount: 0;
  modelsPreview: string[];
  reason: 'account_not_found';
};

export type ModelRefreshSkippedResult = {
  accountId: number;
  refreshed: false;
  status: 'skipped';
  errorCode: ModelRefreshSkipCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  reason: ModelRefreshSkipCode;
};

export type ModelRefreshFailureResult = {
  accountId: number;
  refreshed: true;
  status: 'failed';
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
};

export type ModelRefreshSuccessResult = {
  accountId: number;
  refreshed: true;
  status: 'success';
  errorCode: null;
  errorMessage: '';
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
  postProbeResult?: {
    scope: 'single' | 'all';
    probed: number;
    unsupported: number;
    /** Reported separately so a transient failure is never read as "unsupported". */
    inconclusive: number;
    details: Array<{
      modelName: string;
      status: RuntimeModelProbeStatus;
      latencyMs: number | null;
    }>;
  };
};

export type ModelRefreshResult =
  | ModelRefreshAccountNotFoundResult
  | ModelRefreshSkippedResult
  | ModelRefreshFailureResult
  | ModelRefreshSuccessResult;

type ModelDiscoveryAccountRow = typeof schema.accounts.$inferSelect;
const REFRESHED_OAUTH_ACCOUNT = Symbol('refreshedOauthAccount');

function throwWithRefreshedOauthAccount(error: unknown, account: ModelDiscoveryAccountRow): never {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, REFRESHED_OAUTH_ACCOUNT, {
      value: account,
      configurable: true,
    });
    throw error;
  }

  const wrapped = new Error(String(error || 'oauth model discovery failed'));
  Object.defineProperty(wrapped, REFRESHED_OAUTH_ACCOUNT, {
    value: account,
    configurable: true,
  });
  throw wrapped;
}

function getRefreshedOauthAccountFromError(error: unknown): ModelDiscoveryAccountRow | null {
  if (!error || typeof error !== 'object') return null;
  return (
    (error as Record<symbol, ModelDiscoveryAccountRow | undefined>)[REFRESHED_OAUTH_ACCOUNT]
    || null
  );
}

function looksLikeHtmlJsonParseError(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'))
  );
}

function looksLikeShieldChallenge(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );
}

function classifyModelDiscoveryError(message: string): ModelRefreshErrorCode {
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('请求超时')) return 'timeout';
  if (lowered.includes('http 401') || lowered.includes('http 403')
    || lowered.includes('unauthorized') || lowered.includes('invalid')
    || lowered.includes('无权') || lowered.includes('未提供令牌')) return 'unauthorized';
  return 'unknown';
}

function buildModelFailureMessage(code: ModelRefreshErrorCode, fallback?: string, platform?: string | null) {
  const raw = String(fallback || '').trim();
  if (looksLikeHtmlJsonParseError(raw) || looksLikeShieldChallenge(raw)) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    if (normalizedPlatform === 'new-api' || normalizedPlatform === 'anyrouter') {
      return '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型';
    }
    return '模型获取失败：站点返回了网页而不是 JSON 响应';
  }
  if (code === 'timeout') return '模型获取失败（请求超时）';
  if (code === 'unauthorized') return '模型获取失败，API Key 已无效';
  if (code === 'empty_models') return '模型获取失败：未获取到可用模型';
  return fallback || '模型获取失败';
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function normalizeModels(models: string[]): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = rawModel.trim();
    if (!modelName) continue;

    // Keep app/database behavior stable across SQLite/MySQL by deduping with a
    // case-insensitive key after trimming whitespace.
    const dedupeKey = modelName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalizedModels.push(modelName);
  }

  return normalizedModels;
}

async function updateOauthModelDiscoveryState(input: {
  account: typeof schema.accounts.$inferSelect;
  checkedAt: string;
  status: 'healthy' | 'abnormal';
  lastModelSyncError?: string;
  lastDiscoveredModels?: string[];
}) {
  const oauth = getOauthInfoFromAccount(input.account);
  if (!oauth) return input.account.extraConfig || null;
  const extraConfig = mergeAccountExtraConfig(input.account.extraConfig, {
    oauth: buildStoredOauthStateFromAccount(input.account, {
      provider: oauth.provider,
      modelDiscoveryStatus: input.status,
      lastModelSyncAt: input.checkedAt,
      lastModelSyncError: input.lastModelSyncError,
      lastDiscoveredModels: input.lastDiscoveredModels ?? [],
    }),
  });
  await db.update(schema.accounts).set({
    extraConfig,
    updatedAt: input.checkedAt,
  }).where(eq(schema.accounts.id, input.account.id)).run();
  return extraConfig;
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildAccountNotFoundRefreshResult(accountId: number): ModelRefreshAccountNotFoundResult {
  return {
    accountId,
    refreshed: false,
    status: 'failed',
    errorCode: 'account_not_found',
    errorMessage: '账号不存在',
    modelCount: 0,
    modelsPreview: [],
    reason: 'account_not_found',
  };
}

function buildSkippedRefreshResult(
  accountId: number,
  code: ModelRefreshSkipCode,
  errorMessage: string,
): ModelRefreshSkippedResult {
  return {
    accountId,
    refreshed: false,
    status: 'skipped',
    errorCode: code,
    errorMessage,
    modelCount: 0,
    modelsPreview: [],
    reason: code,
  };
}

function buildFailedRefreshResult(input: {
  accountId: number;
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
}): ModelRefreshFailureResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'failed',
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    modelCount: 0,
    modelsPreview: [],
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
  };
}

function buildSuccessfulRefreshResult(input: {
  accountId: number;
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
  postProbeResult?: ModelRefreshSuccessResult['postProbeResult'];
}): ModelRefreshSuccessResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'success',
    errorCode: null,
    errorMessage: '',
    modelCount: input.modelCount,
    modelsPreview: input.modelsPreview,
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
    postProbeResult: input.postProbeResult,
  };
}

function shouldRetryModelDiscoveryWithOauthRefresh(error: unknown): boolean {
  const message = ((error as { message?: string })?.message || '').toLowerCase();
  return message.includes('http 401')
    || message.includes('unauthorized')
    || message.includes('unauthenticated');
}

async function retryOauthModelDiscoveryWithRefresh<T>(input: {
  account: ModelDiscoveryAccountRow;
  attempt: (account: ModelDiscoveryAccountRow) => Promise<T>;
}): Promise<{ result: T; account: ModelDiscoveryAccountRow }> {
  let discoveryAccount = input.account;

  try {
    return {
      result: await input.attempt(discoveryAccount),
      account: discoveryAccount,
    };
  } catch (error) {
    if (!shouldRetryModelDiscoveryWithOauthRefresh(error)) {
      throw error;
    }

    await refreshOauthAccessTokenSingleflight(discoveryAccount.id);
    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, discoveryAccount.id))
      .get();
    if (!refreshedAccount) {
      throw error;
    }

    discoveryAccount = refreshedAccount;
    try {
      return {
        result: await input.attempt(discoveryAccount),
        account: discoveryAccount,
      };
    } catch (retryError) {
      throwWithRefreshedOauthAccount(retryError, discoveryAccount);
    }
  }
}

export type ProbeSiteModelDetail = {
  modelName: string;
  status: RuntimeModelProbeStatus;
  latencyMs: number | null;
  reason?: string;
  httpStatus: number | null;
  failureKind: ModelProbeFailureKind | null;
  endpointUsed: UpstreamEndpoint | null;
  latencyExceeded?: true;
};

export type ProbeSiteModelsResult = {
  success: boolean;
  error?: string;
  scope: 'single' | 'all';
  probed: number;
  supported: number;
  /** Verdicts that positively proved the model is absent. Only these can disable. */
  unsupported: number;
  /**
   * Timeouts, rate limits, auth blips, transport errors. Counted separately from
   * `unsupported` because they prove nothing about the model and must never
   * disable it.
   */
  inconclusive: number;
  skipped: number;
  /** How many models this run actually wrote a disable record for. */
  disabled: number;
  /** True only when routing writes were both permitted and performed. */
  routingSynced: boolean;
  discoverySource: ModelProbeDiscoverySource;
  /** False when the model list came from cache, i.e. the credential is unproven. */
  credentialVerified: boolean;
  notes?: string[];
  details: ProbeSiteModelDetail[];
};

export type ProbeSiteModelsProgress =
  | {
    type: 'start';
    scope: 'single' | 'all';
    modelsCount: number;
    modelsToProbe: string[];
    discoverySource: ModelProbeDiscoverySource;
    credentialVerified: boolean;
    discoveredCount: number;
    notes?: string[];
  }
  | {
    type: 'model';
    modelName: string;
    status: RuntimeModelProbeStatus;
    latencyMs: number | null;
    latencyExceeded?: true;
    reason?: string;
    httpStatus: number | null;
    failureKind: ModelProbeFailureKind | null;
    endpointUsed: UpstreamEndpoint | null;
  }
  | { type: 'action'; modelName: string; action: 'disabled' | 'kept_manual' | 'sync_disabled' };

/**
 * Runs an active probe against one site.
 *
 * Two properties matter more than anything else here, and both used to be
 * violated:
 *
 * 1. An `inconclusive` verdict never disables a model. A timeout, a 429, an auth
 *    blip or a dropped connection says nothing about whether the model exists, so
 *    folding it into `unsupported` (as this function once did) let a single
 *    network hiccup permanently disable a working model.
 * 2. Nothing routing-related is written unless `PROXY_ROUTING_ENABLED` **and** the
 *    probe config's `syncToRouting` are both on. Both default off, so by default
 *    this is a pure read-plus-HTTP diagnostic that reports and stores nothing.
 *
 * The model list comes from live discovery rather than `model_availability`, so a
 * probe reflects what the upstream serves right now instead of a stale snapshot.
 */
export async function probeSiteModels(
  siteId: number,
  options?: { scope?: 'single' | 'all'; modelName?: string; concurrency?: number; latencyThresholdMs?: number; signal?: AbortSignal },
  onProgress?: (event: ProbeSiteModelsProgress) => void,
): Promise<ProbeSiteModelsResult> {
  const failure = (scope: 'single' | 'all', error: string): ProbeSiteModelsResult => ({
    success: false,
    error,
    scope,
    probed: 0,
    supported: 0,
    unsupported: 0,
    inconclusive: 0,
    skipped: 0,
    disabled: 0,
    routingSynced: false,
    discoverySource: 'live',
    credentialVerified: false,
    details: [],
  });

  const probeConfig = await loadModelProbeConfig();

  let discovery: ModelProbeDiscoveryTarget;
  try {
    discovery = await discoverModelsForActiveProbe({
      siteId,
      timeoutMs: probeConfig.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof ModelProbeDiscoveryError
      ? error.message
      : (error instanceof Error ? error.message : '模型发现失败');
    return failure(options?.scope === 'all' ? 'all' : 'single', message);
  }

  const { site, account, credential, models: discoveredModels } = discovery;
  const credentialVerified = discovery.source === 'live';
  const scope = (options?.scope ?? (site.postRefreshProbeScope === 'all' ? 'all' : 'single')) as 'single' | 'all';

  const { patterns: interestPatterns } = compileInterestPatterns(probeConfig.interestPatterns);
  const interestMatched = discoveredModels.filter((modelName) => matchesInterest(modelName, interestPatterns));

  // scope 'all' means every interest-matched live model — not every discovered
  // model. Probing an unfiltered list would spend real upstream quota on models
  // nobody asked about.
  let modelsToProbe: string[];
  if (scope === 'all') {
    if (interestMatched.length === 0) {
      return failure(
        scope,
        probeConfig.interestPatterns.length === 0
          ? '未配置模型兴趣正则：请先在模型探测设置中添加正则，否则不会探测任何模型'
          : `实时发现的 ${discoveredModels.length} 个模型均未匹配模型兴趣正则，未执行探测`,
      );
    }
    modelsToProbe = interestMatched;
  } else {
    const requested = ((options?.modelName ?? site.postRefreshProbeModel) || '').trim();
    if (requested) {
      // An explicitly named model is a direct instruction, so the interest filter
      // does not apply to it. It must still actually exist upstream: silently
      // probing some other model (the old behaviour) reported a verdict for a
      // model the caller never asked about.
      const found = discoveredModels.find((m) => m.toLowerCase() === requested.toLowerCase());
      if (!found) {
        return failure(scope, `实时模型列表中不存在模型 ${requested}，未执行探测`);
      }
      modelsToProbe = [found];
    } else {
      // No explicit model: fall back to the first interest-matched one. It must be
      // interest-matched — reaching past the filter to "any discovered model"
      // would contradict the filter it just applied and probe something the
      // operator never expressed interest in.
      const fallback = interestMatched[0];
      if (!fallback) {
        return failure(
          scope,
          probeConfig.interestPatterns.length === 0
            ? '未配置模型兴趣正则：请先在模型探测设置中添加正则，或显式指定要探测的模型'
            : `实时发现的 ${discoveredModels.length} 个模型均未匹配模型兴趣正则，请调整正则或显式指定模型`,
        );
      }
      modelsToProbe = [fallback];
    }
  }

  // A hard ceiling on one manual run. Concurrency is deliberately 1 (a burst of
  // parallel probes is exactly what upstream liveness-detection looks for), so a
  // broad regex matching hundreds of models would mean a very long serial run
  // against real quota. Refuse with the numbers needed to narrow the regex.
  if (modelsToProbe.length > MAX_MANUAL_PROBE_TARGETS) {
    return failure(
      scope,
      `本次匹配到 ${modelsToProbe.length} 个模型，超过单次上限 ${MAX_MANUAL_PROBE_TARGETS} 个`
      + `（实时发现 ${discoveredModels.length} 个）。请收窄模型兴趣正则，或改用指定单个模型探测。`,
    );
  }

  onProgress?.({
    type: 'start',
    scope,
    modelsCount: modelsToProbe.length,
    modelsToProbe,
    discoverySource: discovery.source,
    credentialVerified,
    discoveredCount: discoveredModels.length,
    ...(discovery.notes?.length ? { notes: discovery.notes } : {}),
  });

  const userAgent = resolveModelProbeUserAgent(probeConfig, site.probeUserAgent);
  const endpointType = normalizeModelProbeEndpointType(site.probeEndpointType);
  // 'auto' keeps the pre-existing automatic derivation (with cross-protocol
  // fallback); anything else pins a single endpoint and forbids fallback, so the
  // verdict describes the endpoint the operator chose.
  const forcedEndpoint = endpointType === 'auto' ? undefined : endpointType as UpstreamEndpoint;

  const concurrency = Math.max(1, options?.concurrency ?? probeConfig.concurrency);
  const threshold = options?.latencyThresholdMs ?? 0;
  const detailsMap = new Map<string, ProbeSiteModelDetail>();

  let cursor = 0;
  async function worker() {
    while (cursor < modelsToProbe.length) {
      if (options?.signal?.aborted) break;
      const modelName = modelsToProbe[cursor++]!;
      let detail: ProbeSiteModelDetail;
      try {
        const result = await probeRuntimeModel({
          site,
          account,
          modelName,
          timeoutMs: probeConfig.timeoutMs,
          tokenValue: credential,
          prompt: chooseModelProbePrompt(probeConfig.prompts),
          errorKeywords: probeConfig.errorKeywords,
          maxTokens: probeConfig.maxTokens,
          ...(userAgent ? { userAgent } : {}),
          ...(forcedEndpoint ? { forcedEndpoint } : {}),
        });
        // A slow-but-working model is a deliberate operator policy call, not an
        // inconclusive result, so it keeps mapping to `unsupported`.
        const latencyExceeded = (
          result.status === 'supported'
          && threshold > 0
          && result.latencyMs != null
          && result.latencyMs > threshold
        );
        detail = {
          modelName,
          status: latencyExceeded ? 'unsupported' : result.status,
          latencyMs: result.latencyMs,
          reason: latencyExceeded
            ? `响应延迟 ${result.latencyMs}ms 超过阈值 ${threshold}ms`
            : result.reason,
          httpStatus: result.httpStatus,
          failureKind: result.failureKind,
          endpointUsed: result.endpointUsed,
          ...(latencyExceeded ? { latencyExceeded: true as const } : {}),
        };
      } catch (err) {
        // probeRuntimeModel already converts failures into verdicts, so this is
        // only a guard against an unexpected throw. It stays `inconclusive`,
        // which by design cannot disable anything.
        const errReason = err instanceof Error ? err.message : '探测异常';
        console.warn(`[probe-site-now] probe failed for site ${siteId} model ${modelName}`, err);
        detail = {
          modelName,
          status: 'inconclusive',
          latencyMs: null,
          reason: errReason,
          httpStatus: null,
          failureKind: 'network',
          endpointUsed: null,
        };
      }
      detailsMap.set(modelName, detail);
      onProgress?.({ type: 'model', ...detail });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, modelsToProbe.length) }, worker));

  // Restore the requested order, dropping models an abort never reached.
  const details = modelsToProbe
    .map((modelName) => detailsMap.get(modelName))
    .filter((detail): detail is ProbeSiteModelDetail => detail !== undefined);

  const counts = {
    supported: details.filter((detail) => detail.status === 'supported').length,
    unsupported: details.filter((detail) => detail.status === 'unsupported').length,
    inconclusive: details.filter((detail) => detail.status === 'inconclusive').length,
    skipped: details.filter((detail) => detail.status === 'skipped').length,
  };

  const baseResult: ProbeSiteModelsResult = {
    success: true,
    scope,
    probed: details.length,
    ...counts,
    disabled: 0,
    routingSynced: false,
    discoverySource: discovery.source,
    credentialVerified,
    ...(discovery.notes?.length ? { notes: discovery.notes } : {}),
    details,
  };

  // An aborted run writes nothing. The caller pressed stop and the SSE route
  // suppresses the `complete` event, so disabling models here would change site
  // configuration with no confirmation ever shown to the operator.
  if (options?.signal?.aborted) return baseResult;

  // ONLY `unsupported` reaches the write path. `inconclusive` is excluded by
  // construction rather than by a later check, so no future edit can leak it in.
  const unsupportedModels = details
    .filter((detail) => detail.status === 'unsupported')
    .map((detail) => detail.modelName);
  if (unsupportedModels.length === 0) return baseResult;

  const syncAllowed = config.proxyRoutingEnabled === true && probeConfig.syncToRouting === true;
  if (!syncAllowed) {
    for (const modelName of unsupportedModels) {
      onProgress?.({ type: 'action', modelName, action: 'sync_disabled' });
    }
    return baseResult;
  }

  const checkedAt = new Date().toISOString();
  const disabledModels: string[] = [];
  for (const modelName of unsupportedModels) {
    const existing = await db.select({ isManual: schema.modelAvailability.isManual })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, account.id),
        eq(schema.modelAvailability.modelName, modelName),
      ))
      .get();

    // A manual model is a human assertion that it should be routable. It is a
    // legitimate probe target, but an automated verdict must never overrule the
    // person who added it.
    if (existing?.isManual === true) {
      onProgress?.({ type: 'action', modelName, action: 'kept_manual' });
      continue;
    }

    if (existing) {
      await db.update(schema.modelAvailability)
        .set({ available: false, checkedAt })
        .where(and(
          eq(schema.modelAvailability.accountId, account.id),
          eq(schema.modelAvailability.modelName, modelName),
        ))
        .run();
    }
    await db.insert(schema.siteDisabledModels)
      .values({ siteId, modelName })
      .onConflictDoNothing()
      .run();
    disabledModels.push(modelName);
    onProgress?.({ type: 'action', modelName, action: 'disabled' });
  }

  if (disabledModels.length === 0) {
    return baseResult;
  }

  const reason = disabledModels.length === 1
    ? `主动探测：模型 ${disabledModels[0]} 不可用`
    : `主动探测：${disabledModels.length} 个模型不可用（${disabledModels.slice(0, 3).join('、')}${disabledModels.length > 3 ? '…' : ''}）`;
  await setAccountRuntimeHealth(account.id, { state: 'unhealthy', reason, source: 'manual-probe', checkedAt });

  // Awaited, not fire-and-forget: the SSE `complete` event is what makes the UI
  // refetch its model lists, so routing has to be consistent before it fires.
  try {
    await rebuildTokenRoutesFromAvailability();
  } catch (err) {
    console.warn('[probe-site-now] route rebuild failed', err);
  }

  return { ...baseResult, disabled: disabledModels.length, routingSynced: true };
}

async function runPostRefreshProbeIfEnabled(params: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  discoveredModels: string[];
}): Promise<ModelRefreshSuccessResult['postProbeResult']> {
  if (!params.site.postRefreshProbeEnabled) return undefined;
  if (params.discoveredModels.length === 0) return undefined;

  const scope = (params.site.postRefreshProbeScope === 'all' ? 'all' : 'single') as 'single' | 'all';

  // Determine which models to probe.
  //
  // The interest regex is deliberately NOT applied here. It defaults to an empty
  // list which matches nothing, so filtering this path would silently stop a
  // feature that already ships enabled. scope 'all' therefore means every
  // discovered model, unlike the manual path.
  let modelsToProbe: string[];
  if (scope === 'all') {
    modelsToProbe = params.discoveredModels;
  } else {
    const configModel = (params.site.postRefreshProbeModel || '').trim().toLowerCase();
    const found = configModel
      ? (params.discoveredModels.find((m) => m.toLowerCase() === configModel) ?? params.discoveredModels[0])
      : params.discoveredModels[0];
    modelsToProbe = [found];
  }

  // The request profile (endpoint, UA) and the global probe settings (prompt pool,
  // error keywords, timeout) apply to every probe. Ignoring them here would make
  // the unattended path systematically less accurate than the manual one and let
  // it disable models the manual path would have judged fine.
  const probeConfig = await loadModelProbeConfig();
  const userAgent = resolveModelProbeUserAgent(probeConfig, params.site.probeUserAgent);
  const endpointType = normalizeModelProbeEndpointType(params.site.probeEndpointType);
  const forcedEndpoint = endpointType === 'auto' ? undefined : endpointType as UpstreamEndpoint;

  // runPostRefreshProbeIfEnabled: apply latency threshold from site config
  const threshold = params.site.postRefreshProbeLatencyThresholdMs ?? 0;
  // Probe each model sequentially
  const details: Array<{
    modelName: string;
    status: RuntimeModelProbeStatus;
    latencyMs: number | null;
    latencyExceeded?: true;
  }> = [];
  for (const modelName of modelsToProbe) {
    try {
      const result = await probeRuntimeModel({
        site: params.site,
        account: params.account,
        modelName,
        timeoutMs: probeConfig.timeoutMs,
        prompt: chooseModelProbePrompt(probeConfig.prompts),
        errorKeywords: probeConfig.errorKeywords,
        maxTokens: probeConfig.maxTokens,
        ...(userAgent ? { userAgent } : {}),
        ...(forcedEndpoint ? { forcedEndpoint } : {}),
      });
      const latencyExceeded = (
        result.status === 'supported'
        && threshold > 0
        && result.latencyMs != null
        && result.latencyMs > threshold
      );
      const effectiveStatus: RuntimeModelProbeStatus = latencyExceeded ? 'unsupported' : result.status;
      details.push({
        modelName,
        status: effectiveStatus,
        latencyMs: result.latencyMs,
        ...(latencyExceeded ? { latencyExceeded: true as const } : {}),
      });
    } catch (err) {
      console.warn(`[post-refresh-probe] probe failed for account ${params.account.id} model ${modelName}`, err);
      details.push({ modelName, status: 'inconclusive', latencyMs: null });
    }
  }

  // Only `unsupported` may disable. `inconclusive` (timeout / 429 / auth blip /
  // transport error) proves nothing about the model, and this path runs
  // unattended on every successful model refresh, so treating it as a failure
  // verdict is exactly how a transient upstream wobble used to permanently
  // disable working models.
  //
  // A latency breach is also excluded here, unlike on the manual path. Slowness is
  // a routing-preference signal, not a verdict that the model is absent, and this
  // path writes a SITE-level disable with nobody watching — so a working-but-slow
  // model would be removed from the site for every account on it.
  const unsupportedModels = details
    .filter((d) => d.status === 'unsupported' && d.latencyExceeded !== true)
    .map((d) => d.modelName);
  const inconclusiveCount = details.filter((d) => d.status === 'inconclusive').length;
  const disabledModels: string[] = [];
  if (unsupportedModels.length > 0) {
    const checkedAt = new Date().toISOString();
    for (const modelName of unsupportedModels) {
      const existing = await db.select({ isManual: schema.modelAvailability.isManual })
        .from(schema.modelAvailability)
        .where(and(
          eq(schema.modelAvailability.accountId, params.account.id),
          eq(schema.modelAvailability.modelName, modelName),
        ))
        .get();
      // A manually added model is a human assertion; an automated verdict must
      // not overrule it.
      if (existing?.isManual === true) continue;

      if (existing) {
        await db.update(schema.modelAvailability)
          .set({ available: false, checkedAt })
          .where(and(
            eq(schema.modelAvailability.accountId, params.account.id),
            eq(schema.modelAvailability.modelName, modelName),
          ))
          .run();
      }
      // Add to site-level disabled models
      await db.insert(schema.siteDisabledModels)
        .values({ siteId: params.site.id, modelName })
        .onConflictDoNothing()
        .run();
      disabledModels.push(modelName);
    }
  }

  if (disabledModels.length > 0) {
    const checkedAt = new Date().toISOString();
    // Update account health
    const reason = disabledModels.length === 1
      ? `刷新后探测失败：模型 ${disabledModels[0]} 不可用`
      : `刷新后探测失败：${disabledModels.length} 个模型不可用（${disabledModels.slice(0, 3).join('、')}${disabledModels.length > 3 ? '…' : ''}）`;
    await setAccountRuntimeHealth(params.account.id, {
      state: 'unhealthy',
      reason,
      source: 'post-refresh-probe',
      checkedAt,
    });
    // Single route rebuild for all changes, and only when routing is on at all.
    if (config.proxyRoutingEnabled) {
      rebuildTokenRoutesFromAvailability().catch((err) => {
        console.warn('[post-refresh-probe] route rebuild failed', err);
      });
    }
  }

  return {
    scope,
    probed: details.length,
    // Reports every unsupported verdict, including latency breaches. Those are
    // excluded from disabling above, not from reporting.
    unsupported: details.filter((d) => d.status === 'unsupported').length,
    inconclusive: inconclusiveCount,
    details,
  };
}

export async function refreshModelsForAccount(
  accountId: number,
  options?: { allowInactive?: boolean },
): Promise<ModelRefreshResult> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    return buildAccountNotFoundRefreshResult(accountId);
  }

  const account = row.accounts;
  const site = row.sites;
  const oauth = getOauthInfoFromAccount(account);
  const adapter = getAdapter(site.platform);
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);

  const restoreAvailabilityOnFailure = options?.allowInactive === true;
  const previousAccountTokens = restoreAvailabilityOnFailure
    ? await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all()
    : [];
  const previousModelAvailability = restoreAvailabilityOnFailure
    ? await db.select()
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .all()
    : [];
  const previousTokenModelAvailability = restoreAvailabilityOnFailure
    ? (await Promise.all(previousAccountTokens.map(async (token) => db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all()))).flat()
    : [];

  const clearExistingAvailability = async () => {
    await db.delete(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .run();

    const currentAccountTokens = await db.select({ id: schema.accountTokens.id })
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all();

    for (const token of currentAccountTokens) {
      await db.delete(schema.tokenModelAvailability)
        .where(eq(schema.tokenModelAvailability.tokenId, token.id))
        .run();
    }
  };

  const restorePreviousAvailability = async () => {
    if (!restoreAvailabilityOnFailure) return;
    await clearExistingAvailability();
    if (previousModelAvailability.length > 0) {
      await db.insert(schema.modelAvailability).values(
        previousModelAvailability.map(({ id: _id, ...row }) => row),
      ).run();
    }
    if (previousTokenModelAvailability.length > 0) {
      await db.insert(schema.tokenModelAvailability).values(
        previousTokenModelAvailability.map(({ id: _id, ...row }) => row),
      ).run();
    }
  };

  await clearExistingAvailability();

  // Collect manual model names so discovered models that collide are skipped (unique index).
  const manualModelNames = new Set(
    (await db.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, true),
      ))
      .all()
    ).map((r) => r.modelName.toLowerCase()),
  );

  if (isSiteDisabled(site.status)) {
    return buildSkippedRefreshResult(accountId, 'site_disabled', '站点已禁用');
  }

  if (account.status !== 'active' && !options?.allowInactive) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  if (oauth?.provider === 'codex') {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    let discoveryAccount = account;
    try {
      const { result: codexModels, account: refreshedAccount } = await retryOauthModelDiscoveryWithRefresh({
        account,
        attempt: async (candidateAccount) => withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => discoverCodexModelsFromCloud({ site, account: candidateAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `codex model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      });
      discoveryAccount = refreshedAccount;
      if (codexModels.length === 0) {
        throw new Error('未获取到可用模型');
      }

      const newCodexModels = codexModels.filter((m) => !manualModelNames.has(m.toLowerCase()));
      if (newCodexModels.length > 0) {
        await db.insert(schema.modelAvailability).values(
          newCodexModels.map((modelName) => ({
            accountId,
            modelName,
            available: true,
            latencyMs: Date.now() - startedAt,
            checkedAt,
          })),
        ).run();
      }
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'healthy',
        lastDiscoveredModels: codexModels,
      });
      await setAccountRuntimeHealth(accountId, {
        state: 'healthy',
        reason: 'Codex 云端模型探测成功',
        source: 'model-discovery',
        checkedAt,
      });
      const codexPostProbeResult = await runPostRefreshProbeIfEnabled({
        account: discoveryAccount,
        site,
        discoveredModels: codexModels,
      });
      return buildSuccessfulRefreshResult({
        accountId,
        modelCount: codexModels.length,
        modelsPreview: codexModels.slice(0, 10),
        tokenScanned: 0,
        discoveredByCredential: true,
        discoveredApiToken: false,
        postProbeResult: codexPostProbeResult,
      });
    } catch (err) {
      discoveryAccount = getRefreshedOauthAccountFromError(err) || discoveryAccount;
      const rawMessage = (err as { message?: string })?.message || 'codex model discovery failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Codex 模型获取失败（${rawMessage}）`;
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'abnormal',
        lastModelSyncError: errorMessage,
        lastDiscoveredModels: [],
      });
      await setAccountRuntimeHealth(account.id, {
        state: 'unhealthy',
        reason: errorMessage,
        source: 'model-discovery',
        checkedAt,
      });
      await restorePreviousAvailability();
      return buildFailedRefreshResult({
        accountId,
        errorCode,
        errorMessage,
        tokenScanned: 0,
        discoveredByCredential: false,
        discoveredApiToken: false,
      });
    }
  }

  if (oauth?.provider === 'claude') {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    let discoveryAccount = account;
    try {
      const { result: claudeModels, account: refreshedAccount } = await retryOauthModelDiscoveryWithRefresh({
        account,
        attempt: async (candidateAccount) => withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => discoverClaudeModelsFromCloud({ site, account: candidateAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `claude oauth model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      });
      discoveryAccount = refreshedAccount;
      if (claudeModels.length === 0) {
        throw new Error('未获取到可用模型');
      }
      const newClaudeModels = claudeModels.filter((m) => !manualModelNames.has(m.toLowerCase()));
      if (newClaudeModels.length > 0) {
        await db.insert(schema.modelAvailability).values(
          newClaudeModels.map((modelName) => ({
            accountId,
            modelName,
            available: true,
            latencyMs: Date.now() - startedAt,
            checkedAt,
          })),
        ).run();
      }
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'healthy',
        lastDiscoveredModels: claudeModels,
      });
      await setAccountRuntimeHealth(accountId, {
        state: 'healthy',
        reason: 'Claude OAuth 模型探测成功',
        source: 'model-discovery',
        checkedAt,
      });
      const claudePostProbeResult = await runPostRefreshProbeIfEnabled({
        account: discoveryAccount,
        site,
        discoveredModels: claudeModels,
      });
      return buildSuccessfulRefreshResult({
        accountId,
        modelCount: claudeModels.length,
        modelsPreview: claudeModels.slice(0, 10),
        tokenScanned: 0,
        discoveredByCredential: true,
        discoveredApiToken: false,
        postProbeResult: claudePostProbeResult,
      });
    } catch (err) {
      discoveryAccount = getRefreshedOauthAccountFromError(err) || discoveryAccount;
      const rawMessage = (err as { message?: string })?.message || 'claude oauth model discovery failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Claude OAuth 模型获取失败（${rawMessage}）`;
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'abnormal',
        lastModelSyncError: errorMessage,
        lastDiscoveredModels: [],
      });
      await setAccountRuntimeHealth(account.id, {
        state: 'unhealthy',
        reason: errorMessage,
        source: 'model-discovery',
        checkedAt,
      });
      await restorePreviousAvailability();
      return buildFailedRefreshResult({
        accountId,
        errorCode,
        errorMessage,
        tokenScanned: 0,
        discoveredByCredential: false,
        discoveredApiToken: false,
      });
    }
  }

  if (oauth?.provider === 'gemini-cli') {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    let discoveryAccount = account;
    try {
      try {
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => validateGeminiCliOauthConnection({ site, account: discoveryAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `gemini cli oauth validation timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        );
      } catch (error) {
        if (!shouldRetryModelDiscoveryWithOauthRefresh(error)) {
          throw error;
        }
        const refreshed = await refreshOauthAccessTokenSingleflight(discoveryAccount.id);
        if (!refreshed?.extraConfig) {
          throw error;
        }
        discoveryAccount = {
          ...discoveryAccount,
          accessToken: refreshed.accessToken,
          extraConfig: refreshed.extraConfig,
        };
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => validateGeminiCliOauthConnection({ site, account: discoveryAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `gemini cli oauth validation timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        );
      }
      const newGeminiModels = GEMINI_CLI_STATIC_MODELS.filter((m) => !manualModelNames.has(m.toLowerCase()));
      if (newGeminiModels.length > 0) {
        await db.insert(schema.modelAvailability).values(
          newGeminiModels.map((modelName) => ({
            accountId,
            modelName,
            available: true,
            latencyMs: Date.now() - startedAt,
            checkedAt,
          })),
        ).run();
      }
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'healthy',
        lastDiscoveredModels: GEMINI_CLI_STATIC_MODELS,
      });
      await setAccountRuntimeHealth(accountId, {
        state: 'healthy',
        reason: 'Gemini CLI OAuth 健康探测成功',
        source: 'model-discovery',
        checkedAt,
      });
      const geminiPostProbeResult = await runPostRefreshProbeIfEnabled({
        account: discoveryAccount,
        site,
        discoveredModels: GEMINI_CLI_STATIC_MODELS,
      });
      return buildSuccessfulRefreshResult({
        accountId,
        modelCount: GEMINI_CLI_STATIC_MODELS.length,
        modelsPreview: GEMINI_CLI_STATIC_MODELS.slice(0, 10),
        tokenScanned: 0,
        discoveredByCredential: true,
        discoveredApiToken: false,
        postProbeResult: geminiPostProbeResult,
      });
    } catch (err) {
      const rawMessage = (err as { message?: string })?.message || 'gemini cli oauth validation failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Gemini CLI 模型获取失败（${rawMessage}）`;
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'abnormal',
        lastModelSyncError: errorMessage,
        lastDiscoveredModels: [],
      });
      await setAccountRuntimeHealth(account.id, {
        state: 'unhealthy',
        reason: errorMessage,
        source: 'model-discovery',
        checkedAt,
      });
      await restorePreviousAvailability();
      return buildFailedRefreshResult({
        accountId,
        errorCode,
        errorMessage,
        tokenScanned: 0,
        discoveredByCredential: false,
        discoveredApiToken: false,
      });
    }
  }

  if (oauth?.provider === 'antigravity') {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    let discoveryAccount = account;
    try {
      const { result: antigravityModels, account: refreshedAccount } = await retryOauthModelDiscoveryWithRefresh({
        account,
        attempt: async (candidateAccount) => withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => discoverAntigravityModelsFromCloud({ site, account: candidateAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `antigravity model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      });
      discoveryAccount = refreshedAccount;
      if (antigravityModels.length === 0) {
        throw new Error('未获取到可用模型');
      }

      const newAntigravityModels = antigravityModels.filter((m) => !manualModelNames.has(m.toLowerCase()));
      if (newAntigravityModels.length > 0) {
        await db.insert(schema.modelAvailability).values(
          newAntigravityModels.map((modelName) => ({
            accountId,
            modelName,
            available: true,
            latencyMs: Date.now() - startedAt,
            checkedAt,
          })),
        ).run();
      }
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'healthy',
        lastDiscoveredModels: antigravityModels,
      });
      await setAccountRuntimeHealth(accountId, {
        state: 'healthy',
        reason: 'Antigravity OAuth 健康探测成功',
        source: 'model-discovery',
        checkedAt,
      });
      const antigravityPostProbeResult = await runPostRefreshProbeIfEnabled({
        account: discoveryAccount,
        site,
        discoveredModels: antigravityModels,
      });
      return buildSuccessfulRefreshResult({
        accountId,
        modelCount: antigravityModels.length,
        modelsPreview: antigravityModels.slice(0, 10),
        tokenScanned: 0,
        discoveredByCredential: true,
        discoveredApiToken: false,
        postProbeResult: antigravityPostProbeResult,
      });
    } catch (err) {
      discoveryAccount = getRefreshedOauthAccountFromError(err) || discoveryAccount;
      const rawMessage = (err as { message?: string })?.message || 'antigravity model discovery failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Antigravity 模型获取失败（${rawMessage}）`;
      await updateOauthModelDiscoveryState({
        account: discoveryAccount,
        checkedAt,
        status: 'abnormal',
        lastModelSyncError: errorMessage,
        lastDiscoveredModels: [],
      });
      await setAccountRuntimeHealth(account.id, {
        state: 'unhealthy',
        reason: errorMessage,
        source: 'model-discovery',
        checkedAt,
      });
      await restorePreviousAvailability();
      return buildFailedRefreshResult({
        accountId,
        errorCode,
        errorMessage,
        tokenScanned: 0,
        discoveredByCredential: false,
        discoveredApiToken: false,
      });
    }
  }

  if (!adapter) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  let discoveredApiToken: string | null = null;

  if (!account.apiToken && account.accessToken) {
    try {
      discoveredApiToken = await withTimeout(
        () => withAccountProxyOverride(accountProxyUrl,
          () => adapter.getApiToken(site.url, account.accessToken, platformUserId)),
        API_TOKEN_DISCOVERY_TIMEOUT_MS,
        `api token discovery timeout (${Math.round(API_TOKEN_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
      );
      if (discoveredApiToken && !isMaskedTokenValue(discoveredApiToken)) {
        await ensureDefaultTokenForAccount(account.id, discoveredApiToken, { name: 'default', source: 'sync', preserveExistingMetadata: true });
        await db.update(schema.accounts).set({
          apiToken: discoveredApiToken,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.accounts.id, account.id)).run();
      } else {
        discoveredApiToken = null;
      }
    } catch { }
  }

  const usesManagedTokens = requiresManagedAccountTokens(account);
  let enabledTokens = usesManagedTokens
    ? await db.select()
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, account.id),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ))
      .all()
    : [];
  enabledTokens = enabledTokens.filter(isUsableAccountToken);

  // Last fallback: if still no managed token but account has a legacy apiToken, mirror it into token table.
  if (usesManagedTokens && enabledTokens.length === 0) {
    const fallback = discoveredApiToken || account.apiToken || null;
    if (fallback) {
      await ensureDefaultTokenForAccount(account.id, fallback, { name: 'default', source: 'legacy', preserveExistingMetadata: true });
      enabledTokens = await db.select()
        .from(schema.accountTokens)
        .where(and(
          eq(schema.accountTokens.accountId, account.id),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        ))
        .all();
      enabledTokens = enabledTokens.filter(isUsableAccountToken);
    }
  }

  let aiBaseUrl: string;
  try {
    aiBaseUrl = await requireSiteApiBaseUrl(site);
  } catch (err) {
    const rawMessage = (err as { message?: string })?.message || '模型获取失败';
    const errorCode = classifyModelDiscoveryError(rawMessage);
    const errorMessage = rawMessage;
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    await restorePreviousAvailability();
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: 0,
      discoveredByCredential: false,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const accountModels = new Map<string, string>();   // lowercase key → original name (first-wins)
  const modelLatency = new Map<string, number | null>();
  let scannedTokenCount = 0;
  let discoveredByCredential = false;
  const attemptedCredentials = new Set<string>();
  const failureMessages: string[] = [];
  const recordFailure = (err: unknown) => {
    const message = (err as { message?: string })?.message || String(err || '');
    if (message) failureMessages.push(message);
  };

  const mergeDiscoveredModels = (models: string[], latencyMs: number | null) => {
    for (const modelName of models) {
      const key = modelName.toLowerCase();
      if (!accountModels.has(key)) accountModels.set(key, modelName);
      const prev = modelLatency.get(key);
      if (prev === undefined || prev === null) {
        modelLatency.set(key, latencyMs);
        continue;
      }
      if (latencyMs === null) continue;
      if (latencyMs < prev) modelLatency.set(key, latencyMs);
    }
  };

  const discoverModelsWithCredential = async (credentialRaw: string | null | undefined) => {
    const credential = (credentialRaw || '').trim();
    if (!credential) return;
    if (isMaskedTokenValue(credential)) return;
    if (attemptedCredentials.has(credential)) return;
    attemptedCredentials.add(credential);

    const startedAt = Date.now();
    let models: string[] = [];
    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getModels(aiBaseUrl, credential, platformUserId)),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      recordFailure(err);
      models = [];
    }
    if (models.length === 0) return;
    discoveredByCredential = true;
    const latencyMs = Date.now() - startedAt;
    mergeDiscoveredModels(models, latencyMs);
  };

  // Prefer account-level credential discovery so model availability does not rely on managed tokens.
  await discoverModelsWithCredential(account.apiToken);
  await discoverModelsWithCredential(discoveredApiToken);
  await discoverModelsWithCredential(account.accessToken);

  for (const token of enabledTokens) {
    const startedAt = Date.now();
    let models: string[] = [];

    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getModels(aiBaseUrl, token.token, platformUserId)),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      recordFailure(err);
      models = [];
    }

    if (models.length === 0) continue;

    const latencyMs = Date.now() - startedAt;
    const checkedAt = new Date().toISOString();

    await db.insert(schema.tokenModelAvailability).values(
      models.map((modelName) => ({
        tokenId: token.id,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })),
    ).run();

    scannedTokenCount++;
    mergeDiscoveredModels(models, latencyMs);
  }

  if (accountModels.size === 0) {
    const firstMessage = failureMessages[0] || '';
    const errorCode = firstMessage ? classifyModelDiscoveryError(firstMessage) : 'empty_models';
    const errorMessage = buildModelFailureMessage(errorCode, firstMessage, site.platform);
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    await restorePreviousAvailability();
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: scannedTokenCount,
      discoveredByCredential,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const checkedAt = new Date().toISOString();
  const newAccountModels = Array.from(accountModels.values()).filter((m) => !manualModelNames.has(m.toLowerCase()));
  if (newAccountModels.length > 0) {
    await db.insert(schema.modelAvailability).values(
      newAccountModels.map((modelName) => ({
        accountId: account.id,
        modelName,
        available: true,
        latencyMs: modelLatency.get(modelName.toLowerCase()) ?? null,
        checkedAt,
      })),
    ).run();
  }

  await setAccountRuntimeHealth(account.id, {
    state: 'healthy',
    reason: '模型探测成功',
    source: 'model-discovery',
    checkedAt,
  });

  const modelsPreview = Array.from(accountModels.values()).slice(0, 10);
  const standardPostProbeResult = await runPostRefreshProbeIfEnabled({
    account,
    site,
    discoveredModels: Array.from(accountModels.values()),
  });
  return buildSuccessfulRefreshResult({
    accountId,
    modelCount: accountModels.size,
    modelsPreview,
    tokenScanned: scannedTokenCount,
    discoveredByCredential,
    discoveredApiToken: !!discoveredApiToken,
    postProbeResult: standardPostProbeResult,
  });
}

async function refreshModelsForAllActiveAccounts(): Promise<ModelRefreshResult[]> {
  const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: ModelRefreshResult[] = [];
  for (let offset = 0; offset < accounts.length; offset += MODEL_REFRESH_BATCH_SIZE) {
    const batch = accounts.slice(offset, offset + MODEL_REFRESH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (account) => refreshModelsForAccount(account.id)));
    results.push(...batchResults);
  }
  return results;
}

export async function rebuildTokenRoutesFromAvailability() {
  const tokenRows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();
  const usableTokenRows = tokenRows.filter((row) => (
    isUsableAccountToken(row.account_tokens)
    && requiresManagedAccountTokens(row.accounts)
  ));

  const accountRows = await db.select().from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  // Load site-level disabled models
  const disabledModelRows = await db.select().from(schema.siteDisabledModels).all();
  const disabledModelsBySite = new Map<number, Set<string>>();
  for (const row of disabledModelRows) {
    if (!disabledModelsBySite.has(row.siteId)) disabledModelsBySite.set(row.siteId, new Set());
    disabledModelsBySite.get(row.siteId)!.add(row.modelName.toLowerCase());
  }

  function isModelDisabledForSite(siteId: number, modelName: string): boolean {
    const disabled = disabledModelsBySite.get(siteId);
    return !!disabled && disabled.has(modelName.toLowerCase());
  }

  // Load global brand filter
  const blockedBrandRules = getBlockedBrandRules(config.globalBlockedBrands);

  // Load global allowed models whitelist
  const globalAllowedModels = new Set(
    config.globalAllowedModels.map((m) => m.toLowerCase().trim()).filter(Boolean),
  );

  function isModelAllowedByWhitelist(modelName: string): boolean {
    // If whitelist is empty, allow all models (backward compatible)
    if (globalAllowedModels.size === 0) return true;
    // Check if model is in whitelist (case-insensitive)
    return globalAllowedModels.has(modelName.toLowerCase().trim());
  }

  const enabledOauthRouteUnits = await listEnabledOauthRouteUnitsWithMembers();
  const routeUnitByAccountId = new Map<number, {
    routeUnitId: number;
    representativeAccountId: number;
  }>();
  for (const routeUnit of enabledOauthRouteUnits) {
    const representativeAccountId = routeUnit.members[0]?.account.id;
    if (!representativeAccountId) continue;
    for (const member of routeUnit.members) {
      routeUnitByAccountId.set(member.account.id, {
        routeUnitId: routeUnit.unit.id,
        representativeAccountId,
      });
    }
  }

  const modelCandidates = new Map<string, Map<string, {
    accountId: number;
    tokenId: number | null;
    oauthRouteUnitId: number | null;
  }>>();
  const buildCandidateKey = (input: {
    accountId: number;
    tokenId: number | null;
    oauthRouteUnitId: number | null;
  }) => (
    input.oauthRouteUnitId
      ? `route-unit:${input.oauthRouteUnitId}`
      : `${input.accountId}:${input.tokenId ?? 'account'}`
  );
  const buildChannelKey = (channel: typeof schema.routeChannels.$inferSelect) => (
    channel.oauthRouteUnitId
      ? `route-unit:${channel.oauthRouteUnitId}`
      : `${channel.accountId}:${channel.tokenId ?? 'account'}`
  );
  const addModelCandidate = (
    modelNameRaw: string | null | undefined,
    accountId: number,
    tokenId: number | null,
    siteId: number,
    oauthRouteUnitId: number | null = null,
  ) => {
    const modelName = (modelNameRaw || '').trim();
    if (!modelName) return;
    if (!isModelAllowedByWhitelist(modelName)) return;
    if (isModelDisabledForSite(siteId, modelName)) return;
    if (blockedBrandRules.length > 0 && isModelBlockedByBrand(modelName, blockedBrandRules)) return;
    if (!modelCandidates.has(modelName)) modelCandidates.set(modelName, new Map());
    const candidate = { accountId, tokenId, oauthRouteUnitId };
    modelCandidates.get(modelName)!.set(buildCandidateKey(candidate), candidate);
  };

  for (const row of usableTokenRows) {
    addModelCandidate(row.token_model_availability.modelName, row.accounts.id, row.account_tokens.id, row.accounts.siteId);
  }

  for (const row of accountRows) {
    if (!supportsDirectAccountRoutingConnection(row.accounts)) continue;
    const routeUnit = routeUnitByAccountId.get(row.accounts.id);
    if (routeUnit) {
      addModelCandidate(
        row.model_availability.modelName,
        routeUnit.representativeAccountId,
        null,
        row.accounts.siteId,
        routeUnit.routeUnitId,
      );
      continue;
    }
    addModelCandidate(row.model_availability.modelName, row.accounts.id, null, row.accounts.siteId);
  }

  const sourceRouteReferenceRows = await db.select({ sourceRouteId: schema.routeGroupSources.sourceRouteId })
    .from(schema.routeGroupSources)
    .all();
  const explicitGroupSourceRouteIds = new Set(sourceRouteReferenceRows.map((row) => row.sourceRouteId));
  const routes = await db.select().from(schema.tokenRoutes).all();
  const channels = await db.select().from(schema.routeChannels).all();

  let createdRoutes = 0;
  let createdChannels = 0;
  let removedChannels = 0;
  let removedRoutes = 0;

  for (const [modelName, candidateMap] of modelCandidates.entries()) {
    let route = routes.find((r) => (r.routeMode || 'pattern') !== 'explicit_group' && r.modelPattern === modelName);
    if (!route) {
      const inserted = await db.insert(schema.tokenRoutes).values({
        modelPattern: modelName,
        enabled: true,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      route = insertedId != null
        ? await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, insertedId)).get()
        : undefined;
      if (!route) continue;
      routes.push(route);
      createdRoutes++;
    }

    const routeChannels = channels.filter((channel) => channel.routeId === route.id);
    const desiredKeys = new Set(Array.from(candidateMap.keys()));

    for (const [candidateKey, candidate] of candidateMap.entries()) {
      const exists = routeChannels.some((channel) => buildChannelKey(channel) === candidateKey);
      if (exists) continue;

      const inserted = await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: candidate.accountId,
        tokenId: candidate.tokenId,
        oauthRouteUnitId: candidate.oauthRouteUnitId,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      if (insertedId == null) continue;
      const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, insertedId)).get();
      if (!created) continue;
      channels.push(created);
      createdChannels++;
      desiredKeys.add(candidateKey);
    }

    for (const channel of routeChannels) {
      const channelKey = buildChannelKey(channel);
      if (desiredKeys.has(channelKey)) {
        continue;
      }

      if (!channel.tokenId) {
        const preferred = await getPreferredAccountToken(channel.accountId);
        if (preferred && desiredKeys.has(`${channel.accountId}:${preferred.id}`)) {
          await db.update(schema.routeChannels)
            .set({ tokenId: preferred.id })
            .where(eq(schema.routeChannels.id, channel.id))
            .run();
          continue;
        }
      }

      if (!channel.manualOverride) {
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removedChannels++;
      }
    }
  }

  const latestModelNames = new Set<string>(Array.from(modelCandidates.keys()));
  for (const route of routes) {
    if ((route.routeMode || 'pattern') === 'explicit_group') {
      continue;
    }
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern) {
      continue;
    }
    if (!isExactModelPattern(modelPattern)) {
      const routeChannels = channels.filter((channel) => channel.routeId === route.id);
      const desiredCandidates = new Map<string, {
        accountId: number;
        tokenId: number | null;
        oauthRouteUnitId: number | null;
        sourceModel: string;
      }>();
      for (const [modelName, candidateMap] of modelCandidates.entries()) {
        if (!matchesModelPattern(modelName, modelPattern)) continue;
        for (const candidate of candidateMap.values()) {
          const desired = { ...candidate, sourceModel: modelName };
          desiredCandidates.set(`${buildCandidateKey(candidate)}:${modelName}`, desired);
        }
      }

      const desiredKeys = new Set<string>();
      const desiredSourceModelsByKey = new Map<string, Set<string>>();
      for (const candidate of desiredCandidates.values()) {
        const candidateKey = buildCandidateKey(candidate);
        desiredKeys.add(candidateKey);
        const normalizedSourceModel = candidate.sourceModel.trim().toLowerCase();
        if (!desiredSourceModelsByKey.has(candidateKey)) desiredSourceModelsByKey.set(candidateKey, new Set());
        desiredSourceModelsByKey.get(candidateKey)!.add(normalizedSourceModel);
      }

      for (const channel of routeChannels) {
        if (channel.manualOverride) continue;
        const channelKey = buildChannelKey(channel);
        const normalizedSourceModel = (channel.sourceModel || '').trim().toLowerCase();
        const sourceModels = desiredSourceModelsByKey.get(channelKey);
        if (desiredKeys.has(channelKey) && sourceModels?.has(normalizedSourceModel)) continue;
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        const index = channels.findIndex((item) => item.id === channel.id);
        if (index >= 0) channels.splice(index, 1);
        const routeIndex = routeChannels.findIndex((item) => item.id === channel.id);
        if (routeIndex >= 0) routeChannels.splice(routeIndex, 1);
        removedChannels++;
      }

      for (const candidate of desiredCandidates.values()) {
        const exists = routeChannels.some((channel) => (
          buildChannelKey(channel) === buildCandidateKey(candidate)
          && (channel.sourceModel || '').trim().toLowerCase() === candidate.sourceModel.trim().toLowerCase()
        ));
        if (exists) continue;

        const inserted = await db.insert(schema.routeChannels).values({
          routeId: route.id,
          accountId: candidate.accountId,
          tokenId: candidate.tokenId,
          oauthRouteUnitId: candidate.oauthRouteUnitId,
          sourceModel: candidate.sourceModel,
          priority: 0,
          weight: 10,
          enabled: true,
          manualOverride: false,
        }).run();
        const insertedId = getInsertedRowId(inserted);
        if (insertedId == null) continue;
        const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, insertedId)).get();
        if (!created) continue;
        channels.push(created);
        routeChannels.push(created);
        createdChannels++;
      }
      continue;
    }
    if (latestModelNames.has(modelPattern)) {
      continue;
    }
    if (explicitGroupSourceRouteIds.has(route.id)) {
      continue;
    }

    const routeChannelCount = channels.filter((channel) => channel.routeId === route.id).length;
    if (routeChannelCount > 0) {
      removedChannels += routeChannelCount;
    }

    const deleted = (await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run()).changes;
    if (deleted > 0) {
      removedRoutes += deleted;
    }
  }

  if (createdRoutes > 0 || createdChannels > 0 || removedChannels > 0 || removedRoutes > 0) {
    await clearAllRouteDecisionSnapshots();
  }

  invalidateTokenRouterCache();

  return {
    models: modelCandidates.size,
    createdRoutes,
    createdChannels,
    removedChannels,
    removedRoutes,
  };
}

async function runRefreshModelsAndRebuildRoutes() {
  const refresh = await refreshModelsForAllActiveAccounts();
  const rebuild = await rebuildTokenRoutesFromAvailability();
  return { refresh, rebuild };
}

export async function refreshModelsAndRebuildRoutes() {
  if (inFlightRefreshModelsAndRebuildRoutes) {
    return inFlightRefreshModelsAndRebuildRoutes;
  }

  inFlightRefreshModelsAndRebuildRoutes = (async () => {
    try {
      return await runRefreshModelsAndRebuildRoutes();
    } finally {
      inFlightRefreshModelsAndRebuildRoutes = null;
    }
  })();

  return inFlightRefreshModelsAndRebuildRoutes;
}
