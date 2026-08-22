import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { compileInterestPatterns } from './modelInterestFilter.js';
import { DEFAULT_MODEL_PROBE_PROMPTS } from './modelProbePrompts.js';

export type ModelProbeUserAgentPreset = { id: string; label: string; value: string };

export type ModelProbeConfig = {
  interestPatterns: string[];
  prompts: string[];
  userAgents: ModelProbeUserAgentPreset[];
  defaultUserAgentId: string;
  errorKeywords: string[];
  concurrency: number;
  timeoutMs: number;
  syncToRouting: boolean;
};

export const MODEL_PROBE_CONFIG_SETTING_KEY = 'model_probe_config_v1';

export const MODEL_PROBE_MIN_CONCURRENCY = 1;
export const MODEL_PROBE_MAX_CONCURRENCY = 8;
export const MODEL_PROBE_MIN_TIMEOUT_MS = 3_000;
export const MODEL_PROBE_MAX_TIMEOUT_MS = 60_000;

/**
 * Probe User-Agent presets are defined here rather than reused from
 * `codexClientFamily` / `proxy-core` header helpers on purpose. That table
 * classifies *inbound* client requests, which is the opposite direction from an
 * *outbound* probe UA, and reaching into proxy-core internals for a settings
 * default would add a cross-boundary dependency the drift check guards. The
 * tradeoff: these version strings can drift from the proxy's own defaults and
 * must be refreshed by hand.
 */
const DEFAULT_USER_AGENT_PRESETS: readonly ModelProbeUserAgentPreset[] = [
  { id: 'claude-code', label: 'Claude Code', value: 'claude-cli/2.1.63 (external, cli)' },
  { id: 'codex-cli', label: 'Codex CLI', value: 'codex_cli_rs/0.20.0' },
  { id: 'custom', label: '自定义 / 不发送', value: '' },
];

/**
 * Model-absence semantics ONLY.
 *
 * This list is the ONE thing that promotes an upstream failure to `unsupported`,
 * and `unsupported` is the only verdict that writes persistent state — including
 * `site_disabled_models` on the unattended post-refresh path, which is keyed by
 * SITE rather than by account and never auto-clears. So an account-level or
 * transient phrase here would mark every probed model at a rate-limited or
 * out-of-balance site unavailable for every account on it. That is why
 * billing/capacity/permission wording (insufficient, quota, rate limit, 余额不足,
 * 当前分组上游负载已饱和, 无权限) is deliberately absent.
 *
 * What `classifySuccessfulProbeResponse` actually does, stated so this comment
 * cannot drift from it again: it consults this list on EVERY failure shape it
 * recognizes — a top-level `error`, a non-JSON body, and a protocol-shaped body
 * with no usable content — and only a hit yields `unsupported`. An unmatched
 * failure yields `inconclusive`, which by construction can never disable a model.
 * An earlier revision returned `unsupported` for any top-level `error` before
 * reaching the list at all, which made this narrowing ineffective on the
 * commonest relay error shape; that branch is now keyword-gated.
 */
const DEFAULT_ERROR_KEYWORDS: readonly string[] = [
  'no available channel',
  '无可用渠道',
  'no such model',
  'model not found',
  'model_not_found',
  '模型不存在',
  '模型不可用',
  '不支持的模型',
];

export function getDefaultModelProbeConfig(): ModelProbeConfig {
  return {
    interestPatterns: [],
    prompts: [...DEFAULT_MODEL_PROBE_PROMPTS],
    userAgents: DEFAULT_USER_AGENT_PRESETS.map((preset) => ({ ...preset })),
    defaultUserAgentId: DEFAULT_USER_AGENT_PRESETS[0]!.id,
    errorKeywords: [...DEFAULT_ERROR_KEYWORDS],
    concurrency: 1,
    timeoutMs: 15_000,
    syncToRouting: false,
  };
}

export const MODEL_PROBE_MAX_PROMPT_COUNT = 50;
export const MODEL_PROBE_MAX_PROMPT_LENGTH = 2_000;
export const MODEL_PROBE_MAX_ERROR_KEYWORD_COUNT = 50;
export const MODEL_PROBE_MAX_ERROR_KEYWORD_LENGTH = 200;
export const MODEL_PROBE_MAX_USER_AGENT_PRESET_COUNT = 20;

/**
 * `caseInsensitive` follows how each list is consumed downstream.
 *
 * Error keywords are matched by lowercasing both sides, so case-only variants
 * really are duplicates there. Prompts and interest patterns are compared
 * exactly: `chooseModelProbePrompt` dedupes prompts case-sensitively, and for
 * regexes a lowercased key would conflate semantically opposite sources —
 * `^\d+$` vs `^\D+$`, `\b` vs `\B`, `\w` vs `\W`, `\s` vs `\S` — silently
 * dropping one of a pair.
 *
 * The caps bound a hand-edited settings row the same way the Zod contract bounds
 * an API payload, so neither path can grow the list without limit. They are
 * opt-in because `interestPatterns` must stay untruncated here: its 50/200 caps
 * belong to `compileInterestPatterns`, which *rejects* at save time, and
 * silently dropping the 51st entry first would hide that violation.
 */
function normalizeStringList(
  value: unknown,
  fallback: string[],
  options: { caseInsensitive: boolean; maxCount?: number; maxLength?: number },
): string[] {
  const maxCount = options.maxCount ?? Number.POSITIVE_INFINITY;
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  if (!Array.isArray(value)) return fallback;

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLength) continue;
    const dedupeKey = options.caseInsensitive ? trimmed.toLowerCase() : trimmed;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(trimmed);
    if (normalized.length >= maxCount) break;
  }
  return normalized;
}

/**
 * Only real numbers and numeric strings count. Blanket `Number(value)` would
 * turn `null`, `''`, `[]` and `false` into 0 and then clamp them to the minimum,
 * so a hand-edited row with a null timeout would silently become the 3s floor
 * instead of falling back to the documented default.
 */
function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    numeric = Number(value.trim());
  } else {
    return fallback;
  }

  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeUserAgentPresets(value: unknown, fallback: ModelProbeUserAgentPreset[]): ModelProbeUserAgentPreset[] {
  if (!Array.isArray(value)) return fallback;

  const presets: ModelProbeUserAgentPreset[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const rawValue = typeof record.value === 'string' ? record.value.trim() : '';
    presets.push({ id, label: label || id, value: rawValue });
    if (presets.length >= MODEL_PROBE_MAX_USER_AGENT_PRESET_COUNT) break;
  }

  return presets.length > 0 ? presets : fallback;
}

/**
 * Single canonical normalizer. Every read and write funnels through it so a
 * hand-edited settings row, a legacy row and an API payload all converge on the
 * same shape, and so clamping cannot be bypassed by writing straight to
 * `settings`.
 */
export function normalizeModelProbeConfig(input: unknown): ModelProbeConfig {
  const defaults = getDefaultModelProbeConfig();
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};

  const userAgents = normalizeUserAgentPresets(record.userAgents, defaults.userAgents);
  const requestedDefaultId = typeof record.defaultUserAgentId === 'string'
    ? record.defaultUserAgentId.trim()
    : '';
  const knownIds = new Set(userAgents.map((preset) => preset.id));
  const defaultUserAgentId = [requestedDefaultId, defaults.defaultUserAgentId, userAgents[0]?.id]
    .find((candidate): candidate is string => Boolean(candidate) && knownIds.has(candidate as string))
    ?? '';

  return {
    // Left uncapped on purpose: compileInterestPatterns owns the 50/200 limits
    // and reports them as save-time rejections.
    interestPatterns: normalizeStringList(record.interestPatterns, defaults.interestPatterns, {
      caseInsensitive: false,
    }),
    prompts: normalizeStringList(record.prompts, defaults.prompts, {
      caseInsensitive: false,
      maxCount: MODEL_PROBE_MAX_PROMPT_COUNT,
      maxLength: MODEL_PROBE_MAX_PROMPT_LENGTH,
    }),
    userAgents,
    defaultUserAgentId,
    errorKeywords: normalizeStringList(record.errorKeywords, defaults.errorKeywords, {
      caseInsensitive: true,
      maxCount: MODEL_PROBE_MAX_ERROR_KEYWORD_COUNT,
      maxLength: MODEL_PROBE_MAX_ERROR_KEYWORD_LENGTH,
    }),
    concurrency: clampInteger(
      record.concurrency,
      MODEL_PROBE_MIN_CONCURRENCY,
      MODEL_PROBE_MAX_CONCURRENCY,
      defaults.concurrency,
    ),
    timeoutMs: clampInteger(
      record.timeoutMs,
      MODEL_PROBE_MIN_TIMEOUT_MS,
      MODEL_PROBE_MAX_TIMEOUT_MS,
      defaults.timeoutMs,
    ),
    syncToRouting: record.syncToRouting === true,
  };
}

/**
 * Reads the single JSON settings row. Probe configuration stays fully usable when
 * `PROXY_ROUTING_ENABLED=false`: nothing here touches the routing stack
 * (tokenRouter, route refresh/decision/cooldown, the `token_routes` /
 * `route_channels` tables).
 *
 * A test asserts that over this file's own import list. That is a per-file check,
 * not a transitive-closure one — see `modelProbeRunService.ts` for why the closure
 * claim would be false.
 */
export async function loadModelProbeConfig(): Promise<ModelProbeConfig> {
  const row = await db.select()
    .from(schema.settings)
    .where(eq(schema.settings.key, MODEL_PROBE_CONFIG_SETTING_KEY))
    .get();
  if (!row?.value) {
    return getDefaultModelProbeConfig();
  }

  try {
    return normalizeModelProbeConfig(JSON.parse(row.value));
  } catch {
    return getDefaultModelProbeConfig();
  }
}

/**
 * Thrown when a submitted interest pattern cannot compile or breaks the shared
 * caps. Separate from a generic Error so an API route can map it to 400 instead
 * of a 500: it is caller-fixable input, not a server fault.
 */
export class ModelProbeConfigValidationError extends Error {
  readonly invalidPatterns: ReadonlyArray<{ source: string; reason: string }>;

  constructor(message: string, invalidPatterns: ReadonlyArray<{ source: string; reason: string }>) {
    super(message);
    this.name = 'ModelProbeConfigValidationError';
    this.invalidPatterns = invalidPatterns;
  }
}

export function isModelProbeConfigValidationError(error: unknown): error is ModelProbeConfigValidationError {
  return error instanceof ModelProbeConfigValidationError;
}

/**
 * Replaces the WHOLE config: any field the caller omits is reset to its default,
 * not merged with what is stored. An API route must therefore load the current
 * config and spread the incoming patch over it, because passing a partial body
 * straight through here would silently wipe the untouched fields.
 *
 * Validates interest patterns before persisting. A stored regex that cannot
 * compile would silently shrink the probe target set on every later run, so a
 * bad pattern is rejected at write time while the caller can still fix it.
 */
export async function saveModelProbeConfig(input: unknown): Promise<ModelProbeConfig> {
  const next = normalizeModelProbeConfig(input);

  const compiled = compileInterestPatterns(next.interestPatterns);
  if (compiled.invalid.length > 0) {
    const details = compiled.invalid
      .map((entry) => `"${entry.source}" (${entry.reason})`)
      .join('; ');
    throw new ModelProbeConfigValidationError(
      `Invalid model interest pattern: ${details}`,
      compiled.invalid,
    );
  }

  await upsertSetting(MODEL_PROBE_CONFIG_SETTING_KEY, next);
  return next;
}

/**
 * A per-site User-Agent override always wins: sites differ in what upstream
 * WAFs accept, and the global preset is only a default.
 */
export function resolveModelProbeUserAgent(config: ModelProbeConfig, siteOverride?: string | null): string {
  const override = typeof siteOverride === 'string' ? siteOverride.trim() : '';
  if (override) return override;

  const preset = config.userAgents.find((entry) => entry.id === config.defaultUserAgentId);
  return preset?.value.trim() || '';
}
