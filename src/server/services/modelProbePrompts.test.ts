import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODEL_PROBE_PROMPTS,
  MODEL_PROBE_FALLBACK_PROMPT,
  chooseModelProbePrompt,
} from './modelProbePrompts.js';

describe('DEFAULT_MODEL_PROBE_PROMPTS', () => {
  it('avoids the fixed hi/hello wording that sites use to detect liveness probes', () => {
    expect(DEFAULT_MODEL_PROBE_PROMPTS.length).toBeGreaterThanOrEqual(5);

    for (const prompt of DEFAULT_MODEL_PROBE_PROMPTS) {
      expect(prompt.trim()).toBe(prompt);
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt.trim().toLowerCase()).not.toBe('hi');
      expect(prompt.trim().toLowerCase()).not.toBe('hello');
    }

    expect(new Set(DEFAULT_MODEL_PROBE_PROMPTS).size).toBe(DEFAULT_MODEL_PROBE_PROMPTS.length);
  });
});

describe('chooseModelProbePrompt', () => {
  it('selects each configured prompt through the injected random source', () => {
    const prompts = ['first prompt', 'second prompt', 'third prompt'];

    for (const [index, expected] of prompts.entries()) {
      const randomInt = vi.fn(() => index);
      expect(chooseModelProbePrompt(prompts, randomInt)).toBe(expected);
      expect(randomInt).toHaveBeenCalledWith(prompts.length);
    }
  });

  it('trims entries and de-duplicates before selecting', () => {
    const selected = chooseModelProbePrompt(
      ['  duplicate  ', 'duplicate', '   ', '', 'other'],
      (max) => {
        expect(max).toBe(2);
        return 0;
      },
    );

    expect(selected).toBe('duplicate');
  });

  it('falls back to a neutral prompt when nothing usable is configured', () => {
    for (const empty of [[], ['', '   '], undefined as unknown as string[], null as unknown as string[]]) {
      expect(chooseModelProbePrompt(empty)).toBe(MODEL_PROBE_FALLBACK_PROMPT);
    }
  });

  it('ignores a random source that returns an out-of-range or invalid index', () => {
    const prompts = ['alpha', 'beta'];

    expect(prompts).toContain(chooseModelProbePrompt(prompts, () => 99));
    expect(prompts).toContain(chooseModelProbePrompt(prompts, () => -1));
    expect(prompts).toContain(chooseModelProbePrompt(prompts, () => Number.NaN));
  });

  it('uses a crypto-backed source by default and stays within the prompt list', () => {
    const prompts = ['alpha', 'beta', 'gamma'];
    const picks = new Set<string>();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const picked = chooseModelProbePrompt(prompts);
      expect(prompts).toContain(picked);
      picks.add(picked);
    }

    expect(picks.size).toBeGreaterThan(1);
  });
});
