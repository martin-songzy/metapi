import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getOAuthProviderDefinition } from './providers.js';
import { resolveChannelProxyUrl, resolveSiteProxyUrlByRequestUrl } from '../siteProxy.js';

export async function resolveOauthProviderProxyUrl(provider: string): Promise<string | null> {
  const definition = getOAuthProviderDefinition(provider);
  if (!definition) return null;
  return resolveSiteProxyUrlByRequestUrl(definition.site.url);
}

/**
 * The proxy for one OAuth connection: its own choice, or its site's.
 *
 * Resolved against the site RECORD rather than by request URL, so a connection that
 * explicitly refused a proxy is honoured — the URL-based path cannot see that answer.
 */
export async function resolveOauthAccountProxyUrl(input: {
  siteId?: number | null;
  extraConfig?: string | null;
}): Promise<string | null> {
  if (!input.siteId || input.siteId <= 0) {
    return resolveChannelProxyUrl(null, input.extraConfig);
  }
  const site = await db.select({
    proxyRef: schema.sites.proxyRef,
  }).from(schema.sites).where(eq(schema.sites.id, input.siteId)).get();
  return resolveChannelProxyUrl(site ?? null, input.extraConfig);
}
