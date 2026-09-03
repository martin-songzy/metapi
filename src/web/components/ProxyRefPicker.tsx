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
  /** Shown under the control as 最终生效, so the layered answer is never a guess. */
  effectiveUrl?: string | null;
  effectiveSource?: string | null;
  disabled?: boolean;
  idPrefix?: string;
};

/**
 * The sentinel `<option>` value standing in for `null`.
 *
 * A select cannot carry a non-string value, and the empty string is already what a
 * browser reports for "nothing chosen" — using it for 不走代理 would make an
 * unmounted or reset control silently mean "go direct".
 */
const DIRECT_OPTION_VALUE = '__direct__';

const selectStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 13,
  outline: 'none',
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
  const selectValue = value === null ? DIRECT_OPTION_VALUE : value;

  return (
    <div data-testid={`${idPrefix}-picker`}>
      <select
        data-testid={`${idPrefix}-select`}
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === DIRECT_OPTION_VALUE ? null : next);
        }}
        style={selectStyle}
      >
        {allowInherit && (
          <option data-testid={`${idPrefix}-inherit`} value={PROXY_REF_INHERIT}>跟随站点</option>
        )}
        <option data-testid={`${idPrefix}-direct`} value={DIRECT_OPTION_VALUE}>不走代理</option>
        {entries.map((entry) => (
          <option key={entry.id} data-testid={`${idPrefix}-entry-${entry.id}`} value={entry.id}>
            {entry.name} — {maskProxyCredentials(entry.url)}
          </option>
        ))}
        {/*
          A reference to a deleted entry keeps its own option rather than snapping the
          control to the first one: silently re-pointing a site at a DIFFERENT proxy on
          open is the failure this whole consolidation exists to remove. It reads as
          "no proxy" at request time, and this says so.
        */}
        {selectValue !== PROXY_REF_INHERIT
          && selectValue !== DIRECT_OPTION_VALUE
          && !entries.some((entry) => entry.id === selectValue) && (
          <option data-testid={`${idPrefix}-missing`} value={selectValue}>
            引用的代理已删除（按不走代理处理）
          </option>
        )}
      </select>

      {entries.length === 0 && (
        <div
          data-testid={`${idPrefix}-empty`}
          style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingTop: 6 }}
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
