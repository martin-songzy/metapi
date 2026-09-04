import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isMaskedTokenValue } from './accountTokenService.js';

/**
 * Guards against the same credential being stored twice on one site.
 *
 * Three pages can each hold a credential — 完整账号 (`accounts.access_token`),
 * 直连 Key (`accounts.api_token`) and 令牌分发池 (`account_tokens.token`) — and none
 * of the three tables has a uniqueness constraint on the value, so pasting one key
 * into all three produced three rows that look like three independent credentials.
 *
 * The consequences are not cosmetic:
 *
 *   - routing builds one channel per accounts row, so a duplicated key collects
 *     double weight in weighted selection, and a cooldown recorded against one
 *     channel leaves the other hammering the same upstream key;
 *   - a duplicate under one account used to be probed twice, billing real quota
 *     twice per model (now deduped in `selectProbeKeys`, but the split-cooldown
 *     problem above has no such backstop).
 *
 * A real foreign key or unique index cannot express this: the value lives in three
 * columns across two tables, and an existing deployment may already hold duplicates
 * that a `CREATE UNIQUE INDEX` would fail on at boot. So it is checked here, on
 * writes only, leaving stored rows readable.
 */
export type DuplicateCredentialHit = {
  /** Which table holds the existing copy. */
  kind: 'account' | 'account_token';
  accountId: number;
  /** `accounts.username`, or `#id` when the row has none (直连 Key rows often do not). */
  accountLabel: string;
  /** Set only for an `account_token` hit. */
  tokenName?: string;
};

function accountLabelOf(account: { id: number; username: string | null }): string {
  const username = (account.username || '').trim();
  return username || `#${account.id}`;
}

/**
 * Masked placeholders are never compared: `sk-abc***xyz` is what upstream returns
 * for two DIFFERENT keys whose prefix and suffix happen to match, so treating two
 * of them as the same credential would reject a legitimate second key.
 */
function comparableCredential(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (isMaskedTokenValue(trimmed)) return null;
  return trimmed;
}

export async function findDuplicateCredentialOnSite(input: {
  siteId: number;
  credential: string;
  /** The account being written, so editing a row does not collide with itself. */
  excludeAccountId?: number;
  /** The `account_tokens` row being written, for the same reason. */
  excludeTokenId?: number;
}): Promise<DuplicateCredentialHit | null> {
  const credential = comparableCredential(input.credential);
  if (!credential) return null;

  const accounts = await db.select()
    .from(schema.accounts)
    .where(eq(schema.accounts.siteId, input.siteId))
    .all();

  for (const account of accounts) {
    if (account.id === input.excludeAccountId) continue;
    // Both columns, because which one holds a given key depends on the segment it
    // was added from, not on the key itself.
    if (comparableCredential(account.apiToken) === credential
      || comparableCredential(account.accessToken) === credential) {
      return { kind: 'account', accountId: account.id, accountLabel: accountLabelOf(account) };
    }
  }

  // One query for every account's tokens rather than one per account: this runs on
  // the create path, and a busy site carries tens of accounts.
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) return null;

  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(inArray(schema.accountTokens.accountId, accountIds))
    .all();

  const accountsById = new Map<number, typeof accounts[number]>();
  for (const account of accounts) accountsById.set(account.id, account);

  for (const token of tokens) {
    if (token.id === input.excludeTokenId) continue;
    if (comparableCredential(token.token) !== credential) continue;
    const owner = accountsById.get(token.accountId);
    return {
      kind: 'account_token',
      accountId: token.accountId,
      accountLabel: owner ? accountLabelOf(owner) : `#${token.accountId}`,
      tokenName: token.name || `#${token.id}`,
    };
  }

  return null;
}

/**
 * Names the existing location rather than only saying "duplicate": the operator has
 * three pages to look on, and a message that does not say which one leaves them
 * hunting for a row they cannot see from where they are standing.
 */
export function describeDuplicateCredential(hit: DuplicateCredentialHit): string {
  if (hit.kind === 'account_token') {
    return `该凭据已存在：账号 ${hit.accountLabel} 的令牌「${hit.tokenName}」。`
      + '同一个 Key 存两份会让路由把它当成两条通道，冷却也不互通。';
  }
  return `该凭据已存在：本站点的连接 ${hit.accountLabel}。`
    + '同一个 Key 存两份会让路由把它当成两条通道，冷却也不互通。';
}
