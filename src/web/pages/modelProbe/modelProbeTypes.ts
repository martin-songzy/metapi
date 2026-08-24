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
  siteConcurrencyText: string;
  modelConcurrencyText: string;
  timeoutMsText: string;
  maxTokensText: string;
  syncToRouting: boolean;
  /**
   * Carried through, and editable in exactly one place: the value of the
   * `custom` preset. See `MODEL_PROBE_CUSTOM_UA_PRESET_ID` for why the other
   * presets stay read-only.
   */
  userAgents: ModelProbeUserAgentPreset[];
};

/**
 * The id of the one preset whose VALUE the global panel lets an operator edit.
 *
 * The server ships it with an empty value (`DEFAULT_USER_AGENT_PRESETS` in
 * `src/server/services/modelProbeConfigService.ts`), which the resolver reads as
 * "send no User-Agent". With no input bound to it, picking 自定义 at global level
 * could only ever mean "send nothing", so the custom option was inert and a
 * custom UA was expressible per-site only — 30 sites meant setting it 30 times.
 *
 * The two built-in presets stay read-only on purpose: their version strings are
 * maintained by hand in the server source, and letting the panel overwrite them
 * would make 「Claude Code」 mean something other than Claude Code.
 *
 * The literal duplicates the server's preset id because web code may not import
 * from `src/server`; a test asserts both still match.
 *
 * It is a PRESET ID, which is a different namespace from the per-site select's
 * option values — see `MODEL_PROBE_UA_PRESET_PREFIX`. The two used to be the same
 * string (`'custom'`) in the same namespace, which is what let the per-site
 * sentinel shadow this preset the moment it gained a value.
 */
export const MODEL_PROBE_CUSTOM_UA_PRESET_ID = 'custom';

export function customUserAgentPresetValue(presets: readonly ModelProbeUserAgentPreset[]): string {
  return presets.find((preset) => preset.id === MODEL_PROBE_CUSTOM_UA_PRESET_ID)?.value ?? '';
}

export function hasCustomUserAgentPreset(presets: readonly ModelProbeUserAgentPreset[]): boolean {
  return presets.some((preset) => preset.id === MODEL_PROBE_CUSTOM_UA_PRESET_ID);
}

/**
 * Returns a new preset list with the custom preset's value replaced. Presets are
 * copied rather than mutated so the draft stays a fresh object and React sees the
 * change.
 */
export function withCustomUserAgentValue(
  presets: readonly ModelProbeUserAgentPreset[],
  value: string,
): ModelProbeUserAgentPreset[] {
  return presets.map((preset) => (
    preset.id === MODEL_PROBE_CUSTOM_UA_PRESET_ID ? { ...preset, value } : { ...preset }
  ));
}

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
    siteConcurrencyText: String(config.siteConcurrency),
    modelConcurrencyText: String(config.modelConcurrency),
    timeoutMsText: String(config.timeoutMs),
    maxTokensText: String(config.maxTokens),
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
  saved: Pick<ModelProbeConfig, 'siteConcurrency' | 'modelConcurrency' | 'timeoutMs' | 'maxTokens'>,
): ModelProbeConfigPayload {
  return {
    interestPatterns: splitConfigLines(draft.interestPatternsText),
    prompts: splitConfigLines(draft.promptsText),
    userAgents: draft.userAgents.map((preset) => ({ ...preset })),
    defaultUserAgentId: draft.defaultUserAgentId,
    errorKeywords: splitConfigLines(draft.errorKeywordsText),
    siteConcurrency: clampDraftInteger(
      draft.siteConcurrencyText,
      limits.minSiteConcurrency,
      limits.maxSiteConcurrency,
      saved.siteConcurrency,
    ),
    modelConcurrency: clampDraftInteger(
      draft.modelConcurrencyText,
      limits.minModelConcurrency,
      limits.maxModelConcurrency,
      saved.modelConcurrency,
    ),
    timeoutMs: clampDraftInteger(
      draft.timeoutMsText,
      limits.minTimeoutMs,
      limits.maxTimeoutMs,
      saved.timeoutMs,
    ),
    maxTokens: clampDraftInteger(
      draft.maxTokensText,
      limits.minMaxTokens,
      limits.maxMaxTokens,
      saved.maxTokens,
    ),
    syncToRouting: draft.syncToRouting,
  };
}

/**
 * Clamps a typed number to the server-reported bounds so a typo cannot be
 * silently rewritten by the server into something the operator never saw.
 *
 * A blank or non-numeric field is NOT a value — it is the absence of one — so it
 * falls back to `fallback`, which callers pass as the currently saved setting.
 * Falling back to `min` instead (as this did) disagrees with the server on the
 * field where it matters: `clampInteger` in
 * `src/server/services/modelProbeConfigService.ts` returns the DEFAULT for a
 * blank input, and for `timeoutMs` the default is 15000 while the minimum is
 * 3000. Clearing the timeout field therefore installed a 3s probe timeout the
 * operator never chose, which manufactures `inconclusive` timeouts against
 * slow-but-working models — the exact class of false verdict this feature exists
 * to remove. Concurrency hid it, because there the server's default and minimum
 * are both 1.
 *
 * Re-sending the saved value is preferred over sending the server's default
 * because the web layer is not told what the defaults are (`limits` carries
 * bounds only), and because a blanked field most plausibly means "I did not mean
 * to change this".
 */
export function clampDraftInteger(text: string, min: number, max: number, fallback: number): number {
  const numeric = Number.parseInt(String(text ?? '').trim(), 10);
  const resolved = Number.isFinite(numeric) ? numeric : fallback;
  return Math.min(max, Math.max(min, resolved));
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
 * What the per-site select holds. UI-only — never stored. The site column holds
 * one plain string: empty means "use the global preset", anything else is the
 * literal User-Agent to send.
 *
 * Three disjoint forms, and the disjointness is the point:
 *
 * - `MODEL_PROBE_UA_INHERIT` — send whatever the global default resolves to
 * - `MODEL_PROBE_UA_SITE_CUSTOM` — send the literal typed into this row's box
 * - `MODEL_PROBE_UA_PRESET_PREFIX + presetId` — send that preset's value
 *
 * Preset choices are PREFIXED rather than being the bare preset id, so a preset
 * can never collide with a sentinel no matter what id the server ships or an
 * operator adds. It previously could and did: the built-in `custom` preset's id
 * equalled the sentinel `'custom'`, and while that preset shipped with a blank
 * value `selectableUserAgentPresets` filtered it out of this select, so nothing
 * noticed. Giving the preset a value put two options with the same value in one
 * select — one of them unreachable, and a stored UA matching that preset
 * resolving back to `''`, i.e. silently dropping the site's override.
 */
export type ModelProbeSiteUserAgentChoice = string;

export const MODEL_PROBE_UA_INHERIT = 'inherit';

/**
 * Deliberately NOT `'custom'`. The server owns preset ids and one of them is
 * `custom`; a sentinel sharing a string with a preset id is exactly the trap
 * above, and the prefix alone would have been enough only for as long as nobody
 * read the two constants as interchangeable. Safe to change freely because this
 * value never leaves the browser.
 */
export const MODEL_PROBE_UA_SITE_CUSTOM = 'site-custom';

/**
 * Namespaces preset ids inside the per-site select's value space. A preset id
 * containing this prefix still cannot collide with a sentinel, because the
 * sentinels do not carry it.
 */
export const MODEL_PROBE_UA_PRESET_PREFIX = 'preset:';

export function modelProbeUserAgentPresetChoice(presetId: string): string {
  return `${MODEL_PROBE_UA_PRESET_PREFIX}${presetId}`;
}

export function modelProbeUserAgentPresetIdFromChoice(choice: string): string | null {
  return choice.startsWith(MODEL_PROBE_UA_PRESET_PREFIX)
    ? choice.slice(MODEL_PROBE_UA_PRESET_PREFIX.length)
    : null;
}

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

/**
 * The custom preset's own label reads 自定义 / 不发送, which is true at GLOBAL level
 * (a blank value there means "send no User-Agent") and false here: a site can only
 * inherit or send something, so picking this option sends the preset's value. It
 * would also read as a near-duplicate of the per-site 自定义 sentinel sitting next
 * to it. Relabelled for this select only; the preset itself is untouched.
 */
function siteUserAgentPresetLabel(preset: ModelProbeUserAgentPreset): string {
  return preset.id === MODEL_PROBE_CUSTOM_UA_PRESET_ID ? '全局自定义 UA' : preset.label;
}

export function siteUserAgentOptions(
  presets: readonly ModelProbeUserAgentPreset[],
): Array<{ value: string; label: string; description?: string }> {
  return [
    { value: MODEL_PROBE_UA_INHERIT, label: '继承全局' },
    ...selectableUserAgentPresets(presets).map((preset) => ({
      value: modelProbeUserAgentPresetChoice(preset.id),
      label: siteUserAgentPresetLabel(preset),
      // Only for the relabelled entry, whose own label no longer names the value
      // it sends. The built-in presets' labels already do.
      ...(preset.id === MODEL_PROBE_CUSTOM_UA_PRESET_ID ? { description: preset.value } : {}),
    })),
    { value: MODEL_PROBE_UA_SITE_CUSTOM, label: '自定义' },
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
    userAgentChoice: preset
      ? modelProbeUserAgentPresetChoice(preset.id)
      : MODEL_PROBE_UA_SITE_CUSTOM,
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

/**
 * Exhaustive over the three forms of `ModelProbeSiteUserAgentChoice`, and order
 * carries no meaning now that the three are disjoint by construction. It used to:
 * the sentinel test ran first and shadowed the preset lookup for the id `custom`.
 */
function resolveDraftUserAgent(
  draft: ModelProbeSiteDraft,
  presets: readonly ModelProbeUserAgentPreset[],
): string {
  if (draft.userAgentChoice === MODEL_PROBE_UA_INHERIT) return '';
  if (draft.userAgentChoice === MODEL_PROBE_UA_SITE_CUSTOM) return draft.customUserAgent.trim();

  const presetId = modelProbeUserAgentPresetIdFromChoice(draft.userAgentChoice);
  // Neither a sentinel nor a preset choice: nothing the select can produce, so
  // inherit rather than invent a literal.
  if (presetId === null) return '';

  const preset = presets.find((entry) => entry.id === presetId);
  // A preset that disappeared from the config falls back to inherit rather than
  // writing a stale literal nobody can see in the select.
  return preset?.value.trim() ?? '';
}

export function siteDraftEquals(left: ModelProbeSiteDraft, right: ModelProbeSiteDraft): boolean {
  return left.probeEndpointType === right.probeEndpointType
    && left.userAgentChoice === right.userAgentChoice
    && left.customUserAgent.trim() === right.customUserAgent.trim();
}
