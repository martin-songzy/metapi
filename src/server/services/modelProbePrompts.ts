import { randomInt as cryptoRandomInt } from 'node:crypto';

/**
 * Probe prompts are deliberately varied and non-trivial. Upstream relays often
 * flag a fixed "hi"/"hello" as a liveness check, so a rotating pool of ordinary
 * requests keeps an active probe indistinguishable from real traffic.
 */
export const DEFAULT_MODEL_PROBE_PROMPTS: readonly string[] = [
  '请用一个词回答：你好',
  'Summarize: the sky is blue.',
  'Translate to French: book',
  'What is 2+3?',
  'Name one color.',
  'Reply with a single word.',
];

export const MODEL_PROBE_FALLBACK_PROMPT = 'Reply with a single short word.';

function normalizePrompts(prompts: unknown): string[] {
  if (!Array.isArray(prompts)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of prompts) {
    if (typeof entry !== 'string') continue;
    const prompt = entry.trim();
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    normalized.push(prompt);
  }
  return normalized;
}

/**
 * Picks one prompt at random. The random source is injectable so tests stay
 * deterministic; the default is crypto-backed rather than Math.random because a
 * predictable rotation would defeat the point of varying the wording.
 */
export function chooseModelProbePrompt(
  prompts: string[],
  randomInt: (max: number) => number = (max) => cryptoRandomInt(max),
): string {
  const normalized = normalizePrompts(prompts);
  if (normalized.length <= 0) return MODEL_PROBE_FALLBACK_PROMPT;
  if (normalized.length === 1) return normalized[0] as string;

  const rawIndex = Math.trunc(Number(randomInt(normalized.length)));
  if (!Number.isFinite(rawIndex)) return normalized[0] as string;

  const safeIndex = ((rawIndex % normalized.length) + normalized.length) % normalized.length;
  return normalized[safeIndex] as string;
}
