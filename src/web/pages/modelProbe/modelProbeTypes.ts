import {
  MODEL_PROBE_ENDPOINT_TYPES,
  normalizeModelProbeEndpointType,
  type ModelProbeEndpointType,
} from '../../../shared/modelProbeEndpointTypes.js';
import type {
  ModelProbeConfig,
  ModelProbeConfigLimits,
  ModelProbeConfigPayload,
  ModelProbeSite,
  ModelProbeSiteConfigPayload,
  ModelProbeUserAgentPreset,
} from '../../api.js';

export {
  MODEL_PROBE_ENDPOINT_TYPES,
  normalizeModelProbeEndpointType,
  type ModelProbeEndpointType,
};

/**
 * The `type` a probe sweep carries in `/api/tasks`, used to recognise a sweep
 * worth reattaching to. It duplicates `ACTIVE_MODEL_PROBE_TASK_TYPE` in
 * `src/server/services/modelProbeRunService.ts` because web code may not import
 * from `src/server`; a test asserts both literals still match, so the two cannot
 * drift apart unnoticed. A shared module would be the better home for it.
 */
export const MODEL_PROBE_TASK_TYPE = 'active-model-probe';

/**
 * Only `'auto'` is renamed for display; the other three are the literal endpoint
 * names an operator reads in upstream docs and logs, so translating them would
 * make the select harder to map onto reality.
 */
export function modelProbeEndpointLabel(value: ModelProbeEndpointType): string {
  return value === 'auto' ? '自动' : value;
}

export function modelProbeEndpointOptions(): Array<{ value: ModelProbeEndpointType; label: string }> {
  return MODEL_PROBE_ENDPOINT_TYPES.map((value) => ({
    value,
    label: modelProbeEndpointLabel(value),
  }));
}

/**
 * The panels edit the multi-line fields as raw text rather than as arrays: an
 * operator mid-edit can legitimately hold a blank or duplicate line, and
 * re-splitting on every keystroke would move the caret. Text is split into a list
 * only when the form is submitted.
 */
export type ModelProbeConfigDraft = {
  interestPatternsText: string;
  promptsText: string;
  errorKeywordsText: string;
  defaultUserAgentId: string;
  concurrencyText: string;
  timeoutMsText: string;
  syncToRouting: boolean;
  /** Carried through untouched: this panel does not edit the preset table. */
  userAgents: ModelProbeUserAgentPreset[];
};

export function splitConfigLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

export function joinConfigLines(values: readonly string[]): string {
  return values.join('\n');
}

export function configDraftFromConfig(config: ModelProbeConfig): ModelProbeConfigDraft {
  return {
    interestPatternsText: joinConfigLines(config.interestPatterns),
    promptsText: joinConfigLines(config.prompts),
    errorKeywordsText: joinConfigLines(config.errorKeywords),
    defaultUserAgentId: config.defaultUserAgentId,
    concurrencyText: String(config.concurrency),
    timeoutMsText: String(config.timeoutMs),
    syncToRouting: config.syncToRouting,
    userAgents: config.userAgents.map((preset) => ({ ...preset })),
  };
}

/**
 * Always a complete config, never a patch: `PUT /api/model-probe/config` replaces
 * the whole record, so an omitted key would be reset to its default rather than
 * left alone.
 */
export function configPayloadFromDraft(
  draft: ModelProbeConfigDraft,
  limits: ModelProbeConfigLimits,
): ModelProbeConfigPayload {
  return {
    interestPatterns: splitConfigLines(draft.interestPatternsText),
    prompts: splitConfigLines(draft.promptsText),
    userAgents: draft.userAgents.map((preset) => ({ ...preset })),
    defaultUserAgentId: draft.defaultUserAgentId,
    errorKeywords: splitConfigLines(draft.errorKeywordsText),
    concurrency: clampDraftInteger(draft.concurrencyText, limits.minConcurrency, limits.maxConcurrency),
    timeoutMs: clampDraftInteger(draft.timeoutMsText, limits.minTimeoutMs, limits.maxTimeoutMs),
    syncToRouting: draft.syncToRouting,
  };
}

/**
 * Clamps to the server-reported bounds so a typo cannot be silently rewritten by
 * the server into something the operator never saw. A blank or non-numeric field
 * falls back to the minimum, matching the server's own floor.
 */
export function clampDraftInteger(text: string, min: number, max: number): number {
  const numeric = Number.parseInt(String(text ?? '').trim(), 10);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

export type ModelProbePatternIssue = {
  source: string;
  reason: string;
};

/**
 * Mirrors the server's `compileInterestPatterns` rejection rules so a bad regex
 * is marked in place instead of coming back as a 400 that names a pattern the
 * operator has to hunt for. The caps come from the server-reported limits, never
 * from a local constant.
 */
export function findInvalidInterestPatterns(
  text: string,
  limits: Pick<ModelProbeConfigLimits, 'maxInterestPatterns' | 'maxInterestPatternLength'>,
): ModelProbePatternIssue[] {
  const issues: ModelProbePatternIssue[] = [];
  let accepted = 0;

  for (const source of splitConfigLines(text)) {
    if (source.length > limits.maxInterestPatternLength) {
      issues.push({
        source,
        reason: `正则长度超过 ${limits.maxInterestPatternLength} 个字符`,
      });
      continue;
    }
    if (accepted >= limits.maxInterestPatterns) {
      issues.push({
        source,
        reason: `正则数量超过上限 ${limits.maxInterestPatterns} 条`,
      });
      continue;
    }
    try {
      new RegExp(source, 'i');
      accepted += 1;
    } catch (error) {
      issues.push({
        source,
        reason: error instanceof Error ? error.message : '不是合法的正则表达式',
      });
    }
  }

  return issues;
}

/**
 * `'inherit'` and `'custom'` are UI-only selections, not stored values. The site
 * column holds one plain string: empty means "use the global preset", anything
 * else is the literal User-Agent to send.
 */
export type ModelProbeSiteUserAgentChoice = 'inherit' | 'custom' | string;

export const MODEL_PROBE_UA_INHERIT = 'inherit';
export const MODEL_PROBE_UA_CUSTOM = 'custom';

export type ModelProbeSiteDraft = {
  probeEndpointType: ModelProbeEndpointType;
  /** Preset id, or one of the two UI-only sentinels. */
  userAgentChoice: ModelProbeSiteUserAgentChoice;
  /** Kept even while a preset is selected so switching back to 自定义 does not lose the text. */
  customUserAgent: string;
};

/**
 * Presets whose value is blank cannot be told apart from "inherit" once stored,
 * so they are not offered as their own choice — the built-in `custom` preset
 * (empty value, label 自定义 / 不发送) is exactly such an entry.
 */
export function selectableUserAgentPresets(
  presets: readonly ModelProbeUserAgentPreset[],
): ModelProbeUserAgentPreset[] {
  return presets.filter((preset) => preset.value.trim().length > 0);
}

export function siteUserAgentOptions(
  presets: readonly ModelProbeUserAgentPreset[],
): Array<{ value: string; label: string }> {
  return [
    { value: MODEL_PROBE_UA_INHERIT, label: '继承全局' },
    ...selectableUserAgentPresets(presets).map((preset) => ({
      value: preset.id,
      label: preset.label,
    })),
    { value: MODEL_PROBE_UA_CUSTOM, label: '自定义' },
  ];
}

export function siteDraftFromSite(
  site: ModelProbeSite,
  presets: readonly ModelProbeUserAgentPreset[],
): ModelProbeSiteDraft {
  const stored = String(site.probeUserAgent ?? '').trim();
  if (!stored) {
    return {
      probeEndpointType: normalizeModelProbeEndpointType(site.probeEndpointType),
      userAgentChoice: MODEL_PROBE_UA_INHERIT,
      customUserAgent: '',
    };
  }

  const preset = selectableUserAgentPresets(presets).find((entry) => entry.value.trim() === stored);
  return {
    probeEndpointType: normalizeModelProbeEndpointType(site.probeEndpointType),
    userAgentChoice: preset ? preset.id : MODEL_PROBE_UA_CUSTOM,
    // A stored value that matches no preset stays visible and editable rather
    // than being dropped into an empty custom field.
    customUserAgent: preset ? '' : stored,
  };
}

export function siteConfigPayloadFromDraft(
  draft: ModelProbeSiteDraft,
  presets: readonly ModelProbeUserAgentPreset[],
): Required<ModelProbeSiteConfigPayload> {
  return {
    probeEndpointType: draft.probeEndpointType,
    probeUserAgent: resolveDraftUserAgent(draft, presets),
  };
}

function resolveDraftUserAgent(
  draft: ModelProbeSiteDraft,
  presets: readonly ModelProbeUserAgentPreset[],
): string {
  if (draft.userAgentChoice === MODEL_PROBE_UA_INHERIT) return '';
  if (draft.userAgentChoice === MODEL_PROBE_UA_CUSTOM) return draft.customUserAgent.trim();
  const preset = presets.find((entry) => entry.id === draft.userAgentChoice);
  // A preset that disappeared from the config falls back to inherit rather than
  // writing a stale literal nobody can see in the select.
  return preset?.value.trim() ?? '';
}

export function siteDraftEquals(left: ModelProbeSiteDraft, right: ModelProbeSiteDraft): boolean {
  return left.probeEndpointType === right.probeEndpointType
    && left.userAgentChoice === right.userAgentChoice
    && left.customUserAgent.trim() === right.customUserAgent.trim();
}
