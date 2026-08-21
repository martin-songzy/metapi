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
 * Kept deliberately conservative: these phrases mean "the upstream refused for
 * billing or capacity reasons", never "this model does not exist", so a probe
 * that trips one of them must stay inconclusive instead of disabling a model.
 */
const DEFAULT_ERROR_KEYWORDS: readonly string[] = [
  'insufficient',
  'quota',
  '余额不足',
  '无可用渠道',
  'no available channel',
  'rate limit',
  '当前分组上游负载已饱和',
  '无权限',
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

/**
 * `caseInsensitive` follows how each list is consumed downstream: interest
 * patterns compile with the `i` flag and keyword matching lowercases both sides,
 * so differing only in case means duplicate there. Prompts are compared exactly,
 * matching `chooseModelProbePrompt`, so what we store is what it would pick from.
 */
function normalizeStringList(
  value: unknown,
  fallback: string[],
  options: { caseInsensitive: boolean },
): string[] {
  if (!Array.isArray(value)) return fallback;

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const dedupeKey = options.caseInsensitive ? trimmed.toLocaleLowerCase() : trimmed;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(trimmed);
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
    interestPatterns: normalizeStringList(record.interestPatterns, defaults.interestPatterns, { caseInsensitive: true }),
    prompts: normalizeStringList(record.prompts, defaults.prompts, { caseInsensitive: false }),
    userAgents,
    defaultUserAgentId,
    errorKeywords: normalizeStringList(record.errorKeywords, defaults.errorKeywords, { caseInsensitive: true }),
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
 * Reads the single JSON settings row. Intentionally free of any routing-table
 * dependency so probe configuration stays usable with
 * `PROXY_ROUTING_ENABLED=false`.
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
    throw new Error(`Invalid model interest pattern: ${details}`);
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
