import { type CSSProperties } from 'react';
import type { ProxyPoolEntry } from '../api.js';
import { PROXY_REF_INHERIT } from '../proxyRefWire.js';

/**
 * The one control sites and connections use to choose a proxy.
 *
 * Deliberately a PICKER, never an input: addresses are entered in exactly one place
 * (设置 → 代理池) and everything else references an entry by id. That is the whole
 * point of the consolidation — three address fields in three pages meant three ways
 * to disagree about which proxy a request actually used.
 *
 * `allowInherit` is what separates the two callers. A site has two answers (an entry,
 * or 不走代理). A connection has three, because it sits above a site and needs to be
 * able to say 跟随站点 as well as to override it — and "跟随" has to be distinct from
 * "不走", or a connection could never refuse a proxy its site had set.
 */
export type ProxyRefPickerProps = {
  entries: ProxyPoolEntry[];
  /** Wire value: `null` = 不走代理, `'inherit'` = 跟随站点, an id = that entry. */
  value: string | null;
  onChange: (next: string | null) => void;
  allowInherit?: boolean;
  /** Shown under the radio group as 最终生效, so the layered answer is never a guess. */
  effectiveUrl?: string | null;
  effectiveSource?: string | null;
  disabled?: boolean;
  idPrefix?: string;
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 0',
  fontSize: 13,
};

function maskProxyCredentials(url: string): string {
  // A pool address may carry user:password. The picker is a read-back surface, and an
  // error toast echoing a proxy password is exactly how one leaks into a screenshot.
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = parsed.username ? '***' : '';
    parsed.password = parsed.password ? '***' : '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function ProxyRefPicker({
  entries,
  value,
  onChange,
  allowInherit = false,
  effectiveUrl,
  effectiveSource,
  disabled = false,
  idPrefix = 'proxy-ref',
}: ProxyRefPickerProps) {
  const groupName = `${idPrefix}-group`;

  return (
    <div data-testid={`${idPrefix}-picker`}>
      {allowInherit && (
        <label style={rowStyle}>
          <input
            type="radio"
            name={groupName}
            data-testid={`${idPrefix}-inherit`}
            checked={value === PROXY_REF_INHERIT}
            disabled={disabled}
            onChange={() => onChange(PROXY_REF_INHERIT)}
          />
          <span>跟随站点</span>
        </label>
      )}

      <label style={rowStyle}>
        <input
          type="radio"
          name={groupName}
          data-testid={`${idPrefix}-direct`}
          checked={value === null}
          disabled={disabled}
          onChange={() => onChange(null)}
        />
        <span>不走代理</span>
      </label>

      {entries.map((entry) => (
        <label key={entry.id} style={rowStyle}>
          <input
            type="radio"
            name={groupName}
            data-testid={`${idPrefix}-entry-${entry.id}`}
            checked={value === entry.id}
            disabled={disabled}
            onChange={() => onChange(entry.id)}
          />
          <span>{entry.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
            {maskProxyCredentials(entry.url)}
          </span>
        </label>
      ))}

      {entries.length === 0 && (
        <div
          data-testid={`${idPrefix}-empty`}
          style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '6px 0' }}
        >
          代理池为空。地址统一在「设置 → 代理池」里添加，这里只做选择。
        </div>
      )}

      {effectiveUrl !== undefined && (
        <div
          data-testid={`${idPrefix}-effective`}
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--color-text-muted)',
            borderTop: '1px dashed var(--color-border)',
            paddingTop: 8,
          }}
        >
          最终生效：{effectiveUrl ? maskProxyCredentials(effectiveUrl) : '不走代理'}
          {effectiveSource ? `（${effectiveSource}）` : ''}
        </div>
      )}
    </div>
  );
}

/**
 * The address a choice resolves to, mirroring the server's layering so the form can
 * show 最终生效 without a round trip. Keep in step with `resolveChannelProxyUrl`.
 */
export function resolveEffectiveProxy(input: {
  entries: ProxyPoolEntry[];
  connectionRef?: string | null;
  siteRef?: string | null;
}): { url: string | null; source: string } {
  const findUrl = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const entry = input.entries.find((candidate) => candidate.id === id);
    // An unknown id is "no proxy", never another entry — same rule as the server.
    return entry ? entry.url : null;
  };

  if (input.connectionRef !== undefined && input.connectionRef !== PROXY_REF_INHERIT) {
    if (input.connectionRef === null) return { url: null, source: '连接：不走代理' };
    const url = findUrl(input.connectionRef);
    return url
      ? { url, source: '连接' }
      : { url: null, source: '连接引用的代理已不存在' };
  }

  if (!input.siteRef) return { url: null, source: '站点：不走代理' };
  const siteUrl = findUrl(input.siteRef);
  return siteUrl
    ? { url: siteUrl, source: '站点' }
    : { url: null, source: '站点引用的代理已不存在' };
}
