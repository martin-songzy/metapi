import currentContract from '../db/generated/schemaContract.json' with { type: 'json' };
import { describe, expect, it, vi } from 'vitest';
import {
  __databaseMigrationServiceTestUtils,
  maskConnectionString,
  normalizeMigrationInput,
} from './databaseMigrationService.js';

function cloneContract<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDbSchemaMock() {
  return {
    settings: { __table: 'settings' },
    sites: { __table: 'sites' },
    siteApiEndpoints: { __table: 'siteApiEndpoints' },
    siteAnnouncements: { __table: 'siteAnnouncements' },
    siteDisabledModels: { __table: 'siteDisabledModels' },
    accounts: { __table: 'accounts' },
    accountTokens: { __table: 'accountTokens' },
    checkinLogs: { __table: 'checkinLogs' },
    modelAvailability: { __table: 'modelAvailability' },
    tokenModelAvailability: { __table: 'tokenModelAvailability' },
    modelProbeResults: { __table: 'modelProbeResults' },
    tokenRoutes: { __table: 'tokenRoutes' },
    routeChannels: { __table: 'routeChannels' },
    routeGroupSources: { __table: 'routeGroupSources' },
    proxyLogs: { __table: 'proxyLogs' },
    proxyVideoTasks: { __table: 'proxyVideoTasks' },
    proxyFiles: { __table: 'proxyFiles' },
    downstreamApiKeys: { __table: 'downstreamApiKeys' },
    events: { __table: 'events' },
  };
}

function createDbMock(rowsByTable: Record<string, unknown[]>) {
  return {
    select() {
      return {
        from(table: { __table: string }) {
          return {
            all: async () => rowsByTable[table.__table] ?? [],
          };
        },
      };
    },
  };
}

describe('databaseMigrationService', () => {
  it('accepts postgres migration input with normalized url', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'postgres',
      connectionString: '  postgres://user:pass@db.example.com:5432/metapi  ',
      overwrite: true,
    });

    expect(normalized).toEqual({
      dialect: 'postgres',
      connectionString: 'postgres://user:pass@db.example.com:5432/metapi',
      overwrite: true,
      ssl: false,
    });
  });

  it('accepts mysql migration input', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://root:pass@db.example.com:3306/metapi',
    });

    expect(normalized.dialect).toBe('mysql');
    expect(normalized.overwrite).toBe(true);
    expect(normalized.ssl).toBe(false);
  });

  it('accepts sqlite file migration target path', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'sqlite',
      connectionString: './data/target.db',
      overwrite: false,
    });

    expect(normalized).toEqual({
      dialect: 'sqlite',
      connectionString: './data/target.db',
      overwrite: false,
      ssl: false,
    });
  });

  it('rejects unknown dialect', () => {
    expect(() => normalizeMigrationInput({
      dialect: 'oracle',
      connectionString: 'oracle://db',
    } as any)).toThrow(/鏂硅█|sqlite\/mysql\/postgres/i);
  });

  it('rejects postgres input when scheme mismatches', () => {
    expect(() => normalizeMigrationInput({
      dialect: 'postgres',
      connectionString: 'mysql://root:pass@127.0.0.1:3306/metapi',
    })).toThrow(/postgres/i);
  });

  it('masks connection string credentials', () => {
    const masked = maskConnectionString('postgres://admin:super-secret@db.example.com:5432/metapi');
    expect(masked).toBe('postgres://admin:***@db.example.com:5432/metapi');
  });

  it('normalizes ssl boolean from input', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://user:pass@tidb.example.com:4000/db',
      ssl: true,
    });
    expect(normalized.ssl).toBe(true);
  });

  it('defaults ssl to false when not provided', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'postgres',
      connectionString: 'postgres://user:pass@db.example.com:5432/metapi',
    });
    expect(normalized.ssl).toBe(false);
  });

  it('parses ssl from string values', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://user:pass@host:3306/db',
      ssl: '1',
    });
    expect(normalized.ssl).toBe(true);
  });

  it('parses ssl false from string "0"', () => {
    const normalized = normalizeMigrationInput({
      dialect: 'mysql',
      connectionString: 'mysql://user:pass@host:3306/db',
      ssl: '0',
    });
    expect(normalized.ssl).toBe(false);
  });

  it.each(['postgres', 'mysql', 'sqlite'] as const)('creates or patches sites schema with use_system_proxy and custom_headers for %s', async (dialect) => {
    const executedSql: string[] = [];
    const liveContract = cloneContract(currentContract);
    delete liveContract.tables.sites.columns.use_system_proxy;
    delete liveContract.tables.sites.columns.custom_headers;

    await __databaseMigrationServiceTestUtils.ensureSchema({
      dialect,
      connectionString: dialect === 'sqlite' ? ':memory:' : `${dialect}://example.invalid/metapi`,
      ssl: false,
      begin: async () => {},
      commit: async () => {},
      rollback: async () => {},
      execute: async (sqlText) => {
        executedSql.push(sqlText);
        return [];
      },
      queryScalar: async () => 1,
      close: async () => {},
    }, {
      currentContract,
      liveContract,
    });

    const useSystemProxySql = executedSql.find((sqlText) => sqlText.includes('use_system_proxy'));
    const customHeadersSql = executedSql.find((sqlText) => sqlText.includes('custom_headers'));

    expect(useSystemProxySql).toContain('use_system_proxy');
    expect(customHeadersSql).toContain('custom_headers');
  });

  it.each(['postgres', 'mysql'] as const)('patches token_routes decision snapshot columns for %s', async (dialect) => {
    const executedSql: string[] = [];
    const liveContract = cloneContract(currentContract);
    delete liveContract.tables.token_routes.columns.decision_snapshot;

    await __databaseMigrationServiceTestUtils.ensureSchema({
      dialect,
      connectionString: `${dialect}://example.invalid/metapi`,
      ssl: false,
      begin: async () => {},
      commit: async () => {},
      rollback: async () => {},
      execute: async (sqlText) => {
        executedSql.push(sqlText);
        return [];
      },
      queryScalar: async () => 1,
      close: async () => {},
    }, {
      currentContract,
      liveContract,
    });

    expect(
      executedSql.some((sqlText) => sqlText.includes('ADD COLUMN') && sqlText.includes('decision_snapshot')),
    ).toBe(true);
  });

  it('carries every site probe column through a migration', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 3,
          name: 'probe-site',
          url: 'https://probe.example.com',
          platform: 'new-api',
          status: 'active',
          postRefreshProbeEnabled: true,
          postRefreshProbeModel: 'claude-opus-4-6',
          postRefreshProbeScope: 'all',
          postRefreshProbeLatencyThresholdMs: 4500,
          probeEndpointType: 'messages',
          probeUserAgent: 'claude-cli/2.1.63 (external, cli)',
          createdAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T01:00:00.000Z',
        }],
        siteApiEndpoints: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        modelProbeResults: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: { settings: [] },
    } as any);

    const statement = statements.find((item) => item.table === 'sites');
    const valueOf = (column: string) => statement?.values[statement.columns.indexOf(column)];

    // Every one of these was absent from the column list, so migrating a database
    // silently reset all six to their defaults. Deleting any single line below
    // must fail this test.
    expect(valueOf('post_refresh_probe_enabled')).toBe(true);
    expect(valueOf('post_refresh_probe_model')).toBe('claude-opus-4-6');
    expect(valueOf('post_refresh_probe_scope')).toBe('all');
    expect(valueOf('post_refresh_probe_latency_threshold_ms')).toBe(4500);
    expect(valueOf('probe_endpoint_type')).toBe('messages');
    expect(valueOf('probe_user_agent')).toBe('claude-cli/2.1.63 (external, cli)');
  });

  it('keeps a not-null site probe column from migrating as null', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        // A row from a database that predates these columns carries no value at
        // all; probe_endpoint_type and probe_user_agent are NOT NULL, so a bare
        // passthrough would fail the insert on the target.
        sites: [{ id: 4, name: 'legacy', url: 'https://legacy.example.com', platform: 'new-api' }],
        siteApiEndpoints: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        modelProbeResults: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: { settings: [] },
    } as any);

    const statement = statements.find((item) => item.table === 'sites');
    const valueOf = (column: string) => statement?.values[statement.columns.indexOf(column)];

    expect(valueOf('probe_endpoint_type')).toBe('auto');
    expect(valueOf('probe_user_agent')).toBe('');
    expect(valueOf('post_refresh_probe_scope')).toBe('single');
    expect(valueOf('post_refresh_probe_latency_threshold_ms')).toBe(0);
  });

  it('caps an over-long probe user agent so the value survives every dialect', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        // SQLite stores unbounded TEXT, but the MySQL column is VARCHAR(512):
        // uncapped, this row either aborts the migration with ER_DATA_TOO_LONG or
        // is silently truncated depending on strict mode.
        sites: [{
          id: 5,
          name: 'long-agent',
          url: 'https://long-agent.example.com',
          platform: 'new-api',
          probeUserAgent: 'u'.repeat(900),
        }],
        siteApiEndpoints: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        modelProbeResults: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: { settings: [] },
    } as any);

    const statement = statements.find((item) => item.table === 'sites');
    const value = statement?.values[statement.columns.indexOf('probe_user_agent')];
    expect(typeof value === 'string' && value.length).toBe(512);
  });

  it('migrates every sites column the schema contract declares', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{ id: 1, name: 'x', url: 'https://x.example.com', platform: 'new-api' }],
        siteApiEndpoints: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        modelProbeResults: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: { settings: [] },
    } as any);

    const statement = statements.find((item) => item.table === 'sites');
    const contractColumns = Object.keys(currentContract.tables.sites.columns).sort();
    // This hand-maintained list has already drifted behind the schema once, and
    // the only symptom was users quietly losing configuration on a database
    // migration. Adding a sites column now fails here instead.
    expect([...(statement?.columns ?? [])].sort()).toEqual(contractColumns);
  });

  it('includes useSystemProxy and customHeaders when building site migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'openai',
          useSystemProxy: true,
          customHeaders: '{"x-site-scope":"internal"}',
          status: 'active',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [],
        routeChannels: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: {
        settings: [],
      },
    });

    const siteStatement = statements.find((statement) => statement.table === 'sites');
    const useSystemProxyIndex = siteStatement?.columns.indexOf('use_system_proxy') ?? -1;
    const customHeadersIndex = siteStatement?.columns.indexOf('custom_headers') ?? -1;

    expect(useSystemProxyIndex).toBeGreaterThanOrEqual(0);
    expect(siteStatement?.values[useSystemProxyIndex]).toBe(true);
    expect(customHeadersIndex).toBeGreaterThanOrEqual(0);
    expect(siteStatement?.values[customHeadersIndex]).toBe('{"x-site-scope":"internal"}');
  });

  it('includes site api endpoints when building migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
          status: 'active',
        }],
        siteApiEndpoints: [{
          id: 9,
          siteId: 1,
          url: 'https://api.example.com',
          enabled: true,
          sortOrder: 2,
          cooldownUntil: '2026-03-31T12:05:00.000Z',
          lastSelectedAt: '2026-03-31T12:00:00.000Z',
          lastFailedAt: '2026-03-31T11:59:00.000Z',
          lastFailureReason: 'HTTP 502',
          createdAt: '2026-03-30T00:00:00.000Z',
          updatedAt: '2026-03-31T12:05:00.000Z',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const endpointStatement = statements.find((statement) => statement.table === 'site_api_endpoints');
    expect(endpointStatement?.columns).toEqual([
      'id',
      'site_id',
      'url',
      'enabled',
      'sort_order',
      'cooldown_until',
      'last_selected_at',
      'last_failed_at',
      'last_failure_reason',
      'created_at',
      'updated_at',
    ]);
    expect(endpointStatement?.values).toEqual([
      9,
      1,
      'https://api.example.com',
      true,
      2,
      '2026-03-31T12:05:00.000Z',
      '2026-03-31T12:00:00.000Z',
      '2026-03-31T11:59:00.000Z',
      'HTTP 502',
      '2026-03-30T00:00:00.000Z',
      '2026-03-31T12:05:00.000Z',
    ]);
  });

  it('serializes parsed JSON-column values when building migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'openai',
          customHeaders: { 'x-site-scope': 'internal' },
          status: 'active',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [{
          id: 2,
          siteId: 1,
          username: 'user-1',
          accessToken: 'access-1',
          extraConfig: { platformUserId: 42 },
          status: 'active',
        }],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [{
          id: 3,
          modelPattern: '*',
          modelMapping: { '*': 'gpt-4o-mini' },
          decisionSnapshot: { channels: [1] },
          enabled: true,
        }],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [{
          id: 4,
          billingDetails: { total: 1.25 },
        }],
        proxyVideoTasks: [{
          id: 5,
          publicId: 'video-public-id',
          upstreamVideoId: 'upstream-video-id',
          siteUrl: 'https://example.com',
          tokenValue: 'sk-video',
          statusSnapshot: { status: 'done' },
          upstreamResponseMeta: { id: 'video' },
        }],
        proxyFiles: [],
        downstreamApiKeys: [{
          id: 6,
          name: 'managed-key',
          key: 'mk-demo',
          supportedModels: ['gpt-4o-mini'],
          allowedRouteIds: [3],
          siteWeightMultipliers: { 1: 1.5 },
          excludedSiteIds: [1],
          excludedCredentialRefs: [{ kind: 'default_api_key', siteId: 1, accountId: 2 }],
          enabled: true,
        }],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const siteStatement = statements.find((statement) => statement.table === 'sites');
    const accountStatement = statements.find((statement) => statement.table === 'accounts');
    const tokenRouteStatement = statements.find((statement) => statement.table === 'token_routes');
    const proxyLogStatement = statements.find((statement) => statement.table === 'proxy_logs');
    const proxyVideoStatement = statements.find((statement) => statement.table === 'proxy_video_tasks');
    const downstreamKeyStatement = statements.find((statement) => statement.table === 'downstream_api_keys');

    expect(siteStatement?.values[siteStatement.columns.indexOf('custom_headers')]).toBe('{"x-site-scope":"internal"}');
    expect(accountStatement?.values[accountStatement.columns.indexOf('extra_config')]).toBe('{"platformUserId":42}');
    expect(tokenRouteStatement?.values[tokenRouteStatement.columns.indexOf('model_mapping')]).toBe('{"*":"gpt-4o-mini"}');
    expect(tokenRouteStatement?.values[tokenRouteStatement.columns.indexOf('decision_snapshot')]).toBe('{"channels":[1]}');
    expect(proxyLogStatement?.values[proxyLogStatement.columns.indexOf('billing_details')]).toBe('{"total":1.25}');
    expect(proxyVideoStatement?.values[proxyVideoStatement.columns.indexOf('status_snapshot')]).toBe('{"status":"done"}');
    expect(proxyVideoStatement?.values[proxyVideoStatement.columns.indexOf('upstream_response_meta')]).toBe('{"id":"video"}');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('supported_models')]).toBe('["gpt-4o-mini"]');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('allowed_route_ids')]).toBe('[3]');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('site_weight_multipliers')]).toBe('{"1":1.5}');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('excluded_site_ids')]).toBe('[1]');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('excluded_credential_refs')]).toBe('[{"kind":"default_api_key","siteId":1,"accountId":2}]');
  });

  it('uses schema logical types to serialize JSON columns instead of String(value)', () => {
    expect(__databaseMigrationServiceTestUtils.serializeColumnValue('sites', 'custom_headers', {
      'x-site-scope': 'internal',
    })).toBe('{"x-site-scope":"internal"}');
    expect(__databaseMigrationServiceTestUtils.serializeColumnValue('downstream_api_keys', 'supported_models', [
      'gpt-4o-mini',
    ])).toBe('["gpt-4o-mini"]');
    expect(__databaseMigrationServiceTestUtils.serializeColumnValue('sites', 'name', {
      demo: true,
    })).toBe('[object Object]');
  });

  it('serializes object-backed JSON columns when building migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'openai',
          customHeaders: { 'x-site-scope': 'internal' },
          status: 'active',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [{
          id: 2,
          siteId: 1,
          accessToken: 'access',
          extraConfig: { platformUserId: 1234 },
          status: 'active',
        }],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [{
          id: 3,
          modelPattern: 'gpt-*',
          modelMapping: { 'gpt-*': 'gpt-5-mini' },
          decisionSnapshot: { candidates: [1, 2] },
          enabled: true,
        }],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [{
          id: 4,
          billingDetails: { currency: 'usd', total: 1.23 },
        }],
        proxyVideoTasks: [{
          id: 5,
          publicId: 'video-public-id',
          upstreamVideoId: 'upstream-video-id',
          siteUrl: 'https://example.com',
          tokenValue: 'sk-video',
          statusSnapshot: { status: 'done' },
          upstreamResponseMeta: { id: 'video' },
        }],
        proxyFiles: [],
        downstreamApiKeys: [{
          id: 6,
          name: 'managed',
          key: 'sk-managed',
          enabled: true,
          supportedModels: ['gpt-5', 'gpt-5-mini'],
          allowedRouteIds: [10, 11],
          siteWeightMultipliers: { 1: 2, 2: 0.5 },
        }],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const sitesStatement = statements.find((statement) => statement.table === 'sites');
    expect(sitesStatement?.values[sitesStatement.columns.indexOf('custom_headers')]).toBe('{"x-site-scope":"internal"}');

    const accountsStatement = statements.find((statement) => statement.table === 'accounts');
    expect(accountsStatement?.values[accountsStatement.columns.indexOf('extra_config')]).toBe('{"platformUserId":1234}');

    const tokenRoutesStatement = statements.find((statement) => statement.table === 'token_routes');
    expect(tokenRoutesStatement?.values[tokenRoutesStatement.columns.indexOf('model_mapping')]).toBe('{"gpt-*":"gpt-5-mini"}');
    expect(tokenRoutesStatement?.values[tokenRoutesStatement.columns.indexOf('decision_snapshot')]).toBe('{"candidates":[1,2]}');

    const proxyLogsStatement = statements.find((statement) => statement.table === 'proxy_logs');
    expect(proxyLogsStatement?.values[proxyLogsStatement.columns.indexOf('billing_details')]).toBe('{"currency":"usd","total":1.23}');

    const proxyVideoTasksStatement = statements.find((statement) => statement.table === 'proxy_video_tasks');
    expect(proxyVideoTasksStatement?.values[proxyVideoTasksStatement.columns.indexOf('status_snapshot')]).toBe('{"status":"done"}');
    expect(proxyVideoTasksStatement?.values[proxyVideoTasksStatement.columns.indexOf('upstream_response_meta')]).toBe('{"id":"video"}');

    const downstreamApiKeysStatement = statements.find((statement) => statement.table === 'downstream_api_keys');
    expect(downstreamApiKeysStatement?.values[downstreamApiKeysStatement.columns.indexOf('supported_models')]).toBe('["gpt-5","gpt-5-mini"]');
    expect(downstreamApiKeysStatement?.values[downstreamApiKeysStatement.columns.indexOf('allowed_route_ids')]).toBe('[10,11]');
    expect(downstreamApiKeysStatement?.values[downstreamApiKeysStatement.columns.indexOf('site_weight_multipliers')]).toBe('{"1":2,"2":0.5}');
  });

  it('serializes JSON logical-type columns from object and array values', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'openai',
          customHeaders: { 'x-site-scope': 'internal' },
          status: 'active',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [{
          id: 2,
          siteId: 1,
          username: 'user-1',
          accessToken: 'token-1',
          extraConfig: { platformUserId: 1001, credentialMode: 'session' },
          status: 'active',
        }],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [{
          id: 3,
          modelPattern: 'gpt-*',
          modelMapping: { 'gpt-*': 'gpt-4.1' },
          decisionSnapshot: { matched: true, channels: [1] },
          enabled: true,
        }],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [{
          id: 4,
          billingDetails: { source: 'pricing', total: 1.25 },
        }],
        proxyVideoTasks: [{
          id: 5,
          publicId: 'video-1',
          upstreamVideoId: 'upstream-1',
          siteUrl: 'https://example.com',
          tokenValue: 'sk-video',
          requestedModel: 'veo-3',
          actualModel: 'veo-3',
          channelId: 9,
          accountId: 2,
          statusSnapshot: { status: 'done' },
          upstreamResponseMeta: { id: 'video' },
        }],
        proxyFiles: [],
        downstreamApiKeys: [{
          id: 6,
          name: 'managed',
          key: 'sk-managed',
          supportedModels: ['gpt-4.1', 'gpt-4o'],
          allowedRouteIds: [3, 8],
          siteWeightMultipliers: { 1: 2 },
          enabled: true,
        }],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const siteStatement = statements.find((statement) => statement.table === 'sites');
    const accountStatement = statements.find((statement) => statement.table === 'accounts');
    const routeStatement = statements.find((statement) => statement.table === 'token_routes');
    const proxyLogStatement = statements.find((statement) => statement.table === 'proxy_logs');
    const videoStatement = statements.find((statement) => statement.table === 'proxy_video_tasks');
    const downstreamKeyStatement = statements.find((statement) => statement.table === 'downstream_api_keys');

    expect(siteStatement?.values[siteStatement.columns.indexOf('custom_headers')]).toBe('{"x-site-scope":"internal"}');
    expect(accountStatement?.values[accountStatement.columns.indexOf('extra_config')]).toBe('{"platformUserId":1001,"credentialMode":"session"}');
    expect(routeStatement?.values[routeStatement.columns.indexOf('model_mapping')]).toBe('{"gpt-*":"gpt-4.1"}');
    expect(routeStatement?.values[routeStatement.columns.indexOf('decision_snapshot')]).toBe('{"matched":true,"channels":[1]}');
    expect(proxyLogStatement?.values[proxyLogStatement.columns.indexOf('billing_details')]).toBe('{"source":"pricing","total":1.25}');
    expect(videoStatement?.values[videoStatement.columns.indexOf('status_snapshot')]).toBe('{"status":"done"}');
    expect(videoStatement?.values[videoStatement.columns.indexOf('upstream_response_meta')]).toBe('{"id":"video"}');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('supported_models')]).toBe('["gpt-4.1","gpt-4o"]');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('allowed_route_ids')]).toBe('[3,8]');
    expect(downstreamKeyStatement?.values[downstreamKeyStatement.columns.indexOf('site_weight_multipliers')]).toBe('{"1":2}');
  });

  it('serializes JSON logical-type columns from parsed objects and arrays', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'openai',
          customHeaders: { 'x-site-scope': 'internal' },
          status: 'active',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [{
          id: 2,
          siteId: 1,
          username: 'demo-user',
          accessToken: 'token',
          extraConfig: { platformUserId: 42 },
          status: 'active',
        }],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [{
          id: 3,
          modelPattern: 'gpt-*',
          modelMapping: { 'gpt-4.1': 'gpt-4o-mini' },
          decisionSnapshot: { matched: true, routeId: 3 },
          enabled: true,
        }],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [{
          id: 4,
          billingDetails: { total: 1.25, currency: 'USD' },
        }],
        proxyVideoTasks: [{
          id: 5,
          publicId: 'vid_1',
          upstreamVideoId: 'upstream_1',
          siteUrl: 'https://example.com',
          tokenValue: 'sk-video',
          statusSnapshot: { status: 'done' },
          upstreamResponseMeta: { id: 'video-1' },
        }],
        proxyFiles: [],
        downstreamApiKeys: [{
          id: 6,
          name: 'managed-key',
          key: 'sk-managed',
          supportedModels: ['gpt-4.1', 'gpt-4o-mini'],
          allowedRouteIds: [3],
          siteWeightMultipliers: { 1: 1.5 },
        }],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const sitesStatement = statements.find((statement) => statement.table === 'sites');
    const accountsStatement = statements.find((statement) => statement.table === 'accounts');
    const tokenRoutesStatement = statements.find((statement) => statement.table === 'token_routes');
    const proxyLogsStatement = statements.find((statement) => statement.table === 'proxy_logs');
    const proxyVideoStatement = statements.find((statement) => statement.table === 'proxy_video_tasks');
    const downstreamStatement = statements.find((statement) => statement.table === 'downstream_api_keys');

    expect(sitesStatement?.values[sitesStatement.columns.indexOf('custom_headers')]).toBe('{"x-site-scope":"internal"}');
    expect(accountsStatement?.values[accountsStatement.columns.indexOf('extra_config')]).toBe('{"platformUserId":42}');
    expect(tokenRoutesStatement?.values[tokenRoutesStatement.columns.indexOf('model_mapping')]).toBe('{"gpt-4.1":"gpt-4o-mini"}');
    expect(tokenRoutesStatement?.values[tokenRoutesStatement.columns.indexOf('decision_snapshot')]).toBe('{"matched":true,"routeId":3}');
    expect(proxyLogsStatement?.values[proxyLogsStatement.columns.indexOf('billing_details')]).toBe('{"total":1.25,"currency":"USD"}');
    expect(proxyVideoStatement?.values[proxyVideoStatement.columns.indexOf('status_snapshot')]).toBe('{"status":"done"}');
    expect(proxyVideoStatement?.values[proxyVideoStatement.columns.indexOf('upstream_response_meta')]).toBe('{"id":"video-1"}');
    expect(downstreamStatement?.values[downstreamStatement.columns.indexOf('supported_models')]).toBe('["gpt-4.1","gpt-4o-mini"]');
    expect(downstreamStatement?.values[downstreamStatement.columns.indexOf('allowed_route_ids')]).toBe('[3]');
    expect(downstreamStatement?.values[downstreamStatement.columns.indexOf('site_weight_multipliers')]).toBe('{"1":1.5}');
  });

  it('serializes JSON logical-type columns without coercing objects to [object Object]', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [{
          id: 1,
          name: 'demo',
          url: 'https://example.com',
          platform: 'openai',
          customHeaders: { 'x-site-scope': 'internal' },
          status: 'active',
        }],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [{
          id: 2,
          siteId: 1,
          username: 'user',
          accessToken: 'access',
          apiToken: 'api',
          extraConfig: { platformUserId: 42, credentialMode: 'session' },
          status: 'active',
        }],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [{
          id: 3,
          modelPattern: '*',
          modelMapping: { 'gpt-4.1': 'gpt-4o-mini' },
          decisionSnapshot: { matched: true, routeId: 3 },
          enabled: true,
        }],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [{
          id: 4,
          billingDetails: { source: 'pricing', usd: 1.25 },
        }],
        proxyVideoTasks: [{
          id: 5,
          publicId: 'vid_1',
          upstreamVideoId: 'upstream_1',
          siteUrl: 'https://example.com',
          tokenValue: 'sk-video',
          requestedModel: 'veo-3',
          actualModel: 'veo-3',
          statusSnapshot: { status: 'done' },
          upstreamResponseMeta: { id: 'video' },
        }],
        proxyFiles: [],
        downstreamApiKeys: [{
          id: 6,
          name: 'managed',
          key: 'key-1',
          supportedModels: ['gpt-4.1'],
          allowedRouteIds: [3],
          siteWeightMultipliers: { 1: 2 },
          enabled: true,
        }],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const sitesStatement = statements.find((statement) => statement.table === 'sites');
    const accountsStatement = statements.find((statement) => statement.table === 'accounts');
    const tokenRoutesStatement = statements.find((statement) => statement.table === 'token_routes');
    const proxyLogsStatement = statements.find((statement) => statement.table === 'proxy_logs');
    const proxyVideoTasksStatement = statements.find((statement) => statement.table === 'proxy_video_tasks');
    const downstreamKeysStatement = statements.find((statement) => statement.table === 'downstream_api_keys');

    expect(sitesStatement?.values[sitesStatement.columns.indexOf('custom_headers')]).toBe('{"x-site-scope":"internal"}');
    expect(accountsStatement?.values[accountsStatement.columns.indexOf('extra_config')]).toBe('{"platformUserId":42,"credentialMode":"session"}');
    expect(tokenRoutesStatement?.values[tokenRoutesStatement.columns.indexOf('model_mapping')]).toBe('{"gpt-4.1":"gpt-4o-mini"}');
    expect(tokenRoutesStatement?.values[tokenRoutesStatement.columns.indexOf('decision_snapshot')]).toBe('{"matched":true,"routeId":3}');
    expect(proxyLogsStatement?.values[proxyLogsStatement.columns.indexOf('billing_details')]).toBe('{"source":"pricing","usd":1.25}');
    expect(proxyVideoTasksStatement?.values[proxyVideoTasksStatement.columns.indexOf('status_snapshot')]).toBe('{"status":"done"}');
    expect(proxyVideoTasksStatement?.values[proxyVideoTasksStatement.columns.indexOf('upstream_response_meta')]).toBe('{"id":"video"}');
    expect(downstreamKeysStatement?.values[downstreamKeysStatement.columns.indexOf('supported_models')]).toBe('["gpt-4.1"]');
    expect(downstreamKeysStatement?.values[downstreamKeysStatement.columns.indexOf('allowed_route_ids')]).toBe('[3]');
    expect(downstreamKeysStatement?.values[downstreamKeysStatement.columns.indexOf('site_weight_multipliers')]).toBe('{"1":2}');
  });

  it('includes disabled models, proxy video tasks, and proxy files in migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [],
        siteAnnouncements: [],
        siteDisabledModels: [{
          id: 3,
          siteId: 12,
          modelName: 'claude-opus-4-6',
          createdAt: '2026-03-14T00:00:00.000Z',
        }],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [{
          id: 10,
          modelPattern: 'claude-opus-4-6',
          displayName: 'claude-opus-4-6',
          displayIcon: 'icon-claude',
          modelMapping: null,
          routeMode: 'explicit_group',
          decisionSnapshot: '{"channels":[1]}',
          decisionRefreshedAt: '2026-03-14T01:30:00.000Z',
          routingStrategy: 'round_robin',
          enabled: true,
          createdAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T01:00:00.000Z',
        }],
        routeChannels: [],
        proxyLogs: [],
        proxyVideoTasks: [{
          id: 5,
          publicId: 'video-public-id',
          upstreamVideoId: 'upstream-video-id',
          siteUrl: 'https://example.com',
          tokenValue: 'sk-video',
          requestedModel: 'veo-3',
          actualModel: 'veo-3',
          channelId: 7,
          accountId: 9,
          statusSnapshot: '{"status":"done"}',
          upstreamResponseMeta: '{"id":"video"}',
          lastUpstreamStatus: 200,
          lastPolledAt: '2026-03-14T01:00:00.000Z',
          createdAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T01:00:00.000Z',
        }],
        proxyFiles: [{
          id: 8,
          publicId: 'file-public-id',
          ownerType: 'downstream_key',
          ownerId: 'key-1',
          filename: 'demo.txt',
          mimeType: 'text/plain',
          purpose: 'assistants',
          byteSize: 4,
          sha256: 'abcd',
          contentBase64: 'ZGVtbw==',
          createdAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T01:00:00.000Z',
          deletedAt: null,
        }],
        routeGroupSources: [{
          id: 9,
          groupRouteId: 12,
          sourceRouteId: 13,
        }],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    expect(statements.some((statement) => statement.table === 'site_disabled_models')).toBe(true);
    expect(statements.some((statement) => statement.table === 'proxy_video_tasks')).toBe(true);
    expect(statements.some((statement) => statement.table === 'proxy_files')).toBe(true);
    expect(statements.some((statement) => statement.table === 'route_group_sources')).toBe(true);
    const tokenRouteStatement = statements.find((statement) => statement.table === 'token_routes');
    const routeModeIndex = tokenRouteStatement?.columns.indexOf('route_mode') ?? -1;
    expect(routeModeIndex).toBeGreaterThanOrEqual(0);
    expect(tokenRouteStatement?.values[routeModeIndex]).toBe('explicit_group');
  });

  it('includes site announcements in migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
        siteAnnouncements: [{
          id: 11,
          siteId: 3,
          platform: 'openai',
          sourceKey: 'notice-1',
          title: '????',
          content: '????',
          level: 'warning',
          sourceUrl: 'https://example.com/notice',
          startsAt: '2026-03-20T00:00:00.000Z',
          endsAt: '2026-03-21T00:00:00.000Z',
          upstreamCreatedAt: '2026-03-19T00:00:00.000Z',
          upstreamUpdatedAt: '2026-03-20T00:00:00.000Z',
          firstSeenAt: '2026-03-20T00:00:00.000Z',
          lastSeenAt: '2026-03-20T01:00:00.000Z',
          readAt: null,
          dismissedAt: null,
          rawPayload: '{"id":"notice-1"}',
        }],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const statement = statements.find((item) => item.table === 'site_announcements');
    expect(statement).toBeDefined();
    expect(statement?.columns).toContain('source_key');
    expect(statement?.values[statement?.columns.indexOf('title') ?? -1]).toBe('????');
  });

  it('includes site announcements in migration summary', async () => {
    vi.resetModules();

    const rowsByTable = {
      settings: [],
      sites: [],
      siteAnnouncements: [{
        id: 11,
        siteId: 3,
        platform: 'openai',
        sourceKey: 'notice-1',
        title: '????',
        content: '????',
        level: 'warning',
        sourceUrl: 'https://example.com/notice',
        startsAt: '2026-03-20T00:00:00.000Z',
        endsAt: '2026-03-21T00:00:00.000Z',
        upstreamCreatedAt: '2026-03-19T00:00:00.000Z',
        upstreamUpdatedAt: '2026-03-20T00:00:00.000Z',
        firstSeenAt: '2026-03-20T00:00:00.000Z',
        lastSeenAt: '2026-03-20T01:00:00.000Z',
        readAt: null,
        dismissedAt: null,
        rawPayload: '{"id":"notice-1"}',
      }],
      siteDisabledModels: [],
      accounts: [],
      accountTokens: [],
      checkinLogs: [],
      modelAvailability: [],
      tokenModelAvailability: [],
      tokenRoutes: [],
      routeChannels: [],
      routeGroupSources: [],
      proxyLogs: [],
      proxyVideoTasks: [],
      proxyFiles: [],
      downstreamApiKeys: [],
      events: [],
    };

    const client = {
      dialect: 'sqlite',
      connectionString: ':memory:',
      ssl: false,
      begin: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      execute: vi.fn(async () => []),
      queryScalar: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    };

    vi.doMock('../db/index.js', () => ({
      db: createDbMock(rowsByTable),
      schema: createDbSchemaMock(),
    }));
    vi.doMock('../db/runtimeSchemaBootstrap.js', () => ({
      createRuntimeSchemaClient: async () => client,
      ensureRuntimeDatabaseSchema: async () => {},
    }));

    try {
      const { migrateCurrentDatabase } = await import('./databaseMigrationService.js');
      const summary = await migrateCurrentDatabase({
        dialect: 'sqlite',
        connectionString: ':memory:',
        overwrite: true,
      });

      expect(summary.rows.siteAnnouncements).toBe(1);
      expect(client.begin).toHaveBeenCalledTimes(1);
      expect(client.commit).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../db/index.js');
      vi.doUnmock('../db/runtimeSchemaBootstrap.js');
      vi.resetModules();
    }
  });

  it('excludes runtime database config settings from migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: {
        settings: [
          { key: 'db_type', value: 'sqlite' },
          { key: 'db_url', value: '/app/data/hub.db' },
          { key: 'db_ssl', value: false },
          { key: 'routing_fallback_unit_cost', value: 0.25 },
        ],
      },
    } as any);

    const migratedSettingKeys = statements
      .filter((statement) => statement.table === 'settings')
      .map((statement) => statement.values[0]);

    expect(migratedSettingKeys).toContain('routing_fallback_unit_cost');
    expect(migratedSettingKeys).not.toContain('db_type');
    expect(migratedSettingKeys).not.toContain('db_url');
    expect(migratedSettingKeys).not.toContain('db_ssl');
  });

  it('includes active model probe results in migration statements', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        modelProbeResults: [{
          id: 4,
          siteId: 12,
          accountId: 21,
          modelName: 'claude-opus-4-6',
          status: 'supported',
          latencyMs: 812,
          httpStatus: 200,
          failureKind: null,
          reason: null,
          endpointUsed: '/v1/messages',
          promptUsed: 'ping',
          userAgentUsed: 'claude-cli/2.1.63 (external, cli)',
          checkedAt: '2026-03-14T02:00:00.000Z',
        }],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const statement = statements.find((item) => item.table === 'model_probe_results');
    expect(statement).toBeDefined();
    expect(statement?.columns).toEqual([
      'id',
      'site_id',
      'account_id',
      'model_name',
      'status',
      'latency_ms',
      'http_status',
      'failure_kind',
      'reason',
      'endpoint_used',
      'prompt_used',
      'user_agent_used',
      'checked_at',
    ]);
    const valueOf = (column: string) => statement?.values[statement.columns.indexOf(column)];
    expect(valueOf('site_id')).toBe(12);
    expect(valueOf('account_id')).toBe(21);
    expect(valueOf('model_name')).toBe('claude-opus-4-6');
    expect(valueOf('status')).toBe('supported');
    expect(valueOf('latency_ms')).toBe(812);
    expect(valueOf('http_status')).toBe(200);
    expect(valueOf('endpoint_used')).toBe('/v1/messages');
    expect(valueOf('user_agent_used')).toBe('claude-cli/2.1.63 (external, cli)');
    expect(valueOf('checked_at')).toBe('2026-03-14T02:00:00.000Z');
  });

  it('keeps a null account id null instead of coercing it to zero', () => {
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: {
        sites: [],
        siteAnnouncements: [],
        siteDisabledModels: [],
        accounts: [],
        accountTokens: [],
        checkinLogs: [],
        modelAvailability: [],
        tokenModelAvailability: [],
        modelProbeResults: [{
          id: 5,
          siteId: 12,
          accountId: null,
          modelName: 'gpt-5-codex',
          status: 'inconclusive',
          latencyMs: null,
          httpStatus: null,
          failureKind: 'timeout',
          reason: 'first byte timeout',
          endpointUsed: null,
          promptUsed: null,
          userAgentUsed: null,
          checkedAt: '2026-03-14T02:00:00.000Z',
        }],
        tokenRoutes: [],
        routeChannels: [],
        routeGroupSources: [],
        proxyLogs: [],
        proxyVideoTasks: [],
        proxyFiles: [],
        downstreamApiKeys: [],
        events: [],
      },
      preferences: {
        settings: [],
      },
    } as any);

    const statement = statements.find((item) => item.table === 'model_probe_results');
    const valueOf = (column: string) => statement?.values[statement.columns.indexOf(column)];
    // account_id 0 would violate the accounts foreign key on every dialect.
    expect(valueOf('account_id')).toBeNull();
    expect(valueOf('latency_ms')).toBeNull();
    expect(valueOf('http_status')).toBeNull();
    expect(valueOf('failure_kind')).toBe('timeout');
  });

  // Every column omitted here is a column that silently reverts to its default
  // when a user migrates their database. These five tables were already drifted
  // before the probe work started; they are recorded rather than fixed so that
  // *new* drift fails this test instead of hiding among them. Fixing one means
  // deleting its entry, and this test will say so.
  const KNOWN_COLUMN_DRIFT: Record<string, string[]> = {
    accounts: ['oauth_provider', 'oauth_account_key', 'oauth_project_id'],
    downstream_api_keys: ['group_name', 'tags'],
    model_availability: ['is_manual'],
    proxy_logs: [
      'client_family',
      'client_app_id',
      'client_app_name',
      'client_confidence',
      'is_stream',
      'first_byte_latency_ms',
    ],
    route_channels: ['oauth_route_unit_id'],
  };

  // The column guard above cannot see a table that is missing outright, and that
  // is exactly the blind spot that let nine tables go uncopied unnoticed. Every
  // contract table must appear in one of these two lists.
  const MIGRATED_TABLES = [
    'sites', 'site_api_endpoints', 'site_announcements', 'site_disabled_models', 'accounts',
    'account_tokens', 'checkin_logs', 'model_availability', 'token_model_availability',
    'model_probe_results', 'token_routes', 'route_channels', 'route_group_sources', 'proxy_logs',
    'proxy_video_tasks', 'proxy_files', 'downstream_api_keys', 'events', 'settings',
  ];

  // Reviewed, not merely observed. The first two are configuration and are really
  // lost: clearTargetData deletes sites and accounts, both cascade away, and
  // nothing re-inserts them. The three usage aggregates also cascade off sites but
  // are derived from proxy_logs, which is migrated, so they can be rebuilt. The
  // last four have no FK into migrated rows, so they simply stay on the target.
  const REVIEWED_UNMIGRATED_TABLES: Record<string, string> = {
    oauth_route_units: 'configuration; cascade-deleted with sites and never re-inserted',
    oauth_route_unit_members: 'configuration; cascade-deleted with accounts and never re-inserted',
    model_day_usage: 'derived aggregate; rebuildable from migrated proxy_logs',
    site_day_usage: 'derived aggregate; rebuildable from migrated proxy_logs',
    site_hour_usage: 'derived aggregate; rebuildable from migrated proxy_logs',
    analytics_projection_checkpoints: 'projection bookkeeping; regenerated by the projection worker',
    admin_snapshots: 'cache with an expiry; regenerated on demand',
    proxy_debug_traces: 'opt-in debug capture, not user data',
    proxy_debug_attempts: 'opt-in debug capture, not user data',
  };

  it('does not add new column drift between the contract and the migration inserts', () => {
    const tableKeys = [
      'sites', 'siteApiEndpoints', 'siteAnnouncements', 'siteDisabledModels', 'accounts',
      'accountTokens', 'checkinLogs', 'modelAvailability', 'tokenModelAvailability',
      'modelProbeResults', 'tokenRoutes', 'routeChannels', 'routeGroupSources', 'proxyLogs',
      'proxyVideoTasks', 'proxyFiles', 'downstreamApiKeys', 'events',
    ];
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      // One placeholder row per table is enough: only the column list is read.
      accounts: Object.fromEntries(tableKeys.map((key) => [key, [{ id: 1 }]])),
      preferences: { settings: [{ key: 'k', value: 'v' }] },
    } as any);

    const unexpected: string[] = [];
    const fixedButStillListed: string[] = [];

    for (const statement of statements) {
      const contractColumns = Object.keys(
        (currentContract.tables as Record<string, { columns: Record<string, unknown> }>)[statement.table]?.columns ?? {},
      );
      if (contractColumns.length === 0) continue;
      const allowed = new Set(KNOWN_COLUMN_DRIFT[statement.table] ?? []);
      const missing = contractColumns.filter((column) => !statement.columns.includes(column));

      for (const column of missing) {
        if (!allowed.has(column)) unexpected.push(`${statement.table}.${column}`);
      }
      for (const column of allowed) {
        if (!missing.includes(column)) fixedButStillListed.push(`${statement.table}.${column}`);
      }
    }

    expect(unexpected, 'new column drift: add these to the migration insert').toEqual([]);
    expect(fixedButStillListed, 'now migrated: delete these from KNOWN_COLUMN_DRIFT').toEqual([]);
  });

  it('accounts for every contract table as either migrated or reviewed', () => {
    const tableKeys = [
      'sites', 'siteApiEndpoints', 'siteAnnouncements', 'siteDisabledModels', 'accounts',
      'accountTokens', 'checkinLogs', 'modelAvailability', 'tokenModelAvailability',
      'modelProbeResults', 'tokenRoutes', 'routeChannels', 'routeGroupSources', 'proxyLogs',
      'proxyVideoTasks', 'proxyFiles', 'downstreamApiKeys', 'events',
    ];
    const statements = __databaseMigrationServiceTestUtils.buildStatements({
      version: 'test',
      timestamp: Date.now(),
      accounts: Object.fromEntries(tableKeys.map((key) => [key, [{ id: 1 }]])),
      preferences: { settings: [{ key: 'k', value: 'v' }] },
    } as any);

    const emitted = [...new Set(statements.map((statement) => statement.table))].sort();
    expect(emitted, 'a table stopped being migrated, or a new insert needs listing')
      .toEqual([...MIGRATED_TABLES].sort());

    const accountedFor = new Set([...MIGRATED_TABLES, ...Object.keys(REVIEWED_UNMIGRATED_TABLES)]);
    const unaccounted = Object.keys(currentContract.tables).filter((table) => !accountedFor.has(table)).sort();
    // A new table added to the schema lands here until someone decides whether a
    // migration must carry it. Silence is what made the current gap invisible.
    expect(unaccounted, 'new table: migrate it, or add it to REVIEWED_UNMIGRATED_TABLES with a reason')
      .toEqual([]);
  });

  it('clears probe results and resets their postgres sequence when migrating', async () => {
    vi.resetModules();

    const rowsByTable = {
      settings: [],
      sites: [],
      siteApiEndpoints: [],
      siteAnnouncements: [],
      siteDisabledModels: [],
      accounts: [],
      accountTokens: [],
      checkinLogs: [],
      modelAvailability: [],
      tokenModelAvailability: [],
      modelProbeResults: [{
        id: 7,
        siteId: 3,
        accountId: null,
        modelName: 'gpt-5-codex',
        status: 'skipped',
        latencyMs: null,
        httpStatus: null,
        failureKind: null,
        reason: 'site disabled',
        endpointUsed: null,
        promptUsed: null,
        userAgentUsed: null,
        checkedAt: '2026-03-14T02:00:00.000Z',
      }],
      tokenRoutes: [],
      routeChannels: [],
      routeGroupSources: [],
      proxyLogs: [],
      proxyVideoTasks: [],
      proxyFiles: [],
      downstreamApiKeys: [],
      events: [],
    };

    const executedSql: string[] = [];
    const client = {
      dialect: 'postgres',
      connectionString: 'postgres://example.invalid/metapi',
      ssl: false,
      begin: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      execute: vi.fn(async (sqlText: string) => {
        executedSql.push(sqlText);
        return [];
      }),
      queryScalar: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    };

    vi.doMock('../db/index.js', () => ({
      db: createDbMock(rowsByTable),
      schema: createDbSchemaMock(),
    }));
    vi.doMock('../db/runtimeSchemaBootstrap.js', () => ({
      createRuntimeSchemaClient: async () => client,
      ensureRuntimeDatabaseSchema: async () => {},
    }));

    try {
      const { migrateCurrentDatabase } = await import('./databaseMigrationService.js');
      const summary = await migrateCurrentDatabase({
        dialect: 'postgres',
        connectionString: 'postgres://example.invalid/metapi',
        overwrite: true,
      });

      expect(summary.rows.modelProbeResults).toBe(1);
      // Left out of the wipe, an overwrite migration hits the unique key on
      // (site_id, model_name) the moment the same site is re-inserted.
      expect(executedSql.some((sqlText) => /DELETE FROM "model_probe_results"/.test(sqlText))).toBe(true);
      // Left out of the sequence reset, the first probe written after the
      // migration reuses id 1 and collides with a copied row.
      expect(executedSql.some((sqlText) => sqlText.includes("pg_get_serial_sequence('model_probe_results', 'id')"))).toBe(true);
      expect(executedSql.some((sqlText) => sqlText.includes('INSERT INTO "model_probe_results"'))).toBe(true);
    } finally {
      vi.doUnmock('../db/index.js');
      vi.doUnmock('../db/runtimeSchemaBootstrap.js');
      vi.resetModules();
    }
  });
});
