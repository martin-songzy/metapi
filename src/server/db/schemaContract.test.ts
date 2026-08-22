import { describe, expect, it } from 'vitest';
import { buildSchemaContractFromSqliteMigrations } from './schemaContract.js';

describe('schema contract generation', () => {
  it('captures the current schema shape from sqlite migrations', () => {
    const contract = buildSchemaContractFromSqliteMigrations();

    expect(contract.tables.sites.columns.status).toMatchObject({
      logicalType: 'text',
      notNull: true,
      primaryKey: false,
    });
    expect(contract.tables.account_tokens.columns.token_group).toBeDefined();
    expect(contract.tables.account_tokens.columns.value_status).toMatchObject({
      logicalType: 'text',
      notNull: true,
      defaultValue: "'ready'",
    });
    expect(contract.tables.site_disabled_models).toBeDefined();
    expect(contract.tables.downstream_api_keys).toBeDefined();
    expect(contract.tables.proxy_files).toBeDefined();
    expect(contract.tables.admin_snapshots.columns.snapshot_key).toMatchObject({
      logicalType: 'text',
      notNull: true,
      primaryKey: false,
    });
    expect(contract.tables.proxy_video_tasks).toBeDefined();
    expect(contract.tables.route_channels.columns.source_model).toBeDefined();
    expect(contract.tables.route_channels.columns.last_selected_at).toBeDefined();
    expect(contract.tables.route_channels.columns.consecutive_fail_count).toMatchObject({
      logicalType: 'integer',
      notNull: true,
      defaultValue: '0',
    });
    expect(contract.tables.sites.columns.use_system_proxy).toMatchObject({
      logicalType: 'boolean',
      defaultValue: 'false',
    });
    expect(contract.tables.token_routes.columns.routing_strategy).toMatchObject({
      logicalType: 'text',
      defaultValue: "'weighted'",
    });
    expect(contract.indexes).toContainEqual(
      expect.objectContaining({ name: 'sites_status_idx', table: 'sites', unique: false }),
    );
    expect(contract.uniques).toContainEqual(
      expect.objectContaining({
        name: 'site_disabled_models_site_model_unique',
        table: 'site_disabled_models',
        columns: ['site_id', 'model_name'],
      }),
    );
    expect(contract.uniques).toContainEqual(
      expect.objectContaining({
        name: 'model_availability_account_model_unique',
        table: 'model_availability',
        columns: ['account_id', 'model_name'],
      }),
    );
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'site_disabled_models',
        columns: ['site_id'],
        referencedTable: 'sites',
        referencedColumns: ['id'],
      }),
    );
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'route_channels',
        columns: ['token_id'],
        referencedTable: 'account_tokens',
        referencedColumns: ['id'],
      }),
    );
  });

  it('captures the active model probe result table from sqlite migrations', () => {
    const contract = buildSchemaContractFromSqliteMigrations();
    const table = contract.tables.model_probe_results;

    expect(table).toBeDefined();
    expect(table.columns.site_id).toMatchObject({ logicalType: 'integer', notNull: true });
    // Nullable on purpose: a probe can be inconclusive or skipped before any
    // account is chosen, and the account it did use can later be deleted.
    expect(table.columns.account_id).toMatchObject({ logicalType: 'integer', notNull: false });
    expect(table.columns.model_name).toMatchObject({ logicalType: 'text', notNull: true });
    expect(table.columns.status).toMatchObject({ logicalType: 'text', notNull: true });
    expect(table.columns.latency_ms).toMatchObject({ logicalType: 'integer', notNull: false });
    expect(table.columns.http_status).toMatchObject({ logicalType: 'integer', notNull: false });
    expect(table.columns.failure_kind).toMatchObject({ logicalType: 'text', notNull: false });
    expect(table.columns.reason).toMatchObject({ logicalType: 'text', notNull: false });
    expect(table.columns.endpoint_used).toMatchObject({ logicalType: 'text', notNull: false });
    expect(table.columns.prompt_used).toMatchObject({ logicalType: 'text', notNull: false });
    expect(table.columns.user_agent_used).toMatchObject({ logicalType: 'text', notNull: false });
    expect(table.columns.checked_at).toMatchObject({ logicalType: 'datetime' });

    // (site_id, model_name) rather than a token-scoped key: a nullable token_id
    // lets SQLite and Postgres keep unlimited NULL duplicates, so "latest result
    // only" would silently degrade into an append-only log.
    expect(contract.uniques).toContainEqual(
      expect.objectContaining({
        name: 'model_probe_results_site_model_unique',
        table: 'model_probe_results',
        columns: ['site_id', 'model_name'],
      }),
    );
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'model_probe_results',
        columns: ['site_id'],
        referencedTable: 'sites',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
    );
    // SET NULL, not CASCADE: losing the account must not erase the recorded
    // verdict for that site's model.
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'model_probe_results',
        columns: ['account_id'],
        referencedTable: 'accounts',
        referencedColumns: ['id'],
        onDelete: 'SET NULL',
      }),
    );
  });
});
