import { eq } from 'drizzle-orm';

import { buildConfig, config } from '../config.js';
import { db, schema, switchRuntimeDatabase } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { coerceProxyPool, PROXY_POOL_SETTING_KEY } from './proxyPoolService.js';
import { updateBalanceRefreshCron, updateCheckinCron, updateLogCleanupSettings } from './checkinScheduler.js';
import { ensureDefaultSitesSeeded } from './defaultSiteSeedService.js';
import { startProxyLogRetentionService } from './proxyLogRetentionService.js';
import { invalidateSiteProxyCache, primeSiteProxyPool } from './siteProxy.js';

export const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';

type FactoryResetDependencies = {
  switchRuntimeDatabase?: typeof switchRuntimeDatabase;
  runSqliteMigrations?: () => Promise<void> | void;
  ensureDefaultSitesSeeded?: typeof ensureDefaultSitesSeeded;
};

type PreservedInfrastructureState = {
  authToken: string;
  proxyToken: string;
  dbType: 'sqlite' | 'mysql' | 'postgres';
  dbUrl: string;
  dbSsl: boolean;
  /**
   * The proxy pool, preserved on the operator's explicit ruling: a proxy is
   * infrastructure, not business data, and an instance that loses it may be unable
   * to reach any upstream to be reconfigured — including the upstream it would need
   * to fix itself.
   *
   * Read from the database rather than from `config`, unlike every field above:
   * this one has no runtime mirror, it lives only in `settings`. So it has to be
   * captured BEFORE the wipe, which is why `captureInfrastructureState` is async.
   */
  proxyPool: unknown;
};

async function clearAllBusinessData() {
  await db.transaction(async (tx) => {
    await tx.delete(schema.routeChannels).run();
    await tx.delete(schema.tokenModelAvailability).run();
    await tx.delete(schema.modelAvailability).run();
    await tx.delete(schema.proxyLogs).run();
    await tx.delete(schema.proxyVideoTasks).run();
    await tx.delete(schema.proxyFiles).run();
    await tx.delete(schema.checkinLogs).run();
    await tx.delete(schema.accountTokens).run();
    await tx.delete(schema.accounts).run();
    await tx.delete(schema.tokenRoutes).run();
    await tx.delete(schema.sites).run();
    await tx.delete(schema.downstreamApiKeys).run();
    await tx.delete(schema.events).run();
    await tx.delete(schema.settings).run();
  });
}

async function readSettingValue(key: string): Promise<unknown> {
  try {
    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get();
    if (!row?.value) return undefined;
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

async function captureInfrastructureState(): Promise<PreservedInfrastructureState> {
  return {
    authToken: config.authToken,
    proxyToken: config.proxyToken,
    dbType: config.dbType,
    dbUrl: config.dbUrl,
    dbSsl: config.dbSsl,
    proxyPool: await readSettingValue(PROXY_POOL_SETTING_KEY),
  };
}

function shouldPreserveExternalRuntime(state: PreservedInfrastructureState): boolean {
  return state.dbType !== 'sqlite' && !!state.dbUrl.trim();
}

function resetRuntimeConfigToInitialState(preserved: PreservedInfrastructureState) {
  const baseline = buildConfig(process.env);
  Object.assign(config, baseline);
  config.authToken = preserved.authToken || baseline.authToken || FACTORY_RESET_ADMIN_TOKEN;
  config.proxyToken = preserved.proxyToken || baseline.proxyToken;
  if (shouldPreserveExternalRuntime(preserved)) {
    config.dbType = preserved.dbType;
    config.dbUrl = preserved.dbUrl;
    config.dbSsl = preserved.dbSsl;
  }
  config.logCleanupConfigured = false;
  config.logCleanupUsageLogsEnabled = config.proxyLogRetentionDays > 0;
  config.logCleanupProgramLogsEnabled = false;
  config.logCleanupRetentionDays = Math.max(1, Math.trunc(config.proxyLogRetentionDays || config.logCleanupRetentionDays || 30));
  updateCheckinCron(config.checkinCron);
  updateBalanceRefreshCron(config.balanceRefreshCron);
  updateLogCleanupSettings({
    cronExpr: config.logCleanupCron,
    usageLogsEnabled: config.logCleanupUsageLogsEnabled,
    programLogsEnabled: config.logCleanupProgramLogsEnabled,
    retentionDays: config.logCleanupRetentionDays,
  });
  startProxyLogRetentionService();
  invalidateSiteProxyCache();
}

async function restoreInfrastructureSettings(preserved: PreservedInfrastructureState): Promise<void> {
  await upsertSetting('auth_token', preserved.authToken || FACTORY_RESET_ADMIN_TOKEN);
  await upsertSetting('proxy_token', preserved.proxyToken);

  if (Array.isArray(preserved.proxyPool) && preserved.proxyPool.length > 0) {
    await upsertSetting(PROXY_POOL_SETTING_KEY, preserved.proxyPool);
    // Republish into the synchronous mirror: the wipe left it holding entries that
    // no longer exist in the DB, and the reset itself must not leave the request
    // path resolving against a pool nobody stored.
    primeSiteProxyPool(coerceProxyPool(preserved.proxyPool));
  } else {
    primeSiteProxyPool([]);
  }

  if (shouldPreserveExternalRuntime(preserved)) {
    await upsertSetting('db_type', preserved.dbType);
    await upsertSetting('db_url', preserved.dbUrl);
    await upsertSetting('db_ssl', preserved.dbSsl);
    return;
  }

  await upsertSetting('db_type', config.dbType);
  await upsertSetting('db_url', config.dbUrl);
  await upsertSetting('db_ssl', config.dbSsl);
}

async function runDefaultSqliteMigrations() {
  const migrateModule = await import('../db/migrate.js');
  migrateModule.runSqliteMigrations();
}

export async function performFactoryReset(deps: FactoryResetDependencies = {}): Promise<void> {
  const switchRuntimeDatabaseImpl = deps.switchRuntimeDatabase ?? switchRuntimeDatabase;
  const runSqliteMigrationsImpl = deps.runSqliteMigrations ?? runDefaultSqliteMigrations;
  const ensureDefaultSitesSeededImpl = deps.ensureDefaultSitesSeeded ?? ensureDefaultSitesSeeded;
  // Awaited before the first wipe: the proxy pool has no runtime mirror to read
  // back from once the settings table is gone.
  const preserved = await captureInfrastructureState();

  await clearAllBusinessData();
  resetRuntimeConfigToInitialState(preserved);
  await switchRuntimeDatabaseImpl(config.dbType, config.dbUrl, config.dbSsl);
  if (config.dbType === 'sqlite') {
    await runSqliteMigrationsImpl();
  }
  await clearAllBusinessData();
  await restoreInfrastructureSettings(preserved);
  await ensureDefaultSitesSeededImpl();
}
