import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  parseModelProbeConfigPayload,
  parseModelProbePreviewPayload,
  parseModelProbeResultsQuery,
  parseModelProbeRunPayload,
  parseModelProbeSiteConfigPayload,
} from './modelProbePayloads.js';

describe('parseModelProbeConfigPayload', () => {
  it('accepts a full config payload', () => {
    const result = parseModelProbeConfigPayload({
      interestPatterns: ['gpt-5', 'claude'],
      prompts: ['What is 2+3?'],
      userAgents: [{ id: 'claude-code', label: 'Claude Code', value: 'claude-cli/2.1.63 (external, cli)' }],
      defaultUserAgentId: 'claude-code',
      errorKeywords: ['insufficient'],
      concurrency: 4,
      timeoutMs: 20000,
      maxTokens: 777,
      syncToRouting: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.interestPatterns).toEqual(['gpt-5', 'claude']);
    expect(result.data.concurrency).toBe(4);
    expect(result.data.maxTokens).toBe(777);
    expect(result.data.syncToRouting).toBe(true);
  });

  /**
   * Regression guard for the deployed incident: `maxTokens` shipped through the
   * config service, the limits payload and the UI, but NOT through this contract —
   * whose `.strict()` then rejected every global-config save from the updated
   * frontend with "unrecognized key". A field is not done until all four layers
   * accept it; this file is the layer that bit.
   */
  // 15s timeout: importing the config service transitively initializes the
  // database layer, which under parallel-suite load can exceed the 5s default.
  it('bounds maxTokens to the same range the config service clamps to', { timeout: 15_000 }, async () => {
    expect(parseModelProbeConfigPayload({ maxTokens: 1 }).success).toBe(true);
    expect(parseModelProbeConfigPayload({ maxTokens: 4_096 }).success).toBe(true);
    for (const bad of [0, -5, 4_097, 12.5, '777']) {
      expect(parseModelProbeConfigPayload({ maxTokens: bad }).success).toBe(false);
    }

    // The literals here exist because importing the config service would pull the
    // database into this contract module — so pin them equal instead.
    const configService = await import('../services/modelProbeConfigService.js');
    expect(configService.MODEL_PROBE_MIN_MAX_TOKENS).toBe(1);
    expect(configService.MODEL_PROBE_MAX_MAX_TOKENS).toBe(4_096);
  });

  it('accepts an empty object, which the service then treats as a full reset to defaults', () => {
    // Every field is optional here, but saveModelProbeConfig replaces the whole
    // config rather than merging, so an API route must spread a patch over the
    // loaded config instead of passing a partial body straight through.
    const result = parseModelProbeConfigPayload({});
    expect(result.success).toBe(true);
  });

  /**
   * The site ceiling must match the config service's clamp exactly. They are
   * separate literals (see the maxTokens note above for why), and a mismatch is
   * not a cosmetic bug: the route would accept a number the service then clamps
   * back down, so the UI would show a value the operator never actually saved.
   */
  // 15s timeout: importing the config service transitively initializes the
  // database layer, which under parallel-suite load can exceed the 5s default.
  it('bounds site concurrency to the same range the config service clamps to', { timeout: 15_000 }, async () => {
    expect(parseModelProbeConfigPayload({ siteConcurrency: 1 }).success).toBe(true);
    expect(parseModelProbeConfigPayload({ siteConcurrency: 50 }).success).toBe(true);
    for (const bad of [0, -5, 51, 12.5, '30']) {
      expect(parseModelProbeConfigPayload({ siteConcurrency: bad }).success).toBe(false);
    }

    const configService = await import('../services/modelProbeConfigService.js');
    expect(configService.MODEL_PROBE_MIN_SITE_CONCURRENCY).toBe(1);
    expect(configService.MODEL_PROBE_MAX_SITE_CONCURRENCY).toBe(50);
  });

  it('caps list sizes and per-entry lengths', () => {
    const tooManyPrompts = parseModelProbeConfigPayload({
      prompts: Array.from({ length: 51 }, (_unused, index) => `prompt ${index}`),
    });
    expect(tooManyPrompts.success).toBe(false);
    if (!tooManyPrompts.success) expect(tooManyPrompts.error).toContain('prompts');

    const longPrompt = parseModelProbeConfigPayload({ prompts: ['a'.repeat(2001)] });
    expect(longPrompt.success).toBe(false);

    const tooManyPatterns = parseModelProbeConfigPayload({
      interestPatterns: Array.from({ length: 51 }, (_unused, index) => `model-${index}`),
    });
    expect(tooManyPatterns.success).toBe(false);
    if (!tooManyPatterns.success) expect(tooManyPatterns.error).toContain('interestPatterns');

    const longPattern = parseModelProbeConfigPayload({ interestPatterns: ['a'.repeat(201)] });
    expect(longPattern.success).toBe(false);

    const tooManyKeywords = parseModelProbeConfigPayload({
      errorKeywords: Array.from({ length: 51 }, (_unused, index) => `keyword-${index}`),
    });
    expect(tooManyKeywords.success).toBe(false);
    if (!tooManyKeywords.success) expect(tooManyKeywords.error).toContain('errorKeywords');

    const tooManyPresets = parseModelProbeConfigPayload({
      userAgents: Array.from({ length: 21 }, (_unused, index) => ({
        id: `preset-${index}`,
        label: `Preset ${index}`,
        value: 'agent/1.0',
      })),
    });
    expect(tooManyPresets.success).toBe(false);
    if (!tooManyPresets.success) expect(tooManyPresets.error).toContain('userAgents');
  });

  it('accepts lists exactly at the caps', () => {
    const result = parseModelProbeConfigPayload({
      interestPatterns: Array.from({ length: 50 }, (_unused, index) => `model-${index}`),
      prompts: Array.from({ length: 50 }, (_unused, index) => `prompt ${index}`),
      errorKeywords: Array.from({ length: 50 }, (_unused, index) => `keyword-${index}`),
      userAgents: Array.from({ length: 20 }, (_unused, index) => ({
        id: `preset-${index}`,
        label: `Preset ${index}`,
        value: 'agent/1.0',
      })),
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-object payloads', () => {
    for (const input of ['nope', 42, [], null]) {
      const result = parseModelProbeConfigPayload(input);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toContain('probe config');
    }
  });

  it('rejects wrong field types with a field-naming message', () => {
    const patterns = parseModelProbeConfigPayload({ interestPatterns: 'gpt-5' });
    expect(patterns.success).toBe(false);
    if (!patterns.success) expect(patterns.error).toContain('interestPatterns');

    const concurrency = parseModelProbeConfigPayload({ concurrency: 'four' });
    expect(concurrency.success).toBe(false);
    if (!concurrency.success) expect(concurrency.error).toContain('concurrency');

    const sync = parseModelProbeConfigPayload({ syncToRouting: 'yes' });
    expect(sync.success).toBe(false);
    if (!sync.success) expect(sync.error).toContain('syncToRouting');

    const agents = parseModelProbeConfigPayload({ userAgents: [{ label: 'no id' }] });
    expect(agents.success).toBe(false);
    if (!agents.success) expect(agents.error).toContain('userAgents');
  });

  it('rejects unknown keys so a typo cannot silently drop a setting', () => {
    const result = parseModelProbeConfigPayload({ interestPaterns: ['gpt-5'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('interestPaterns');
  });

  it('exposes only parse functions, keeping persistence out of the contract module', async () => {
    const contractModule = await import('./modelProbePayloads.js');
    const exportedFunctions = Object.entries(contractModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const name of exportedFunctions) {
      expect(name.startsWith('parse')).toBe(true);
    }
  });

  it('does not import the database layer', async () => {
    const source = await readFile(
      new URL('./modelProbePayloads.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from '(\.\.\/db\/|@db\/)/);
    expect(source).not.toMatch(/upsertSetting|drizzle-orm/);
  });
});

describe('parseModelProbeSiteConfigPayload', () => {
  it('accepts every supported endpoint type', () => {
    for (const probeEndpointType of ['auto', 'chat', 'messages', 'responses']) {
      const result = parseModelProbeSiteConfigPayload({ probeEndpointType });
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.data.probeEndpointType).toBe(probeEndpointType);
    }
  });

  it('rejects the singular "response" spelling and arbitrary strings', () => {
    for (const probeEndpointType of ['response', 'completions', '']) {
      const result = parseModelProbeSiteConfigPayload({ probeEndpointType });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toContain('probeEndpointType');
    }
  });

  it('trims the user agent and rejects one longer than 512 characters', () => {
    const trimmed = parseModelProbeSiteConfigPayload({ probeUserAgent: '  codex_cli_rs/0.20.0  ' });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data.probeUserAgent).toBe('codex_cli_rs/0.20.0');

    const tooLong = parseModelProbeSiteConfigPayload({ probeUserAgent: 'a'.repeat(513) });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) expect(tooLong.error).toContain('probeUserAgent');
  });
});

describe('parseModelProbePreviewPayload', () => {
  it('treats an omitted scope as every site', () => {
    const ok = parseModelProbePreviewPayload({});
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.siteIds).toBeUndefined();
  });

  it('dedupes and sorts an explicit site scope', () => {
    const ok = parseModelProbePreviewPayload({ siteIds: [7, 3, 7] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.siteIds).toEqual([3, 7]);
  });

  it('rejects an empty list rather than reading it as every site', () => {
    const bad = parseModelProbePreviewPayload({ siteIds: [] });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toContain('siteIds');
  });

  it('rejects non-positive, fractional and non-numeric site ids', () => {
    for (const siteIds of [[0], [-1], [1.5], ['7']]) {
      const bad = parseModelProbePreviewPayload({ siteIds });
      expect(bad.success).toBe(false);
      if (bad.success) continue;
      expect(bad.error).toContain('siteIds');
    }
  });

  it('rejects the single-site shape so a caller cannot silently probe everything', () => {
    const bad = parseModelProbePreviewPayload({ siteId: 7 });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toContain('siteId');
  });
});

describe('parseModelProbeRunPayload', () => {
  it('accepts an optional scope with an optional confirmation count', () => {
    const result = parseModelProbeRunPayload({ siteIds: [3, 3, 1], confirmedTargetCount: 51 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.siteIds).toEqual([1, 3]);
    expect(result.data.confirmedTargetCount).toBe(51);
  });

  it('accepts an empty body as a full sweep awaiting confirmation', () => {
    const result = parseModelProbeRunPayload({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.siteIds).toBeUndefined();
    expect(result.data.confirmedTargetCount).toBeUndefined();
  });

  it('accepts a zero confirmation count and rejects a negative one', () => {
    expect(parseModelProbeRunPayload({ confirmedTargetCount: 0 }).success).toBe(true);

    const negative = parseModelProbeRunPayload({ confirmedTargetCount: -1 });
    expect(negative.success).toBe(false);
    if (!negative.success) expect(negative.error).toContain('confirmedTargetCount');
  });

  it('rejects fields the run service cannot honour', () => {
    for (const body of [
      { models: ['gpt-5'] },
      { userAgentId: 'codex-cli' },
      { concurrency: 2 },
      { timeoutMs: 9000 },
    ]) {
      expect(parseModelProbeRunPayload(body).success).toBe(false);
    }
  });
});

describe('parseModelProbeResultsQuery', () => {
  it('coerces query string values and applies limit defaults', () => {
    const result = parseModelProbeResultsQuery({ siteId: '5', status: 'supported', limit: '50' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.siteId).toBe(5);
    expect(result.data.status).toBe('supported');
    expect(result.data.limit).toBe(50);
  });

  it('treats every filter as optional', () => {
    const result = parseModelProbeResultsQuery({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.siteId).toBeUndefined();
    expect(result.data.status).toBeUndefined();
    expect(result.data.limit).toBeUndefined();
  });

  it('treats a cleared filter serialized as an empty param as no filter', () => {
    for (const query of [{ siteId: '' }, { status: '' }, { limit: '' }, { siteId: '   ' }]) {
      const result = parseModelProbeResultsQuery(query);
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.data.siteId).toBeUndefined();
      expect(result.data.status).toBeUndefined();
      expect(result.data.limit).toBeUndefined();
    }
  });

  it('parses a fully blank filter set the way a reset UI form would send it', () => {
    const result = parseModelProbeResultsQuery({ siteId: '', status: '', limit: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({});
  });

  it('ignores unrelated query params instead of failing the listing', () => {
    const result = parseModelProbeResultsQuery({ siteId: '5', _t: '1700000000000' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.siteId).toBe(5);
  });

  it('rejects a limit above the hard cap', () => {
    const result = parseModelProbeResultsQuery({ limit: '900' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('limit');
  });

  it('accepts every probe result status', () => {
    for (const status of ['supported', 'unsupported', 'inconclusive', 'skipped']) {
      expect(parseModelProbeResultsQuery({ status }).success).toBe(true);
    }
  });

  it('rejects unknown statuses and non-numeric ids', () => {
    const status = parseModelProbeResultsQuery({ status: 'maybe' });
    expect(status.success).toBe(false);
    if (!status.success) expect(status.error).toContain('status');

    const siteId = parseModelProbeResultsQuery({ siteId: 'abc' });
    expect(siteId.success).toBe(false);
    if (!siteId.success) expect(siteId.error).toContain('siteId');
  });

  it('accepts the model filter, sort field, order and offset the results service supports', () => {
    const result = parseModelProbeResultsQuery({
      model: '  GPT-5  ',
      sortBy: 'balance',
      order: 'asc',
      offset: '40',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.model).toBe('GPT-5');
    expect(result.data.sortBy).toBe('balance');
    expect(result.data.order).toBe('asc');
    expect(result.data.offset).toBe(40);
  });

  it('accepts every sort field and order', () => {
    for (const sortBy of ['latency', 'balance', 'checkedAt']) {
      expect(parseModelProbeResultsQuery({ sortBy }).success).toBe(true);
    }
    for (const order of ['asc', 'desc']) {
      expect(parseModelProbeResultsQuery({ order }).success).toBe(true);
    }
  });

  it('accepts offset 0 because paging starts at the first row', () => {
    const result = parseModelProbeResultsQuery({ offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.offset).toBe(0);
  });

  it('rejects an unknown sort field instead of silently falling back', () => {
    const sortBy = parseModelProbeResultsQuery({ sortBy: 'cost' });
    expect(sortBy.success).toBe(false);
    if (!sortBy.success) expect(sortBy.error).toContain('sortBy');

    const order = parseModelProbeResultsQuery({ order: 'ascending' });
    expect(order.success).toBe(false);
    if (!order.success) expect(order.error).toContain('order');
  });

  it('rejects a negative offset and an over-long model filter', () => {
    const offset = parseModelProbeResultsQuery({ offset: '-1' });
    expect(offset.success).toBe(false);
    if (!offset.success) expect(offset.error).toContain('offset');

    const model = parseModelProbeResultsQuery({ model: 'a'.repeat(201) });
    expect(model.success).toBe(false);
    if (!model.success) expect(model.error).toContain('model');
  });

  it('treats every new filter as absent when the UI sends it blank', () => {
    const result = parseModelProbeResultsQuery({ model: '', sortBy: '', order: '', offset: '' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.model).toBeUndefined();
    expect(result.data.sortBy).toBeUndefined();
    expect(result.data.order).toBeUndefined();
    expect(result.data.offset).toBeUndefined();
  });
});
