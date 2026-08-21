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
      syncToRouting: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.interestPatterns).toEqual(['gpt-5', 'claude']);
    expect(result.data.concurrency).toBe(4);
    expect(result.data.syncToRouting).toBe(true);
  });

  it('accepts an empty object so partial updates stay possible', () => {
    const result = parseModelProbeConfigPayload({});
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
    expect(source).not.toMatch(/from '\.\.\/db\//);
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
  it('requires a positive integer site id', () => {
    const ok = parseModelProbePreviewPayload({ siteId: 7 });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.siteId).toBe(7);

    for (const siteId of [0, -1, 1.5, '7', undefined]) {
      const bad = parseModelProbePreviewPayload({ siteId });
      expect(bad.success).toBe(false);
      if (bad.success) continue;
      expect(bad.error).toContain('siteId');
    }
  });
});

describe('parseModelProbeRunPayload', () => {
  it('accepts a site id with optional explicit models and overrides', () => {
    const result = parseModelProbeRunPayload({
      siteId: 3,
      models: [' gpt-5 ', 'gpt-5', ''],
      userAgentId: 'codex-cli',
      concurrency: 2,
      timeoutMs: 9000,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.siteId).toBe(3);
    expect(result.data.models).toEqual(['gpt-5']);
    expect(result.data.userAgentId).toBe('codex-cli');
    expect(result.data.concurrency).toBe(2);
  });

  it('defaults models to undefined so the caller can fall back to interest matching', () => {
    const result = parseModelProbeRunPayload({ siteId: 3 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.models).toBeUndefined();
  });

  it('rejects a missing site id and out-of-range overrides', () => {
    expect(parseModelProbeRunPayload({}).success).toBe(false);

    const concurrency = parseModelProbeRunPayload({ siteId: 3, concurrency: 99 });
    expect(concurrency.success).toBe(false);
    if (!concurrency.success) expect(concurrency.error).toContain('concurrency');

    const timeout = parseModelProbeRunPayload({ siteId: 3, timeoutMs: 10 });
    expect(timeout.success).toBe(false);
    if (!timeout.success) expect(timeout.error).toContain('timeoutMs');
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
});
