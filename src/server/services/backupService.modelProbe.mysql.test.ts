import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The restore path for `model_probe_results` upserts on the (site_id,
 * model_name) unique key, and the conflict clause is dialect-specific: SQLite /
 * PostgreSQL take `onConflictDoUpdate` while Drizzle's MySQL builder exposes
 * only `onDuplicateKeyUpdate`.
 *
 * `backupService.test.ts` runs against SQLite, so it structurally cannot catch a
 * MySQL-only builder mistake, and the `db` handle in that file is loose enough
 * that typecheck will not either. This suite fakes the MySQL builder the way
 * `adminSnapshotStore.mysql.test.ts` and `usageAggregationService.mysql.test.ts`
 * do and asserts which method the restore reaches for.
 *
 * The fake deliberately does NOT define `onConflictDoUpdate`, mirroring the real
 * MySQL builder: if the dialect branch is ever removed, this suite fails with a
 * TypeError rather than quietly passing.
 */
const modelProbeResults = sqliteTable('model_probe_results', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull(),
  accountId: integer('account_id'),
  modelName: text('model_name').notNull(),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  httpStatus: integer('http_status'),
  failureKind: text('failure_kind'),
  reason: text('reason'),
  endpointUsed: text('endpoint_used'),
  promptUsed: text('prompt_used'),
  userAgentUsed: text('user_agent_used'),
  checkedAt: text('checked_at'),
});

const schema = { modelProbeResults };

type ProbeRow = {
  siteId: number;
  accountId: number | null;
  modelName: string;
  status: string;
  latencyMs: number | null;
  httpStatus: number | null;
  failureKind: string | null;
  reason: string | null;
  endpointUsed: string | null;
  promptUsed: string | null;
  userAgentUsed: string | null;
  checkedAt: string;
};

const state: {
  rows: ProbeRow[];
  onDuplicateKeyUpdateCalls: number;
  onDuplicateKeyUpdateTables: string[];
  insertedTables: string[];
} = {
  rows: [],
  onDuplicateKeyUpdateCalls: 0,
  onDuplicateKeyUpdateTables: [],
  insertedTables: [],
};

function resetMockState() {
  state.rows = [];
  state.onDuplicateKeyUpdateCalls = 0;
  state.onDuplicateKeyUpdateTables = [];
  state.insertedTables = [];
}

function resolveTableName(table: unknown): string {
  if (table === modelProbeResults) return 'model_probe_results';
  return 'unknown';
}

/**
 * Mirrors Drizzle's MySQL insert builder surface: `values`,
 * `onDuplicateKeyUpdate`, `run`. No `onConflictDoUpdate` and no
 * `onConflictDoNothing`, because MySqlInsertBase does not have them.
 */
function makeMysqlInsertChain(table: unknown) {
  let values: ProbeRow | null = null;
  let duplicateSet: Partial<ProbeRow> | null = null;

  const chain = {
    values(nextValues: ProbeRow) {
      values = nextValues;
      return chain;
    },
    onDuplicateKeyUpdate(input: { set: Partial<ProbeRow> }) {
      state.onDuplicateKeyUpdateCalls += 1;
      state.onDuplicateKeyUpdateTables.push(resolveTableName(table));
      duplicateSet = input.set;
      return chain;
    },
    run: vi.fn(async () => {
      if (!values) throw new Error('values() must be called before run()');

      const existingIndex = state.rows.findIndex((row) =>
        row.siteId === values!.siteId && row.modelName === values!.modelName,
      );

      if (existingIndex === -1) {
        state.rows.push({ ...values });
        return { changes: 1 };
      }

      // A MySQL upsert with no duplicate-key clause would have thrown on the
      // unique key instead of overwriting.
      if (!duplicateSet) throw new Error('duplicate key on (site_id, model_name)');

      state.rows[existingIndex] = { ...state.rows[existingIndex], ...duplicateSet };
      return { changes: 1 };
    }),
  };

  return chain;
}

const tx = {
  insert: vi.fn((table: unknown) => {
    state.insertedTables.push(resolveTableName(table));
    return makeMysqlInsertChain(table);
  }),
};

vi.mock('../db/index.js', () => ({
  db: { insert: vi.fn(() => makeMysqlInsertChain(modelProbeResults)) },
  runtimeDbDialect: 'mysql',
  schema,
}));

type BackupServiceModule = typeof import('./backupService.js');

function probeRow(overrides: Partial<ProbeRow> = {}): ProbeRow {
  return {
    siteId: 1,
    accountId: 7,
    modelName: 'gpt-4o-mini',
    status: 'supported',
    latencyMs: 120,
    httpStatus: 200,
    failureKind: null,
    reason: null,
    endpointUsed: 'chat_completions',
    promptUsed: 'ping',
    userAgentUsed: 'metapi-probe',
    checkedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('backupService model probe restore on mysql', () => {
  let backupService: BackupServiceModule;

  beforeEach(async () => {
    resetMockState();
    vi.resetModules();
    backupService = await import('./backupService.js');
  });

  it('uses the mysql duplicate-key clause instead of onConflictDoUpdate', async () => {
    await backupService.upsertRestoredModelProbeResult(tx, probeRow());

    expect(state.insertedTables).toEqual(['model_probe_results']);
    expect(state.onDuplicateKeyUpdateCalls).toBe(1);
    expect(state.onDuplicateKeyUpdateTables).toEqual(['model_probe_results']);
    expect(state.rows).toHaveLength(1);
  });

  it('lets a repeated (siteId, modelName) overwrite rather than abort the restore', async () => {
    await backupService.upsertRestoredModelProbeResult(tx, probeRow());
    await backupService.upsertRestoredModelProbeResult(tx, probeRow({
      accountId: null,
      status: 'unsupported',
      latencyMs: null,
      httpStatus: 404,
      failureKind: 'model_missing',
      reason: 'no such model',
      checkedAt: '2026-08-21T01:00:00.000Z',
    }));

    // Both writes went through the duplicate-key clause, so the later verdict
    // wins instead of the unique key rolling back the whole restore.
    expect(state.onDuplicateKeyUpdateCalls).toBe(2);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      siteId: 1,
      modelName: 'gpt-4o-mini',
      accountId: null,
      status: 'unsupported',
      latencyMs: null,
      httpStatus: 404,
      failureKind: 'model_missing',
      reason: 'no such model',
      checkedAt: '2026-08-21T01:00:00.000Z',
    });
  });

  it('never reaches for a conflict-clause method the mysql builder lacks', async () => {
    // Guards the regression directly: the fake builder has no
    // `onConflictDoUpdate`, so an unbranched call throws here the way it would
    // on a real MySQL deployment.
    const chain = makeMysqlInsertChain(modelProbeResults);
    expect((chain as Record<string, unknown>).onConflictDoUpdate).toBeUndefined();
    expect((chain as Record<string, unknown>).onConflictDoNothing).toBeUndefined();

    await expect(
      backupService.upsertRestoredModelProbeResult(tx, probeRow()),
    ).resolves.toBeUndefined();
  });
});
