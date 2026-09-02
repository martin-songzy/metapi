import { AsyncLocalStorage } from 'node:async_hooks';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { SocksClient } from 'socks';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from './siteCustomHeaders.js';
import {
  getProxyRefFromExtraConfig,
  parseConnectionProxyRefInput,
  PROXY_REF_INHERIT,
} from './accountExtraConfig.js';
import { stripTrailingSlashes } from './urlNormalization.js';

const SITE_PROXY_CACHE_TTL_MS = 3_000;
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const SOCKS_PROXY_PROTOCOLS = new Set([
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS = 60_000;

/**
 * Duplicated from `proxyPoolService` rather than imported: that module imports
 * `normalizeSiteProxyUrl` from here, and closing the cycle on this path is not
 * worth saving two string literals. `proxyPoolService` owns the meaning of both.
 */
const PROXY_POOL_SETTING_KEY_LOCAL = 'proxy_pool_v1';

/** Only the two fields the resolver needs; the full entry also carries `name`. */
type ProxyPoolEntry = { id: string; url: string };

type SiteProxyRow = {
  siteUrl: string;
  /** Reference into the proxy pool; null means "do not proxy". */
  proxyRef: string | null;
  customHeaders: unknown;
};

type ParsedSiteProxyInput = {
  present: boolean;
  valid: boolean;
  proxyUrl: string | null;
};

export type SiteProxyConfigLike = {
  /** Reference into the proxy pool. */
  proxyRef?: string | null;
  customHeaders?: unknown;
};

/**
 * The connection (account) half of a channel.
 *
 * Deliberately an object rather than a bare proxy URL: the old signature took
 * `accountProxyUrl?: string | null`, so a caller that forgot to migrate would still
 * typecheck while silently losing the connection's "do not proxy" answer. Requiring
 * the raw `extraConfig` makes every call site a compile error until it is visited,
 * and keeps the three-state read in ONE place instead of at each caller.
 */
export type SiteProxyConnectionLike = {
  extraConfig?: string | null;
};

let siteProxyCache: {
  loadedAt: number;
  rows: SiteProxyRow[];
  /** The proxy pool, cached alongside the rows so a resolve stays one round trip. */
  pool: ProxyPoolEntry[];
} = {
  loadedAt: 0,
  rows: [],
  pool: [],
};

const dispatcherCache = new Map<string, Dispatcher>();

const accountProxyOverride = new AsyncLocalStorage<string | null>();

/**
 * Pins one channel's proxy decision for the duration of `fn`, including the
 * decision "go direct".
 *
 * `undefined` means "no opinion" and leaves the layers below to resolve as usual;
 * `null` is an explicit direct connection and SUPPRESSES the site's proxy. That
 * distinction matters because the adapters below re-resolve by request URL, so
 * without it a connection that refused a proxy would silently pick its site's one
 * back up.
 */
export function withAccountProxyOverride<T>(
  proxyUrl: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (proxyUrl === undefined) return fn();
  return accountProxyOverride.run(normalizeSiteProxyUrl(proxyUrl), fn);
}

type ParsedSocksProxyConfig = {
  shouldLookup: boolean;
  proxy: {
    host: string;
    port: number;
    type: 4 | 5;
    userId?: string;
    password?: string;
  };
};

type UndiciConnectOptions = {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
  localAddress?: string | null;
  httpSocket?: Socket;
};

export function normalizeSiteUrl(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = stripTrailingSlashes(parsed.pathname);
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return stripTrailingSlashes(trimmed);
  }
}

/** Settings values are JSON-encoded, but tolerate a legacy bare string. */
function parseSettingRowValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The proxy pool, read straight from the settings row rather than through
 * `proxyPoolService`.
 *
 * That service imports `normalizeSiteProxyUrl` from here, so importing it back
 * would close a module cycle on the hottest path in the process. Duplicating this
 * much of the read is the cheaper trade; the SHAPE is still owned there, and
 * anything malformed is dropped entry by entry exactly as `coerceProxyPool` does.
 */
function coercePoolRowValue(raw: unknown): ProxyPoolEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: ProxyPoolEntry[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const url = normalizeSiteProxyUrl(record.url);
    if (!url) continue;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, url });
  }
  return entries;
}

async function getCachedSiteProxyRows(nowMs = Date.now()): Promise<SiteProxyRow[]> {
  if ((nowMs - siteProxyCache.loadedAt) < SITE_PROXY_CACHE_TTL_MS) {
    return siteProxyCache.rows;
  }

  try {
    const [rows, poolSetting] = await Promise.all([
      db
        .select({
          siteUrl: schema.sites.url,
          proxyRef: schema.sites.proxyRef,
          customHeaders: schema.sites.customHeaders,
        })
        .from(schema.sites)
        .all(),
      db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, PROXY_POOL_SETTING_KEY_LOCAL))
        .get(),
    ]);

    siteProxyCache = {
      loadedAt: nowMs,
      rows: rows.map((row) => ({
        siteUrl: normalizeSiteUrl(row.siteUrl),
        proxyRef: typeof row.proxyRef === 'string' && row.proxyRef.trim() ? row.proxyRef.trim() : null,
        customHeaders: row.customHeaders ?? null,
      })),
      pool: coercePoolRowValue(parseSettingRowValue(poolSetting?.value)),
    };
  } catch {
    // Fails to "no proxy" rather than to a stale snapshot: a request that should
    // have been proxied and was not is visible immediately, whereas one that keeps
    // using a proxy the operator just removed is not.
    //
    // The pool is the exception — it is kept. Blanking it would make every site's
    // reference dangle at once, so one failed read would unproxy the whole instance
    // instead of the one site whose row could not be re-read.
    siteProxyCache = {
      loadedAt: nowMs,
      rows: [],
      pool: siteProxyCache.pool,
    };
  }

  return siteProxyCache.rows;
}

function getDispatcherByProxyUrl(proxyUrl: string, skipCache = false): Dispatcher | undefined {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return undefined;

  if (!skipCache) {
    const cached = dispatcherCache.get(normalized);
    if (cached) return cached;
  }

  try {
    const parsedProxyUrl = new URL(normalized);
    const dispatcher = SOCKS_PROXY_PROTOCOLS.has(parsedProxyUrl.protocol.toLowerCase())
      ? createSocksDispatcher(parsedProxyUrl)
      : new ProxyAgent(normalized);
    if (!skipCache) {
      dispatcherCache.set(normalized, dispatcher);
    }
    return dispatcher;
  } catch {
    return undefined;
  }
}

function parseSocksProxyUrl(proxyUrl: URL): ParsedSocksProxyConfig {
  let shouldLookup = false;
  let type: 4 | 5 = 5;

  switch (proxyUrl.protocol.toLowerCase()) {
    case 'socks4:':
      shouldLookup = true;
      type = 4;
      break;
    case 'socks4a:':
      type = 4;
      break;
    case 'socks5:':
      shouldLookup = true;
      type = 5;
      break;
    case 'socks:':
    case 'socks5h:':
      type = 5;
      break;
    default:
      throw new TypeError(`Unsupported SOCKS proxy protocol: ${proxyUrl.protocol}`);
  }

  const proxy: ParsedSocksProxyConfig['proxy'] = {
    host: proxyUrl.hostname,
    port: Number.parseInt(proxyUrl.port, 10) || 1080,
    type,
  };

  if (proxyUrl.username) {
    proxy.userId = decodeURIComponent(proxyUrl.username);
  }
  if (proxyUrl.password) {
    proxy.password = decodeURIComponent(proxyUrl.password);
  }

  return { shouldLookup, proxy };
}

function applySocketDefaults(socket: Socket | TLSSocket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS);
}

async function resolveSocksDestinationHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, {}, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(address);
    });
  });
}

async function createSocksSocket(
  connectOptions: UndiciConnectOptions,
  socksProxy: ParsedSocksProxyConfig,
): Promise<Socket | TLSSocket> {
  if (!connectOptions.hostname) {
    throw new Error('Missing hostname for SOCKS proxy request');
  }

  const destinationHost = socksProxy.shouldLookup
    ? await resolveSocksDestinationHost(connectOptions.hostname)
    : connectOptions.hostname;
  const destinationPort = Number.parseInt(connectOptions.port, 10)
    || (connectOptions.protocol === 'https:' ? 443 : 80);

  const { socket } = await SocksClient.createConnection({
    proxy: socksProxy.proxy,
    destination: {
      host: destinationHost,
      port: destinationPort,
    },
    command: 'connect',
    timeout: DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    socket_options: connectOptions.localAddress
      ? { localAddress: connectOptions.localAddress } as any
      : undefined,
  });
  applySocketDefaults(socket);

  if (connectOptions.protocol !== 'https:') {
    return socket;
  }

  return await new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      host: connectOptions.hostname,
      servername: connectOptions.servername || (!isIP(connectOptions.hostname) ? connectOptions.hostname : undefined),
      ALPNProtocols: ['http/1.1'],
    });

    const cleanup = (error: Error) => {
      socket.destroy();
      tlsSocket.destroy();
      reject(error);
    };

    tlsSocket.once('secureConnect', () => {
      tlsSocket.off('error', cleanup);
      applySocketDefaults(tlsSocket);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', cleanup);
  });
}

function createSocksDispatcher(proxyUrl: URL): Dispatcher {
  const socksProxy = parseSocksProxyUrl(proxyUrl);
  return new UndiciAgent({
    connect: (connectOptions, callback) => {
      void createSocksSocket(connectOptions, socksProxy)
        .then((socket) => callback(null, socket))
        .catch((error) => {
          callback(error instanceof Error ? error : new Error(String(error)), null as any);
        });
    },
  });
}

export function normalizeSiteProxyUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function parseSiteProxyUrlInput(input: unknown): ParsedSiteProxyInput {
  if (input === undefined) {
    return { present: false, valid: true, proxyUrl: null };
  }
  if (input === null) {
    return { present: true, valid: true, proxyUrl: null };
  }

  if (typeof input !== 'string') {
    return { present: true, valid: false, proxyUrl: null };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { present: true, valid: true, proxyUrl: null };
  }

  const normalized = normalizeSiteProxyUrl(trimmed);
  if (!normalized) {
    return { present: true, valid: false, proxyUrl: null };
  }

  return {
    present: true,
    valid: true,
    proxyUrl: normalized,
  };
}

export function invalidateSiteProxyCache(): void {
  // `loadedAt: 0` forces the next read to refetch. The pool is deliberately KEPT:
  // several resolvers are synchronous and read this mirror directly, so blanking it
  // here would answer "no proxy" for every site until something async happened to
  // refill it — silently unproxying the instance in the window right after an edit.
  // Writers call `primeSiteProxyPool` with what they just stored, so the mirror is
  // never stale for longer than one write.
  siteProxyCache = {
    loadedAt: 0,
    rows: [],
    pool: siteProxyCache.pool,
  };
}

/**
 * Publish a known-good pool into the synchronous mirror.
 *
 * Called at boot (from settings hydration) and by every writer, so the sync
 * resolvers below never have to answer from a cold cache. Does NOT touch
 * `loadedAt`: the site rows still refresh on their own TTL.
 */
export function primeSiteProxyPool(entries: readonly ProxyPoolEntry[]): void {
  siteProxyCache = {
    ...siteProxyCache,
    pool: entries.map((entry) => ({ id: entry.id, url: entry.url })),
  };
}

function findBestMatchingSiteRow(rows: SiteProxyRow[], normalizedRequestUrl: string): SiteProxyRow | null {
  let bestMatch: SiteProxyRow | null = null;
  let bestMatchLength = -1;

  for (const row of rows) {
    if (!row.siteUrl) continue;

    const isPrefixMatch = (
      normalizedRequestUrl === row.siteUrl
      || normalizedRequestUrl.startsWith(`${row.siteUrl}/`)
      || normalizedRequestUrl.startsWith(`${row.siteUrl}?`)
    );
    if (!isPrefixMatch) continue;

    if (row.siteUrl.length > bestMatchLength) {
      bestMatch = row;
      bestMatchLength = row.siteUrl.length;
    }
  }

  return bestMatch;
}

async function resolveSiteRequestConfigByRequestUrl(requestUrl: string): Promise<{
  proxyUrl: string | null;
  customHeaders: unknown;
}> {
  const normalizedRequestUrl = normalizeSiteUrl(requestUrl);
  if (!normalizedRequestUrl) {
    return { proxyUrl: null, customHeaders: null };
  }

  const rows = await getCachedSiteProxyRows();
  const matchedRow = findBestMatchingSiteRow(rows, normalizedRequestUrl);
  const proxyUrl = resolveProxyUrlForSite(matchedRow);
  return {
    proxyUrl,
    customHeaders: matchedRow?.customHeaders ?? null,
  };
}

export async function resolveSiteProxyUrlByRequestUrl(requestUrl: string): Promise<string | null> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  return resolved.proxyUrl;
}

export async function withSiteProxyRequestInit(
  requestUrl: string,
  options?: UndiciRequestInit,
): Promise<UndiciRequestInit> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(resolved.customHeaders, options?.headers);
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }

  const alsOverride = accountProxyOverride.getStore();
  // `!== undefined`, not `??`: a stored null is the channel saying "direct", and
  // must not fall through to the site's proxy.
  const proxyUrl = alsOverride !== undefined ? alsOverride : resolved.proxyUrl;

  if (!proxyUrl) {
    return nextOptions;
  }

  const dispatcher = getDispatcherByProxyUrl(proxyUrl, alsOverride != null);
  if (!dispatcher) {
    return nextOptions;
  }

  return {
    ...nextOptions,
    dispatcher,
  };
}

export function withExplicitProxyRequestInit(
  proxyUrl: string | null | undefined,
  options?: UndiciRequestInit,
  skipCache = false,
): UndiciRequestInit {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return options ?? {};

  const dispatcher = getDispatcherByProxyUrl(normalized, skipCache);
  if (!dispatcher) return options ?? {};

  return {
    ...(options || {}),
    dispatcher,
  };
}

/**
 * One pool id → its address, from the synchronous mirror.
 *
 * For the callers that hold a bare reference and no site to fall back to (the
 * Telegram notifier, for instance). An unknown or empty id is "no proxy" — never
 * another entry.
 */
export function resolveProxyRefFromPrimedPool(ref: string | null | undefined): string | null {
  const trimmed = typeof ref === 'string' ? ref.trim() : '';
  if (!trimmed) return null;
  const entry = siteProxyCache.pool.find((candidate) => candidate.id === trimmed);
  return entry ? entry.url : null;
}

/**
 * A site's proxy: whichever pool entry it references, or none.
 *
 * `null` means "do not proxy" — full stop. There is no fallback to a global value,
 * which is what lets a site refuse a proxy at all; under the old address/opt-in
 * columns an empty value meant "ask the layer above", so no site could say no.
 */
export function resolveProxyUrlForSite(
  site: SiteProxyConfigLike | null | undefined,
  options?: { pool?: readonly ProxyPoolEntry[] },
): string | null {
  const pool = options?.pool ?? siteProxyCache.pool;
  const ref = typeof site?.proxyRef === 'string' && site.proxyRef.trim()
    ? site.proxyRef.trim()
    : null;
  if (!ref) return null;
  const entry = pool.find((candidate) => candidate.id === ref);
  // An unknown id resolves to "no proxy", never to another entry: sending traffic
  // through a proxy the operator did not choose is worse than not proxying.
  return entry ? entry.url : null;
}

/**
 * Applies an ALREADY-RESOLVED proxy decision, merging the site's custom headers.
 *
 * For callers that must pin one egress path across a whole logical attempt (every
 * retry and endpoint fallback of a proxied request): they resolve once, then reuse
 * the answer here. `null` is honoured as "direct" — there is deliberately no
 * fallback to the site and no consultation of the async-local override, because
 * either one could split a single attempt across two egress paths mid-flight.
 */
export function withResolvedProxyRequestInit(
  site: SiteProxyConfigLike | null | undefined,
  proxyUrl: string | null,
  options?: UndiciRequestInit,
): UndiciRequestInit {
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(site?.customHeaders, options?.headers);
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }
  return withExplicitProxyRequestInit(proxyUrl, nextOptions);
}

export function withSiteRecordProxyRequestInit(
  site: SiteProxyConfigLike | null | undefined,
  options?: UndiciRequestInit,
  connection?: SiteProxyConnectionLike | null,
): UndiciRequestInit {
  // An ALS override still wins over both layers: it is set by a caller that has
  // already resolved the channel and is deliberately pinning this one request.
  const alsOverride = accountProxyOverride.getStore();
  if (alsOverride != null) {
    const nextOptions: UndiciRequestInit = {
      ...(options || {}),
    };
    const mergedHeaders = mergeHeadersWithSiteCustomHeaders(site?.customHeaders, options?.headers);
    if (mergedHeaders) {
      nextOptions.headers = mergedHeaders;
    }
    return withExplicitProxyRequestInit(alsOverride, nextOptions, true);
  }

  return withResolvedProxyRequestInit(
    site,
    resolveChannelProxyUrlFromPrimedPool(site, connection?.extraConfig ?? undefined),
    options,
  );
}

/**
 * The proxy for one channel (site + connection). The single resolver every caller
 * should use.
 *
 * Layering:
 *   connection ref, if it has an opinion  →  site ref  →  no proxy
 * where the connection's `null` is an OPINION ("do not proxy") that overrides the
 * site, while an absent key means "follow the site".
 *
 * This also closed a pre-existing inconsistency: the `/v1/*` forwarding paths used
 * a helper that ignored the connection's proxy opt-in while the management paths
 * honoured it, so that setting only half worked. One resolver, one answer.
 *
 * The async form additionally refreshes the site rows before resolving; the sync
 * form answers from the primed pool mirror (see `primeSiteProxyPool`) and is what
 * the many synchronous request-init helpers use.
 */
export function resolveChannelProxyUrlFromPrimedPool(
  site: SiteProxyConfigLike | null | undefined,
  accountExtraConfig?: string | null,
): string | null {
  const ref = getProxyRefFromExtraConfig(accountExtraConfig ?? undefined);
  if (ref !== undefined) {
    // An explicit null is the connection refusing a proxy outright — the case the
    // old address/opt-in model could not express at all.
    if (ref === null) return null;
    const entry = siteProxyCache.pool.find((candidate) => candidate.id === ref);
    // An unknown id resolves to "no proxy", never to another entry: routing traffic
    // through a proxy the operator did not choose is worse than not proxying.
    return entry ? entry.url : null;
  }
  return resolveProxyUrlForSite(site);
}

export async function resolveChannelProxyUrl(
  site: SiteProxyConfigLike | null | undefined,
  accountExtraConfig?: string | null,
): Promise<string | null> {
  // Warms `siteProxyCache.pool` and the site rows.
  await getCachedSiteProxyRows();
  return resolveChannelProxyUrlFromPrimedPool(site, accountExtraConfig);
}

/**
 * The effective proxy for a connection choice that has NOT been stored yet — the
 * "test this before saving" paths, where the form's picker is the only source of the
 * answer. Takes the wire value (`undefined`/`'inherit'` = follow the site, `null` =
 * direct, an id = that entry) so the route layer never has to hand-roll the layering.
 */
export async function resolveProxyUrlForConnectionChoice(
  site: SiteProxyConfigLike | null | undefined,
  wireProxyRef: string | null | undefined,
): Promise<string | null> {
  await getCachedSiteProxyRows();
  if (wireProxyRef === undefined || wireProxyRef === PROXY_REF_INHERIT) {
    return resolveProxyUrlForSite(site);
  }
  return resolveProxyRefFromPrimedPool(parseConnectionProxyRefInput(wireProxyRef) ?? null);
}
