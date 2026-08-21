import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MODEL_PROBE_PROMPTS } from './modelProbePrompts.js';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./modelProbeConfigService.js');

describe('modelProbeConfigService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let service: ServiceModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-probe-config-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    service = await import('./modelProbeConfigService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    if (typeof closeDbConnections === 'function') {
      await closeDbConnections();
    }
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  describe('getDefaultModelProbeConfig', () => {
    it('starts with no interest patterns so nothing is probed before the user opts in', () => {
      expect(service.getDefaultModelProbeConfig().interestPatterns).toEqual([]);
    });

    it('uses the six shared non-trivial prompts', () => {
      const config = service.getDefaultModelProbeConfig();
      expect(config.prompts).toHaveLength(6);
      expect(config.prompts).toEqual([...DEFAULT_MODEL_PROBE_PROMPTS]);
      for (const prompt of config.prompts) {
        expect(prompt.trim().length).toBeGreaterThan(4);
      }
    });

    it('ships stable user agent preset ids with claude-code selected by default', () => {
      const config = service.getDefaultModelProbeConfig();
      expect(config.userAgents.map((preset) => preset.id)).toEqual(['claude-code', 'codex-cli', 'custom']);

      const byId = new Map(config.userAgents.map((preset) => [preset.id, preset]));
      expect(byId.get('claude-code')?.value).toBe('claude-cli/2.1.63 (external, cli)');
      expect(byId.get('codex-cli')?.value).toBe('codex_cli_rs/0.20.0');
      expect(byId.get('custom')?.value).toBe('');
      for (const preset of config.userAgents) {
        expect(preset.label.trim()).not.toBe('');
      }
      expect(config.defaultUserAgentId).toBe('claude-code');
    });

    it('defaults concurrency to 1 and timeout to 15000', () => {
      const config = service.getDefaultModelProbeConfig();
      expect(config.concurrency).toBe(1);
      expect(config.timeoutMs).toBe(15000);
    });

    it('keeps syncToRouting off so probes never mutate the routing tables by default', () => {
      expect(service.getDefaultModelProbeConfig().syncToRouting).toBe(false);
    });

    it('defaults to the conservative shared error keyword list', () => {
      expect(service.getDefaultModelProbeConfig().errorKeywords).toEqual([
        'insufficient',
        'quota',
        '余额不足',
        '无可用渠道',
        'no available channel',
        'rate limit',
        '当前分组上游负载已饱和',
        '无权限',
      ]);
    });

    it('returns a fresh object each call so callers cannot mutate the defaults', () => {
      const first = service.getDefaultModelProbeConfig();
      first.interestPatterns.push('leaked');
      first.userAgents[0]!.value = 'leaked';
      const second = service.getDefaultModelProbeConfig();
      expect(second.interestPatterns).toEqual([]);
      expect(second.userAgents[0]?.value).toBe('claude-cli/2.1.63 (external, cli)');
    });
  });

  describe('normalizeModelProbeConfig', () => {
    it('falls back to defaults for junk input', () => {
      expect(service.normalizeModelProbeConfig(null)).toEqual(service.getDefaultModelProbeConfig());
      expect(service.normalizeModelProbeConfig('nope')).toEqual(service.getDefaultModelProbeConfig());
    });

    it('clamps concurrency into 1..8 and timeout into 3000..60000', () => {
      expect(service.normalizeModelProbeConfig({ concurrency: 0 }).concurrency).toBe(1);
      expect(service.normalizeModelProbeConfig({ concurrency: -5 }).concurrency).toBe(1);
      expect(service.normalizeModelProbeConfig({ concurrency: 99 }).concurrency).toBe(8);
      expect(service.normalizeModelProbeConfig({ concurrency: 3.7 }).concurrency).toBe(3);
      expect(service.normalizeModelProbeConfig({ concurrency: 'x' }).concurrency).toBe(1);

      expect(service.normalizeModelProbeConfig({ timeoutMs: 10 }).timeoutMs).toBe(3000);
      expect(service.normalizeModelProbeConfig({ timeoutMs: 999999 }).timeoutMs).toBe(60000);
      expect(service.normalizeModelProbeConfig({ timeoutMs: 20000 }).timeoutMs).toBe(20000);
      expect(service.normalizeModelProbeConfig({ timeoutMs: Number.NaN }).timeoutMs).toBe(15000);
    });

    it('falls back to defaults instead of clamping empty-ish numeric fields to the floor', () => {
      for (const blank of [null, undefined, '', '   ', [], false, {}]) {
        expect(service.normalizeModelProbeConfig({ timeoutMs: blank }).timeoutMs).toBe(15000);
        expect(service.normalizeModelProbeConfig({ concurrency: blank }).concurrency).toBe(1);
      }
    });

    it('accepts numeric strings from hand-edited settings rows', () => {
      expect(service.normalizeModelProbeConfig({ timeoutMs: '20000' }).timeoutMs).toBe(20000);
      expect(service.normalizeModelProbeConfig({ concurrency: ' 4 ' }).concurrency).toBe(4);
    });

    it('trims and dedupes interest patterns, prompts and error keywords', () => {
      const config = service.normalizeModelProbeConfig({
        interestPatterns: [' gpt-5 ', 'gpt-5', '', 42, null],
        prompts: ['  hi there  ', 'hi there', '   '],
        errorKeywords: [' Quota ', 'quota', ''],
      });

      expect(config.interestPatterns).toEqual(['gpt-5']);
      expect(config.prompts).toEqual(['hi there']);
      expect(config.errorKeywords).toEqual(['Quota']);
    });

    it('dedupes prompts case-sensitively but patterns and keywords case-insensitively', () => {
      const config = service.normalizeModelProbeConfig({
        interestPatterns: ['GPT-5', 'gpt-5'],
        prompts: ['Name one color.', 'name one color.'],
        errorKeywords: ['Rate Limit', 'rate limit'],
      });

      expect(config.interestPatterns).toEqual(['GPT-5']);
      expect(config.prompts).toEqual(['Name one color.', 'name one color.']);
      expect(config.errorKeywords).toEqual(['Rate Limit']);
    });

    it('honours an explicitly emptied list instead of restoring defaults', () => {
      const config = service.normalizeModelProbeConfig({
        interestPatterns: [],
        prompts: [''],
        errorKeywords: [],
      });

      expect(config.interestPatterns).toEqual([]);
      expect(config.prompts).toEqual([]);
      expect(config.errorKeywords).toEqual([]);
    });

    it('keeps the default preset selection when the caller only replaces other fields', () => {
      const config = service.normalizeModelProbeConfig({ concurrency: 5 });
      expect(config.defaultUserAgentId).toBe('claude-code');
      expect(config.userAgents).toEqual(service.getDefaultModelProbeConfig().userAgents);
    });

    it('keeps normalization independent from the routing tables', async () => {
      const previous = process.env.PROXY_ROUTING_ENABLED;
      process.env.PROXY_ROUTING_ENABLED = 'false';
      try {
        const saved = await service.saveModelProbeConfig({ interestPatterns: ['gpt-5'] });
        expect(saved.interestPatterns).toEqual(['gpt-5']);
        expect(saved.syncToRouting).toBe(false);
        expect((await service.loadModelProbeConfig()).interestPatterns).toEqual(['gpt-5']);
      } finally {
        if (previous === undefined) delete process.env.PROXY_ROUTING_ENABLED;
        else process.env.PROXY_ROUTING_ENABLED = previous;
      }
    });

    it('dedupes duplicate preset ids, keeping the first occurrence', () => {
      const config = service.normalizeModelProbeConfig({
        userAgents: [
          { id: 'claude-code', label: 'First', value: 'ua-first' },
          { id: ' claude-code ', label: 'Duplicate', value: 'ua-duplicate' },
          { id: 'custom', label: 'Custom', value: '' },
        ],
        defaultUserAgentId: 'claude-code',
      });

      expect(config.userAgents.map((preset) => preset.id)).toEqual(['claude-code', 'custom']);
      expect(config.userAgents[0]).toEqual({ id: 'claude-code', label: 'First', value: 'ua-first' });
    });

    it('falls back to the default presets when none survive normalization', () => {
      const config = service.normalizeModelProbeConfig({ userAgents: ['nope', { label: 'no id' }] });
      expect(config.userAgents).toEqual(service.getDefaultModelProbeConfig().userAgents);
    });

    it('repoints defaultUserAgentId at the first preset when the selection is unknown', () => {
      const config = service.normalizeModelProbeConfig({
        userAgents: [{ id: 'codex-cli', label: 'Codex', value: 'codex_cli_rs/0.20.0' }],
        defaultUserAgentId: 'ghost',
      });
      expect(config.defaultUserAgentId).toBe('codex-cli');
    });

    it('preserves an explicit syncToRouting opt-in', () => {
      expect(service.normalizeModelProbeConfig({ syncToRouting: true }).syncToRouting).toBe(true);
      expect(service.normalizeModelProbeConfig({ syncToRouting: 'true' }).syncToRouting).toBe(false);
    });
  });

  describe('loadModelProbeConfig / saveModelProbeConfig', () => {
    it('returns defaults when nothing is stored', async () => {
      const config = await service.loadModelProbeConfig();
      expect(config).toEqual(service.getDefaultModelProbeConfig());
      const rows = await db.select().from(schema.settings).all();
      expect(rows).toHaveLength(0);
    });

    it('upserts exactly one JSON settings row under model_probe_config_v1', async () => {
      expect(service.MODEL_PROBE_CONFIG_SETTING_KEY).toBe('model_probe_config_v1');

      await service.saveModelProbeConfig({ interestPatterns: ['gpt-5'], concurrency: 3 });
      await service.saveModelProbeConfig({ interestPatterns: ['claude'], concurrency: 4 });

      const rows = await db.select().from(schema.settings).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toBe('model_probe_config_v1');

      const parsed = JSON.parse(String(rows[0]?.value));
      expect(parsed.interestPatterns).toEqual(['claude']);
      expect(parsed.concurrency).toBe(4);
      expect(parsed.syncToRouting).toBe(false);
    });

    it('round-trips a saved config through load', async () => {
      const saved = await service.saveModelProbeConfig({
        interestPatterns: ['^gpt-5'],
        prompts: ['What is 2+3?'],
        errorKeywords: ['insufficient'],
        userAgents: [{ id: 'custom', label: 'Custom', value: 'my-agent/1.0' }],
        defaultUserAgentId: 'custom',
        concurrency: 2,
        timeoutMs: 9000,
        syncToRouting: true,
      });

      await expect(service.loadModelProbeConfig()).resolves.toEqual(saved);
    });

    it('falls back to defaults when the stored row is corrupt', async () => {
      await db.insert(schema.settings).values({
        key: service.MODEL_PROBE_CONFIG_SETTING_KEY,
        value: '{not json',
      }).run();

      await expect(service.loadModelProbeConfig()).resolves.toEqual(service.getDefaultModelProbeConfig());
    });

    it('rejects an invalid interest regex with a message naming the pattern', async () => {
      await expect(service.saveModelProbeConfig({ interestPatterns: ['gpt-5', '([unclosed'] }))
        .rejects.toThrow(/\(\[unclosed/);

      const rows = await db.select().from(schema.settings).all();
      expect(rows).toHaveLength(0);
    });

    it('rejects a pattern list that exceeds the shared caps', async () => {
      await expect(service.saveModelProbeConfig({ interestPatterns: ['a'.repeat(201)] }))
        .rejects.toThrow(/200 characters/);

      const tooMany = Array.from({ length: 51 }, (_unused, index) => `model-${index}`);
      await expect(service.saveModelProbeConfig({ interestPatterns: tooMany }))
        .rejects.toThrow(/50 patterns/);
    });

    it('accepts valid regex patterns unchanged', async () => {
      const saved = await service.saveModelProbeConfig({ interestPatterns: ['^gpt-5.*$', 'claude-(opus|sonnet)'] });
      expect(saved.interestPatterns).toEqual(['^gpt-5.*$', 'claude-(opus|sonnet)']);
    });
  });

  describe('resolveModelProbeUserAgent', () => {
    it('returns the selected global preset value', () => {
      const config = service.getDefaultModelProbeConfig();
      expect(service.resolveModelProbeUserAgent(config)).toBe('claude-cli/2.1.63 (external, cli)');

      const codex = service.normalizeModelProbeConfig({ ...config, defaultUserAgentId: 'codex-cli' });
      expect(service.resolveModelProbeUserAgent(codex)).toBe('codex_cli_rs/0.20.0');
    });

    it('lets a site override win over the selected global preset', () => {
      const config = service.getDefaultModelProbeConfig();
      expect(service.resolveModelProbeUserAgent(config, '  site-agent/9.9  ')).toBe('site-agent/9.9');
    });

    it('falls back to the global preset for blank, null or undefined overrides', () => {
      const config = service.getDefaultModelProbeConfig();
      for (const override of [null, undefined, '', '   ']) {
        expect(service.resolveModelProbeUserAgent(config, override)).toBe('claude-cli/2.1.63 (external, cli)');
      }
    });

    it('returns an empty string when the selected preset carries no value', () => {
      const config = service.normalizeModelProbeConfig({ defaultUserAgentId: 'custom' });
      expect(service.resolveModelProbeUserAgent(config)).toBe('');
    });
  });
});
