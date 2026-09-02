import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { getProxyRefFromExtraConfig, PROXY_REF_INHERIT, withProxyRefInExtraConfig } from './accountExtraConfig.js';
import { normalizeSiteProxyUrl, primeSiteProxyPool } from './siteProxy.js';

/**
 * The single place a proxy ADDRESS is entered.
 *
 * Sites and connections no longer hold an address of their own — they hold a
 * reference into this list. That is the whole point of the feature: one input,
 * many selectors. A site that wants its own proxy adds an entry here first.
 *
 * Stored as one JSON row in `settings` rather than a real table. The tradeoff is
 * deliberate and has one consequence worth stating up front: `proxy_ref` on a
 * site CANNOT be a real foreign key, so deleting an entry has to fix up its
 * referrers in application code, and a missed fix-up leaves a dangling ref.
 * `resolveProxyRef` therefore treats an unknown id as "no proxy" rather than
 * falling back to some other entry — a site that silently used a DIFFERENT
 * proxy than the operator chose is the one outcome worse than not proxying.
 *
 * Backup/restore needs no registration: `exportPreferencesSection` copies every
 * settings row except a 4-key deny list, and `isSettingValueAcceptable` defaults
 * to accepting unknown keys. Factory reset is the opposite — it wipes the table
 * and writes back only an explicit allow list, so this key IS registered there
 * (operator's call: a proxy is infrastructure, and losing it can leave an
 * instance unable to reach any upstream to be reconfigured).
 */
export const PROXY_POOL_SETTING_KEY = 'proxy_pool_v1';

/**
 * Route-layer validation for a connection's proxy choice.
 *
 * Passes the WIRE value through untouched (so "leave alone" and "follow the site"
 * stay distinguishable downstream) and only rejects shapes that cannot mean
 * anything. An id that is not in the pool is refused rather than stored: reads
 * treat a dangling ref as "no proxy", so accepting one here would quietly take a
 * connection off its proxy.
 */
export async function validateConnectionProxyRefPayload(raw: unknown): Promise<
  { valid: true; value: string | null | undefined } | { valid: false; message: string }
> {
  if (raw === undefined) return { valid: true, value: undefined };
  if (raw === null) return { valid: true, value: null };
  if (typeof raw !== 'string') {
    return { valid: false, message: 'invalid proxyRef: expected a proxy pool id, null, or "inherit"' };
  }

  const trimmed = raw.trim();
  if (!trimmed || trimmed === PROXY_REF_INHERIT) {
    return { valid: true, value: PROXY_REF_INHERIT };
  }

  const pool = await loadProxyPool();
  if (!pool.some((entry) => entry.id === trimmed)) {
    return { valid: false, message: 'unknown proxyRef: the selected proxy no longer exists' };
  }
  return { valid: true, value: trimmed };
}


export type ProxyPoolEntry = {
  /** Opaque, never reused. Referenced by sites/connections. */
  id: string;
  /** Display label only. Renaming never breaks a reference. */
  name: string;
  /** Normalized by `normalizeSiteProxyUrl` before it is ever stored. */
  url: string;
};

const MAX_PROXY_POOL_ENTRIES = 50;
const MAX_PROXY_NAME_LENGTH = 40;

/**
 * Ids are random, not sequential, and never reused.
 *
 * A positional or reused id would make "delete an entry" silently repoint every
 * reference after it, which is exactly the failure the id exists to prevent.
 */
function generateProxyId(): string {
  return `px_${randomBytes(6).toString('hex')}`;
}

function normalizeProxyName(raw: unknown, fallbackUrl: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed) return trimmed.slice(0, MAX_PROXY_NAME_LENGTH);
  // Named after its host:port rather than left blank — a list of unnamed rows is
  // unusable, and this is also what migration uses for pre-existing addresses.
  try {
    const parsed = new URL(fallbackUrl);
    return (parsed.host || fallbackUrl).slice(0, MAX_PROXY_NAME_LENGTH);
  } catch {
    return fallbackUrl.slice(0, MAX_PROXY_NAME_LENGTH);
  }
}

/**
 * Parses whatever is in the settings row into a list that is safe to serve.
 *
 * Hostile/corrupt input is dropped entry by entry rather than failing the whole
 * read: losing one malformed row degrades a single site to "no proxy", while
 * throwing here would take down every page that renders proxy state.
 */
export function coerceProxyPool(raw: unknown): ProxyPoolEntry[] {
  if (!Array.isArray(raw)) return [];

  const seenIds = new Set<string>();
  const entries: ProxyPoolEntry[] = [];

  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;

    const url = normalizeSiteProxyUrl(record.url);
    if (!url) continue;

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    entries.push({ id, name: normalizeProxyName(record.name, url), url });
    if (entries.length >= MAX_PROXY_POOL_ENTRIES) break;
  }

  return entries;
}

export async function loadProxyPool(): Promise<ProxyPoolEntry[]> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, PROXY_POOL_SETTING_KEY))
    .get();

  if (!row?.value) return [];
  try {
    return coerceProxyPool(JSON.parse(row.value));
  } catch {
    return [];
  }
}

export async function saveProxyPool(entries: ProxyPoolEntry[]): Promise<void> {
  await upsertSetting(PROXY_POOL_SETTING_KEY, entries);
  // Publish straight into the synchronous mirror the request-path resolvers read,
  // so the new pool is in force for the very next request rather than after the
  // next cache refresh.
  primeSiteProxyPool(entries);
}

/**
 * Resolves a stored reference to a usable address.
 *
 * Three distinct inputs, three distinct meanings — collapsing any two would
 * lose a state the UI needs:
 *  - `undefined` → "no opinion, inherit from the layer above" (connection only)
 *  - `null`      → "explicitly do not proxy", which OVERRIDES the layer above
 *  - a string id → that entry, or nothing if the entry is gone
 */
export function resolveProxyRef(
  ref: string | null | undefined,
  pool: readonly ProxyPoolEntry[],
): string | null {
  if (!ref) return null;
  const entry = pool.find((candidate) => candidate.id === ref);
  // A dangling ref reads as "no proxy", never as "some other entry".
  return entry ? entry.url : null;
}

export function isDanglingProxyRef(
  ref: string | null | undefined,
  pool: readonly ProxyPoolEntry[],
): boolean {
  if (!ref) return false;
  return !pool.some((candidate) => candidate.id === ref);
}

export type ProxyPoolMutationError =
  | 'invalid_url'
  | 'not_found'
  | 'limit_reached';

export class ProxyPoolError extends Error {
  constructor(public readonly code: ProxyPoolMutationError, message: string) {
    super(message);
    this.name = 'ProxyPoolError';
  }
}

export async function addProxyPoolEntry(input: { name?: unknown; url: unknown }): Promise<ProxyPoolEntry> {
  const url = normalizeSiteProxyUrl(input.url);
  if (!url) {
    throw new ProxyPoolError('invalid_url', '代理地址无效，支持 http/https/socks4/socks5');
  }

  const pool = await loadProxyPool();
  if (pool.length >= MAX_PROXY_POOL_ENTRIES) {
    throw new ProxyPoolError('limit_reached', `代理数量已达上限 ${MAX_PROXY_POOL_ENTRIES} 个`);
  }

  // Duplicate URLs are allowed on purpose: two entries can legitimately share an
  // address while carrying different names, and de-duplicating here would silently
  // merge two sites' independently-managed choices into one.
  const entry: ProxyPoolEntry = {
    id: generateProxyId(),
    name: normalizeProxyName(input.name, url),
    url,
  };
  await saveProxyPool([...pool, entry]);
  return entry;
}

/**
 * Edits an entry IN PLACE, keeping its id.
 *
 * That is what makes "change the address once, every site follows" work — the
 * operator's stated expectation. Replacing the id instead would silently orphan
 * every referrer.
 */
export async function updateProxyPoolEntry(
  id: string,
  patch: { name?: unknown; url?: unknown },
): Promise<ProxyPoolEntry> {
  const pool = await loadProxyPool();
  const index = pool.findIndex((candidate) => candidate.id === id);
  if (index < 0) {
    throw new ProxyPoolError('not_found', '代理不存在');
  }

  const current = pool[index]!;
  let url = current.url;
  if (patch.url !== undefined) {
    const normalized = normalizeSiteProxyUrl(patch.url);
    if (!normalized) {
      throw new ProxyPoolError('invalid_url', '代理地址无效，支持 http/https/socks4/socks5');
    }
    url = normalized;
  }

  const next: ProxyPoolEntry = {
    id: current.id,
    name: patch.name === undefined ? current.name : normalizeProxyName(patch.name, url),
    url,
  };

  const nextPool = [...pool];
  nextPool[index] = next;
  await saveProxyPool(nextPool);
  return next;
}

export type ProxyPoolReferrers = {
  siteNames: string[];
  accountLabels: string[];
};

/**
 * Who currently points at this entry.
 *
 * Powers the pre-delete confirmation, which TELLS but does not block (operator's
 * ruling): deletion proceeds and every referrer is reset to "no proxy".
 *
 * Reads the columns/keys added in step 2, so until those land this returns empty
 * lists — which is correct rather than merely harmless: with no reference stored
 * anywhere yet, nothing can be pointing at a pool entry.
 */
export async function listProxyPoolReferrers(id: string): Promise<ProxyPoolReferrers> {
  const siteRows = await db.select({
    name: schema.sites.name,
    proxyRef: schema.sites.proxyRef,
  }).from(schema.sites).all();

  const accountRows = await db.select({
    id: schema.accounts.id,
    username: schema.accounts.username,
    extraConfig: schema.accounts.extraConfig,
  }).from(schema.accounts).all();

  const siteNames = siteRows
    .filter((row) => row.proxyRef === id)
    .map((row) => row.name || '(未命名站点)');

  const accountLabels = accountRows
    .filter((row) => getProxyRefFromExtraConfig(row.extraConfig) === id)
    .map((row) => row.username || `#${row.id}`);

  return { siteNames, accountLabels };
}

/**
 * Deletes the entry and resets everything that referenced it to "no proxy".
 *
 * The reset is the whole reason this is not a bare `saveProxyPool`: `proxy_ref`
 * cannot be a foreign key (the pool lives in a JSON settings row, so there is no
 * table to point at), so nothing in the database cleans up behind this delete.
 *
 * Order matters. References are cleared BEFORE the pool row is rewritten: if the
 * process dies in between, the surviving state is "sites explicitly not proxied,
 * entry still listed", which is inert. The other order would leave live sites
 * pointing at an id that no longer exists.
 */
export async function deleteProxyPoolEntry(id: string): Promise<void> {
  const pool = await loadProxyPool();
  if (!pool.some((candidate) => candidate.id === id)) {
    throw new ProxyPoolError('not_found', '代理不存在');
  }

  await clearProxyRefEverywhere(id);
  await saveProxyPool(pool.filter((candidate) => candidate.id !== id));
}

async function clearProxyRefEverywhere(id: string): Promise<void> {
  await db.update(schema.sites)
    .set({ proxyRef: null })
    .where(eq(schema.sites.proxyRef, id))
    .run();

  const accountRows = await db.select({
    id: schema.accounts.id,
    extraConfig: schema.accounts.extraConfig,
  }).from(schema.accounts).all();

  for (const row of accountRows) {
    if (getProxyRefFromExtraConfig(row.extraConfig) !== id) continue;
    // Reset to an explicit null ("do not proxy") rather than deleting the key
    // (which would mean "inherit from the site"). A connection that had chosen a
    // specific proxy must not silently start following its site's choice.
    await db.update(schema.accounts)
      .set({ extraConfig: withProxyRefInExtraConfig(row.extraConfig, null) })
      .where(eq(schema.accounts.id, row.id))
      .run();
  }
}

