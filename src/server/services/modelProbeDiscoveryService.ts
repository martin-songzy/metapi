import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireSiteApiBaseUrl } from './siteApiEndpointService.js';
import { getAdapter } from './platforms/index.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { resolveChannelProxyUrl, withAccountProxyOverride, withResolvedProxyRequestInit } from './siteProxy.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isMaskedTokenValue,
  isUsableAccountToken,
} from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { maskCredentialInText } from './modelProbeSecrets.js';
import { fetchTokenAccessibleModels } from './modelProbeTokenModels.js';

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
 * Its own import list also names nothing from the routing layer (`tokenRouter` and
 * friends), and it calls nothing there, so it stays fully usable when
 * `PROXY_ROUTING_ENABLED=false`. That is a per-file property; the transitive import
 * closure does reach routing (see `modelProbeRunService.ts`).
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
 *
 * `credential` is threaded in purely to mask it. The message here is the upstream
 * response body verbatim (`platforms/base.ts` throws `HTTP ${status}: ${body}`),
 * and a relay that echoes the rejected key in that body would otherwise put it
 * into `liveFailure.message` → `notes[0]` → the `no_models` error, all of which
 * are served to the browser. Shape-based redaction at the HTTP boundary cannot be
 * relied on for this: an opaque session token has no recognizable shape.
 */
function classifyLiveFailure(error: unknown, credential: string): ModelProbeLiveFailure {
  const raw = (error as { message?: string })?.message || String(error || '模型发现失败');
  const message = maskCredentialInText(raw, credential);
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
 * Sentinel `tokenId` for the account-level primary key (`accounts.api_token` or
 * `accounts.access_token`). Those live on the account row, not in
 * `account_tokens`, so they have no row id of their own.
 *
 * Because 0 is shared across every account, anything keyed on it must also carry
 * `accountId` — which is why `model_probe_key_results` is unique on
 * (account_id, token_id, model_name) rather than (token_id, model_name), and why
 * `token_id` there cannot be a real foreign key.
 */
export const PRIMARY_PROBE_TOKEN_ID = 0;

/**
 * Why a key is present but will not be probed. `null` means it will be.
 *
 * Skipped keys are still returned rather than filtered out: a key that never ran
 * looks identical to a key that reached nothing once it is missing from the
 * results table, and that ambiguity is exactly what the per-key view exists to
 * remove.
 */
export type ProbeKeySkipReason = 'disabled' | 'credential_unavailable';

export type ProbeKeyCandidate = {
  /** `PRIMARY_PROBE_TOKEN_ID` for the account-level key, else `account_tokens.id`. */
  tokenId: number;
  /** Display label. Empty string for the primary key; the UI names it locally. */
  tokenName: string;
  /** Null exactly when `skipReason` is set — an unprobeable key has no usable value. */
  credential: string | null;
  credentialKind: ModelProbeCredentialKind;
  skipReason: ProbeKeySkipReason | null;
};

export type SelectedProbeKeys = {
  account: AccountRow;
  keys: ProbeKeyCandidate[];
};

/**
 * Every key on the highest-priority account of a site: the account-level primary
 * key plus each `account_tokens` row.
 *
 * Scoped to ONE account (the same one `selectProbeCredential` would pick) rather
 * than every account on the site — the per-key feature is about distinguishing
 * keys within an account, and widening it to all accounts would multiply probe
 * cost again for a dimension the results table only decorates.
 *
 * `enabled` is reused as the probe switch instead of adding a column: additional
 * keys never carry proxy traffic (they are a discovery axis only), so for them
 * that flag already means nothing except "should this be probed".
 */
async function selectProbeKeys(siteId: number): Promise<SelectedProbeKeys | null> {
  const selected = await selectProbeCredential(siteId);
  if (!selected) return null;

  const { account } = selected;
  const keys: ProbeKeyCandidate[] = [];

  // The primary key is whatever `selectProbeCredential` resolved, so routing and
  // probing agree on which credential is authoritative. When it resolved to a
  // managed row (the account carries neither apiToken nor accessToken), that row
  // keeps its real id and is skipped in the loop below rather than probed twice.
  const primaryTokenId = selected.credentialKind === 'managed_token'
    ? await resolveManagedCredentialTokenId(account.id, selected.credential)
    : PRIMARY_PROBE_TOKEN_ID;

  keys.push({
    tokenId: primaryTokenId ?? PRIMARY_PROBE_TOKEN_ID,
    tokenName: '',
    credential: selected.credential,
    credentialKind: selected.credentialKind,
    skipReason: null,
  });

  const tokens: AccountTokenRow[] = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, account.id))
    .orderBy(asc(schema.accountTokens.id))
    .all();

  for (const token of [...tokens].sort((left, right) => (left.id ?? 0) - (right.id ?? 0))) {
    if (token.id == null) continue;
    if (primaryTokenId != null && token.id === primaryTokenId) continue;

    const credential = usableCredentialValue(token.token);
    const ready = token.valueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
      && isUsableAccountToken(token)
      && credential != null;

    // Disabled outranks unusable in the reported reason: an operator who turned a
    // key off wants to see that, not a complaint about its value.
    const skipReason: ProbeKeySkipReason | null = token.enabled === false
      ? 'disabled'
      : (ready ? null : 'credential_unavailable');

    keys.push({
      tokenId: token.id,
      tokenName: token.name || '',
      credential: skipReason === null ? credential : null,
      credentialKind: 'managed_token',
      skipReason,
    });
  }

  return { account, keys };
}

/** Maps a resolved managed credential back to its row id, for dedupe against additional keys. */
async function resolveManagedCredentialTokenId(accountId: number, credential: string): Promise<number | null> {
  const tokens: AccountTokenRow[] = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .orderBy(asc(schema.accountTokens.id))
    .all();

  for (const token of [...tokens].sort((left, right) => (left.id ?? 0) - (right.id ?? 0))) {
    if (usableCredentialValue(token.token) === credential) return token.id ?? null;
  }

  return null;
}

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

  // From here down the credential is in scope, so every message this function
  // builds is masked by value before it escapes. These messages become
  // `liveFailure.message`, `notes[]` and `ModelProbeDiscoveryError.message`, and
  // the run service copies the last of those into `skipped[].message` — all served
  // to the browser.
  //
  // Where the protection actually lives, measured rather than assumed: only TWO
  // call sites carry load. `classifyLiveFailure` (the upstream body) and
  // `base_url_unavailable` (endpoint-resolution text) each fail a test when their
  // mask is removed. The `mask()` calls on `notes[0]`, on `no_models` and on
  // `credential_invalid` are defence in depth, not independent controls: the first
  // two wrap text `classifyLiveFailure` already masked, and the
  // `credential_invalid` template is local prose plus a parsed integer, so masking
  // it is a no-op by construction. They are kept so the invariant stays "every
  // message built here is masked" rather than a per-line judgement call — but if
  // `classifyLiveFailure` ever regresses, only `notes[0]` and `no_models` are
  // still standing behind it.
  const mask = (text: string) => maskCredentialInText(text, credential);

  let baseUrl: string;
  try {
    baseUrl = await requireSiteApiBaseUrl(site);
  } catch (error) {
    throw new ModelProbeDiscoveryError(
      'base_url_unavailable',
      mask((error as { message?: string })?.message || '当前站点的 API 请求地址均不可用'),
      { oauthProvider, cause: error },
    );
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const proxyUrl = await resolveChannelProxyUrl(site, account.extraConfig);

  // Prefer the OpenAI-compatible catalog scoped to THIS token before any
  // management-API listing. The adapter path below reads what the USER can reach;
  // the probe then fires with a TOKEN, and tokens sit in one group — so a model the
  // management API lists can be unreachable for that key ("无可用渠道") even though
  // it works through another key on the same site. `/v1/models` authenticated AS
  // the probe key makes the target list and the probing credential agree.
  //
  // Opportunistic by design: only `api_token` credentials are tried (session-style
  // access tokens are not Bearer keys), and ANY failure here falls through to the
  // adapter path untouched — some platforms do not expose `/v1/models` at all, and
  // discovery must not regress for them. `fetchTokenAccessibleModels` never throws.
  if (credentialKind === 'api_token') {
    const viaToken = await fetchTokenAccessibleModels({
      baseUrl,
      credential,
      timeoutMs: input.timeoutMs,
      buildRequestInit: (init) => withResolvedProxyRequestInit(site, proxyUrl, init),
    });
    if (viaToken && viaToken.length > 0) {
      return {
        site,
        account,
        credential,
        models: normalizeModelNames(viaToken),
        source: 'live',
        credentialKind,
      };
    }
  }

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
    liveFailure = classifyLiveFailure(error, credential);
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
      mask(`账号凭据已失效（HTTP ${liveFailure.status}），请更新 API Key 或访问令牌后重试`),
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
  const notes: string[] = [mask(`获取模型列表失败：${effectiveLiveFailure.message}`)];
  if (oauthProvider) {
    notes.push(mask(`未执行 ${oauthProvider} OAuth 云端模型发现（本版本不支持），仅使用上述来源`));
  }

  const cachedModels = await readCachedModelNames(account.id);
  if (cachedModels.length > 0) {
    // Locally authored, but pushed through `mask` anyway so the invariant is
    // "every entry in `notes` is masked" rather than a per-line judgement call.
    notes.push(mask('以下模型来自缓存，本次未验证凭据是否仍然有效'));
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
    mask(`没有可探测的模型：实时获取和历史缓存都是空的。${notes.join('；')}`),
    { oauthProvider, liveFailure: effectiveLiveFailure },
  );
}

/** One key's discovery outcome. `models` is what THAT key can reach, not the site total. */
export type ProbeKeyDiscovery = {
  tokenId: number;
  tokenName: string;
  /** Null exactly when `skipReason` is set. */
  credential: string | null;
  credentialKind: ModelProbeCredentialKind;
  /** Set when the key was never fetched at all. */
  skipReason: ProbeKeySkipReason | null;
  models: string[];
  /** Null when the key was skipped — nothing was fetched, so there is no source. */
  source: ModelProbeDiscoverySource | null;
  /** Why `models` is empty or unverified. Null on a clean live hit. */
  liveFailure: ModelProbeLiveFailure | null;
  notes: string[];
};

export type ModelProbeKeyDiscoveryResult = {
  site: SiteRow;
  account: AccountRow;
  keys: ProbeKeyDiscovery[];
  /** Union of every key's models, deduped — the site's full probe target list. */
  models: string[];
};

/**
 * Per-key model discovery: every key on the site's highest-priority account
 * fetches its own catalog, and the site's target list is their union.
 *
 * The union matters because keys on one relay account routinely sit in different
 * token groups, so a model only key B can reach would never be probed if the
 * target list came from key A alone.
 *
 * Two deliberate asymmetries between the primary key and the additional ones:
 *
 *  - The primary key keeps today's exact semantics by delegating to
 *    `discoverModelsForActiveProbe` (token catalog → management adapter → cached
 *    fallback), so existing single-key behaviour is untouched.
 *  - Additional keys use `/v1/models` ONLY. The management adapter is user-scoped,
 *    not token-scoped, so it would hand every key an identical list and erase the
 *    very difference this feature exists to show. Cache is per-account for the
 *    same reason. An additional key that reaches nothing reports nothing.
 */
export async function discoverProbeKeysForActiveProbe(input: {
  siteId: number;
  timeoutMs: number;
}): Promise<ModelProbeKeyDiscoveryResult> {
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

  const selected = await selectProbeKeys(site.id);
  if (!selected) {
    throw new ModelProbeDiscoveryError(
      'no_credential',
      '该站点没有携带可用凭据的活跃账号，请先为账号补充 API Key 或访问令牌',
    );
  }

  const { account, keys } = selected;

  // A dead primary key is downgraded from fatal to per-key here: it must not hide
  // models that a secondary key can still reach. Site-level codes are rethrown
  // untouched, because no other key can salvage them.
  let primaryTarget: ModelProbeDiscoveryTarget | null = null;
  let primaryError: ModelProbeDiscoveryError | null = null;
  try {
    primaryTarget = await discoverModelsForActiveProbe(input);
  } catch (error) {
    if (!(error instanceof ModelProbeDiscoveryError)) throw error;
    if (error.code === 'site_not_found'
      || error.code === 'adapter_unavailable'
      || error.code === 'no_credential') {
      throw error;
    }
    primaryError = error;
  }

  // `selectProbeKeys` builds the list with the primary key first, so POSITION is
  // the discriminator here, not the id. Comparing ids would be wrong twice over:
  // the sentinel 0 is shared across accounts, and when the primary resolves to a
  // managed row it carries a real `account_tokens.id` indistinguishable in shape
  // from the additional keys.
  const [primaryKey, ...additionalKeys] = keys;
  if (!primaryKey) {
    throw new ModelProbeDiscoveryError(
      'no_credential',
      '该站点没有携带可用凭据的活跃账号，请先为账号补充 API Key 或访问令牌',
    );
  }

  const needsBaseUrl = additionalKeys.some((key) => key.skipReason === null && key.credential);

  let baseUrl: string | null = null;
  let baseUrlError: string | null = null;
  if (needsBaseUrl) {
    try {
      baseUrl = await requireSiteApiBaseUrl(site);
    } catch (error) {
      baseUrlError = (error as { message?: string })?.message || '当前站点的 API 请求地址均不可用';
    }
  }

  const proxyUrl = await resolveChannelProxyUrl(site, account.extraConfig);

  const discovered: ProbeKeyDiscovery[] = [{
    tokenId: primaryKey.tokenId,
    tokenName: primaryKey.tokenName,
    credential: primaryKey.credential,
    credentialKind: primaryKey.credentialKind,
    skipReason: null,
    models: primaryTarget?.models ?? [],
    source: primaryTarget?.source ?? null,
    liveFailure: primaryTarget?.source === 'cached'
      ? primaryTarget.liveFailure
      : (primaryError?.liveFailure ?? null),
    notes: primaryTarget?.notes ?? (primaryError ? [primaryError.message] : []),
  }];

  for (const key of additionalKeys) {
    if (key.skipReason !== null || !key.credential) {
      discovered.push({
        tokenId: key.tokenId,
        tokenName: key.tokenName,
        credential: null,
        credentialKind: key.credentialKind,
        skipReason: key.skipReason ?? 'credential_unavailable',
        models: [],
        source: null,
        liveFailure: null,
        notes: [],
      });
      continue;
    }

    // Every message built below is masked by this key's own value before it can
    // reach `notes` → the results page, same invariant as the primary path.
    const maskKey = (text: string) => maskCredentialInText(text, key.credential || '');

    if (!baseUrl) {
      discovered.push({
        tokenId: key.tokenId,
        tokenName: key.tokenName,
        credential: key.credential,
        credentialKind: key.credentialKind,
        skipReason: null,
        models: [],
        source: 'live',
        liveFailure: {
          kind: 'transport',
          status: null,
          message: maskKey(baseUrlError || '当前站点的 API 请求地址均不可用'),
        },
        notes: [maskKey(`获取模型列表失败：${baseUrlError || '当前站点的 API 请求地址均不可用'}`)],
      });
      continue;
    }

    // Never throws by contract, so no classification is needed — a null return and
    // an empty array are both "this key reached nothing".
    const viaToken = await fetchTokenAccessibleModels({
      baseUrl,
      credential: key.credential,
      timeoutMs: input.timeoutMs,
      buildRequestInit: (init) => withResolvedProxyRequestInit(site, proxyUrl, init),
    });

    const models = normalizeModelNames(viaToken || []);
    discovered.push({
      tokenId: key.tokenId,
      tokenName: key.tokenName,
      credential: key.credential,
      credentialKind: key.credentialKind,
      skipReason: null,
      models,
      source: 'live',
      liveFailure: models.length > 0 ? null : {
        kind: 'empty_unknown',
        status: null,
        message: '该 Key 的 /v1/models 没有返回任何模型。可能是它所在的令牌分组确实没有可用模型，'
          + '也可能是该 Key 已失效',
      },
      notes: models.length > 0
        ? []
        : [maskKey('该 Key 未获取到模型列表，本次不会为它发起探测')],
    });
  }

  const models = normalizeModelNames(discovered.flatMap((key) => key.models));

  // Nothing reachable through any key. Surface the primary key's own diagnosis
  // rather than a generic message — it is the only path that distinguishes
  // auth failure from an empty catalog.
  if (models.length === 0) {
    if (primaryError) throw primaryError;
    throw new ModelProbeDiscoveryError(
      'no_models',
      '没有可探测的模型：该账号下所有 Key 都没有返回模型',
      { oauthProvider: getOauthInfoFromAccount(account)?.provider || null },
    );
  }

  return { site, account, keys: discovered, models };
}
