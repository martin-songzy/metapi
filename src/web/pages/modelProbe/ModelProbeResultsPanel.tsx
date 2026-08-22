import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ModelProbeResult,
  type ModelProbeResultSortBy,
  type ModelProbeResultStatus,
  type ModelProbeResultsQuery,
  type ModelProbeSite,
} from '../../api.js';
import ModernSelect from '../../components/ModernSelect.js';
import ResponsiveFilterPanel from '../../components/ResponsiveFilterPanel.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { useToast } from '../../components/Toast.js';

/**
 * Stored verdicts from past sweeps.
 *
 * The row of "生效中的筛选" is rendered from the server's own `query` echo rather
 * than from local state: the server is the one that decides what a blank term or
 * an out-of-range limit means, and showing the local draft instead would claim a
 * filter is in effect when it never reached the query.
 *
 * `reason` is upstream-authored text (already redacted server-side) and is only
 * ever rendered as a text child — never as markup.
 */

const PAGE_SIZE = 50;
const PLACEHOLDER = '—';

type ModelProbeResultsPanelProps = {
  sites: ModelProbeSite[];
  isMobile: boolean;
  /** Bumped by the run panel when a sweep finishes, so the table reloads itself. */
  refreshToken: number;
};

const STATUS_LABELS: Record<ModelProbeResultStatus, string> = {
  supported: '可用',
  unsupported: '不支持',
  inconclusive: '未确定',
  skipped: '已跳过',
};

const STATUS_COLORS: Record<ModelProbeResultStatus, string> = {
  supported: 'var(--color-success)',
  unsupported: 'var(--color-danger)',
  inconclusive: 'var(--color-warning)',
  skipped: 'var(--color-text-muted)',
};

const SORT_LABELS: Record<ModelProbeResultSortBy, string> = {
  latency: '响应速度',
  balance: '站点余额',
  checkedAt: '探测时间',
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-muted)',
  lineHeight: 1.7,
};

const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 13,
  outline: 'none',
};

/** Nullable columns are null in normal operation (a skipped model has no latency). */
function formatLatency(value: number | null): string {
  return value === null || !Number.isFinite(value) ? PLACEHOLDER : `${Math.round(value)} ms`;
}

function formatBalance(value: number | null): string {
  return value === null || !Number.isFinite(value) ? PLACEHOLDER : value.toFixed(2);
}

function formatText(value: string | null): string {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : PLACEHOLDER;
}

function formatCheckedAt(value: string | null): string {
  if (!value) return PLACEHOLDER;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export default function ModelProbeResultsPanel({ sites, isMobile, refreshToken }: ModelProbeResultsPanelProps) {
  const toast = useToast();
  const [modelDraft, setModelDraft] = useState('');
  const [query, setQuery] = useState<ModelProbeResultsQuery>({
    sortBy: 'checkedAt',
    order: 'desc',
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [items, setItems] = useState<ModelProbeResult[]>([]);
  const [total, setTotal] = useState(0);
  const [appliedQuery, setAppliedQuery] = useState<ModelProbeResultsQuery | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);

  /**
   * `cancelled` is the repo's standard stale-response guard (see `TokensPanel`,
   * `Models`, `ModelProbeRunPanel`). Without it a slow earlier request can land
   * after a newer one and repaint the table, leaving the rows disagreeing with
   * the sort button rendered as active and with the applied-filter echo.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const response = await api.getModelProbeResults(query);
        if (cancelled) return;
        setItems(Array.isArray(response.items) ? response.items : []);
        setTotal(Number.isFinite(response.total) ? response.total : 0);
        setAppliedQuery(response.query ?? {});
        setLoadError('');
      } catch (error: any) {
        if (cancelled) return;
        const message = error?.message || '加载探测结果失败';
        setItems([]);
        setTotal(0);
        setAppliedQuery(null);
        setLoadError(message);
        toast.error(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [query, refreshToken, toast]);

  /** Any filter or sort change resets paging: page 3 of the old filter is meaningless. */
  const applyQuery = (patch: Partial<ModelProbeResultsQuery>) => {
    setQuery((prev) => {
      const next: ModelProbeResultsQuery = { ...prev, ...patch, offset: 0 };
      if (patch.model !== undefined && !patch.model) delete next.model;
      if (patch.siteId !== undefined && !patch.siteId) delete next.siteId;
      if (patch.status !== undefined && !patch.status) delete next.status;
      return next;
    });
  };

  const handleSort = (sortBy: ModelProbeResultSortBy) => {
    // Same field again flips direction; a new field starts at its most useful
    // direction — fastest first for latency, richest first for balance.
    const sameField = query.sortBy === sortBy;
    const defaultOrder: 'asc' | 'desc' = sortBy === 'latency' ? 'asc' : 'desc';
    const order: 'asc' | 'desc' = sameField ? (query.order === 'asc' ? 'desc' : 'asc') : defaultOrder;
    applyQuery({ sortBy, order });
  };

  const siteOptions = useMemo(() => [
    { value: '', label: '全部站点' },
    ...sites.map((site) => ({ value: String(site.id), label: site.name })),
  ], [sites]);

  const statusOptions = useMemo(() => [
    { value: '', label: '全部状态' },
    ...(Object.keys(STATUS_LABELS) as ModelProbeResultStatus[]).map((value) => ({
      value,
      label: STATUS_LABELS[value],
    })),
  ], []);

  const siteNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const site of sites) map.set(site.id, site.name);
    return map;
  }, [sites]);

  const appliedText = useMemo(() => {
    const applied = appliedQuery;
    if (!applied) return '';
    const siteLabel = applied.siteId === undefined
      ? '全部站点'
      : (siteNameById.get(applied.siteId) ?? `站点 #${applied.siteId}`);
    const statusLabel = applied.status === undefined ? '全部状态' : STATUS_LABELS[applied.status];
    const sortBy = applied.sortBy ?? 'checkedAt';
    const order = applied.order === 'asc' ? '升序' : '降序';
    const modelLabel = applied.model ? `模型 ${applied.model}` : '全部模型';
    return `生效中：${modelLabel} · ${siteLabel} · ${statusLabel} · 按${SORT_LABELS[sortBy]}${order}`;
  }, [appliedQuery, siteNameById]);

  const filterFields = (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 170 }}>
        <div style={{ ...hintStyle, marginBottom: 4 }}>模型名</div>
        <input
          type="text"
          data-testid="model-probe-results-model"
          value={modelDraft}
          onChange={(event) => setModelDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyQuery({ model: modelDraft.trim() });
          }}
          placeholder="按模型名模糊搜索"
          style={textInputStyle}
        />
      </div>
      <div style={{ flex: '0 1 160px', minWidth: 140 }}>
        <div style={{ ...hintStyle, marginBottom: 4 }}>站点</div>
        <ModernSelect
          data-testid="model-probe-results-site"
          size="sm"
          value={query.siteId === undefined ? '' : String(query.siteId)}
          onChange={(value) => applyQuery({ siteId: value ? Number(value) : undefined })}
          options={siteOptions}
        />
      </div>
      <div style={{ flex: '0 1 140px', minWidth: 130 }}>
        <div style={{ ...hintStyle, marginBottom: 4 }}>状态</div>
        <ModernSelect
          data-testid="model-probe-results-status"
          size="sm"
          value={query.status ?? ''}
          onChange={(value) => applyQuery({ status: (value || undefined) as ModelProbeResultStatus | undefined })}
          options={statusOptions}
        />
      </div>
      <button
        type="button"
        data-testid="model-probe-results-apply"
        className="btn btn-ghost"
        style={{ border: '1px solid var(--color-border)' }}
        onClick={() => applyQuery({ model: modelDraft.trim() })}
      >
        查询
      </button>
    </div>
  );

  const sortButtons = (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {(Object.keys(SORT_LABELS) as ModelProbeResultSortBy[]).map((field) => {
        const active = query.sortBy === field;
        return (
          <button
            key={field}
            type="button"
            data-testid={`model-probe-sort-${field}`}
            className="btn btn-ghost"
            style={{
              border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
              color: active ? 'var(--color-primary)' : undefined,
              padding: '6px 12px',
              fontSize: 12,
            }}
            onClick={() => handleSort(field)}
          >
            {SORT_LABELS[field]}
            {active ? (query.order === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        );
      })}
    </div>
  );

  const renderStatus = (status: ModelProbeResultStatus) => (
    <span style={{ color: STATUS_COLORS[status], fontWeight: 600, fontSize: 12 }}>
      {STATUS_LABELS[status]}
    </span>
  );

  const renderReason = (row: ModelProbeResult) => {
    const parts: string[] = [];
    if (row.httpStatus !== null) parts.push(`HTTP ${row.httpStatus}`);
    if (row.failureKind) parts.push(row.failureKind);
    const prefix = parts.length > 0 ? `${parts.join(' / ')}` : '';
    const reason = String(row.reason ?? '').trim();
    if (!prefix && !reason) return PLACEHOLDER;
    // Text children only: `reason` is upstream-authored.
    return (
      <span style={{ fontSize: 12, lineHeight: 1.6, wordBreak: 'break-word' }}>
        {prefix && <span style={{ color: 'var(--color-text-muted)' }}>{prefix}{reason ? ' · ' : ''}</span>}
        {reason}
      </span>
    );
  };

  const offset = query.offset ?? 0;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const renderMobileRows = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((row) => (
        <MobileCard
          key={row.id}
          className={`model-probe-result-row-${row.id}`}
          title={row.modelName}
          subtitle={row.siteName}
          headerActions={renderStatus(row.status)}
        >
          <div data-testid={`model-probe-result-row-${row.id}`}>
            <MobileField label="账号" value={formatText(row.accountUsername)} />
            <MobileField label="余额" value={formatBalance(row.balance)} />
            <MobileField label="响应" value={formatLatency(row.latencyMs)} />
            <MobileField label="接口" value={formatText(row.endpointUsed)} stacked />
            <MobileField label="探测时间" value={formatCheckedAt(row.checkedAt)} />
            <MobileField label="原因" value={renderReason(row)} stacked />
          </div>
        </MobileCard>
      ))}
    </div>
  );

  const renderDesktopRows = () => (
    <div data-testid="model-probe-results-table" style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>站点 / 账号</th>
            <th>模型</th>
            <th>状态</th>
            <th>响应</th>
            <th>余额</th>
            <th style={{ minWidth: 170 }}>接口</th>
            <th style={{ minWidth: 150 }}>探测时间</th>
            <th style={{ minWidth: 220 }}>原因</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id} data-testid={`model-probe-result-row-${row.id}`}>
              <td>
                <div style={{ fontWeight: 600 }}>{row.siteName}</div>
                <div style={hintStyle}>{formatText(row.accountUsername)}</div>
              </td>
              <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{row.modelName}</td>
              <td>{renderStatus(row.status)}</td>
              <td>{formatLatency(row.latencyMs)}</td>
              <td>{formatBalance(row.balance)}</td>
              <td style={{ fontSize: 12, wordBreak: 'break-all' }}>{formatText(row.endpointUsed)}</td>
              <td style={{ fontSize: 12 }}>{formatCheckedAt(row.checkedAt)}</td>
              <td>{renderReason(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="card" data-testid="model-probe-results-panel" style={{ padding: 18, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>探测结果</div>
          <div style={{ ...hintStyle, marginTop: 6 }}>
            每行是一次真实请求得出的结论。「未确定」只说明这次没测出来，不代表模型不可用。
          </div>
        </div>
        {sortButtons}
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={filterOpen}
        onMobileOpen={() => setFilterOpen(true)}
        onMobileClose={() => setFilterOpen(false)}
        mobileTitle="筛选探测结果"
        mobileContent={filterFields}
        desktopContent={<div style={{ marginBottom: 12 }}>{filterFields}</div>}
      />

      {appliedText && (
        <div data-testid="model-probe-results-applied" style={{ ...hintStyle, marginBottom: 10 }}>
          {appliedText} · 共 {total} 条
        </div>
      )}

      {loadError && (
        <div className="alert alert-error" data-testid="model-probe-results-error" style={{ marginBottom: 12 }}>
          {loadError}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner spinner-sm" /></div>
      ) : items.length === 0 ? (
        <div data-testid="model-probe-results-empty" style={{ padding: 24, textAlign: 'center' }}>
          <div className="empty-state-title">还没有符合条件的探测结果</div>
          <div className="empty-state-desc">
            {loadError
              ? '结果加载失败，这里的空白不代表没有结果。'
              : '发起一次探测后结果会出现在这里；如果刚跑完仍然是空的，通常是没有模型匹配到正则。'}
          </div>
        </div>
      ) : isMobile ? renderMobileRows() : renderDesktopRows()}

      {(canPrev || canNext) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            data-testid="model-probe-results-prev"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => setQuery((prev) => ({ ...prev, offset: Math.max(0, (prev.offset ?? 0) - PAGE_SIZE) }))}
            disabled={!canPrev || loading}
          >
            上一页
          </button>
          <button
            type="button"
            data-testid="model-probe-results-next"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => setQuery((prev) => ({ ...prev, offset: (prev.offset ?? 0) + PAGE_SIZE }))}
            disabled={!canNext || loading}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

