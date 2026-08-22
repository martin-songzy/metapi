import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireSiteApiBaseUrl } from './siteApiEndpointService.js';
import { getAdapter } from './platforms/index.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { resolveChannelProxyUrl, withAccountProxyOverride } from './siteProxy.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isMaskedTokenValue,
  isUsableAccountToken,
} from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';

/**
 * Read-only model discovery for the active model probe preview/run flows.
 *
 * This module is deliberately side-effect free: it only ever issues `db.select`
 * queries. It must never call `refreshModelsForAccount()` from `modelService`,
 * because that helper deletes and rewrites `model_availability`, mutates account
 * health, kicks off post-refresh probes and rebuilds `token_routes` /
 * `route_channels` — all unacceptable behind a "preview" button.
 *
 * For the same reason it calls `requireSiteApiBaseUrl()` rather than
 * `runWithSiteApiEndpointPool()`: the pool helper records endpoint
 * success/failure cooldown state, which is a write.
 *
 * It also imports nothing from the routing layer (`tokenRouter` and friends), so
 * it stays fully usable when `PROXY_ROUTING_ENABLED=false`.
 */

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type AccountTokenRow = typeof schema.accountTokens.$inferSelect;

export type ModelProbeDiscoverySource = 'live' | 'cached';

export type ModelProbeCredentialKind = 'api_token' | 'access_token' | 'managed_token';

/**
 * Machine-readable description of a failed live fetch, so a caller can decide
 * whether cached models are safe to act on instead of parsing prose.
 */
export type ModelProbeLiveFailure = {
  /**
   * `empty_unknown` is the common case, not an edge case. Most adapters swallow
   * errors inside `getModels` and return `[]` (see `newApi.ts` and
   * `standardApiProvider.ts`, both `catch { return []; }`), so for them a revoked
   * credential is indistinguishable from a site that genuinely has no models.
   */
  kind: 'auth' | 'timeout' | 'transport' | 'empty_unknown';
  status: number | null;
  message: string;
};

type ModelProbeDiscoveryBase = {
  site: SiteRow;
  account: AccountRow;
  credential: string;
  models: string[];
  credentialKind: ModelProbeCredentialKind;
  notes?: string[];
};

/**
 * Modelled as a discriminated union so that "cached models with no stated reason"
 * is unrepresentable. A cached result means the credential was never confirmed
 * working, and the caller must be able to see that structurally rather than
 * having it read as a clean success.
 */
export type ModelProbeDiscoveryTarget =
  | (ModelProbeDiscoveryBase & { source: 'live'; liveFailure?: never })
  | (ModelProbeDiscoveryBase & { source: 'cached'; liveFailure: ModelProbeLiveFailure });

export type ModelProbeDiscoveryErrorCode =
  | 'site_not_found'
  | 'adapter_unavailable'
  | 'no_credential'
  | 'credential_invalid'
  | 'base_url_unavailable'
  | 'no_models';

export class ModelProbeDiscoveryError extends Error {
  readonly code: ModelProbeDiscoveryErrorCode;
  readonly oauthProvider: string | null;
  readonly liveFailure: ModelProbeLiveFailure | null;

  constructor(
    code: ModelProbeDiscoveryErrorCode,
    message: string,
    options?: {
      oauthProvider?: string | null;
      liveFailure?: ModelProbeLiveFailure | null;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ModelProbeDiscoveryError';
    this.code = code;
    this.oauthProvider = options?.oauthProvider ?? null;
    this.liveFailure = options?.liveFailure ?? null;
  }
}

/** Sentinel so timeout detection never depends on matching message text. */
class DiscoveryTimeoutError extends Error {}

/**
 * A revoked or rejected credential is not the same as "upstream was flaky".
 * Serving cached models under a dead credential would make preview look
 * successful while every probe in the run phase is doomed, so 401/403 has to be
 * distinguishable by the caller.
 */
function classifyLiveFailure(error: unknown): ModelProbeLiveFailure {
  const message = (error as { message?: string })?.message || String(error || '模型发现失败');
  if (error instanceof DiscoveryTimeoutError) {
    return { kind: 'timeout', status: null, message };
  }

  const matched = message.match(/\bHTTP\s+(\d{3})\b/i);
  const status = matched ? Number.parseInt(matched[1] || '', 10) : null;
  const normalizedStatus = Number.isFinite(status) ? status : null;
  if (normalizedStatus === 401 || normalizedStatus === 403) {
    return { kind: 'auth', status: normalizedStatus, message };
  }

  return { kind: 'transport', status: normalizedStatus, message };
}

/**
 * Trim, drop blanks, and dedupe case-insensitively while keeping the casing of
 * the first occurrence. Mirrors the normalization the write path applies so a
 * preview shows exactly the names a real refresh would store.
 */
function normalizeModelNames(models: readonly unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const modelName = raw.trim();
    if (!modelName) continue;
    const dedupeKey = modelName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(modelName);
  }

  return normalized;
}

/** `isPinned desc, sortOrder asc, id asc` — null-safe so ordering stays stable. */
function compareAccountPriority(left: AccountRow, right: AccountRow): number {
  const pinned = Number(right.isPinned === true) - Number(left.isPinned === true);
  if (pinned !== 0) return pinned;
  const sortOrder = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
  if (sortOrder !== 0) return sortOrder;
  return (left.id ?? 0) - (right.id ?? 0);
}

function usableCredentialValue(raw: string | null | undefined): string | null {
  const credential = (raw || '').trim();
  if (!credential) return null;
  if (isMaskedTokenValue(credential)) return null;
  return credential;
}

async function selectManagedCredential(accountId: number): Promise<string | null> {
  const tokens: AccountTokenRow[] = await db.select()
    .from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .orderBy(asc(schema.accountTokens.id))
    .all();

  const ordered = [...tokens].sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
  for (const token of ordered) {
    if (!isUsableAccountToken(token)) continue;
    const credential = usableCredentialValue(token.token);
    if (credential) return credential;
  }

  return null;
}

type SelectedCredential = {
  account: AccountRow;
  credential: string;
  credentialKind: ModelProbeCredentialKind;
};

/**
 * Walks active accounts in deterministic priority order and returns the first
 * one that carries a usable credential, preferring `apiToken`, then
 * `accessToken`, then a managed ready `account_tokens` row.
 */
async function selectProbeCredential(siteId: number): Promise<SelectedCredential | null> {
  // `status` is nullable (schema.ts), and the rest of the repo reads a null
  // status as active via `(status || 'active') === 'active'`. Excluding NULL in
  // SQL would leave a legacy account unpreviewable behind a misleading
  // "no credential" error, so match the same semantics here.
  const accounts: AccountRow[] = await db.select()
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.siteId, siteId),
      or(
        isNull(schema.accounts.status),
        eq(schema.accounts.status, 'active'),
      ),
    ))
    .orderBy(
      desc(schema.accounts.isPinned),
      asc(schema.accounts.sortOrder),
      asc(schema.accounts.id),
    )
    .all();

  const ordered = [...accounts]
    .filter((account) => (account.status || 'active') === 'active')
    .sort(compareAccountPriority);

  for (const account of ordered) {
    const apiToken = usableCredentialValue(account.apiToken);
    if (apiToken) return { account, credential: apiToken, credentialKind: 'api_token' };

    const accessToken = usableCredentialValue(account.accessToken);
    if (accessToken) return { account, credential: accessToken, credentialKind: 'access_token' };

    const managed = await selectManagedCredential(account.id);
    if (managed) return { account, credential: managed, credentialKind: 'managed_token' };
  }

  return null;
}

async function readCachedModelNames(accountId: number): Promise<string[]> {
  const rows = await db.select({ modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, accountId),
      eq(schema.modelAvailability.available, true),
    ))
    .all();

  return normalizeModelNames(rows.map((row) => row.modelName));
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DiscoveryTimeoutError(message)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function discoverModelsForActiveProbe(input: {
  siteId: number;
  timeoutMs: number;
}): Promise<ModelProbeDiscoveryTarget> {
  const site: SiteRow | undefined = await db.select()
    .from(schema.sites)
    .where(eq(schema.sites.id, input.siteId))
    .get();
  if (!site) {
    throw new ModelProbeDiscoveryError('site_not_found', '站点不存在');
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) {
    throw new ModelProbeDiscoveryError(
      'adapter_unavailable',
      `站点平台 ${site.platform || '未知'} 暂不支持模型发现`,
    );
  }

  const selected = await selectProbeCredential(site.id);
  if (!selected) {
    throw new ModelProbeDiscoveryError(
      'no_credential',
      '该站点没有携带可用凭据的活跃账号，请先为账号补充 API Key 或访问令牌',
    );
  }

  const { account, credential, credentialKind } = selected;
  const oauthProvider = getOauthInfoFromAccount(account)?.provider || null;

  let baseUrl: string;
  try {
    baseUrl = await requireSiteApiBaseUrl(site);
  } catch (error) {
    throw new ModelProbeDiscoveryError(
      'base_url_unavailable',
      (error as { message?: string })?.message || '当前站点的 API 请求地址均不可用',
      { oauthProvider, cause: error },
    );
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const proxyUrl = resolveChannelProxyUrl(site, account.extraConfig);

  let liveModels: string[] = [];
  let liveFailure: ModelProbeLiveFailure | null = null;
  try {
    liveModels = normalizeModelNames(await runWithTimeout(
      () => withAccountProxyOverride(
        proxyUrl,
        () => adapter.getModels(baseUrl, credential, platformUserId),
      ),
      input.timeoutMs,
      `模型发现超时（${Math.max(1, Math.round(input.timeoutMs))}ms）`,
    ));
  } catch (error) {
    liveFailure = classifyLiveFailure(error);
  }

  if (liveModels.length > 0) {
    return { site, account, credential, models: liveModels, source: 'live', credentialKind };
  }

  // The brief only asks for a cached fallback when the live result is *empty*.
  // An auth rejection is different in kind: the credential we would hand back is
  // provably dead, so cached models would make preview read as success while the
  // run phase fails on every single probe. Refuse instead.
  if (liveFailure?.kind === 'auth') {
    throw new ModelProbeDiscoveryError(
      'credential_invalid',
      `账号凭据已失效（HTTP ${liveFailure.status}），请更新 API Key 或访问令牌后重试`,
      { oauthProvider, liveFailure },
    );
  }

  // Reaching here means the live fetch produced no models. If the adapter threw,
  // we know why; if it returned [] we do not, because most adapters swallow the
  // error. Either way the credential is UNVERIFIED, so a cached result must carry
  // a reason. Never leave this null: that is what would let a revoked credential
  // read as a clean success.
  //
  // The copy below is operator-facing: `empty_unknown` is the MOST COMMON failure
  // path (most adapters return `[]` instead of throwing), and this message ends up
  // in `notes[0]`, in the `no_models` error and on the results page. It therefore
  // states what the operator observes and what to check, not how the adapter layer
  // is implemented. `kind: 'empty_unknown'` is the machine-readable half for anyone
  // who needs the distinction.
  const effectiveLiveFailure: ModelProbeLiveFailure = liveFailure ?? {
    kind: 'empty_unknown',
    status: null,
    message: '上游没有返回任何模型，也没有报错。可能是该账号在此站点确实没有可用模型，'
      + '也可能是凭据已失效，请先确认账号凭据仍然有效',
  };

  // OAuth-only accounts (Codex / Claude / Gemini CLI / Antigravity) need cloud
  // discovery that this read-only v1 intentionally does not perform, so their
  // adapters can legitimately come back empty. Say so rather than implying the
  // account simply has no models.
  const notes: string[] = [`获取模型列表失败：${effectiveLiveFailure.message}`];
  if (oauthProvider) {
    notes.push(`未执行 ${oauthProvider} OAuth 云端模型发现（本版本不支持），仅使用上述来源`);
  }

  const cachedModels = await readCachedModelNames(account.id);
  if (cachedModels.length > 0) {
    notes.push('以下模型来自缓存，本次未验证凭据是否仍然有效');
    return {
      site,
      account,
      credential,
      models: cachedModels,
      source: 'cached',
      credentialKind,
      notes,
      liveFailure: effectiveLiveFailure,
    };
  }

  throw new ModelProbeDiscoveryError(
    'no_models',
    `没有可探测的模型：实时获取和历史缓存都是空的。${notes.join('；')}`,
    { oauthProvider, liveFailure: effectiveLiveFailure },
  );
}
