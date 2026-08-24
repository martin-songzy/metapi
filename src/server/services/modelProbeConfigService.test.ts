import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

    it('defaults site concurrency to 5, model concurrency to 1, timeout to 15000', () => {
      const config = service.getDefaultModelProbeConfig();
      expect(config.siteConcurrency).toBe(5);
      expect(config.modelConcurrency).toBe(1);
      expect(config.timeoutMs).toBe(15000);
    });

    it('keeps syncToRouting off so probes never mutate the routing tables by default', () => {
      expect(service.getDefaultModelProbeConfig().syncToRouting).toBe(false);
    });

    it('defaults to model-absence error keywords only', () => {
      expect(service.getDefaultModelProbeConfig().errorKeywords).toEqual([
        'no available channel',
        '无可用渠道',
        'no such model',
        'model not found',
        'model_not_found',
        '模型不存在',
        '模型不可用',
        '不支持的模型',
      ]);
    });

    it('excludes billing, capacity and permission wording from the defaults', () => {
      // The classifier maps ANY keyword hit to `unsupported`, so an account-level
      // or transient phrase would mark every model at a rate-limited or
      // out-of-balance site unavailable — and with syncToRouting on, write those
      // verdicts into site_disabled_models. Such responses must stay inconclusive.
      const keywords = service.getDefaultModelProbeConfig().errorKeywords;
      for (const transientPhrase of [
        'insufficient',
        'quota',
        'rate limit',
        '余额不足',
        '当前分组上游负载已饱和',
        '无权限',
      ]) {
        expect(keywords).not.toContain(transientPhrase);
      }
    });

    it('keeps every default keyword a model-absence phrase the classifier can safely act on', async () => {
      const { classifySuccessfulProbeResponse } = await import('./modelProbeResponseClassifier.js');
      const { errorKeywords } = service.getDefaultModelProbeConfig();

      for (const keyword of errorKeywords) {
        const classification = classifySuccessfulProbeResponse({
          endpoint: 'chat',
          rawBody: JSON.stringify({ choices: [{ message: { content: '' } }], detail: keyword }),
          errorKeywords,
        });
        expect(classification.status).toBe('unsupported');
      }
    });

    it('leaves an out-of-balance response inconclusive under the default keywords', async () => {
      const { classifySuccessfulProbeResponse } = await import('./modelProbeResponseClassifier.js');
      const { errorKeywords } = service.getDefaultModelProbeConfig();

      const classification = classifySuccessfulProbeResponse({
        endpoint: 'chat',
        rawBody: JSON.stringify({
          choices: [{ message: { content: '' } }],
          detail: '当前分组上游负载已饱和，或余额不足 (insufficient quota), please retry',
        }),
        errorKeywords,
      });

      expect(classification.status).toBe('inconclusive');
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

    it('clamps both concurrency axes and the timeout into their bounds', () => {
      // Site axis: 1..10.
      expect(service.normalizeModelProbeConfig({ siteConcurrency: 0 }).siteConcurrency).toBe(1);
      expect(service.normalizeModelProbeConfig({ siteConcurrency: -5 }).siteConcurrency).toBe(1);
      expect(service.normalizeModelProbeConfig({ siteConcurrency: 99 }).siteConcurrency).toBe(10);
      expect(service.normalizeModelProbeConfig({ siteConcurrency: 3.7 }).siteConcurrency).toBe(3);
      expect(service.normalizeModelProbeConfig({ siteConcurrency: 'x' }).siteConcurrency).toBe(5);

      // Model axis: 1..8, same shape as before the split.
      expect(service.normalizeModelProbeConfig({ modelConcurrency: 0 }).modelConcurrency).toBe(1);
      expect(service.normalizeModelProbeConfig({ modelConcurrency: 99 }).modelConcurrency).toBe(8);
      expect(service.normalizeModelProbeConfig({ modelConcurrency: 3.7 }).modelConcurrency).toBe(3);

      expect(service.normalizeModelProbeConfig({ timeoutMs: 10 }).timeoutMs).toBe(3000);
      expect(service.normalizeModelProbeConfig({ timeoutMs: 999999 }).timeoutMs).toBe(60000);
      expect(service.normalizeModelProbeConfig({ timeoutMs: 20000 }).timeoutMs).toBe(20000);
      expect(service.normalizeModelProbeConfig({ timeoutMs: Number.NaN }).timeoutMs).toBe(15000);

      // The budget counts thinking tokens too, so a value small enough to truncate
      // before any visible content turns working models into false `empty_content`
      // verdicts. 0 is the dangerous input and must clamp, not pass through.
      expect(service.normalizeModelProbeConfig({ maxTokens: 0 }).maxTokens).toBe(1);
      expect(service.normalizeModelProbeConfig({ maxTokens: 99999 }).maxTokens).toBe(4096);
      expect(service.normalizeModelProbeConfig({ maxTokens: 256 }).maxTokens).toBe(256);
      expect(service.normalizeModelProbeConfig({ maxTokens: 128.9 }).maxTokens).toBe(128);
      expect(service.normalizeModelProbeConfig({ maxTokens: Number.NaN }).maxTokens).toBe(64);
    });

    it('falls back to defaults instead of clamping empty-ish numeric fields to the floor', () => {
      for (const blank of [null, undefined, '', '   ', [], false, {}]) {
        expect(service.normalizeModelProbeConfig({ timeoutMs: blank }).timeoutMs).toBe(15000);
        expect(service.normalizeModelProbeConfig({ siteConcurrency: blank }).siteConcurrency).toBe(5);
        expect(service.normalizeModelProbeConfig({ modelConcurrency: blank }).modelConcurrency).toBe(1);
        expect(service.normalizeModelProbeConfig({ maxTokens: blank }).maxTokens).toBe(64);
      }
    });

    it('accepts numeric strings from hand-edited settings rows', () => {
      expect(service.normalizeModelProbeConfig({ timeoutMs: '20000' }).timeoutMs).toBe(20000);
      expect(service.normalizeModelProbeConfig({ modelConcurrency: ' 2 ' }).modelConcurrency).toBe(2);
    });

    it('maps the legacy single concurrency onto the per-site axis', () => {
      // Rows saved before the split carry only `concurrency`. Mapping it to
      // modelConcurrency can only shrink the old flat burst rate; a NEW explicit
      // modelConcurrency must win over the legacy key so an operator raising the
      // per-site knob is not silently dragged back.
      expect(service.normalizeModelProbeConfig({ concurrency: 4 }).modelConcurrency).toBe(4);
      expect(service.normalizeModelProbeConfig({ concurrency: 99 }).modelConcurrency).toBe(8);
      expect(service.normalizeModelProbeConfig({
        concurrency: 7,
        modelConcurrency: 2,
      }).modelConcurrency).toBe(2);
      // ...and the sites axis is untouched by the legacy key.
      expect(service.normalizeModelProbeConfig({ concurrency: 4 }).siteConcurrency).toBe(5);
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

    it('dedupes patterns and prompts case-sensitively but keywords case-insensitively', () => {
      const config = service.normalizeModelProbeConfig({
        interestPatterns: ['GPT-5', 'gpt-5'],
        prompts: ['Name one color.', 'name one color.'],
        errorKeywords: ['Model Not Found', 'model not found'],
      });

      expect(config.interestPatterns).toEqual(['GPT-5', 'gpt-5']);
      expect(config.prompts).toEqual(['Name one color.', 'name one color.']);
      expect(config.errorKeywords).toEqual(['Model Not Found']);
    });

    it('keeps regexes that differ only by escape case, which are semantically opposite', () => {
      // A lowercased dedupe key would collapse these pairs and silently drop one.
      const config = service.normalizeModelProbeConfig({
        interestPatterns: ['^\\d+$', '^\\D+$', 'a\\bb', 'a\\Bb', '\\w+', '\\W+', '\\s', '\\S'],
      });

      expect(config.interestPatterns).toEqual([
        '^\\d+$', '^\\D+$', 'a\\bb', 'a\\Bb', '\\w+', '\\W+', '\\s', '\\S',
      ]);
    });

    it('bounds a hand-edited settings row: prompts, keywords and presets are capped', () => {
      const config = service.normalizeModelProbeConfig({
        prompts: Array.from({ length: 80 }, (_unused, index) => `prompt ${index}`),
        errorKeywords: Array.from({ length: 80 }, (_unused, index) => `keyword-${index}`),
        userAgents: Array.from({ length: 40 }, (_unused, index) => ({
          id: `preset-${index}`,
          label: `Preset ${index}`,
          value: 'agent/1.0',
        })),
      });

      expect(config.prompts).toHaveLength(50);
      expect(config.errorKeywords).toHaveLength(50);
      expect(config.userAgents).toHaveLength(20);
    });

    it('drops over-long prompt and keyword entries', () => {
      const config = service.normalizeModelProbeConfig({
        prompts: ['ok prompt', 'a'.repeat(2001)],
        errorKeywords: ['ok keyword', 'b'.repeat(201)],
      });

      expect(config.prompts).toEqual(['ok prompt']);
      expect(config.errorKeywords).toEqual(['ok keyword']);
    });

    it('leaves interest patterns untruncated so save-time validation can still reject them', () => {
      // compileInterestPatterns owns the 50/200 caps and reports violations;
      // truncating here would hide the 51st pattern from that check.
      const config = service.normalizeModelProbeConfig({
        interestPatterns: Array.from({ length: 60 }, (_unused, index) => `model-${index}`),
      });
      expect(config.interestPatterns).toHaveLength(60);
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
      const config = service.normalizeModelProbeConfig({ modelConcurrency: 5 });
      expect(config.defaultUserAgentId).toBe('claude-code');
      expect(config.userAgents).toEqual(service.getDefaultModelProbeConfig().userAgents);
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

      // The legacy alias feeds modelConcurrency on input, but the PERSISTED record
      // carries only the new keys — the split is one-way at rest.
      await service.saveModelProbeConfig({ interestPatterns: ['gpt-5'], modelConcurrency: 3 });
      await service.saveModelProbeConfig({ interestPatterns: ['claude'], siteConcurrency: 4 });

      const rows = await db.select().from(schema.settings).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toBe('model_probe_config_v1');

      const parsed = JSON.parse(String(rows[0]?.value));
      expect(parsed.interestPatterns).toEqual(['claude']);
      expect(parsed.siteConcurrency).toBe(4);
      expect(parsed.modelConcurrency).toBe(1);
      expect(parsed.concurrency).toBeUndefined();
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

    it('throws a discriminable validation error so a route can answer 400 rather than 500', async () => {
      const error = await service.saveModelProbeConfig({ interestPatterns: ['([unclosed'] })
        .then(() => null, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(service.ModelProbeConfigValidationError);
      expect(service.isModelProbeConfigValidationError(error)).toBe(true);
      expect(service.isModelProbeConfigValidationError(new Error('unrelated'))).toBe(false);

      const validationError = error as InstanceType<typeof service.ModelProbeConfigValidationError>;
      expect(validationError.name).toBe('ModelProbeConfigValidationError');
      expect(validationError.invalidPatterns.map((entry) => entry.source)).toEqual(['([unclosed']);
      expect(validationError.invalidPatterns[0]?.reason).toBeTruthy();
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

  describe('routing independence', () => {
    // A test that flips process.env.PROXY_ROUTING_ENABLED would be a no-op:
    // config.ts evaluates buildConfig(process.env) once at import, before any test
    // body runs. So assert the property structurally over the source instead, the
    // same way modelProbePayloads.test.ts and db/returning.architecture.test.ts do.
    //
    // Scope note: this reads ONE file's import list. It does not and cannot show
    // that the routing stack is absent from the transitive closure — it is not
    // (runtimeModelProbe -> oauth/service -> modelService -> tokenRouter). The
    // behavioural guarantee is pinned in modelProbe.e2e.test.ts instead.
    it('names no routing module in its own import list', async () => {
      const source = await readFile(
        new URL('./modelProbeConfigService.ts', import.meta.url),
        'utf8',
      );
      // Strip comments: the assertion is about code, and the doc comments
      // legitimately name these modules to explain why they are absent.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      const forbidden = [
        'tokenRouter',
        'routeRefresh',
        'routeDecision',
        'routeCooldown',
        'route_channels',
        'token_routes',
      ];

      const importSpecifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      expect(importSpecifiers.length).toBeGreaterThan(0);
      for (const specifier of importSpecifiers) {
        for (const name of forbidden) {
          expect(specifier).not.toContain(name);
        }
      }

      for (const name of forbidden) {
        expect(code).not.toContain(name);
      }
    });

    it('saves and loads without consulting any routing state', async () => {
      const saved = await service.saveModelProbeConfig({ interestPatterns: ['gpt-5'] });
      expect(saved.interestPatterns).toEqual(['gpt-5']);
      expect(saved.syncToRouting).toBe(false);
      await expect(service.loadModelProbeConfig()).resolves.toEqual(saved);
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
