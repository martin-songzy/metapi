import { asc, desc, eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { normalizeModelProbeEndpointType } from '../../shared/modelProbeEndpointTypes.js';
import type { ModelProbeEndpointType } from '../../shared/modelProbeEndpointTypes.js';
import type { BackgroundTask, BackgroundTaskLogEntry } from './backgroundTaskService.js';
import {
  MODEL_PROBE_MAX_PATTERN_COUNT,
  MODEL_PROBE_MAX_PATTERN_LENGTH,
  type InvalidInterestPattern,
} from './modelInterestFilter.js';
import {
  MODEL_PROBE_MAX_CONCURRENCY,
  MODEL_PROBE_MAX_ERROR_KEYWORD_COUNT,
  MODEL_PROBE_MAX_PROMPT_COUNT,
  MODEL_PROBE_MAX_TIMEOUT_MS,
  MODEL_PROBE_MIN_MAX_TOKENS,
  MODEL_PROBE_MAX_MAX_TOKENS,
  MODEL_PROBE_MIN_SITE_CONCURRENCY,
  MODEL_PROBE_MAX_SITE_CONCURRENCY,
  MODEL_PROBE_MIN_MODEL_CONCURRENCY,
  MODEL_PROBE_MAX_MODEL_CONCURRENCY,
  MODEL_PROBE_MIN_TIMEOUT_MS,
  loadModelProbeConfig,
  saveModelProbeConfig,
  type ModelProbeConfig,
} from './modelProbeConfigService.js';
import type { ModelProbeLiveFailure } from './modelProbeDiscoveryService.js';
import {
  ACTIVE_MODEL_PROBE_TASK_TYPE,
  MAX_ACTIVE_PROBE_RUN_TARGETS,
  MODEL_PROBE_CONFIRM_TARGET_THRESHOLD,
  previewActiveModelProbe,
  queueActiveModelProbe,
  type ModelProbePreview,
  type ModelProbeResultView,
  type ModelProbeSkippedSite,
} from './modelProbeRunService.js';

/**
 * Presentation and orchestration layer for the active model probe API.
 *
 * `routes/api/modelProbe.ts` is a pure adapter: it parses a payload and calls
 * one function here. Everything with a decision in it — the confirmation gate,
 * the patch-merge semantics of a partial config save, per-site profile
 * persistence, and boundary redaction — lives in this module so the route file
 * owns no logic.
 *
 * This module names nothing from the routing stack (tokenRouter, route
 * refresh/decision/cooldown, modelService) in its own import list, and a test in
 * `routes/api/modelProbe.test.ts` asserts that over this file's source.
 *
 * Read that narrowly: it is a statement about this file, not about the transitive
 * closure, which does reach routing via runtimeModelProbe -> oauth/service ->
 * modelService. The API surface keeps working with `PROXY_ROUTING_ENABLED=false`
 * because nothing routing-related executes at import time and no path here calls
 * into routing — not because the import graph excludes it.
 */

export const MODEL_PROBE_REDACTED_MASK = '[redacted]';

/**
 * Re-exported from `modelProbeRunService`, which owns it alongside the hard cap
 * and now re-checks it. Kept exported here because the limits payload and the
 * route's 409 bodies read it from this module; a second literal would let the
 * gate and the runner disagree about the same threshold.
 */
export { MODEL_PROBE_CONFIRM_TARGET_THRESHOLD };

/**
 * Matches the column cap in `modelProbeRunService.upsertModelProbeResult`, so a
 * persisted `reason` survives intact while an unpersisted message (a preview note,
 * a live-failure body) cannot relay a multi-megabyte upstream page to the browser.
 */
export const MAX_UPSTREAM_TEXT_LENGTH = 1_000;
const TRUNCATION_SUFFIX = '…（已截断）';

/**
 * Extra characters kept past `MAX_UPSTREAM_TEXT_LENGTH` while the secret
 * patterns run, so nothing can straddle the served boundary unmasked. See
 * `redactUpstreamProbeText`.
 *
 * 4096 is chosen to comfortably exceed the longest thing `SECRET_PATTERNS` can
 * match. The binding case is the JWT rule: a token with fat claims (scopes, an
 * embedded identity document) runs to a couple of KB, and unlike the `sk-` and
 * `bearer` rules a JWT prefix does not match at all, so a bisected one is not
 * partially caught — it is missed entirely. 4096 leaves roughly double the
 * headroom over a realistic 1-2 KB token while keeping the regex work bounded by
 * a fixed ~5 KB window no matter how large the upstream body is.
 */
export const UPSTREAM_REDACTION_OVERLAP = 4_096;

/**
 * Secret-shaped substrings are masked out of upstream-authored text before it
 * leaves the process.
 *
 * `modelProbeRunService` already masks the ONE credential whose value it knows.
 * This is the complementary half: a relay error body can echo a key the probe
 * never held — the site's own upstream key, another tenant's token, an
 * `Authorization` header from a proxied request — and every field listed in
 * `MODEL_PROBE_UPSTREAM_TEXT_FIELDS` is copied verbatim from such a body.
 *
 * Shape-based rather than value-based on purpose: at this point no secret value
 * is known, so the only available signal is the shape. Patterns are ordered
 * value-first (a bare key, a JWT) then label-first (`token=...`), because a bare
 * match inside a labelled pair should already be gone by the time the label rule
 * runs, and the label rule keeps the label so the reader still learns which field
 * upstream complained about.
 */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Provider-style keys: sk-..., sk-ant-..., sk-proj-...
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: MODEL_PROBE_REDACTED_MASK },
  // JWTs / OAuth access tokens.
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replacement: MODEL_PROBE_REDACTED_MASK },
  // `Authorization: Bearer <token>` / `Basic <token>`.
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi,
    replacement: `$1 ${MODEL_PROBE_REDACTED_MASK}`,
  },
  // Labelled secrets in JSON, form bodies and query strings. The lookahead skips a
  // value the earlier rules already handled — without it `Authorization: Bearer
  // <token>` becomes `Authorization: [redacted] [redacted]`, because `Bearer` is
  // itself a long-enough "value" for this pattern.
  {
    pattern: /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?key|authorization|password|passwd|secret|token|key)(["']?\s*[:=]\s*["']?)(?!\[redacted\]|bearer\b|basic\b)([^\s"',;)}\]&]{6,})/gi,
    replacement: `$1$2${MODEL_PROBE_REDACTED_MASK}`,
  },
];

/**
 * The single redactor for upstream-authored text. Masks secret-shaped substrings
 * and bounds the length; keeps everything else so an operator can still diagnose
 * a verdict from the results table.
 *
 * Redacts inside an OVERLAP WINDOW: cut to `MAX + UPSTREAM_REDACTION_OVERLAP`,
 * run the patterns over that, then cut to `MAX`. Both orderings on their own are
 * wrong, in opposite directions:
 *
 * - Redact then truncate is safe but unbounded in CPU. `notes` and
 *   `liveFailure.message` are not persisted and come from `HTTP ${status}: ${body}`,
 *   so they can carry a multi-megabyte error page, and a preview fans that out
 *   across every site. Five regexes over the whole body would make the response
 *   size the attacker's choice of CPU cost.
 * - Truncate then redact is bounded but leaks. It is tempting to argue a bisected
 *   secret is harmless because the surviving prefix still matches — that is true
 *   for the `sk-` and `bearer` rules (at most ~7 characters of key material
 *   survive) and FALSE for the JWT rule, which requires all three dot-separated
 *   segments and therefore does not match a prefix at all. A JWT straddling the
 *   cut would be served with its header and payload intact: base64url-encoded
 *   JSON, i.e. readable claims. The signature is cut so the token is unusable,
 *   but the claims are the disclosure.
 *
 * The window keeps both properties. Regex cost is bounded by the window, not by
 * the input; and nothing reaches the output straddling the final cut unmasked,
 * because anything crossing it was wholly inside the wider window when the
 * patterns ran. The residual limit is honest and narrow: a secret LONGER than
 * `UPSTREAM_REDACTION_OVERLAP` that starts before `MAX` can still be bisected at
 * the window edge, which is why that constant is sized well above the longest
 * token these patterns can match.
 */
export function redactUpstreamProbeText(value: string): string {
  const source = String(value ?? '');
  const overflows = source.length > MAX_UPSTREAM_TEXT_LENGTH;

  let redacted = overflows
    ? source.slice(0, MAX_UPSTREAM_TEXT_LENGTH + UPSTREAM_REDACTION_OVERLAP)
    : source;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  if (!overflows) return redacted;
  // Masking shortens text, so the window may now fit under the cap. The suffix
  // still belongs: the source was longer than what is being served either way.
  return redacted.length > MAX_UPSTREAM_TEXT_LENGTH
    ? redacted.slice(0, MAX_UPSTREAM_TEXT_LENGTH) + TRUNCATION_SUFFIX
    : redacted + TRUNCATION_SUFFIX;
}

function redactNullableUpstreamProbeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return redactUpstreamProbeText(value);
}

export type ModelProbeLiveFailureResponse = {
  kind: ModelProbeLiveFailure['kind'];
  status: number | null;
  message: string;
};

export type ModelProbePreviewSiteResponse = {
  siteId: number;
  siteName: string;
  source: 'live' | 'cached';
  credentialVerified: boolean;
  discoveredCount: number;
  models: string[];
  liveFailure: ModelProbeLiveFailureResponse | null;
  notes: string[];
};

export type ModelProbeSkippedSiteResponse = {
  siteId: number;
  siteName: string;
  code: ModelProbeSkippedSite['code'];
  message: string;
};

export type ModelProbePreviewResponse = {
  sites: ModelProbePreviewSiteResponse[];
  totalModels: number;
  invalidPatterns: InvalidInterestPattern[];
  skipped: ModelProbeSkippedSiteResponse[];
  exceedsRunLimit: boolean;
};

/**
 * Projects field by field rather than spreading. The run service's internal
 * discovery structures carry a live credential, and a spread would relay any
 * field a future change adds to the preview type — including that one. Listing
 * the fields makes a leak a compile-time addition instead of a silent one.
 */
export function toModelProbePreviewResponse(preview: ModelProbePreview): ModelProbePreviewResponse {
  return {
    sites: preview.sites.map((site) => ({
      siteId: site.siteId,
      siteName: site.siteName,
      source: site.source,
      credentialVerified: site.credentialVerified,
      discoveredCount: site.discoveredCount,
      models: [...site.models],
      liveFailure: site.liveFailure
        ? {
          kind: site.liveFailure.kind,
          status: site.liveFailure.status,
          message: redactUpstreamProbeText(site.liveFailure.message),
        }
        : null,
      notes: site.notes.map((note) => redactUpstreamProbeText(note)),
    })),
    totalModels: preview.totalModels,
    // Author-supplied regex sources and locally generated compile errors, not
    // upstream text, so they pass through unredacted.
    invalidPatterns: preview.invalidPatterns.map((entry) => ({
      source: entry.source,
      reason: entry.reason,
    })),
    skipped: preview.skipped.map((skip) => ({
      siteId: skip.siteId,
      siteName: skip.siteName,
      code: skip.code,
      message: redactUpstreamProbeText(skip.message),
    })),
    exceedsRunLimit: preview.exceedsRunLimit,
  };
}

export type ModelProbeResultResponse = Omit<ModelProbeResultView, 'reason'> & { reason: string | null };

export function toModelProbeResultResponse(item: ModelProbeResultView): ModelProbeResultResponse {
  return {
    id: item.id,
    siteId: item.siteId,
    siteName: item.siteName,
    accountId: item.accountId,
    accountUsername: item.accountUsername,
    balance: item.balance,
    modelName: item.modelName,
    status: item.status,
    latencyMs: item.latencyMs,
    httpStatus: item.httpStatus,
    failureKind: item.failureKind,
    reason: redactNullableUpstreamProbeText(item.reason),
    endpointUsed: item.endpointUsed,
    promptUsed: item.promptUsed,
    userAgentUsed: item.userAgentUsed,
    checkedAt: item.checkedAt,
  };
}

export const MAX_TASK_REDACTION_DEPTH = 6;
export const MAX_TASK_REDACTION_NODES = 5_000;

/**
 * Redacts every string inside an arbitrary task result.
 *
 * `BackgroundTask.result` is typed `unknown`, so the run summary's
 * `skippedSites[].message` cannot be projected field by field the way the preview
 * is. Walking it is the honest alternative: it stays correct if the summary shape
 * changes, and the depth/node budget keeps a pathological payload from turning a
 * task poll into a CPU sink.
 */
function redactUnknownDeep(value: unknown, budget: { nodes: number }, depth = 0): unknown {
  // Fails CLOSED. Past the budget or the depth ceiling, anything that could contain
  // text — a string, or an object/array whose contents will not be visited — is
  // replaced by the mask. Passing the subtree through would make "bury the secret at
  // depth 7" a way to skip redaction entirely, which is precisely the wrong
  // behaviour for a limit that exists only to bound cost. Numbers, booleans and null
  // carry no text and pass through, so a truncated summary keeps its counters.
  if (budget.nodes <= 0 || depth > MAX_TASK_REDACTION_DEPTH) {
    if (typeof value === 'string') return MODEL_PROBE_REDACTED_MASK;
    if (value !== null && typeof value === 'object') return MODEL_PROBE_REDACTED_MASK;
    return value;
  }
  budget.nodes -= 1;

  if (typeof value === 'string') return redactUpstreamProbeText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknownDeep(entry, budget, depth + 1));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      output[key] = redactUnknownDeep(source[key], budget, depth + 1);
    }
    return output;
  }
  return value;
}

/**
 * Background task output is a second, independent leak surface: a sweep's
 * "skipped site" log line quotes an upstream discovery error verbatim, its result
 * summary carries `skippedSites[].message`, and both reach the browser through
 * `/api/tasks`, `/api/tasks/:id` and the generic task log stream.
 *
 * Redacting at write time would be better still, but `appendBackgroundTaskLog` is
 * shared by every task type, so the probe-specific rule lives at the boundaries
 * that serve it. The task-type test is HERE rather than in each route so all of
 * those boundaries cannot drift apart, and so a route stays a pure adapter.
 *
 * Non-probe tasks pass through untouched: widening redaction to every task type
 * is a separate change with its own blast radius.
 */
function isActiveModelProbeTask(taskType: string): boolean {
  return taskType === ACTIVE_MODEL_PROBE_TASK_TYPE;
}

export function redactBackgroundTaskForResponse(task: BackgroundTask): BackgroundTask {
  if (!isActiveModelProbeTask(task.type)) return task;

  const logs: BackgroundTaskLogEntry[] = task.logs.map((entry) => ({
    seq: entry.seq,
    message: redactUpstreamProbeText(entry.message),
    createdAt: entry.createdAt,
  }));

  return {
    ...task,
    message: redactUpstreamProbeText(task.message),
    error: redactNullableUpstreamProbeText(task.error),
    result: redactUnknownDeep(task.result, { nodes: MAX_TASK_REDACTION_NODES }),
    logs,
  };
}

/**
 * Per-entry variant for streaming surfaces, which push one log line at a time and
 * therefore cannot go through the whole-task redactor.
 */
export function redactBackgroundTaskLogForResponse(
  taskType: string,
  entry: BackgroundTaskLogEntry,
): BackgroundTaskLogEntry {
  if (!isActiveModelProbeTask(taskType)) return entry;
  return {
    seq: entry.seq,
    message: redactUpstreamProbeText(entry.message),
    createdAt: entry.createdAt,
  };
}

export type ModelProbeConfigLimits = {
  minSiteConcurrency: number;
  maxSiteConcurrency: number;
  minModelConcurrency: number;
  maxModelConcurrency: number;
  /** @deprecated alias pair of the model-concurrency bounds, kept for old clients. */
  minConcurrency: number;
  /** @deprecated see minConcurrency. */
  maxConcurrency: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  minMaxTokens: number;
  maxMaxTokens: number;
  maxInterestPatterns: number;
  maxInterestPatternLength: number;
  maxPrompts: number;
  maxErrorKeywords: number;
  confirmTargetThreshold: number;
  maxRunTargets: number;
};

export function getModelProbeConfigLimits(): ModelProbeConfigLimits {
  return {
    minSiteConcurrency: MODEL_PROBE_MIN_SITE_CONCURRENCY,
    maxSiteConcurrency: MODEL_PROBE_MAX_SITE_CONCURRENCY,
    minModelConcurrency: MODEL_PROBE_MIN_MODEL_CONCURRENCY,
    maxModelConcurrency: MODEL_PROBE_MAX_MODEL_CONCURRENCY,
    // Deprecated alias pair — same numbers as the model axis, so an older
    // frontend rendering a single 并数 field still gets working bounds.
    minConcurrency: MODEL_PROBE_MIN_MODEL_CONCURRENCY,
    maxConcurrency: MODEL_PROBE_MAX_MODEL_CONCURRENCY,
    minTimeoutMs: MODEL_PROBE_MIN_TIMEOUT_MS,
    maxTimeoutMs: MODEL_PROBE_MAX_TIMEOUT_MS,
    minMaxTokens: MODEL_PROBE_MIN_MAX_TOKENS,
    maxMaxTokens: MODEL_PROBE_MAX_MAX_TOKENS,
    maxInterestPatterns: MODEL_PROBE_MAX_PATTERN_COUNT,
    maxInterestPatternLength: MODEL_PROBE_MAX_PATTERN_LENGTH,
    maxPrompts: MODEL_PROBE_MAX_PROMPT_COUNT,
    maxErrorKeywords: MODEL_PROBE_MAX_ERROR_KEYWORD_COUNT,
    confirmTargetThreshold: MODEL_PROBE_CONFIRM_TARGET_THRESHOLD,
    maxRunTargets: MAX_ACTIVE_PROBE_RUN_TARGETS,
  };
}

/**
 * `saveModelProbeConfig` replaces the WHOLE config, so a partial API patch has to
 * be spread over the stored one here or every field the caller omitted would be
 * reset to its default.
 *
 * Keys carrying `undefined` are dropped before the spread. The Zod contract omits
 * absent optional keys already, so this only guards a future internal caller that
 * builds the patch by hand — where `{ concurrency: undefined }` would otherwise
 * overwrite a stored 4 with the default 1.
 */
export async function applyModelProbeConfigPatch(patch: Record<string, unknown>): Promise<ModelProbeConfig> {
  const current = await loadModelProbeConfig();
  const supplied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    supplied[key] = value;
  }

  return saveModelProbeConfig({ ...current, ...supplied });
}

export type ModelProbeSiteView = {
  id: number;
  name: string;
  url: string;
  platform: string;
  status: string;
  probeEndpointType: ModelProbeEndpointType;
  probeUserAgent: string;
};

/**
 * Explicit projection: `sites.apiKey` is a secret column, so `db.select()` over
 * the whole row must never back this endpoint.
 */
const siteViewColumns = {
  id: schema.sites.id,
  name: schema.sites.name,
  url: schema.sites.url,
  platform: schema.sites.platform,
  status: schema.sites.status,
  probeEndpointType: schema.sites.probeEndpointType,
  probeUserAgent: schema.sites.probeUserAgent,
};

function toSiteView(row: {
  id: number;
  name: string;
  url: string;
  platform: string;
  status: string | null;
  probeEndpointType: string | null;
  probeUserAgent: string | null;
}): ModelProbeSiteView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    platform: row.platform,
    status: row.status || 'active',
    // The column is plain text and a legacy or hand-edited row can hold anything,
    // so normalize on read the way every other probe reader does.
    probeEndpointType: normalizeModelProbeEndpointType(row.probeEndpointType),
    probeUserAgent: row.probeUserAgent ?? '',
  };
}

/** Same order the sites page and the sweep use, so row N means the same site everywhere. */
export async function listModelProbeSites(): Promise<ModelProbeSiteView[]> {
  const rows = await db.select(siteViewColumns)
    .from(schema.sites)
    .orderBy(
      desc(schema.sites.isPinned),
      asc(schema.sites.sortOrder),
      asc(schema.sites.id),
    )
    .all();

  return rows.map(toSiteView);
}

/**
 * Writes only the fields the caller supplied, so saving an endpoint override
 * cannot blank a user agent the operator set earlier. Returns `null` for an
 * unknown site so the route can answer 404 instead of silently succeeding.
 *
 * Re-reads after the write rather than echoing the patch back: the response then
 * describes what is actually stored, including the normalization a legacy value
 * goes through.
 */
export async function updateModelProbeSiteConfig(
  siteId: number,
  patch: { probeEndpointType?: ModelProbeEndpointType; probeUserAgent?: string },
): Promise<ModelProbeSiteView | null> {
  const existing = await db.select(siteViewColumns)
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();
  if (!existing) return null;

  const updates: Record<string, unknown> = {};
  if (patch.probeEndpointType !== undefined) updates.probeEndpointType = patch.probeEndpointType;
  if (patch.probeUserAgent !== undefined) updates.probeUserAgent = patch.probeUserAgent;

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date().toISOString();
    await db.update(schema.sites)
      .set(updates)
      .where(eq(schema.sites.id, siteId))
      .run();
  }

  const row = await db.select(siteViewColumns)
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();
  return row ? toSiteView(row) : null;
}

export type ModelProbeRunRequest = {
  siteIds?: number[];
  confirmedTargetCount?: number;
};

/** One literal discriminant per member so a route can narrow on `outcome`. */
export type ModelProbeRunDecision =
  | { outcome: 'queued'; taskId: string; reused: boolean; targetCount: number; preview: ModelProbePreviewResponse }
  | { outcome: 'confirmation_required'; targetCount: number; preview: ModelProbePreviewResponse }
  | { outcome: 'run_limit_exceeded'; targetCount: number; preview: ModelProbePreviewResponse };

/**
 * The confirmation gate.
 *
 * The target count is always recomputed from a fresh preview rather than trusted
 * from the request: `confirmedTargetCount` is only an echo of what the operator
 * was shown, so a stale number (the model list moved between preview and confirm)
 * or an invented one has to fail the comparison instead of waving the sweep
 * through. Preview is read-only and issues no probe requests, so paying for it on
 * every run is cheap relative to what a run costs.
 *
 * The count this gate settles on is then handed to `queueActiveModelProbe` as
 * `authorizedTargetCount`, and the runner re-checks its own rediscovery against
 * it. Without that the gate bounded only itself: the runner discovered
 * independently, so a site that contributed 0 targets here (a timed-out model-list
 * request) and recovered before the sweep could turn a dialog-free click into
 * hundreds of paid requests. The number is passed even when it was under the
 * dialog threshold — "authorized" means "this gate saw it and allowed it", which
 * covers both the confirmed and the waved-through case.
 */
export async function requestActiveModelProbeRun(request: ModelProbeRunRequest): Promise<ModelProbeRunDecision> {
  const scope = request.siteIds ? { siteIds: request.siteIds } : {};
  const preview = await previewActiveModelProbe(scope);
  const response = toModelProbePreviewResponse(preview);
  const targetCount = preview.totalModels;

  // Refused before the confirmation check: no dialog can authorize a sweep the
  // run service would reject anyway, and saying so up front tells the operator to
  // narrow the regex rather than to click confirm.
  if (preview.exceedsRunLimit || targetCount > MAX_ACTIVE_PROBE_RUN_TARGETS) {
    return { outcome: 'run_limit_exceeded', targetCount, preview: response };
  }

  if (targetCount > MODEL_PROBE_CONFIRM_TARGET_THRESHOLD && request.confirmedTargetCount !== targetCount) {
    return { outcome: 'confirmation_required', targetCount, preview: response };
  }

  const { task, reused } = queueActiveModelProbe({ ...scope, authorizedTargetCount: targetCount });
  return { outcome: 'queued', taskId: task.id, reused, targetCount, preview: response };
}
