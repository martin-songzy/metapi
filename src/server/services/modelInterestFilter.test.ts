import { describe, expect, it } from 'vitest';

import {
  MODEL_PROBE_MAX_PATTERN_COUNT,
  MODEL_PROBE_MAX_PATTERN_LENGTH,
  compileInterestPatterns,
  matchesInterest,
} from './modelInterestFilter.js';

describe('compileInterestPatterns', () => {
  it('treats an empty or non-array input as matching no model', () => {
    for (const raw of [undefined, null, [], '', {}, 'opus']) {
      const { patterns, invalid } = compileInterestPatterns(raw);
      expect(patterns).toHaveLength(0);
      expect(invalid).toHaveLength(0);
      expect(matchesInterest('claude-opus-4.8', patterns)).toBe(false);
    }
  });

  it('isolates malformed patterns instead of throwing', () => {
    const { patterns, invalid } = compileInterestPatterns(['glm-5\\.[2-9]', '[', 'opus']);

    expect(patterns).toHaveLength(2);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.source).toBe('[');
    expect(invalid[0]?.reason).toBeTruthy();
  });

  it('rejects overlong patterns and entries beyond the count cap', () => {
    const overlong = 'a'.repeat(MODEL_PROBE_MAX_PATTERN_LENGTH + 1);
    const overlongResult = compileInterestPatterns([overlong]);
    expect(overlongResult.patterns).toHaveLength(0);
    expect(overlongResult.invalid).toHaveLength(1);
    expect(overlongResult.invalid[0]?.reason).toContain(String(MODEL_PROBE_MAX_PATTERN_LENGTH));

    const tooMany = Array.from({ length: MODEL_PROBE_MAX_PATTERN_COUNT + 3 }, (_, index) => `model-${index}`);
    const tooManyResult = compileInterestPatterns(tooMany);
    expect(tooManyResult.patterns).toHaveLength(MODEL_PROBE_MAX_PATTERN_COUNT);
    expect(tooManyResult.invalid).toHaveLength(3);
    expect(tooManyResult.invalid[0]?.reason).toContain(String(MODEL_PROBE_MAX_PATTERN_COUNT));
  });

  it('ignores blank entries and de-duplicates equivalent sources', () => {
    const { patterns, invalid } = compileInterestPatterns(['  opus  ', 'opus', '', '   ', 42]);

    expect(patterns).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });
});

describe('matchesInterest', () => {
  it('matches opus 4.8 and newer while rejecting older opus releases', () => {
    const { patterns, invalid } = compileInterestPatterns(['opus-(4\\.(8|9)|[5-9])|opus-([5-9]|[1-9]\\d)']);
    expect(invalid).toHaveLength(0);

    for (const supported of [
      'claude-opus-4.8',
      'claude-opus-4.9',
      'claude-opus-5',
      'claude-opus-5.1',
      'claude-opus-12',
    ]) {
      expect(matchesInterest(supported, patterns)).toBe(true);
    }

    for (const rejected of ['claude-opus-4.1', 'claude-opus-4.7', 'claude-sonnet-4.8']) {
      expect(matchesInterest(rejected, patterns)).toBe(false);
    }
  });

  it('matches glm 5.2 and newer but not glm 5.1', () => {
    const { patterns } = compileInterestPatterns(['glm-5\\.([2-9]|[1-9]\\d)']);

    expect(matchesInterest('glm-5.2', patterns)).toBe(true);
    expect(matchesInterest('glm-5.9', patterns)).toBe(true);
    expect(matchesInterest('glm-5.12', patterns)).toBe(true);
    expect(matchesInterest('glm-5.1', patterns)).toBe(false);
    expect(matchesInterest('glm-4.9', patterns)).toBe(false);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const { patterns } = compileInterestPatterns(['gpt-5\\.6']);

    expect(matchesInterest('GPT-5.6-SOL', patterns)).toBe(true);
    expect(matchesInterest('  gpt-5.6  ', patterns)).toBe(true);
    expect(matchesInterest('', patterns)).toBe(false);
  });

  it('is stateless across repeated calls with global-like patterns', () => {
    const { patterns } = compileInterestPatterns(['opus']);

    expect(matchesInterest('claude-opus-4.8', patterns)).toBe(true);
    expect(matchesInterest('claude-opus-4.8', patterns)).toBe(true);
    expect(matchesInterest('claude-opus-4.8', patterns)).toBe(true);
  });
});
