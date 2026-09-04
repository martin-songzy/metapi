import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ModelProbeKeyResult,
  type ModelProbeKeyResultStatus,
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

/**
 * Identifies the desktop table's columns.
 *
 * A registry rather than inline `<th>`/`<td>` pairs, because visibility and width
 * both need a stable key to persist against, and because a header and its cell
 * drifting out of order is the classic way a table like this breaks silently.
 */
type ResultColumnKey =
  | 'site' | 'model' | 'status' | 'key' | 'latency' | 'balance'
  | 'endpoint' | 'checkedAt' | 'prompt' | 'userAgent' | 'reason';

const COLUMN_LABELS: Record<ResultColumnKey, string> = {
  site: '站点 / 账号',
  model: '模型',
  status: '状态',
  key: 'Key',
  latency: '响应',
  balance: '余额',
  endpoint: '接口',
  checkedAt: '探测时间',
  prompt: '提示词',
  userAgent: 'User-Agent',
  reason: '原因',
};

const COLUMN_ORDER: ResultColumnKey[] = [
  'site', 'model', 'key', 'status', 'latency', 'balance',
  'endpoint', 'checkedAt', 'prompt', 'userAgent', 'reason',
];

const DEFAULT_COLUMN_WIDTHS: Partial<Record<ResultColumnKey, number>> = {
  key: 150,
  endpoint: 170,
  checkedAt: 150,
  prompt: 200,
  userAgent: 200,
  reason: 220,
};

/**
 * `prompt` and `userAgent` are hidden by default: they answer a real question —
 * probe prompts are drawn at random from a configurable pool, so "which prompt
 * produced this verdict?" is not otherwise answerable, and it matters most for the
 * `empty_content` verdict where a model returned a valid shape with no text — but
 * showing them unasked would crowd a table the operator already reports as too wide.
 */
const DEFAULT_HIDDEN_COLUMNS: ResultColumnKey[] = ['prompt', 'userAgent'];

const COLUMN_LAYOUT_STORAGE_KEY = 'metapi.modelProbe.results.columns.v2';
const MIN_COLUMN_WIDTH = 80;

/**
 * Fallback width for a column the operator has never resized.
 *
 * Every column needs one, because the table is sized by content rather than
 * stretched to the viewport: see the `<table>` style for why.
 */
const FALLBACK_COLUMN_WIDTH = 140;

/**
 * 全部 maps to the server's own ceiling rather than to "no limit": the endpoint
 * caps `limit` at 500 anyway, so pretending otherwise would silently truncate.
 */
const PAGE_SIZE_OPTIONS = [50, 100, 500] as const;
const ALL_PAGE_SIZE = 500;

type ColumnLayout = {
  hidden: ResultColumnKey[];
  widths: Partial<Record<ResultColumnKey, number>>;
};

function defaultColumnLayout(): ColumnLayout {
  return { hidden: [...DEFAULT_HIDDEN_COLUMNS], widths: {} };
}

/**
 * Reads the persisted layout, discarding anything that no longer makes sense.
 *
 * Unknown keys are dropped rather than kept: a layout stored by an older build can
 * name a column that has since been removed, and carrying it through would leave
 * the table permanently hiding a column that no checkbox can restore. Any parse or
 * storage failure falls back to defaults — a corrupt preference must not break the
 * page, and `localStorage` itself is absent in the test environment.
 */
function readColumnLayout(): ColumnLayout {
  try {
    const raw = globalThis.localStorage?.getItem(COLUMN_LAYOUT_STORAGE_KEY);
    if (!raw) return defaultColumnLayout();

    const parsed = JSON.parse(raw) as Partial<ColumnLayout> | null;
    if (!parsed || typeof parsed !== 'object') return defaultColumnLayout();

    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((key): key is ResultColumnKey => COLUMN_ORDER.includes(key as ResultColumnKey))
      : [...DEFAULT_HIDDEN_COLUMNS];

    const widths: Partial<Record<ResultColumnKey, number>> = {};
    if (parsed.widths && typeof parsed.widths === 'object') {
      for (const [key, value] of Object.entries(parsed.widths)) {
        if (!COLUMN_ORDER.includes(key as ResultColumnKey)) continue;
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        widths[key as ResultColumnKey] = Math.max(MIN_COLUMN_WIDTH, Math.round(value));
      }
    }

    return { hidden, widths };
  } catch {
    return defaultColumnLayout();
  }
}

function writeColumnLayout(layout: ColumnLayout): void {
  try {
    globalThis.localStorage?.setItem(COLUMN_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // A full or unavailable storage must not stop the operator resizing a column.
  }
}

type ModelProbeResultsPanelProps = {
  sites: ModelProbeSite[];
  isMobile: boolean;
  /** Bumped by the run panel when a sweep finishes, so the table reloads itself. */
  refreshToken: number;
  /** Called after a successful 清空结果 so the parent bumps `refreshToken`. */
  onResultsCleared?: () => void;
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

/**
 * Extends the site-scoped vocabulary with the two states only a per-key verdict
 * has. 「已停用」 and 「密钥不可用」 are deliberately not merged into 「未确定」:
 * that one means the probe ran and could not attribute the failure, while these
 * two mean no request was ever sent for this key — a distinction that matters
 * both diagnostically and because every probe costs the operator money.
 */
const KEY_STATUS_LABELS: Record<ModelProbeKeyResultStatus, string> = {
  ...STATUS_LABELS,
  disabled: '已停用',
  unavailable: '密钥不可用',
};

/** Both never-probed states read as muted: neither is a verdict about the model. */
const KEY_STATUS_COLORS: Record<ModelProbeKeyResultStatus, string> = {
  ...STATUS_COLORS,
  disabled: 'var(--color-text-muted)',
  unavailable: 'var(--color-text-muted)',
};

/**
 * The primary key has no stored name — it lives on the account row, not in
 * `account_tokens` — so it is labelled here rather than rendered blank. An
 * unnamed additional key falls back to its row id so two nameless keys stay
 * tellable apart, matching how the task log describes them.
 */
function describeKeyLabel(entry: { isPrimary: boolean; tokenName: string; tokenId: number }): string {
  if (entry.isPrimary) return '主 Key';
  return entry.tokenName ? entry.tokenName : `Key #${entry.tokenId}`;
}

const SORT_LABELS: Record<ModelProbeResultSortBy, string> = {
  site: '站点',
  model: '模型',
  status: '状态',
  key: 'Key',
  latency: '响应速度',
  balance: '站点余额',
  endpoint: '接口',
  checkedAt: '探测时间',
  prompt: '提示词',
  userAgent: 'User-Agent',
  reason: '原因',
};


/**
 * Which direction a column opens on when first clicked.
 *
 * The useful default differs by column: fastest first for latency, richest first
 * for balance, newest first for a timestamp, and A→Z for anything textual.
 */
const SORT_DEFAULT_ORDER: Record<ModelProbeResultSortBy, 'asc' | 'desc'> = {
  site: 'asc',
  model: 'asc',
  status: 'asc',
  key: 'asc',
  latency: 'asc',
  balance: 'desc',
  endpoint: 'asc',
  checkedAt: 'desc',
  prompt: 'asc',
  userAgent: 'asc',
  reason: 'asc',
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

export default function ModelProbeResultsPanel({ sites, isMobile, refreshToken, onResultsCleared }: ModelProbeResultsPanelProps) {
  const toast = useToast();
  const [modelDraft, setModelDraft] = useState('');
  const [query, setQuery] = useState<ModelProbeResultsQuery>({
    sortBy: 'checkedAt',
    order: 'desc',
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [items, setItems] = useState<ModelProbeResult[]>([]);
  const [keyItems, setKeyItems] = useState<ModelProbeKeyResult[]>([]);
  const [total, setTotal] = useState(0);
  const [appliedQuery, setAppliedQuery] = useState<ModelProbeResultsQuery | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [layout, setLayout] = useState<ColumnLayout>(() => readColumnLayout());
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  /**
   * Client-side, unlike every other filter here, and deliberately so: the marker
   * it filters on is not a stored column but a comparison BETWEEN the per-key rows
   * of one site×model pair, so the server would have to self-join the key table to
   * express it. The comparison is already computed below for rendering, and the
   * page is at most `PAGE_SIZE` rows, so filtering here costs nothing and cannot
   * disagree with the badge the operator is looking at.
   *
   * The cost is honest and stated in the label: it narrows THIS page, not the whole
   * result set, so a page of 50 showing 3 matches does not mean the sweep found 3.
   */
  const [backupOnly, setBackupOnly] = useState(false);

  /**
   * 清空结果 is all-or-nothing across every site and model — the server offers no
   * scoped delete, on purpose: the visible filters are for VIEWING, and a filtered
   * delete would let one misclick destroy rows the operator believed untouched.
   * Hence the confirm copy spells out the blast radius instead of saying 当前筛选.
   */
  const handleClearResults = async () => {
    const confirmed = globalThis.confirm?.(
      '将删除全部探测结果（所有站点、所有模型），不可恢复。确认清空？',
    );
    if (!confirmed) return;

    setClearing(true);
    try {
      await api.clearModelProbeResults();
      toast.success('探测结果已清空');
      onResultsCleared?.();
    } catch (error: any) {
      toast.error(error?.message || '清空探测结果失败');
    } finally {
      setClearing(false);
    }
  };

  const hiddenColumns = useMemo(() => new Set(layout.hidden), [layout.hidden]);
  const visibleColumns = useMemo(
    () => COLUMN_ORDER.filter((key) => !hiddenColumns.has(key)),
    [hiddenColumns],
  );

  const persistLayout = (next: ColumnLayout) => {
    setLayout(next);
    writeColumnLayout(next);
  };

  const toggleColumn = (key: ResultColumnKey) => {
    const hidden = hiddenColumns.has(key)
      ? layout.hidden.filter((entry) => entry !== key)
      : [...layout.hidden, key];
    persistLayout({ ...layout, hidden });
  };

  const setColumnWidth = (key: ResultColumnKey, width: number) => {
    persistLayout({
      ...layout,
      widths: { ...layout.widths, [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) },
    });
  };

  const resetColumnLayout = () => persistLayout(defaultColumnLayout());

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
        // Absent on an older server, which is not the same as "one key": an empty
        // array means no key breakdown is available, and the Key column says so
        // rather than implying the primary key was the only one probed.
        setKeyItems(Array.isArray(response.keyItems) ? response.keyItems : []);
        setTotal(Number.isFinite(response.total) ? response.total : 0);
        setAppliedQuery(response.query ?? {});
        setLoadError('');
      } catch (error: any) {
        if (cancelled) return;
        const message = error?.message || '加载探测结果失败';
        setItems([]);
        setKeyItems([]);
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
    // Same field again flips direction; a new field opens on whichever direction is
    // most useful for that column.
    const sameField = query.sortBy === sortBy;
    const order: 'asc' | 'desc' = sameField
      ? (query.order === 'asc' ? 'desc' : 'asc')
      : SORT_DEFAULT_ORDER[sortBy];
    applyQuery({ sortBy, order });
  };

  /**
   * Page size resets the offset with it: keeping offset 100 while shrinking the page
   * to 50 would silently skip a page rather than resize the current one.
   */
  const handlePageSize = (limit: number) => {
    setQuery((prev) => ({ ...prev, limit, offset: 0 }));
  };

  const siteOptions = useMemo(() => [
    { value: '', label: '全部站点' },
    ...sites.map((site) => ({ value: String(site.id), label: site.name })),
  ], [sites]);

  const statusOptions = useMemo(() => [
    { value: '', label: '全部状态' },
    ...(Object.keys(KEY_STATUS_LABELS) as ModelProbeKeyResultStatus[]).map((value) => ({
      value,
      label: KEY_STATUS_LABELS[value],
    })),
  ], []);

  const siteNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const site of sites) map.set(site.id, site.name);
    return map;
  }, [sites]);

  /**
   * Per-key verdicts grouped by the site×model row they belong to.
   *
   * Keyed on `siteId + modelName` because that is the identity of a row in
   * `items` — the per-key rows arrive scoped to exactly the page being shown, so
   * a row with no entry here genuinely has no key breakdown (an older server, or
   * a verdict stored before this feature existed) rather than one key.
   */
  const keyResultsByRow = useMemo(() => {
    const map = new Map<string, ModelProbeKeyResult[]>();
    for (const entry of keyItems) {
      const rowKey = `${entry.siteId}::${entry.modelName}`;
      const bucket = map.get(rowKey);
      if (bucket) bucket.push(entry);
      else map.set(rowKey, [entry]);
    }
    return map;
  }, [keyItems]);

  const keyResultsFor = (row: ModelProbeResult): ModelProbeKeyResult[] =>
    keyResultsByRow.get(`${row.siteId}::${row.modelName}`) ?? [];

  /**
   * True when the primary key could not serve this model but some additional key
   * could.
   *
   * This is the case the whole per-key axis exists to surface, and it is the one
   * an operator cannot find by eye: it only shows up by comparing same-named rows
   * across keys, hundreds of rows deep. Note what it does NOT imply — the router
   * still forwards with the primary key, so a model marked here is reachable only
   * if the operator promotes that key. It is a finding, not a fix.
   *
   * Requires a real primary verdict to be present: with no primary row at all
   * there is nothing to contrast against, and calling that 「仅备用 Key 可用」
   * would claim a comparison that never happened.
   */
  const isBackupOnly = (row: ModelProbeResult): boolean => {
    const keys = keyResultsFor(row);
    const primary = keys.find((entry) => entry.isPrimary);
    if (!primary || primary.status === 'supported') return false;
    return keys.some((entry) => !entry.isPrimary && entry.status === 'supported');
  };

  /**
   * Filtered client-side, unlike every other filter here, which the server
   * applies.
   *
   * It has to be: the marker is derived by comparing a row's key verdicts against
   * each other, and the server returns key rows scoped to the page it already
   * chose. Pushing this into the query would mean a second, differently-bounded
   * pass over both tables.
   *
   * The honest consequence, stated in the UI: this narrows the CURRENT page, so
   * the count shown is "n of this page", not a total across the result set.
   */
  const visibleItems = useMemo(
    () => (backupOnly ? items.filter((row) => isBackupOnly(row)) : items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backupOnly, items, keyResultsByRow],
  );

  const backupOnlyCount = useMemo(
    () => items.filter((row) => isBackupOnly(row)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, keyResultsByRow],
  );

  const appliedText = useMemo(() => {
    const applied = appliedQuery;
    if (!applied) return '';
    const siteLabel = applied.siteId === undefined
      ? '全部站点'
      : (siteNameById.get(applied.siteId) ?? `站点 #${applied.siteId}`);
    const statusLabel = applied.status === undefined ? '全部状态' : KEY_STATUS_LABELS[applied.status];
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
          onChange={(value) => applyQuery({ status: (value || undefined) as ModelProbeKeyResultStatus | undefined })}
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
      {/*
        Not a ModernSelect alongside the others: it is not a server-side filter and
        grouping it with those would imply it narrows the whole result set. The
        label says 本页 for the same reason.
      */}
      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: 'var(--color-text-muted)', cursor: 'pointer',
        }}
        title="主 Key 不可用、但该站点下某个备用 Key 可用的模型。仅筛选当前页。"
      >
        <input
          type="checkbox"
          data-testid="model-probe-results-backup-only"
          checked={backupOnly}
          onChange={(event) => setBackupOnly(event.target.checked)}
        />
        仅备用 Key 可用（本页 {backupOnlyCount}）
      </label>
    </div>
  );

  const ariaSortFor = (field: ModelProbeResultSortBy): 'ascending' | 'descending' | 'none' => {
    if (query.sortBy !== field) return 'none';
    return query.order === 'asc' ? 'ascending' : 'descending';
  };

  const sortButtonLabel = (field: ModelProbeResultSortBy, active: boolean) => {
    if (!active) return `按${SORT_LABELS[field]}排序`;
    const current = query.order === 'asc' ? '升序' : '降序';
    const next = query.order === 'asc' ? '降序' : '升序';
    return `按${SORT_LABELS[field]}排序，当前${current}，点击改为${next}`;
  };

  const renderStatus = (status: ModelProbeKeyResultStatus) => (
    <span style={{ color: KEY_STATUS_COLORS[status], fontWeight: 600, fontSize: 12 }}>
      {KEY_STATUS_LABELS[status]}
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
  const pageSize = query.limit ?? PAGE_SIZE;
  const canPrev = offset > 0;
  const canNext = offset + pageSize < total;


  const renderMobileRows = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {visibleItems.map((row) => (
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
            <MobileField label="Key" value={describeKeyLabel(row)} />
            <MobileField label="原因" value={renderReason(row)} stacked />
          </div>
        </MobileCard>
      ))}
    </div>
  );

  const renderColumnCell = (key: ResultColumnKey, row: ModelProbeResult): React.ReactNode => {
    switch (key) {
      case 'site':
        return (
          <>
            <div style={{ fontWeight: 600 }}>{row.siteName}</div>
            <div style={hintStyle}>{formatText(row.accountUsername)}</div>
          </>
        );
      case 'model':
        return <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{row.modelName}</span>;
      case 'status':
        return renderStatus(row.status);
      case 'key':
        return (
          <span
            data-testid={`model-probe-result-key-${row.id}`}
            style={{ fontSize: 12, wordBreak: 'break-word' }}
            title={row.isPrimary ? '账号自带的主 Key，路由转发用的就是它' : undefined}
          >
            {describeKeyLabel(row)}
          </span>
        );
      case 'latency':
        return formatLatency(row.latencyMs);
      case 'balance':
        return formatBalance(row.balance);
      case 'endpoint':
        return <span style={{ fontSize: 12, wordBreak: 'break-all' }}>{formatText(row.endpointUsed)}</span>;
      case 'checkedAt':
        return <span style={{ fontSize: 12 }}>{formatCheckedAt(row.checkedAt)}</span>;
      case 'prompt':
        // Upstream-neutral but operator-authored text; rendered as a text child only.
        return <span style={{ fontSize: 12, wordBreak: 'break-word' }}>{formatText(row.promptUsed)}</span>;
      case 'userAgent':
        return <span style={{ fontSize: 12, wordBreak: 'break-all' }}>{formatText(row.userAgentUsed)}</span>;
      case 'reason':
      default:
        return renderReason(row);
    }
  };

  const SORTABLE_COLUMNS: Record<ResultColumnKey, ModelProbeResultSortBy> = {
    site: 'site',
    model: 'model',
    status: 'status',
    key: 'key',
    latency: 'latency',
    balance: 'balance',
    endpoint: 'endpoint',
    checkedAt: 'checkedAt',
    prompt: 'prompt',
    userAgent: 'userAgent',
    reason: 'reason',
  };

  /**
   * Drag-to-resize.
   *
   * Bound on the handle, not the `<th>`, and it stops propagation so the gesture
   * cannot also fire the header's sort toggle — a resize that silently re-sorted the
   * page would be worse than no resize at all. Listeners live on `window` for the
   * duration of the drag so the pointer can leave the handle without stranding it.
   */
  const startColumnResize = (key: ResultColumnKey, startX: number, startWidth: number) => {
    const onMove = (event: PointerEvent) => {
      setColumnWidth(key, startWidth + (event.clientX - startX));
    };
    const onUp = () => {
      globalThis.removeEventListener?.('pointermove', onMove);
      globalThis.removeEventListener?.('pointerup', onUp);
    };
    globalThis.addEventListener?.('pointermove', onMove);
    globalThis.addEventListener?.('pointerup', onUp);
  };

  const columnSettings = (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="model-probe-results-column-toggle"
        className="btn btn-ghost"
        style={{ border: '1px solid var(--color-border)' }}
        onClick={() => setColumnMenuOpen((open) => !open)}
      >
        列设置（{visibleColumns.length}/{COLUMN_ORDER.length}）
      </button>
      {columnMenuOpen && (
        <div
          data-testid="model-probe-results-column-menu"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            zIndex: 20,
            background: 'var(--color-bg-elevated, var(--color-bg))',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: 10,
            minWidth: 180,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          {COLUMN_ORDER.map((key) => (
            <label
              key={key}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}
            >
              <input
                type="checkbox"
                data-testid={`model-probe-results-column-${key}`}
                checked={!hiddenColumns.has(key)}
                onChange={() => toggleColumn(key)}
              />
              {COLUMN_LABELS[key]}
            </label>
          ))}
          <button
            type="button"
            data-testid="model-probe-results-column-reset"
            className="btn btn-ghost"
            style={{ marginTop: 6, width: '100%', border: '1px solid var(--color-border)' }}
            onClick={resetColumnLayout}
          >
            恢复默认
          </button>
        </div>
      )}
    </div>
  );

  const renderDesktopRows = () => (
    <div data-testid="model-probe-results-table" style={{ overflowX: 'auto' }}>
      {/*
        `width: max-content` with `minWidth: 100%`, NOT `width: 100%`.

        With a 100%-wide fixed layout the browser has to keep the total constant, so
        widening one column takes the space back from its neighbours — dragging the
        Key column narrowed 模型 next to it and clipped its content, which is not what
        a resize handle means. Sized by content instead, a drag grows the table and
        the wrapper scrolls; every column therefore needs an explicit width, hence
        FALLBACK_COLUMN_WIDTH.
      */}
      <table className="data-table" style={{ width: 'max-content', minWidth: '100%', tableLayout: 'fixed' }}>
        <colgroup>
          {visibleColumns.map((key) => (
            <col key={key} style={{ width: layout.widths[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? FALLBACK_COLUMN_WIDTH }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {visibleColumns.map((key) => {
              const sortKey = SORTABLE_COLUMNS[key];
              const width = layout.widths[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? FALLBACK_COLUMN_WIDTH;
              const active = query.sortBy === sortKey;
              return (
                <th
                  key={key}
                  data-testid={`model-probe-results-header-${key}`}
                  style={{ position: 'relative' }}
                  aria-sort={ariaSortFor(sortKey)}
                >
                  {/*
                    The label is the click target, not the whole `<th>`: the resize
                    handle sits in the same cell, and a header-wide handler would make
                    every drag also re-sort the page.
                  */}
                  <button
                    type="button"
                    data-testid={`model-probe-results-sort-${key}`}
                    onClick={() => handleSort(sortKey)}
                    aria-label={sortButtonLabel(sortKey, active)}
                    aria-pressed={active}
                    style={{
                      appearance: 'none',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      margin: 0,
                      font: 'inherit',
                      color: active ? 'var(--color-primary)' : 'inherit',
                      fontWeight: active ? 700 : undefined,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {COLUMN_LABELS[key]}
                    <span aria-hidden="true" style={{ fontSize: 10, opacity: active ? 1 : 0.35 }}>
                      {active ? (query.order === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </button>
                  <span
                    data-testid={`model-probe-results-resize-${key}`}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`调整${COLUMN_LABELS[key]}列宽`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      startColumnResize(key, event.clientX, width);
                    }}
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      width: 6,
                      height: '100%',
                      cursor: 'col-resize',
                      userSelect: 'none',
                    }}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((row) => (
            <tr key={row.id} data-testid={`model-probe-result-row-${row.id}`}>
              {visibleColumns.map((key) => (
                <td key={key} data-testid={`model-probe-result-cell-${key}-${row.id}`}>
                  {renderColumnCell(key, row)}
                </td>
              ))}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Desktop only: the mobile view is cards, which have no columns to configure. */}
          {!isMobile && columnSettings}
          <button
            type="button"
            data-testid="model-probe-results-clear"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-danger, #c0392b)' }}
            onClick={() => { void handleClearResults(); }}
            disabled={clearing || total === 0}
            title="删除全部探测结果（所有站点），不可恢复"
          >
            {clearing ? <><span className="spinner spinner-sm" /> 清空中...</> : '清空结果'}
          </button>
        </div>
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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          每页
          <select
            data-testid="model-probe-results-page-size"
            value={String(pageSize)}
            onChange={(event) => handlePageSize(Number(event.target.value))}
            disabled={loading}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '4px 8px' }}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size === ALL_PAGE_SIZE ? `全部（最多 ${ALL_PAGE_SIZE}）` : String(size)}
              </option>
            ))}
          </select>
          条
        </label>

        {(canPrev || canNext) && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              data-testid="model-probe-results-prev"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={() => setQuery((prev) => ({ ...prev, offset: Math.max(0, (prev.offset ?? 0) - pageSize) }))}
              disabled={!canPrev || loading}
            >
              上一页
            </button>
            <button
              type="button"
              data-testid="model-probe-results-next"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={() => setQuery((prev) => ({ ...prev, offset: (prev.offset ?? 0) + pageSize }))}
              disabled={!canNext || loading}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

