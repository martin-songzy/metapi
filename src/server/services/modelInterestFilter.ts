export const MODEL_PROBE_MAX_PATTERN_COUNT = 50;
export const MODEL_PROBE_MAX_PATTERN_LENGTH = 200;

export type InvalidInterestPattern = {
  source: string;
  reason: string;
};

export type CompiledInterestPatterns = {
  patterns: RegExp[];
  invalid: InvalidInterestPattern[];
};

/**
 * Compiles user-supplied model interest patterns.
 *
 * Patterns come straight from the settings UI, so one malformed entry must not
 * abort a whole probe run: bad entries are reported instead of thrown, and the
 * length/count caps keep a pathological input from becoming a ReDoS vector.
 */
export function compileInterestPatterns(raw: unknown): CompiledInterestPatterns {
  const patterns: RegExp[] = [];
  const invalid: InvalidInterestPattern[] = [];
  if (!Array.isArray(raw)) return { patterns, invalid };

  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const source = entry.trim();
    if (!source) continue;
    if (seen.has(source)) continue;
    seen.add(source);

    if (source.length > MODEL_PROBE_MAX_PATTERN_LENGTH) {
      invalid.push({
        source,
        reason: `pattern is longer than ${MODEL_PROBE_MAX_PATTERN_LENGTH} characters`,
      });
      continue;
    }

    if (patterns.length >= MODEL_PROBE_MAX_PATTERN_COUNT) {
      invalid.push({
        source,
        reason: `more than ${MODEL_PROBE_MAX_PATTERN_COUNT} patterns are configured`,
      });
      continue;
    }

    try {
      patterns.push(new RegExp(source, 'i'));
    } catch (error) {
      invalid.push({
        source,
        reason: error instanceof Error ? error.message : 'invalid regular expression',
      });
    }
  }

  return { patterns, invalid };
}

/**
 * An empty pattern list matches nothing on purpose: probing every discovered
 * model before the user has expressed interest would spend real upstream quota.
 */
export function matchesInterest(modelName: string, patterns: RegExp[]): boolean {
  if (patterns.length <= 0) return false;
  const normalized = String(modelName || '').trim();
  if (!normalized) return false;
  return patterns.some((pattern) => pattern.test(normalized));
}
