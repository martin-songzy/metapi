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
    expect(contract.tables.sites.columns.is_pinned).toMatchObject({
      logicalType: 'boolean',
      defaultValue: 'false',
    });
    // The single place a proxy address is selected. Nullable on purpose: NULL is
    // "do not proxy", so it must not acquire a default.
    expect(contract.tables.sites.columns.proxy_ref).toMatchObject({
      logicalType: 'text',
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

  it('captures the per-key model probe result table from sqlite migrations', () => {
    const contract = buildSchemaContractFromSqliteMigrations();
    const table = contract.tables.model_probe_key_results;

    expect(table).toBeDefined();
    expect(table.columns.site_id).toMatchObject({ logicalType: 'integer', notNull: true });
    // NOT NULL here, unlike the site-scoped table's nullable account_id: this
    // column is part of the unique key below, and a NULL in a unique key compares
    // distinct on every insert, which would turn the table into an append-only log.
    expect(table.columns.account_id).toMatchObject({ logicalType: 'integer', notNull: true });
    // Same reason, plus it carries the sentinel 0 for the account-level primary key.
    expect(table.columns.token_id).toMatchObject({ logicalType: 'integer', notNull: true });
    expect(table.columns.token_name).toMatchObject({ logicalType: 'text', notNull: true });
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

    // account_id LEADS the key on purpose. token_id 0 is the shared sentinel for
    // every account's primary key, so a (token_id, model_name) key would collide
    // two different accounts' primary-key verdicts into one row.
    expect(contract.uniques).toContainEqual(
      expect.objectContaining({
        name: 'model_probe_key_results_account_token_model_unique',
        table: 'model_probe_key_results',
        columns: ['account_id', 'token_id', 'model_name'],
      }),
    );
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'model_probe_key_results',
        columns: ['site_id'],
        referencedTable: 'sites',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
    );
    // CASCADE, not SET NULL: the column is NOT NULL and in the unique key, so a
    // row whose account is gone has no value to fall back to.
    expect(contract.foreignKeys).toContainEqual(
      expect.objectContaining({
        table: 'model_probe_key_results',
        columns: ['account_id'],
        referencedTable: 'accounts',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      }),
    );
    // token_id must NOT be a foreign key: the sentinel 0 has no account_tokens row
    // to point at. Deleting a key therefore clears these rows in application code
    // (accountTokens.ts, accountTokenService.ts, siteApiKeyMigrationService.ts).
    expect(contract.foreignKeys).not.toContainEqual(
      expect.objectContaining({
        table: 'model_probe_key_results',
        columns: ['token_id'],
      }),
    );
  });
});
