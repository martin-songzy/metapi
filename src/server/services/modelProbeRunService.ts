import { and, asc, desc, eq, inArray, sql, type Column, type SQL } from 'drizzle-orm';

import { config } from '../config.js';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import { normalizeModelProbeEndpointType } from '../../shared/modelProbeEndpointTypes.js';
import {
  appendBackgroundTaskLog,
  getBackgroundTask,
  getRunningTaskByDedupeKey,
  startBackgroundTask,
  type BackgroundTask,
} from './backgroundTaskService.js';
import { compileInterestPatterns, matchesInterest, type InvalidInterestPattern } from './modelInterestFilter.js';
import {
  loadModelProbeConfig,
  resolveEnabledInterestPatterns,
  resolveModelProbeUserAgent,
  type ModelProbeConfig,
} from './modelProbeConfigService.js';
import {
  discoverProbeKeysForActiveProbe,
  ModelProbeDiscoveryError,
  PRIMARY_PROBE_TOKEN_ID,
  type ModelProbeDiscoveryErrorCode,
  type ModelProbeDiscoverySource,
  type ModelProbeLiveFailure,
  type ProbeKeySkipReason,
} from './modelProbeDiscoveryService.js';
import { chooseModelProbePrompt } from './modelProbePrompts.js';
import { maskCredentialInText } from './modelProbeSecrets.js';
import { probeRuntimeModel, type RuntimeModelProbeStatus } from './runtimeModelProbe.js';
import type { ModelProbeFailureKind } from './modelProbeResponseClassifier.js';
import type { UpstreamEndpoint } from './upstreamEndpointRuntime.js';

/**
 * Cross-site orchestration for the active model probe: preview, run, and results.
 *
 * Three properties are load-bearing and each has a test:
 *
 * 1. `previewActiveModelProbe` performs **zero writes and zero runtime probes**.
 *    It answers "what would a run touch?" using read-only discovery, so the
 *    preview button can never spend upstream quota or change routing.
 * 2. Nothing here registers a timer. Unlike `modelAvailabilityProbeService`, this
 *    module has no scheduler at all: every run is explicitly queued by an
 *    operator. That is the whole point of the "active" probe — it must never turn
 *    into unattended periodic traffic against upstream relays.
 * 3. `inconclusive` is recorded in `model_probe_results` for diagnosis but never
 *    reaches `model_availability`. A timeout, 429 or dropped socket says nothing
 *    about whether a model exists.
 * 4. A sweep can be stopped. `requestActiveModelProbeCancellation` sets a flag the
 *    run loop reads between models, so an operator who realises the interest regex
 *    was wrong stops paying for it within one probe. A cancelled sweep keeps its
 *    partial results, reports `cancelled: true`, and is never presented as a
 *    completed one. What the routing write is withheld from is a sweep that
 *    actually left work undone (`remaining > 0`), not merely one whose flag is set:
 *    a cancel landing while the final model was already in flight stops nothing, so
 *    treating it as partial would discard a fully paid sweep's verdicts.
 *
 * Every entry point here keeps working with `PROXY_ROUTING_ENABLED=false`. What
 * makes that true is that nothing routing-related *executes* unless a caller asks
 * for it: this module's own import list names no routing module, and none of the
 * modules involved runs anything at import time.
 *
 * It is specifically NOT true that the routing stack is absent from the transitive
 * import closure. `runtimeModelProbe` imports `oauth/service.js`, which imports
 * `modelService.js`, which imports `tokenRouter.js` — an edge that predates this
 * feature. So `await import('./modelService.js')` in `syncUnsupportedToRouting`
 * keeps this file's import list clean, but it is not isolation: it resolves from an
 * already-warm module cache and must not be read as proof the module was excluded.
 *
 * The commitment that matters is behavioural, and it is pinned behaviourally —
 * `modelProbe.e2e.test.ts` runs a real sweep against a real server with
 * `PROXY_ROUTING_ENABLED=false` and asserts no routing state is written.
 */

export const ACTIVE_MODEL_PROBE_TASK_TYPE = 'active-model-probe';
export const ACTIVE_MODEL_PROBE_DEDUPE_PREFIX = 'active-model-probe';

/**
 * Ceiling on one queued sweep. Concurrency defaults to 1 on purpose (a burst of
 * parallel probes is exactly the shape upstream liveness detection looks for), so
 * a broad regex across many sites would otherwise mean an hours-long serial run
 * against real quota. A run that would exceed this refuses with the numbers
 * needed to narrow the regex rather than truncating silently.
 */
export const MAX_ACTIVE_PROBE_RUN_TARGETS = 300;

/**
 * Above this many probe targets a run needs the operator to echo the count back.
 * 50 sequential probes at the default concurrency of 1 is already minutes of real
 * upstream traffic, so it is the point where "I clicked the wrong button" should
 * cost a dialog rather than quota.
 *
 * Defined HERE, next to the cap, and re-exported by `modelProbeApiService` — the
 * HTTP gate and the runner's own re-check must not be able to describe the same
 * threshold differently. The dependency only runs one way (the api service imports
 * this module, never the reverse), so this is the end that can own it.
 *
 * Set to Infinity to effectively disable the confirmation gate — the 300-target
 * hard cap still applies, but nothing below it triggers a dialog.
 */
export const MODEL_PROBE_CONFIRM_TARGET_THRESHOLD = Infinity;

/**
 * How far the freshly discovered target set may exceed what the gate authorized.
 *
 * The gate demands an EXACT echo of its own preview, but the runner discovers
 * again, so the two legitimately disagree: a site gains or loses a model between
 * the two calls. Requiring exactness here would therefore fail a paid run the
 * operator correctly authorized, which is its own defect — so the runner allows
 * bounded drift and refuses only a material excess.
 *
 * Two slack terms, because one alone is wrong at one end of the range. The
 * absolute floor keeps small sweeps workable (authorize 51, run up to 61) where a
 * ratio would allow almost nothing; the ratio keeps the allowance proportional at
 * the top (authorize 200, run up to 220) where a fixed 10 would be noise. Both are
 * far below the failure this exists to stop, which is a whole site reappearing
 * between the gate and the sweep and adding hundreds of targets.
 */
export const MODEL_PROBE_AUTHORIZED_COUNT_SLACK = 10;
export const MODEL_PROBE_AUTHORIZED_COUNT_SLACK_RATIO = 0.1;

/**
 * Total for every input, including the non-finite ones.
 *
 * `Math.max(0, Math.trunc(NaN))` is `NaN`, not 0 — so a NaN used to propagate all
 * the way out, and `targets.length > NaN` is always false, meaning the guard would
 * have failed OPEN and licensed an unbounded paid sweep. The HTTP path cannot
 * produce a NaN (`preview.totalModels` is a reduce over array lengths), so this is
 * a latent trap for an internal caller rather than a reachable bug, but a guard
 * whose degenerate input disables it is the wrong shape regardless.
 *
 * ZERO authorizes zero, with no slack. The absolute floor exists to keep small
 * sweeps workable — authorize 51, run up to 61 — and there is nothing to keep
 * workable at 0. The scenario is reachable over HTTP: when every site's model-list
 * request times out, `preview.totalModels` is 0, that is under the dialog
 * threshold, so the run is queued with `authorizedTargetCount: 0` and no dialog
 * shown; discovery then recovers and the sweep issued up to 10 real paid requests
 * the operator was told nothing about. `authorizedTargetCount` always comes from a
 * FRESH preview taken at gate time, so 0 means "a fresh look found nothing to
 * probe" — if the runner's own discovery then finds targets, the set moved between
 * the two, which is precisely what this ceiling exists to refuse.
 */
export function modelProbeAuthorizedTargetCeiling(authorizedTargetCount: number): number {
  const truncated = Math.trunc(authorizedTargetCount);
  const authorized = Number.isFinite(truncated) ? Math.max(0, truncated) : 0;
  if (authorized === 0) return 0;
  return authorized + Math.max(
    MODEL_PROBE_AUTHORIZED_COUNT_SLACK,
    Math.ceil(authorized * MODEL_PROBE_AUTHORIZED_COUNT_SLACK_RATIO),
  );
}

/**
 * Model-list discovery is a plain management read (one GET per site, the same
 * call a normal model refresh makes), not probe traffic, so it does not share the
 * deliberately-1 probe concurrency. The floor keeps a preview over a dozen sites
 * from serializing into minutes of waiting. Sites are unique per (platform, url),
 * so these requests fan out across different upstreams rather than bursting at one.
 */
const DISCOVERY_MIN_CONCURRENCY = 4;

/**
 * Storage bound for the persisted `reason` column.
 *
 * KNOWN LIMITATION, reviewed and accepted — do not "fix" this by raising the
 * number. `reason` is cut to this length before the API boundary's redactor ever
 * sees it, and on the classifier-authored path it is cut twice: once at
 * construction (`modelProbeResponseClassifier.capReason`, same 1000) and again
 * here on the way into the column. The boundary
 * (`modelProbeApiService.redactUpstreamProbeText`) serves at that same length and
 * relies on an overlap window to keep a secret from straddling its own final cut.
 *
 * Consequence, stated plainly: for the PERSISTED path that window cannot help.
 * A *foreign* JWT straddling this cut is already bisected in the database, and a
 * bisected JWT never matches the JWT pattern — the surviving header/payload
 * segments are base64url JSON, i.e. readable claims. The window still protects the
 * unpersisted fields (`notes`, `liveFailure.message`, `skipped[].message`), which
 * are never truncated before the boundary.
 *
 * Why this is accepted rather than fixed:
 *
 * - The probe's OWN credential is not exposed by it. That one is masked by value
 *   (`maskCredentialInText`) before either cut, which is the stronger control and
 *   is independent of length.
 * - What remains is shape-based redaction of THIRD-PARTY secrets appearing in
 *   upstream error text, disclosed to the admin who already owns the keys for
 *   these sites. No privilege boundary is crossed.
 * - Both fixes are worse. Raising this bound repurposes a column-size limit as a
 *   security parameter; moving shape-redaction into this service reopens a
 *   reviewed design boundary that deliberately keeps redaction at the HTTP edge
 *   and leaves server-side operators the original upstream wording.
 */
const MAX_PERSISTED_REASON_LENGTH = 1_000;
const DEFAULT_RESULTS_LIMIT = 100;
const MAX_RESULTS_LIMIT = 500;

/**
 * Field paths in the structures this module returns whose text is copied verbatim
 * from an upstream relay. Task 10 redacts these at the HTTP boundary; they are
 * enumerated here rather than pre-redacted so an operator debugging from the
 * server side still sees the original wording.
 *
 * BOTH redaction and length-bounding belong to that boundary
 * (`modelProbeApiService.redactUpstreamProbeText`), and neither is applied here.
 * Nothing in this module truncates a `message`: cutting text short before the
 * redactor runs would hand it a body a secret can straddle, which is exactly the
 * failure the boundary's overlap window exists to prevent. The one length cap in
 * this file is `MAX_PERSISTED_REASON_LENGTH`, which is a database column limit and
 * applies only to the persisted `reason` — see `upsertModelProbeResult`.
 *
 * Everything not listed here is either generated locally or a plain identifier.
 * No credential ever enters any of these structures: only projected fields are
 * copied out of a site/account row, never the row itself.
 *
 * Background task log lines are a separate surface with the same property: the
 * per-model line carries only status/latency/HTTP status/failure kind (never
 * `reason`), but a "skipped site" line quotes the discovery error, which is
 * upstream-authored. The tasks API should treat those lines the same way.
 */
export const MODEL_PROBE_UPSTREAM_TEXT_FIELDS: readonly string[] = [
  'reason',
  'notes',
  'liveFailure.message',
  'skipped.message',
  'skippedSites.message',
];

export type ModelProbeSkipCode = ModelProbeDiscoveryErrorCode | 'site_disabled' | 'discovery_failed';

export type ModelProbeSkippedSite = {
  siteId: number;
  siteName: string;
  code: ModelProbeSkipCode;
  /** May embed upstream prose — see MODEL_PROBE_UPSTREAM_TEXT_FIELDS. */
  message: string;
};

export type ModelProbePreviewSite = {
  siteId: number;
  siteName: string;
  source: ModelProbeDiscoverySource;
  /** False whenever models came from cache: the credential was never proven. */
  credentialVerified: boolean;
  discoveredCount: number;
  models: string[];
  /**
   * Probe targets contributed by this site, i.e. `Σ keys (models this key reaches)`.
   *
   * Distinct from `models.length`, which is the site-level UNION across keys. With
   * three keys whose catalogs overlap the union is far smaller than the number of
   * requests the sweep will actually issue, and this is the billable count.
   */
  targetCount: number;
  /** Per-key breakdown, so the preview can show which key contributes what. */
  keys: ModelProbePreviewKey[];
  liveFailure: ModelProbeLiveFailure | null;
  notes: string[];
};

export type ModelProbePreviewKey = {
  tokenId: number;
  tokenName: string;
  isPrimary: boolean;
  /** Null when this key will be probed; a reason when it will be skipped. */
  skipReason: ProbeKeySkipReason | null;
  discoveredCount: number;
  modelCount: number;
};

export type ModelProbePreview = {
  sites: ModelProbePreviewSite[];
  /**
   * The number of probe requests a run over this set would issue — the per-key
   * total, NOT the count of distinct models.
   *
   * It must be the same quantity `runActiveModelProbe` counts, because the
   * confirmation gate authorizes this number and the runner refuses to exceed it.
   * They disagreed once: the preview summed the site-level model union while the
   * runner built a (key × model) product, so any site with more than one key made
   * the authorized ceiling unreachable and every sweep was refused — after the
   * operator had already confirmed. It also understated the cost by the same factor.
   */
  totalModels: number;
  invalidPatterns: InvalidInterestPattern[];
  skipped: ModelProbeSkippedSite[];
  /** True when a run over this target set would be refused by the size cap. */
  exceedsRunLimit: boolean;
};

export type ModelProbeRunSummary = {
  siteCount: number;
  probed: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  skipped: number;
  disabled: number;
  routingSynced: boolean;
  skippedSites: ModelProbeSkippedSite[];
  invalidPatterns: InvalidInterestPattern[];
  /**
   * True when an operator stopped the sweep. The counters then describe a PARTIAL
   * sweep, so no consumer may read this summary as a completed one: `probed` says
   * nothing about the `remaining` models, which were never asked.
   */
  cancelled: boolean;
  /** Targets that existed but were never probed because the sweep was stopped. */
  remaining: number;
};

/**
 * Task ids an operator asked to stop, checked between models by the run loop.
 *
 * Scoped to this module ON PURPOSE rather than added to `backgroundTaskService`.
 * That service is shared with the update center and friends; giving it a general
 * cancellation concept late in this feature's life would put every other consumer
 * at regression risk for no benefit here. A general task-cancellation feature
 * remains possible later, and this is not in its way.
 *
 * Entries are removed when the run settles, so a flag cannot leak into a later
 * sweep that happens to reuse the scope. The set is bounded by the number of
 * concurrently running sweeps, and `requestActiveModelProbeCancellation` refuses
 * ids that are not live probe tasks, so it cannot be grown by a caller.
 */
const cancelledProbeTaskIds = new Set<string>();

export type ModelProbeCancellationOutcome = 'accepted' | 'not_found' | 'already_finished';

/**
 * Asks a running sweep to stop after the model it is currently probing.
 *
 * Deliberately NOT an `AbortSignal`: the in-flight request is left to finish, so
 * the worst case after a cancel is one more probe bounded by the configured
 * timeout. Threading a signal through `probeRuntimeModel` and `executeEndpointFlow`
 * would kill that request too, at the cost of touching the shared runtime path —
 * a bigger change than the safety property needs.
 *
 * `already_finished` is a distinct outcome from `accepted` because telling an
 * operator a completed sweep was cancelled would misrepresent what their money
 * bought.
 */
export function requestActiveModelProbeCancellation(taskId: string): ModelProbeCancellationOutcome {
  const id = String(taskId || '').trim();
  if (!id) return 'not_found';

  const task = getBackgroundTask(id);
  // Type-checked as well as existence-checked: this must never be a way to poke
  // the cancellation flag of some other task type that shares the id space.
  if (!task || task.type !== ACTIVE_MODEL_PROBE_TASK_TYPE) return 'not_found';
  if (task.status !== 'pending' && task.status !== 'running') return 'already_finished';

  cancelledProbeTaskIds.add(id);
  appendBackgroundTaskLog(id, '收到取消请求，正在结束的这个模型之后不再发起新的探测请求');
  return 'accepted';
}

export function isActiveModelProbeCancelled(taskId: string): boolean {
  return cancelledProbeTaskIds.has(taskId);
}

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

/**
 * One key's discovery result inside a site outcome, already filtered to the
 * interest patterns.
 *
 * `credential` is null exactly when `skipReason` is set: a key that will not be
 * probed has no usable value to probe with. The pair travels together so the
 * probe loop can skip on structure rather than on a truthiness check.
 */
type DiscoveryKeyOutcome = {
  tokenId: number;
  tokenName: string;
  /**
   * Derived from POSITION, never inferred from `tokenId`: the sentinel 0 is
   * shared across accounts, and a primary key that resolved to a managed row
   * carries a real `account_tokens.id` indistinguishable in shape from an
   * additional key's.
   *
   * Load-bearing rather than cosmetic — it gates the site-scoped table write and
   * the routing sync.
   */
  isPrimary: boolean;
  credential: string | null;
  skipReason: ProbeKeySkipReason | null;
  /** Everything this key's catalog returned, before the interest filter. */
  discovered: string[];
  /** What this key will actually be probed for. */
  models: string[];
  source: ModelProbeDiscoverySource | null;
  liveFailure: ModelProbeLiveFailure | null;
  notes: string[];
};

/**
 * `credential`, `source`, `liveFailure` and `notes` remain the PRIMARY key's
 * values, not an aggregate over `keys`. Every existing consumer — the preview
 * payload, `model_probe_results`, the routing sync — is site-scoped and was
 * written against the primary key's semantics, and Q7=C keeps availability
 * decided by the primary key alone. Aggregating here would silently change what
 * those consumers mean.
 *
 * `models` IS the union across keys (Q8=A): it is the target list, and a model
 * only a secondary key can reach still has to be probed.
 */
type DiscoveryOutcome = {
  site: SiteRow;
  account: AccountRow;
  credential: string;
  source: ModelProbeDiscoverySource;
  discovered: string[];
  models: string[];
  liveFailure: ModelProbeLiveFailure | null;
  notes: string[];
  keys: DiscoveryKeyOutcome[];
};

/**
 * Operator-facing label for one key in the task log.
 *
 * The primary key has no name of its own (it lives on the account row, not in
 * `account_tokens`), so it is named here rather than stored empty-and-rendered-
 * blank. An unnamed additional key falls back to its row id so two nameless keys
 * are still tellable apart in the log.
 *
 * `keys` is taken so a single-key site reads as plain 「主 Key」 without a count
 * suffix that would imply a key axis it does not have.
 */
function describeProbeKey(key: DiscoveryKeyOutcome, keys: readonly DiscoveryKeyOutcome[]): string {
  if (key.isPrimary) return keys.length > 1 ? '主 Key' : '主 Key（唯一）';
  return key.tokenName ? `Key ${key.tokenName}` : `Key #${key.tokenId}`;
}

function describeProbeKeySkip(reason: ProbeKeySkipReason): string {
  return reason === 'disabled' ? '该令牌已停用' : '该令牌没有可用的值';
}

/**
 * The set of sites one sweep may touch.
 *
 * A discriminated union rather than `number[] | null`, because the two states
 * that union conflated are opposites in the only dimension that matters here:
 * "no filter, probe every site" and "a filter that selected nothing" must
 * produce the maximum and the minimum amount of real-quota traffic
 * respectively. The previous `normalizeSiteIds` returned `null` for both, so an
 * explicitly empty selection probed every site.
 */
export type ModelProbeScope =
  | { kind: 'all' }
  | { kind: 'ids'; siteIds: number[] };

/** An explicitly supplied scope that names no usable site. */
export class ModelProbeScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProbeScopeError';
  }
}

/**
 * Turns an optional id list into a scope. Absent means every site; present
 * means exactly the sites named.
 *
 * An empty or unusable list is an ERROR, not an empty run. Two reasons:
 *
 * 1. `contracts/modelProbePayloads.ts` already answers 400 for `[]` and for a
 *    non-positive id (`siteIdsSchema`, `.min(1)` plus `z.number().int().positive()`).
 *    Two layers disagreeing about whether the same payload is valid is exactly
 *    how the original bug survived: the contract refused it while this function
 *    silently widened it to every site. One rule, stated once.
 * 2. An empty run would still queue a background task, log a sweep and report
 *    `succeeded` over a scope the operator never got. A refusal names the
 *    problem at the call site instead.
 *
 * Every entry must be a positive integer, so `[3, 0]` is refused rather than
 * quietly narrowed to `[3]`: silently dropping an id from a quota-spending
 * scope is the same class of bug as silently widening it. Ids are deduped and
 * sorted so one scope always yields one dedupe key.
 */
export function resolveModelProbeScope(siteIds?: number[] | null): ModelProbeScope {
  if (siteIds === undefined || siteIds === null) return { kind: 'all' };
  if (!Array.isArray(siteIds)) {
    throw new ModelProbeScopeError('站点范围必须是站点 ID 数组');
  }

  const unique = new Set<number>();
  for (const raw of siteIds) {
    const numeric = Number(raw);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      throw new ModelProbeScopeError(`站点范围包含无效的站点 ID：${String(raw)}`);
    }
    unique.add(numeric);
  }
  if (unique.size === 0) {
    throw new ModelProbeScopeError(
      '本次没有选择任何站点，不会执行探测。要探测全部站点请不要传入 siteIds。',
    );
  }

  return { kind: 'ids', siteIds: [...unique].sort((left, right) => left - right) };
}

/**
 * `all` and a joined id list can never collide, because ids are positive
 * integers and no list of them spells `all`. That matters: two different scopes
 * sharing one key would make one sweep silently join the wrong running task.
 */
export function buildActiveModelProbeDedupeKey(scope: ModelProbeScope): string {
  const suffix = scope.kind === 'all' ? 'all' : scope.siteIds.join(',');
  return `${ACTIVE_MODEL_PROBE_DEDUPE_PREFIX}:${suffix}`;
}

/**
 * Operator copy for a refused oversized sweep, defined next to the cap it
 * describes so the HTTP 409 and the run service's own guard cannot drift into
 * saying different things about the same limit.
 */
export function buildModelProbeRunLimitMessage(targetCount: number): string {
  return `本次匹配到 ${targetCount} 个探测目标，超过单次上限 ${MAX_ACTIVE_PROBE_RUN_TARGETS} 个。`
    + '请收窄模型兴趣正则，或缩小站点范围后重试。';
}

/**
 * Operator copy for a sweep refused because the discovered set outgrew what the
 * gate authorized. Names both numbers: the point is that the set MOVED, and an
 * operator who only sees "refused" cannot tell that from a cap violation.
 */
export function buildModelProbeAuthorizedCountMessage(input: {
  authorizedTargetCount: number;
  discoveredTargetCount: number;
}): string {
  return `发起时确认的目标数量是 ${input.authorizedTargetCount} 个，`
    + `真正开始探测前重新发现到 ${input.discoveredTargetCount} 个，已超出允许的浮动范围，`
    + '本次不会消耗任何额度。可能有站点在这期间恢复或新增了模型；请重新预览确认范围后再发起。';
}

function truncate(value: string, max: number): string {
  const normalized = String(value || '').trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

/**
 * Resolves the sites a sweep may touch.
 *
 * Disabled sites are excluded even when named explicitly. A batch must never
 * quietly spend quota on a site the operator has already switched off; probing a
 * disabled site on purpose is the single-site flow's job (`probeSiteModels`), not
 * this one's. The exclusion is reported rather than silent.
 */
async function resolveTargetSites(scope: ModelProbeScope): Promise<{
  sites: SiteRow[];
  skipped: ModelProbeSkippedSite[];
}> {
  const rows: SiteRow[] = await db.select()
    .from(schema.sites)
    .orderBy(
      desc(schema.sites.isPinned),
      asc(schema.sites.sortOrder),
      asc(schema.sites.id),
    )
    .all();

  // Only `kind: 'all'` means "no filter". A scope carrying ids always filters,
  // even if that leaves nothing — the union makes "selected nothing" and
  // "selected everything" impossible to confuse.
  const requested = scope.kind === 'ids' ? new Set(scope.siteIds) : null;
  const selected = requested ? rows.filter((row) => requested.has(row.id)) : rows;

  const sites: SiteRow[] = [];
  const skipped: ModelProbeSkippedSite[] = [];
  for (const row of selected) {
    if ((row.status || 'active') !== 'active') {
      skipped.push({
        siteId: row.id,
        siteName: row.name,
        code: 'site_disabled',
        message: '站点已停用，批量探测不会对其消耗配额',
      });
      continue;
    }
    sites.push(row);
  }

  if (scope.kind === 'ids') {
    const found = new Set(selected.map((row) => row.id));
    for (const siteId of scope.siteIds) {
      if (found.has(siteId)) continue;
      skipped.push({
        siteId,
        siteName: `#${siteId}`,
        code: 'site_not_found',
        message: '站点不存在',
      });
    }
  }

  return { sites, skipped };
}

/** Runs `worker` over `items` with at most `limit` in flight at any moment. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));

  let cursor = 0;
  const runners = Array.from({ length: safeLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index] as T);
    }
  });

  await Promise.all(runners);
}

async function discoverAcrossSites(input: {
  sites: SiteRow[];
  probeConfig: ModelProbeConfig;
  interestPatterns: RegExp[];
  onSite?: (outcome: DiscoveryOutcome) => void;
  onSkip?: (skip: ModelProbeSkippedSite) => void;
}): Promise<{ outcomes: DiscoveryOutcome[]; skipped: ModelProbeSkippedSite[] }> {
  const outcomes = new Map<number, DiscoveryOutcome>();
  const skipped = new Map<number, ModelProbeSkippedSite>();

  await mapWithConcurrency(
    input.sites,
    Math.max(input.probeConfig.siteConcurrency, DISCOVERY_MIN_CONCURRENCY),
    async (site) => {
      try {
        const discovery = await discoverProbeKeysForActiveProbe({
          siteId: site.id,
          timeoutMs: input.probeConfig.timeoutMs,
        });

        // The primary key is first by construction (`selectProbeKeys` builds it
        // that way), and the site-scoped fields below are ITS values — see the
        // `DiscoveryOutcome` doc comment for why they are not aggregates.
        const [primary] = discovery.keys;
        const keys: DiscoveryKeyOutcome[] = discovery.keys.map((key, index) => ({
          tokenId: key.tokenId,
          tokenName: key.tokenName,
          isPrimary: index === 0,
          credential: key.credential,
          skipReason: key.skipReason,
          discovered: key.models,
          models: key.models.filter((modelName) => matchesInterest(modelName, input.interestPatterns)),
          source: key.source,
          liveFailure: key.liveFailure,
          notes: key.notes,
        }));

        const outcome: DiscoveryOutcome = {
          site: discovery.site,
          account: discovery.account,
          // Non-null by contract: `discoverProbeKeysForActiveProbe` throws rather
          // than returning a primary key without a credential.
          credential: primary?.credential || '',
          source: primary?.source ?? 'live',
          discovered: discovery.models,
          models: discovery.models.filter((modelName) => matchesInterest(modelName, input.interestPatterns)),
          liveFailure: primary?.source === 'cached' ? (primary?.liveFailure ?? null) : null,
          notes: primary?.notes ?? [],
          keys,
        };
        outcomes.set(site.id, outcome);
        input.onSite?.(outcome);
      } catch (error) {
        const skip: ModelProbeSkippedSite = {
          siteId: site.id,
          siteName: site.name,
          code: error instanceof ModelProbeDiscoveryError ? error.code : 'discovery_failed',
          message: error instanceof Error ? error.message : '模型发现失败',
        };
        skipped.set(site.id, skip);
        input.onSkip?.(skip);
      }
    },
  );

  // Restore the site order the caller asked for: concurrent completion order is
  // nondeterministic and the preview is rendered as a list.
  const ordered = input.sites
    .map((site) => outcomes.get(site.id))
    .filter((outcome): outcome is DiscoveryOutcome => outcome !== undefined);
  const orderedSkips = input.sites
    .map((site) => skipped.get(site.id))
    .filter((skip): skip is ModelProbeSkippedSite => skip !== undefined);

  return { outcomes: ordered, skipped: orderedSkips };
}

/**
 * Whether this key will actually be probed.
 *
 * The single predicate both the preview count and the runner's target loop use, so
 * the authorized number and the executed number cannot drift apart again.
 */
function isProbableDiscoveryKey(key: DiscoveryKeyOutcome): boolean {
  return key.skipReason === null && !!key.credential;
}

/** Probe requests one site's discovery would issue: the (key × model) product. */
function countSiteProbeTargets(outcome: DiscoveryOutcome): number {
  return outcome.keys.reduce(
    (sum, key) => sum + (isProbableDiscoveryKey(key) ? key.models.length : 0),
    0,
  );
}

export async function previewActiveModelProbe(input?: { siteIds?: number[] }): Promise<ModelProbePreview> {
  const probeConfig = await loadModelProbeConfig();
  // Invalid entries are quarantined, not thrown: one bad regex must not blind the
  // whole preview, and the caller needs to see which entry was dropped.
  const { patterns, invalid } = compileInterestPatterns(resolveEnabledInterestPatterns(probeConfig));

  // Throws on an explicitly empty or unusable scope, before any discovery call.
  const { sites, skipped: skippedSites } = await resolveTargetSites(resolveModelProbeScope(input?.siteIds));
  const { outcomes, skipped: discoverySkips } = await discoverAcrossSites({
    sites,
    probeConfig,
    interestPatterns: patterns,
  });

  const previewSites: ModelProbePreviewSite[] = outcomes.map((outcome) => ({
    siteId: outcome.site.id,
    siteName: outcome.site.name,
    source: outcome.source,
    credentialVerified: outcome.source === 'live',
    discoveredCount: outcome.discovered.length,
    models: outcome.models,
    targetCount: countSiteProbeTargets(outcome),
    keys: outcome.keys.map((key) => ({
      tokenId: key.tokenId,
      tokenName: key.tokenName,
      isPrimary: key.isPrimary,
      skipReason: key.skipReason,
      discoveredCount: key.discovered.length,
      modelCount: isProbableDiscoveryKey(key) ? key.models.length : 0,
    })),
    liveFailure: outcome.liveFailure,
    notes: outcome.notes,
  }));

  // Per-key, matching the runner exactly. See `ModelProbePreview.totalModels`.
  const totalModels = previewSites.reduce((sum, entry) => sum + entry.targetCount, 0);

  return {
    sites: previewSites,
    totalModels,
    invalidPatterns: invalid,
    skipped: [...skippedSites, ...discoverySkips],
    exceedsRunLimit: totalModels > MAX_ACTIVE_PROBE_RUN_TARGETS,
  };
}

/**
 * Queues one sweep. `dedupeKey` is derived from the requested scope so a
 * double-click, or two operators pressing the same button, join the running task
 * instead of doubling the upstream request volume.
 *
 * `authorizedTargetCount` is what makes the confirmation gate binding: the runner
 * rediscovers, and without this it was bounded only by `MAX_ACTIVE_PROBE_RUN_TARGETS`,
 * so the number the operator was shown constrained nothing. `requestActiveModelProbeRun`
 * always supplies it — including for a sweep small enough to need no dialog, where
 * the authorized number is simply the count the gate itself computed and waved
 * through. Omitting it means "no gate ran", which leaves the cap as the only bound;
 * that is the pre-existing behaviour and it is reachable only by an internal caller,
 * because every HTTP request goes through the gate.
 *
 * Deliberately NOT part of the dedupe key. Two requests over the same scope with
 * different authorized counts must still join one task: giving them distinct keys
 * would let two sweeps run the same scope concurrently and double the quota spend,
 * which is worse than the joined task enforcing the earlier — smaller — authorization.
 */
export function queueActiveModelProbe(input?: {
  siteIds?: number[];
  authorizedTargetCount?: number;
}): {
  task: BackgroundTask;
  reused: boolean;
} {
  // Throws before a task exists, so an empty selection cannot even queue a
  // no-op sweep that would report `succeeded` over a scope nobody asked for.
  const scope = resolveModelProbeScope(input?.siteIds);
  const dedupeKey = buildActiveModelProbeDedupeKey(scope);

  const running = getRunningTaskByDedupeKey(dedupeKey);
  if (running) return { task: running, reused: true };

  // The runner needs its own task id to append logs, but `startBackgroundTask`
  // invokes the runner before returning it. A promise bridges that: the runner
  // awaits the id, and it resolves as soon as the call returns.
  let resolveTaskId: (taskId: string) => void = () => {};
  const taskIdPromise = new Promise<string>((resolve) => { resolveTaskId = resolve; });

  const started = startBackgroundTask(
    {
      type: ACTIVE_MODEL_PROBE_TASK_TYPE,
      title: scope.kind === 'ids'
        ? `主动模型测活（${scope.siteIds.length} 个站点）`
        : '主动模型测活（全部站点）',
      dedupeKey,
    },
    async () => {
      // Clears the cancellation flag however the run ends, including the two
      // pre-probe refusals that throw. A flag left behind would silently stop the
      // next sweep, and task ids are not reused so nothing else can clear it.
      try {
        return await runActiveModelProbe(scope, taskIdPromise, input?.authorizedTargetCount);
      } finally {
        cancelledProbeTaskIds.delete(await taskIdPromise);
      }
    },
  );
  resolveTaskId(started.task.id);

  return started;
}

async function runActiveModelProbe(
  scope: ModelProbeScope,
  taskIdPromise: Promise<string>,
  authorizedTargetCount?: number,
): Promise<ModelProbeRunSummary> {
  const taskId = await taskIdPromise;
  const log = (message: string) => { appendBackgroundTaskLog(taskId, message); };

  const probeConfig = await loadModelProbeConfig();
  const { patterns, invalid } = compileInterestPatterns(resolveEnabledInterestPatterns(probeConfig));
  for (const entry of invalid) {
    log(`忽略无效的模型兴趣正则 "${entry.source}"：${entry.reason}`);
  }
  if (patterns.length === 0) {
    log('未配置有效的模型兴趣正则，本次不会探测任何模型（空列表按设计匹配 0 个模型）');
  }

  const { sites, skipped: siteSkips } = await resolveTargetSites(scope);
  for (const skip of siteSkips) {
    log(`跳过站点 ${skip.siteName}（${skip.code}）：${skip.message}`);
  }

  const targets: Array<{
    discovery: DiscoveryOutcome;
    key: DiscoveryKeyOutcome;
    modelName: string;
  }> = [];
  const { outcomes, skipped: discoverySkips } = await discoverAcrossSites({
    sites,
    probeConfig,
    interestPatterns: patterns,
    onSite: (outcome) => {
      log(
        `站点 ${outcome.site.name}：发现 ${outcome.discovered.length} 个模型，`
        + `命中兴趣正则 ${outcome.models.length} 个`
        + (outcome.source === 'cached' ? '（来自缓存，凭据未经验证）' : ''),
      );
      // Per-key breakdown, logged even when a key contributes nothing: "this key
      // reached no models" and "this key was never asked" are different facts and
      // the operator is paying per key.
      for (const key of outcome.keys) {
        const label = describeProbeKey(key, outcome.keys);
        if (key.skipReason) {
          log(`  ${label}：跳过（${describeProbeKeySkip(key.skipReason)}）`);
          continue;
        }
        log(`  ${label}：发现 ${key.discovered.length} 个模型，命中 ${key.models.length} 个`);
      }
    },
    onSkip: (skip) => {
      log(`跳过站点 ${skip.siteName}（${skip.code}）：${skip.message}`);
    },
  });

  // The cartesian product over (key × model) with NO dedupe across keys (Q13=A):
  // a model both keys can list is probed once per key, because the whole question
  // this feature answers is whether the verdict differs BETWEEN keys. That makes
  // cost scale linearly with key count, which is why the two pre-probe guards
  // below now bound the per-key total rather than the model count.
  for (const outcome of outcomes) {
    for (const key of outcome.keys) {
      if (!isProbableDiscoveryKey(key)) continue;
      for (const modelName of key.models) {
        targets.push({ discovery: outcome, key, modelName });
      }
    }
  }

  const skippedSites = [...siteSkips, ...discoverySkips];
  // Both guards run before the first probe, so a refusal costs nothing. The cap
  // is checked first: it is the absolute ceiling, and its message tells the
  // operator to narrow the regex, which is the more useful instruction when a set
  // violates both bounds.
  if (targets.length > MAX_ACTIVE_PROBE_RUN_TARGETS) {
    throw new Error(buildModelProbeRunLimitMessage(targets.length));
  }
  if (
    authorizedTargetCount !== undefined
    && targets.length > modelProbeAuthorizedTargetCeiling(authorizedTargetCount)
  ) {
    throw new Error(buildModelProbeAuthorizedCountMessage({
      authorizedTargetCount,
      discoveredTargetCount: targets.length,
    }));
  }

  log(`共 ${outcomes.length} 个站点、${targets.length} 个 key×模型 待探测，站点间并发 ${probeConfig.siteConcurrency}、站点内并发 ${probeConfig.modelConcurrency}`);

  // Rows for keys that were LISTED but never probed (Q21=B). Written before the
  // probe loop because they cost nothing — no request leaves the process — and they
  // are what stops 「压根没探」 from reading as 「这个 key 探不到任何模型」: with no row
  // at all, a skipped key is simply ABSENT from a model's key breakdown, which is
  // the exact ambiguity the per-key view exists to remove.
  //
  // Written against the SITE's target list, not the key's own: a skipped key has no
  // catalogue, because discovery never asked it. That is not a fabricated verdict —
  // `disabled`/`unavailable` assert that no verdict exists — and it cannot leak into
  // availability, which takes only `unsupported` from the primary key (Q7=C).
  //
  // Two deliberate omissions: these never enter `probeOutcomes` (nothing was probed,
  // so they must not move the summary counters or the routing sync), and they carry
  // no prompt/user-agent (none was chosen).
  //
  // The upsert overwrites a real verdict this key earned in an earlier sweep, which
  // is the intended reading: the key is switched off or unusable NOW, and leaving
  // yesterday's `supported` standing would claim it still serves that model.
  for (const outcome of outcomes) {
    for (const key of outcome.keys) {
      if (isProbableDiscoveryKey(key)) continue;
      // 'unavailable' is also the fallback for the structurally-impossible
      // "no skip reason, no credential": the honest report is still that this key
      // was not probed.
      const skipStatus: ModelProbeKeyStatus = key.skipReason === 'disabled' ? 'disabled' : 'unavailable';
      for (const modelName of outcome.models) {
        await upsertModelProbeKeyResult({
          siteId: outcome.site.id,
          accountId: outcome.account.id,
          tokenId: key.tokenId,
          tokenName: key.tokenName,
          modelName,
          status: skipStatus,
          latencyMs: null,
          httpStatus: null,
          failureKind: null,
          // Locally generated, never upstream prose: nothing was sent, so there is
          // no response body to quote.
          reason: describeProbeKeySkip(key.skipReason ?? 'credential_unavailable'),
          endpointUsed: null,
          promptUsed: null,
          userAgentUsed: null,
        });
      }
    }
  }

  type ProbeOutcome = {
    site: SiteRow;
    account: AccountRow;
    modelName: string;
    status: RuntimeModelProbeStatus;
    /**
     * Only a primary-key verdict may reach `model_availability`. An additional
     * key is a discovery axis that carries no proxy traffic, so its `unsupported`
     * says nothing about what the routing credential can actually serve (Q7=C).
     */
    isPrimary: boolean;
  };
  const probeOutcomes: ProbeOutcome[] = [];

  // Two-axis concurrency: SITES fan out in the outer pool, and within each site
  // its models run in an inner pool. A single flat pool could not express "fan
  // out across relays, but stay gentle inside any one relay" — a burst against
  // one site's channel pool for one token group is what gets keys throttled, while
  // parallel different-site traffic is normally fine. The cancel check below sits
  // in the INNER callback, the smallest scheduling unit, so a cancel still lands
  // within one probe.
  //
  // The probe body below keeps its original (single-pool) indentation to keep this
  // diff reviewable; it now runs one level deeper.
  const targetsBySite = new Map<number, typeof targets>();
  for (const target of targets) {
    const siteId = target.discovery.site.id;
    const bucket = targetsBySite.get(siteId);
    if (bucket) bucket.push(target);
    else targetsBySite.set(siteId, [target]);
  }

  await mapWithConcurrency(
    [...targetsBySite.values()],
    probeConfig.siteConcurrency,
    async (siteTargets) => mapWithConcurrency(siteTargets, probeConfig.modelConcurrency, async (target) => {
    // Checked per target rather than once, so a cancel lands within one probe
    // instead of at the end of the sweep. Every target after the flag is set
    // costs nothing, which is the whole point.
    if (isActiveModelProbeCancelled(taskId)) return;

    const { site, account } = target.discovery;
    // The KEY's own credential, not the site's primary one — substituting the
    // latter is exactly what the key axis exists to prevent. `targets` was built
    // only from keys carrying a usable value, so this is non-empty by construction.
    const credential = target.key.credential || '';
    const userAgent = resolveModelProbeUserAgent(probeConfig, site.probeUserAgent);
    const endpointType = normalizeModelProbeEndpointType(site.probeEndpointType);
    // 'auto' keeps the capability-derived endpoint with cross-protocol fallback;
    // anything else pins one endpoint so the verdict describes what was chosen.
    const forcedEndpoint = endpointType === 'auto' ? undefined : endpointType as UpstreamEndpoint;
    const prompt = chooseModelProbePrompt(probeConfig.prompts);

    let status: RuntimeModelProbeStatus;
    let latencyMs: number | null;
    let reason: string;
    let httpStatus: number | null;
    let failureKind: ModelProbeFailureKind | null;
    let endpointUsed: UpstreamEndpoint | null;
    try {
      const result = await probeRuntimeModel({
        site,
        account,
        modelName: target.modelName,
        timeoutMs: probeConfig.timeoutMs,
        tokenValue: credential,
        prompt,
        errorKeywords: probeConfig.errorKeywords,
        maxTokens: probeConfig.maxTokens,
        // Operator's ruling for the MANUAL sweep: an upstream that refuses to
        // serve the model means the model is not usable, whatever the status.
        // Safe to be this decisive here and not on the unattended path, because a
        // verdict from this sweep only reaches `site_disabled_models` behind both
        // `PROXY_ROUTING_ENABLED` and the probe config's `syncToRouting`, whereas
        // `runPostRefreshProbeIfEnabled` writes it on a per-site switch alone.
        nonSuccessVerdict: 'strict',
        ...(userAgent ? { userAgent } : {}),
        ...(forcedEndpoint ? { forcedEndpoint } : {}),
      });
      status = result.status;
      latencyMs = result.latencyMs;
      reason = result.reason;
      httpStatus = result.httpStatus;
      failureKind = result.failureKind;
      endpointUsed = result.endpointUsed;
    } catch (error) {
      // `probeRuntimeModel` already turns failures into verdicts, so this only
      // guards an unexpected throw. It stays `inconclusive`, which by
      // construction can never disable a model.
      status = 'inconclusive';
      latencyMs = null;
      reason = error instanceof Error ? error.message : '探测异常';
      httpStatus = null;
      failureKind = 'network';
      endpointUsed = null;
    }

    // The one secret whose value is known here, so mask it by value before
    // anything is written: some relays echo the rejected key back in their
    // error body, and `reason` is both persisted and served to the results
    // page. Shape-based scrubbing of secrets the probe never held is a
    // separate control at the HTTP boundary, over the fields
    // `MODEL_PROBE_UPSTREAM_TEXT_FIELDS` names.
    //
    // Masked with THIS key's credential, which is the only one that could appear
    // in this particular response body.
    const maskedReason = maskCredentialInText(reason, credential);

    // Every key's verdict lands in the per-key table (Q15=B). Only the primary
    // key's also lands in the site-scoped table: that one is keyed on
    // (site_id, model_name), so writing additional keys there would have them
    // overwrite each other and leave the last-finished key's verdict standing in
    // for the site — the exact ambiguity the per-key table removes.
    await upsertModelProbeKeyResult({
      siteId: site.id,
      accountId: account.id,
      tokenId: target.key.tokenId,
      tokenName: target.key.tokenName,
      modelName: target.modelName,
      status,
      latencyMs,
      httpStatus,
      failureKind,
      reason: maskedReason,
      endpointUsed,
      promptUsed: prompt,
      userAgentUsed: userAgent,
    });

    if (target.key.isPrimary) {
      await upsertModelProbeResult({
        siteId: site.id,
        accountId: account.id,
        modelName: target.modelName,
        status,
        latencyMs,
        httpStatus,
        failureKind,
        reason: maskedReason,
        endpointUsed,
        promptUsed: prompt,
        userAgentUsed: userAgent,
      });
    }

    probeOutcomes.push({
      site,
      account,
      modelName: target.modelName,
      status,
      isPrimary: target.key.isPrimary,
    });
    log(
      `${site.name} / ${describeProbeKey(target.key, target.discovery.keys)} / ${target.modelName}：${status}`
      + (latencyMs != null ? ` ${latencyMs}ms` : '')
      + (httpStatus != null ? ` HTTP ${httpStatus}` : '')
      + (failureKind ? ` (${failureKind})` : ''),
    );
      }),
  );

  const counts = {
    supported: probeOutcomes.filter((outcome) => outcome.status === 'supported').length,
    unsupported: probeOutcomes.filter((outcome) => outcome.status === 'unsupported').length,
    inconclusive: probeOutcomes.filter((outcome) => outcome.status === 'inconclusive').length,
    skipped: probeOutcomes.filter((outcome) => outcome.status === 'skipped').length,
  };

  const cancelled = isActiveModelProbeCancelled(taskId);
  const remaining = Math.max(0, targets.length - probeOutcomes.length);
  // `remaining === 0` means every target produced an outcome, because a worker that
  // bails on the flag returns without pushing one. So a cancelled run with nothing
  // remaining is one where the cancel arrived while the LAST model's probe was
  // already in flight: it stopped nothing, and every request was paid for.
  const abandonedWork = cancelled && remaining > 0;

  // ONLY `unsupported` reaches the write path, filtered by construction rather
  // than by a later check so no future edit can leak `inconclusive` in.
  // Restricted to the PRIMARY key as well (Q7=C): an additional key carries no
  // proxy traffic, so its `unsupported` describes a credential the router will
  // never use. Taking the union across keys here would disable models the routing
  // credential can actually serve.
  const unsupported = probeOutcomes.filter(
    (outcome) => outcome.status === 'unsupported' && outcome.isPrimary,
  );
  // A cancel withdraws the operator's authorization mid-sweep, so a PARTIAL run
  // leaves no persistent routing effect behind. The verdicts themselves are still
  // recorded in `model_probe_results` for inspection — nothing is lost, it simply
  // is not applied.
  //
  // Gated on partial-ness rather than on the flag, because those come apart in
  // exactly one case and it is the case above. Withholding there spent the whole
  // sweep's quota, discarded every verdict it earned, and made the operator pay for
  // all of it again — while telling them 「已取消」 next to 「还有 0 个模型没有被探测」.
  //
  // The competing reading is that a cancel means "do not act on this sweep at all",
  // even a complete one. It loses on two counts: `syncUnsupportedToRouting` flips
  // `model_availability` per account and reversibly rather than writing sticky
  // site-wide state, and the verdicts are accurate about the models actually
  // probed. A full re-spend of real money is the heavier cost.
  const sync = abandonedWork
    ? { disabled: 0, routingSynced: false }
    : await syncUnsupportedToRouting(unsupported, probeConfig, log);
  if (abandonedWork && unsupported.length > 0) {
    log(`${unsupported.length} 个模型在取消前判定为 unsupported，但本次已取消，不会同步到路由`);
  }

  log(
    (cancelled ? '已取消：' : '完成：')
    + `探测 ${probeOutcomes.length} 个模型`
    + (abandonedWork ? `，另有 ${remaining} 个未探测` : '')
    + (cancelled && !abandonedWork ? '，取消到达时全部目标都已探测完，没有漏掉任何模型' : '')
    + `，supported ${counts.supported}、unsupported ${counts.unsupported}、`
    + `inconclusive ${counts.inconclusive}、skipped ${counts.skipped}；`
    + `禁用 ${sync.disabled} 个，路由${sync.routingSynced ? '已' : '未'}重建`,
  );

  return {
    siteCount: outcomes.length,
    probed: probeOutcomes.length,
    ...counts,
    disabled: sync.disabled,
    routingSynced: sync.routingSynced,
    skippedSites,
    invalidPatterns: invalid,
    cancelled,
    remaining,
  };
}

/**
 * Applies `unsupported` verdicts to `model_availability`, gated on BOTH
 * `PROXY_ROUTING_ENABLED` and the probe config's `syncToRouting`. Both default
 * off, so by default a run is a pure diagnostic that touches nothing routable.
 *
 * Only flips `available` on existing rows and only rebuilds routes once at the
 * end. Deliberately does NOT insert `site_disabled_models` and does NOT mark
 * accounts unhealthy: those are sticky, site-wide effects, and a batch sweep
 * across many sites could pull a large share of channels out of rotation at once
 * over what may be a single missing model name.
 */
async function syncUnsupportedToRouting(
  unsupported: Array<{ site: SiteRow; account: AccountRow; modelName: string }>,
  probeConfig: ModelProbeConfig,
  log: (message: string) => void,
): Promise<{ disabled: number; routingSynced: boolean }> {
  if (unsupported.length === 0) return { disabled: 0, routingSynced: false };

  const syncAllowed = config.proxyRoutingEnabled === true && probeConfig.syncToRouting === true;
  if (!syncAllowed) {
    log(
      `${unsupported.length} 个模型判定为 unsupported，但未同步到路由`
      + `（PROXY_ROUTING_ENABLED=${config.proxyRoutingEnabled}，syncToRouting=${probeConfig.syncToRouting}）`,
    );
    return { disabled: 0, routingSynced: false };
  }

  const checkedAt = new Date().toISOString();
  let disabled = 0;
  for (const entry of unsupported) {
    const existing = await db.select({ isManual: schema.modelAvailability.isManual })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, entry.account.id),
        eq(schema.modelAvailability.modelName, entry.modelName),
      ))
      .get();
    if (!existing) continue;

    // A manual model is a human assertion that it should be routable. An
    // automated verdict must never overrule the person who added it.
    if (existing.isManual === true) {
      log(`保留人工添加的模型 ${entry.site.name} / ${entry.modelName}，不做禁用`);
      continue;
    }

    await db.update(schema.modelAvailability)
      .set({ available: false, checkedAt })
      .where(and(
        eq(schema.modelAvailability.accountId, entry.account.id),
        eq(schema.modelAvailability.modelName, entry.modelName),
      ))
      .run();
    disabled += 1;
  }

  if (disabled === 0) return { disabled: 0, routingSynced: false };

  // Imported dynamically to keep `modelService` out of *this file's* import list.
  // That is a code-shape choice, not isolation: `modelService` is already reachable
  // through runtimeModelProbe -> oauth/service -> modelService, so by the time this
  // line runs it almost always resolves from a warm module cache.
  //
  // What makes preview, run and results safe under PROXY_ROUTING_ENABLED=false is
  // that this branch is the only place routing is ever *called*, and it is gated
  // above on both the env flag and the operator's `syncToRouting` setting.
  try {
    const { rebuildTokenRoutesFromAvailability } = await import('./modelService.js');
    await rebuildTokenRoutesFromAvailability();
    return { disabled, routingSynced: true };
  } catch (error) {
    log(`路由重建失败：${error instanceof Error ? error.message : '未知错误'}`);
    return { disabled, routingSynced: false };
  }
}

/**
 * Upserts on the (site_id, model_name) unique key so the table holds the latest
 * verdict per model and never grows one history row per run. Dialects diverge on
 * the conflict clause, so branch at runtime the way `upsertSetting` does.
 */
async function upsertModelProbeResult(input: {
  siteId: number;
  accountId: number | null;
  modelName: string;
  status: RuntimeModelProbeStatus;
  latencyMs: number | null;
  httpStatus: number | null;
  failureKind: ModelProbeFailureKind | null;
  reason: string | null;
  endpointUsed: UpstreamEndpoint | null;
  promptUsed: string | null;
  userAgentUsed: string | null;
}): Promise<void> {
  const values = {
    siteId: input.siteId,
    accountId: input.accountId,
    modelName: input.modelName,
    status: input.status,
    latencyMs: input.latencyMs,
    httpStatus: input.httpStatus,
    failureKind: input.failureKind,
    // Upstream error bodies can be enormous; the column only needs enough to
    // diagnose a verdict.
    reason: input.reason ? truncate(input.reason, MAX_PERSISTED_REASON_LENGTH) : null,
    endpointUsed: input.endpointUsed,
    promptUsed: input.promptUsed,
    userAgentUsed: input.userAgentUsed || null,
    checkedAt: new Date().toISOString(),
  };

  const updateSet = {
    accountId: values.accountId,
    status: values.status,
    latencyMs: values.latencyMs,
    httpStatus: values.httpStatus,
    failureKind: values.failureKind,
    reason: values.reason,
    endpointUsed: values.endpointUsed,
    promptUsed: values.promptUsed,
    userAgentUsed: values.userAgentUsed,
    checkedAt: values.checkedAt,
  };

  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.modelProbeResults).values(values) as any)
      .onDuplicateKeyUpdate({ set: updateSet })
      .run();
    return;
  }

  await (db.insert(schema.modelProbeResults).values(values) as any)
    .onConflictDoUpdate({
      target: [schema.modelProbeResults.siteId, schema.modelProbeResults.modelName],
      set: updateSet,
    })
    .run();
}

/**
 * Per-key twin of `upsertModelProbeResult`, on the
 * (account_id, token_id, model_name) unique key.
 *
 * All three columns are in the key because `token_id` carries the sentinel 0 for
 * an account-level primary key, and 0 is shared across every account — keyed on
 * (token_id, model_name) alone, two accounts' primary keys probing the same model
 * would collide into one row. That is also why `token_id` is not a real foreign
 * key, so deleting an `account_tokens` row has to clear its rows here in
 * application code.
 *
 * `tokenName` is denormalized on purpose: it keeps the results page readable for
 * a key that has since been renamed or deleted, without a join that would drop
 * the row entirely.
 */
async function upsertModelProbeKeyResult(input: {
  siteId: number;
  accountId: number;
  tokenId: number;
  tokenName: string;
  modelName: string;
  // Wider than the site-scoped table's status: this one also records keys that were
  // listed but never probed (Q21=B), which have no runtime verdict.
  status: ModelProbeKeyStatus;
  latencyMs: number | null;
  httpStatus: number | null;
  failureKind: ModelProbeFailureKind | null;
  reason: string | null;
  endpointUsed: UpstreamEndpoint | null;
  promptUsed: string | null;
  userAgentUsed: string | null;
}): Promise<void> {
  const values = {
    siteId: input.siteId,
    accountId: input.accountId,
    tokenId: input.tokenId,
    tokenName: input.tokenName || '',
    modelName: input.modelName,
    status: input.status,
    latencyMs: input.latencyMs,
    httpStatus: input.httpStatus,
    failureKind: input.failureKind,
    reason: input.reason ? truncate(input.reason, MAX_PERSISTED_REASON_LENGTH) : null,
    endpointUsed: input.endpointUsed,
    promptUsed: input.promptUsed,
    userAgentUsed: input.userAgentUsed || null,
    checkedAt: new Date().toISOString(),
  };

  const updateSet = {
    siteId: values.siteId,
    tokenName: values.tokenName,
    status: values.status,
    latencyMs: values.latencyMs,
    httpStatus: values.httpStatus,
    failureKind: values.failureKind,
    reason: values.reason,
    endpointUsed: values.endpointUsed,
    promptUsed: values.promptUsed,
    userAgentUsed: values.userAgentUsed,
    checkedAt: values.checkedAt,
  };

  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.modelProbeKeyResults).values(values) as any)
      .onDuplicateKeyUpdate({ set: updateSet })
      .run();
    return;
  }

  await (db.insert(schema.modelProbeKeyResults).values(values) as any)
    .onConflictDoUpdate({
      target: [
        schema.modelProbeKeyResults.accountId,
        schema.modelProbeKeyResults.tokenId,
        schema.modelProbeKeyResults.modelName,
      ],
      set: updateSet,
    })
    .run();
}

/**
 * Every column the results table renders. Kept in step with
 * `MODEL_PROBE_RESULT_SORT_FIELDS` in the payload contract, which is what rejects
 * an unrecognized value at the route boundary.
 */
export type ModelProbeResultsSortBy =
  | 'site' | 'model' | 'status' | 'key' | 'latency' | 'balance'
  | 'endpoint' | 'checkedAt' | 'prompt' | 'userAgent' | 'reason';

/**
 * Superset of `contracts/modelProbePayloads.ts`'s query type: that Zod schema
 * predates sorting and paging and Task 10 widens it. Every field is optional so
 * a cleared UI filter set is a valid query.
 */
export type ModelProbeResultsQuery = {
  model?: string;
  siteId?: number;
  /** Multiple-site filter for callers that own a task scope (e.g. remote probe). */
  siteIds?: number[];
  status?: string;
  sortBy?: ModelProbeResultsSortBy;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

/**
 * One row of the results page: one KEY's verdict for one model.
 *
 * The page used to list `model_probe_results` (one row per site×model) with a
 * per-key breakdown squeezed into a cell. It lists `model_probe_key_results`
 * instead, because that is what the operator asked the feature for: three keys on
 * one site have three separate answers, and overlapping catalogs make the site-level
 * row an average of facts rather than a fact.
 *
 * `id` is the per-key row's id, so it stays a stable React key and a stable page
 * tiebreaker. The site-scoped table is still written and still drives the routing
 * sync — it is simply no longer what this page reads.
 */
export type ModelProbeResultView = {
  id: number;
  siteId: number;
  siteName: string;
  accountId: number | null;
  accountUsername: string | null;
  /** Account balance, joined in so the results page can sort by it. */
  balance: number | null;
  tokenId: number;
  /** Empty for the primary key, which has no `account_tokens` row to name it. */
  tokenName: string;
  isPrimary: boolean;
  modelName: string;
  status: ModelProbeKeyStatus;
  latencyMs: number | null;
  httpStatus: number | null;
  failureKind: string | null;
  /** May embed upstream prose — see MODEL_PROBE_UPSTREAM_TEXT_FIELDS. */
  reason: string | null;
  endpointUsed: string | null;
  promptUsed: string | null;
  userAgentUsed: string | null;
  checkedAt: string | null;
};

const RESULT_STATUSES: readonly RuntimeModelProbeStatus[] = ['supported', 'unsupported', 'inconclusive', 'skipped'];

/**
 * `status` is plain text in the schema, so a legacy or hand-edited row can hold
 * anything. Unknown text reads as `inconclusive`: "we cannot say" is the honest
 * reading of a verdict we do not recognize.
 */
function normalizeResultStatus(value: unknown): RuntimeModelProbeStatus {
  return RESULT_STATUSES.find((candidate) => candidate === value) ?? 'inconclusive';
}

/**
 * The full ORDER BY for a results page: NULL placement, then the sort column,
 * then `id`.
 *
 * **Why NULL placement is explicit.** `latencyMs` is null for every skipped and
 * every timed-out probe and `balance` is null whenever it is unknown, so null
 * rows are the common case on both sortable columns rather than an edge. The
 * dialects disagree about where they go: SQLite and MySQL sort NULLs FIRST on
 * `asc`, while Postgres sorts them LAST on `asc` and FIRST on `desc`. Left to the
 * dialect default, the operator's Supabase deployment therefore orders these rows
 * differently from every test in this SQLite-only suite, and on SQLite the
 * results panel's own default — 「最快优先」 — opens on a page of `—` placeholders
 * ahead of the fastest real measurement.
 *
 * **Why a CASE expression and not `NULLS LAST`.** That clause does not exist in
 * MySQL at all, so the ANSI form would emit SQL that works on two dialects out of
 * three; the portable form is also the one that needs no `runtimeDbDialect`
 * branch. A test renders this through all three dialects and asserts they match.
 *
 * **Why last in BOTH directions**, rather than mirroring Postgres: a row with no
 * measurement is not a fast time and not a slow one either, so it belongs after
 * everything that was actually measured no matter which way the operator sorts.
 * That is a deliberate deviation from every dialect default.
 *
 * Cost, stated because it is real: a computed leading ORDER BY term means the
 * per-column indexes on this table can no longer satisfy the ordering, so a page
 * is a scan plus a sort. `model_probe_results` holds one row per site×model and a
 * single run is capped at `MAX_ACTIVE_PROBE_RUN_TARGETS`, so the table stays
 * small. Declaring matching `NULLS`-aware indexes would be the alternative, and
 * it is not expressible portably either.
 *
 * `id` last breaks ties so paging cannot repeat or drop a row when the sort
 * column holds duplicates.
 *
 * Exported for the cross-dialect rendering test: a SQLite-only suite cannot
 * otherwise see whether this is even legal SQL on the database production runs on.
 */
export function buildModelProbeResultOrdering(sortColumn: Column | SQL, order: 'asc' | 'desc'): SQL[] {
  const direction = order === 'asc' ? asc : desc;
  return [
    asc(sql`case when ${sortColumn} is null then 1 else 0 end`),
    direction(sortColumn),
    direction(schema.modelProbeKeyResults.id),
  ];
}

/**
 * Removes every stored probe result. Operator-triggered only, from the results
 * panel's 清空结果 button behind a confirm dialog — there is no TTL and no
 * background pruning, so before this existed the table grew forever and the only
 * reset was a full backup import.
 *
 * Deliberately unscoped (no per-site variant): the panel filters sites for
 * VIEWING, and a filtered delete would let one misclick while a filter is active
 * destroy rows the operator believed were untouched. Clearing is all-or-nothing;
 * the confirm copy says so.
 */
export async function clearModelProbeResults(): Promise<void> {
  await db.delete(schema.modelProbeResults).run();
  // Both tables or neither: leaving per-key rows behind would have the results
  // page still showing verdicts the operator believes they just cleared.
  await db.delete(schema.modelProbeKeyResults).run();
}

/**
 * Maps a sort field to the column it orders by.
 *
 * Every results column is sortable, so this covers all of them rather than the
 * numeric few. Text columns sort case-insensitively — `lower()` rather than the
 * raw column — because a table where `GPT-4o` sorts before `claude` purely on byte
 * order reads as unsorted to the operator looking at it.
 */
function resolveModelProbeResultSortColumn(sortBy: string | undefined): Column | SQL {
  switch (sortBy) {
    case 'site':
      return sql`lower(${schema.sites.name})`;
    case 'model':
      return sql`lower(${schema.modelProbeKeyResults.modelName})`;
    case 'status':
      return sql`lower(${schema.modelProbeKeyResults.status})`;
    case 'key':
      // Primary first within a name group: it is the key routing actually uses, and
      // its stored name is empty, so ordering on the name alone would scatter it.
      return sql`lower(${schema.modelProbeKeyResults.tokenName})`;
    case 'latency':
      return schema.modelProbeKeyResults.latencyMs;
    case 'balance':
      return schema.accounts.balance;
    case 'endpoint':
      return sql`lower(${schema.modelProbeKeyResults.endpointUsed})`;
    case 'prompt':
      return sql`lower(${schema.modelProbeKeyResults.promptUsed})`;
    case 'userAgent':
      return sql`lower(${schema.modelProbeKeyResults.userAgentUsed})`;
    case 'reason':
      return sql`lower(${schema.modelProbeKeyResults.reason})`;
    case 'checkedAt':
    default:
      return schema.modelProbeKeyResults.checkedAt;
  }
}

export async function listActiveModelProbeResults(query: ModelProbeResultsQuery): Promise<{
  items: ModelProbeResultView[];
  total: number;
}> {
  const conditions: SQL[] = [];
  const model = String(query.model || '').trim().toLowerCase();
  if (model) {
    const likeTerm = `%${model}%`;
    conditions.push(sql<boolean>`lower(${schema.modelProbeKeyResults.modelName}) like ${likeTerm}`);
  }
  if (Number.isInteger(query.siteId) && (query.siteId as number) > 0) {
    conditions.push(eq(schema.modelProbeKeyResults.siteId, query.siteId as number));
  }
  // Same normalization contract as `listModelProbeKeyResultsForModels`: drop
  // non-positive/non-integer ids, dedupe, and skip the filter entirely when
  // nothing valid remains (an empty `inArray` is a SQL syntax error).
  const scopedSiteIds = [...new Set((query.siteIds ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  if (scopedSiteIds.length > 0) {
    conditions.push(inArray(schema.modelProbeKeyResults.siteId, scopedSiteIds));
  }
  const status = String(query.status || '').trim();
  if (status) {
    conditions.push(eq(schema.modelProbeKeyResults.status, status));
  }
  const where = conditions.length === 0
    ? undefined
    : (conditions.length === 1 ? conditions[0] : and(...conditions));

  const sortColumn = resolveModelProbeResultSortColumn(query.sortBy);

  const limit = Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.trunc(Number(query.limit) || DEFAULT_RESULTS_LIMIT)));
  const rawOffset = Math.trunc(Number(query.offset) || 0);
  const offset = rawOffset > 0 ? rawOffset : 0;

  let listQuery = db.select({
    result: schema.modelProbeKeyResults,
    siteName: schema.sites.name,
    accountUsername: schema.accounts.username,
    balance: schema.accounts.balance,
  })
    .from(schema.modelProbeKeyResults)
    .innerJoin(schema.sites, eq(schema.modelProbeKeyResults.siteId, schema.sites.id))
    // Left: the account row may have been deleted, and such a verdict must still be
    // listable rather than vanishing from the page.
    .leftJoin(schema.accounts, eq(schema.modelProbeKeyResults.accountId, schema.accounts.id));
  if (where) listQuery = listQuery.where(where) as typeof listQuery;

  const rows = await listQuery
    .orderBy(...buildModelProbeResultOrdering(sortColumn, query.order === 'asc' ? 'asc' : 'desc'))
    .limit(limit)
    .offset(offset)
    .all();

  let totalQuery = db.select({ total: sql<number>`count(*)` })
    .from(schema.modelProbeKeyResults)
    .innerJoin(schema.sites, eq(schema.modelProbeKeyResults.siteId, schema.sites.id))
    .leftJoin(schema.accounts, eq(schema.modelProbeKeyResults.accountId, schema.accounts.id));
  if (where) totalQuery = totalQuery.where(where) as typeof totalQuery;
  const totalRow = await totalQuery.get();

  return {
    items: rows.map((row) => ({
      id: row.result.id,
      siteId: row.result.siteId,
      siteName: row.siteName,
      accountId: row.result.accountId ?? null,
      accountUsername: row.accountUsername ?? null,
      balance: row.balance ?? null,
      tokenId: row.result.tokenId,
      tokenName: row.result.tokenName || '',
      isPrimary: row.result.tokenId === PRIMARY_PROBE_TOKEN_ID,
      modelName: row.result.modelName,
      status: normalizeKeyResultStatus(row.result.status),
      latencyMs: row.result.latencyMs ?? null,
      httpStatus: row.result.httpStatus ?? null,
      failureKind: row.result.failureKind ?? null,
      reason: row.result.reason ?? null,
      endpointUsed: row.result.endpointUsed ?? null,
      promptUsed: row.result.promptUsed ?? null,
      userAgentUsed: row.result.userAgentUsed ?? null,
      checkedAt: row.result.checkedAt ?? null,
    })),
    total: Number(totalRow?.total || 0),
  };
}

/**
 * A per-key row carries two states the site-scoped table has no use for: a key
 * that was listed but deliberately never probed.
 *
 * Kept OUT of `RuntimeModelProbeStatus` rather than added to it: that type is the
 * vocabulary of an actual probe attempt, and widening it would put two verdicts
 * that never made a request into every switch that classifies one that did —
 * including the routing sync, where `unsupported` disables a model.
 */
export type ModelProbeKeyStatus = RuntimeModelProbeStatus | 'disabled' | 'unavailable';

const KEY_RESULT_STATUSES: readonly ModelProbeKeyStatus[] = [
  ...RESULT_STATUSES,
  'disabled',
  'unavailable',
];

/**
 * Same fallback reasoning as `normalizeResultStatus`, over the wider per-key
 * vocabulary. A separate function rather than a parameter on that one: the two
 * tables accept different sets, and sharing a normalizer is how the site-scoped
 * table would start admitting `disabled`.
 */
function normalizeKeyResultStatus(value: unknown): ModelProbeKeyStatus {
  return KEY_RESULT_STATUSES.find((candidate) => candidate === value) ?? 'inconclusive';
}

/**
 * One key's verdict for one model.
 *
 * `tokenId` is carried raw so the caller can tell the sentinel apart, but
 * `isPrimary` is what consumers should branch on: it is the same distinction the
 * run loop draws, and reproducing the `=== PRIMARY_PROBE_TOKEN_ID` test at every
 * call site is how that meaning gets forgotten.
 *
 * `tokenName` is the denormalized label stored with the verdict, not a join onto
 * `account_tokens`: a key that has since been renamed or deleted must still
 * render as the key it was when probed.
 */
export type ModelProbeKeyResultView = {
  id: number;
  siteId: number;
  accountId: number;
  tokenId: number;
  tokenName: string;
  isPrimary: boolean;
  modelName: string;
  status: ModelProbeKeyStatus;
  latencyMs: number | null;
  httpStatus: number | null;
  failureKind: string | null;
  /** May embed upstream prose — see MODEL_PROBE_UPSTREAM_TEXT_FIELDS. */
  reason: string | null;
  endpointUsed: string | null;
  checkedAt: string | null;
};

/**
 * Every stored per-key verdict for the given site×model pairs, keyed for lookup
 * by the results page.
 *
 * Scoped to the rows the caller is already showing rather than offering its own
 * filters and paging: the per-key rows are a detail OF a site-scoped result row,
 * so a second independent query could return keys for models absent from the
 * page. The bound on the query is therefore the page itself.
 *
 * Returns a flat array; grouping is the caller's business because the two
 * consumers group differently (a per-row expander keys by model, the summary
 * marker keys by key).
 */
export async function listModelProbeKeyResultsForModels(input: {
  siteIds: number[];
  modelNames: string[];
}): Promise<ModelProbeKeyResultView[]> {
  const siteIds = [...new Set(input.siteIds.filter((id) => Number.isInteger(id) && id > 0))];
  const modelNames = [...new Set(input.modelNames.map((name) => String(name || '').trim()).filter(Boolean))];
  // An empty `inArray` is a SQL syntax error on some dialects, and there is
  // nothing to look up anyway.
  if (siteIds.length === 0 || modelNames.length === 0) return [];

  const rows = await db.select()
    .from(schema.modelProbeKeyResults)
    .where(and(
      inArray(schema.modelProbeKeyResults.siteId, siteIds),
      inArray(schema.modelProbeKeyResults.modelName, modelNames),
    ))
    // Primary key first within a model, then by name, so the caller can render in
    // arrival order without re-sorting: the primary key is the one whose verdict
    // drives routing and therefore the one an operator reads first.
    .orderBy(
      asc(schema.modelProbeKeyResults.modelName),
      asc(schema.modelProbeKeyResults.tokenId),
      asc(schema.modelProbeKeyResults.id),
    )
    .all();

  return rows.map((row) => ({
    id: row.id,
    siteId: row.siteId,
    accountId: row.accountId,
    tokenId: row.tokenId,
    tokenName: row.tokenName || '',
    isPrimary: row.tokenId === PRIMARY_PROBE_TOKEN_ID,
    modelName: row.modelName,
    status: normalizeKeyResultStatus(row.status),
    latencyMs: row.latencyMs ?? null,
    httpStatus: row.httpStatus ?? null,
    failureKind: row.failureKind ?? null,
    reason: row.reason ?? null,
    endpointUsed: row.endpointUsed ?? null,
    checkedAt: row.checkedAt ?? null,
  }));
}
