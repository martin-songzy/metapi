import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ModelProbePreview,
  type ModelProbePreviewSite,
  type ModelProbeRunConflict,
  type ModelProbeRunPayload,
  type ModelProbeSite,
  type ModelProbeTask,
  type ModelProbeTaskLogEntry,
} from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useToast } from '../../components/Toast.js';
import { MODEL_PROBE_TASK_TYPE } from './modelProbeTypes.js';

/**
 * Operator-facing trigger for one probe sweep, plus the live progress of the task
 * it queued.
 *
 * Two invariants drive the whole file:
 *
 * 1. A run spends real quota on paid upstream accounts, so nothing here starts a
 *    sweep implicitly. Preview never runs, and the confirmation gate is only ever
 *    satisfied by an explicit click.
 * 2. Nothing may read as more successful than the server said. A failed task, a
 *    succeeded task with no summary, and a sweep that probed nothing are three
 *    distinct outcomes and each says what actually happened.
 */

const POLL_INTERVAL_MS = 1_000;

type ModelProbeRunPanelProps = {
  sites: ModelProbeSite[];
  isMobile: boolean;
  /** Called once a sweep reaches a terminal state so the results table can reload. */
  onRunFinished: () => void;
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-muted)',
  lineHeight: 1.7,
};

/** The 全选 / 清空 / 反选 trio: small, borderless, next to the section label. */
const scopeActionStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '1px 8px',
  border: '1px solid var(--color-border)',
};

const badgeBase: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
};

/**
 * Logs are keyed by `seq`, never appended blindly: a poll can repeat entries it
 * already returned, or return them out of order, and either would otherwise show
 * up as a duplicated or scrambled transcript.
 */
export function mergeTaskLogs(
  previous: readonly ModelProbeTaskLogEntry[],
  incoming: readonly ModelProbeTaskLogEntry[],
): ModelProbeTaskLogEntry[] {
  const bySeq = new Map<number, ModelProbeTaskLogEntry>();
  for (const entry of previous) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function isTerminal(status: ModelProbeTask['status']): boolean {
  return status === 'succeeded' || status === 'failed';
}

function formatLogTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString();
}

export default function ModelProbeRunPanel({ sites, isMobile, onRunFinished }: ModelProbeRunPanelProps) {
  const toast = useToast();
  const [scopeSiteIds, setScopeSiteIds] = useState<number[]>([]);
  // 添加悬停样式
  useEffect(() => {
    const styleId = 'model-probe-site-hover-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      [data-testid^="model-probe-preview-site-"]:hover .model-probe-site-details {
        display: block !important;
      }
    `;
    document.head.appendChild(style);

    return () => {
      const existingStyle = document.getElementById(styleId);
      if (existingStyle) existingStyle.remove();
    };
  }, []);
  const [preview, setPreview] = useState<ModelProbePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

  /**
   * Only sites a sweep can actually probe are offered as scope.
   *
   * A disabled site is skipped by the runner whatever the operator ticks — it comes
   * back under 跳过的站点 with `site_disabled` — so listing it as a choice offered a
   * decision that had no effect. A missing status counts as active, matching the
   * server's own reading of legacy rows.
   */
  const selectableSites = useMemo(
    () => sites.filter((site) => (site.status || 'active') !== 'disabled'),
    [sites],
  );
  const hiddenDisabledSiteCount = sites.length - selectableSites.length;

  /**
   * A ticked site that has since been disabled is dropped from the selection, not
   * merely hidden: keeping it would send a scope naming a site the panel no longer
   * shows, and the sweep would then report a skip the operator cannot explain.
   */
  useEffect(() => {
    setScopeSiteIds((prev) => {
      const selectable = new Set(selectableSites.map((site) => site.id));
      const next = prev.filter((id) => selectable.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableSites]);

  /**
   * Every selectable site starts ticked, filled in once the site list arrives.
   *
   * The list is fetched asynchronously, so seeding the state initialiser would only
   * ever see an empty array. This runs once — a ref, not a state flag, because a
   * flag would have to be set inside the same effect and a re-render between the
   * two could re-seed over a choice the operator already made.
   */
  const scopeSeededRef = useRef(false);
  useEffect(() => {
    if (scopeSeededRef.current || selectableSites.length === 0) return;
    scopeSeededRef.current = true;
    setScopeSiteIds(selectableSites.map((site) => site.id));
  }, [selectableSites]);

  const toggleScopeSite = (siteId: number, checked: boolean) => {
    setScopeSiteIds((prev) => (
      checked ? [...prev.filter((id) => id !== siteId), siteId] : prev.filter((id) => id !== siteId)
    ));
  };

  /** 全选 / 清空 / 反选. All three write the same state, so they cannot disagree. */
  const selectAllScopeSites = () => setScopeSiteIds(selectableSites.map((site) => site.id));
  const clearScopeSites = () => setScopeSiteIds([]);
  const invertScopeSites = () => setScopeSiteIds((prev) => {
    const selected = new Set(prev);
    return selectableSites.filter((site) => !selected.has(site.id)).map((site) => site.id);
  });

  const allSitesSelected = selectableSites.length > 0
    && scopeSiteIds.length === selectableSites.length;

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  /** Set only for `run_limit_exceeded`: rendered as a dead end, with no confirm. */
  const [blocked, setBlocked] = useState<ModelProbeRunConflict | null>(null);
  /** Set only for `confirmation_required`: the one path that may resend. */
  const [confirming, setConfirming] = useState<ModelProbeRunConflict | null>(null);

  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<ModelProbeTask | null>(null);
  const [logs, setLogs] = useState<ModelProbeTaskLogEntry[]>([]);
  const [reused, setReused] = useState(false);
  const [pollError, setPollError] = useState('');
  /**
   * Bumped to re-arm the poll effect for an *unchanged* task id. Without it the
   * effect could only ever restart when `taskId` changed value, so once polling
   * gave up there was no route back: the server dedupes an unchanged scope and
   * returns the same id, making `setTaskId` a no-op.
   */
  const [pollAttempt, setPollAttempt] = useState(0);
  /** True once polling gave up. Drives the retry / stop-following affordance. */
  const [pollStopped, setPollStopped] = useState(false);
  /** True when this panel adopted a sweep that was already running on mount. */
  const [reattached, setReattached] = useState(false);
  /**
   * Which task the operator has asked to stop. Held as the task id rather than a
   * boolean so a request can never appear to apply to a later sweep: every reset
   * of `taskId` implicitly invalidates it.
   */
  const [cancelRequestedTaskId, setCancelRequestedTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const notifiedTaskIdRef = useRef<string | null>(null);
  /**
   * Set synchronously by `startRun` so a reattach lookup still in flight cannot
   * overwrite a sweep the operator just launched themselves.
   */
  const operatorStartedRef = useRef(false);

  /**
   * A tracked task with no terminal status yet counts as in flight, including
   * the window before the first poll answers. While it is in flight a second
   * 发起探测 must be refused: an unchanged scope would be deduped server-side,
   * but a *changed* scope produces a new dedupe key, so the click would add a
   * sweep spending more quota while the panel quietly dropped the first one.
   */
  const sweepInFlight = taskId !== null && (task === null || !isTerminal(task.status));

  /**
   * True once this sweep's cancellation has been accepted. Compared against the
   * live task id so a stale request cannot label a different sweep.
   */
  const cancelRequested = taskId !== null && cancelRequestedTaskId === taskId;

  /**
   * All-selected collapses to `{}` — the server's `kind: 'all'` scope.
   *
   * The two forms probe the same set but carry different dedupe keys, so sending
   * the full id list here would make "select everything" start a *new* sweep
   * rather than join the identical one already running. `all` also keeps meaning
   * all: a site added later is covered without touching this panel.
   *
   * An empty selection sends `{}` too, but it can never reach the server — the run
   * and preview buttons are disabled while nothing is ticked (see `nothingSelected`).
   */
  const scopePayload = useMemo<ModelProbeRunPayload>(
    () => (allSitesSelected || scopeSiteIds.length === 0
      ? {}
      : { siteIds: [...scopeSiteIds].sort((a, b) => a - b) }),
    [allSitesSelected, scopeSiteIds],
  );

  /** Nothing ticked: the one state that must never reach 发起探测. */
  const nothingSelected = selectableSites.length > 0 && scopeSiteIds.length === 0;

  const handlePreview = async () => {
    // Same refusal as `startRun`: a preview of `{}` would describe every site,
    // which is not the selection the checkboxes show.
    if (nothingSelected) return;
    setPreviewing(true);
    setPreviewError('');
    try {
      const response = await api.previewModelProbe(scopePayload);
      setPreview(response.preview);
    } catch (error: any) {
      setPreview(null);
      const message = error?.message || '预览探测范围失败';
      setPreviewError(message);
      toast.error(message);
    } finally {
      setPreviewing(false);
    }
  };

  /**
   * `confirmedTargetCount` is passed only by the confirm button. Sending it from
   * the plain run button would defeat the gate, and resending it after
   * `run_limit_exceeded` would just fail again — that code is not confirmable.
   */
  const startRun = async (payload: ModelProbeRunPayload) => {
    // Guarded here and not only on `disabled`, so the refusal is a behaviour
    // rather than a styling detail. `nothingSelected` is the one that matters
    // most: its payload is `{}`, which the server reads as every site.
    if (sweepInFlight || nothingSelected) return;
    operatorStartedRef.current = true;
    setStarting(true);
    setStartError('');
    try {
      const outcome = await api.runModelProbe(payload);

      if (outcome.status === 'conflict') {
        if (outcome.data.code === 'run_limit_exceeded') {
          setBlocked(outcome.data);
          setConfirming(null);
        } else {
          setConfirming(outcome.data);
          setBlocked(null);
        }
        setPreview(outcome.data.preview);
        return;
      }

      setBlocked(null);
      setConfirming(null);
      setPreview(outcome.data.preview);
      setReused(outcome.data.reused);
      setLogs([]);
      setTask(null);
      setPollError('');
      setPollStopped(false);
      setReattached(false);
      notifiedTaskIdRef.current = null;
      setTaskId(outcome.data.taskId);
      if (outcome.data.reused) {
        toast.info('已有一次等价的探测在运行，本次直接跟随它的进度');
      }
    } catch (error: any) {
      const message = error?.message || '启动探测失败';
      setStartError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  };

  const handleConfirm = async () => {
    if (!confirming) return;
    const targetCount = confirming.targetCount;
    setConfirming(null);
    await startRun({ ...scopePayload, confirmedTargetCount: targetCount });
  };

  const announceTerminal = useCallback((finished: ModelProbeTask) => {
    if (notifiedTaskIdRef.current === finished.id) return;
    notifiedTaskIdRef.current = finished.id;

    if (finished.status === 'failed') {
      toast.error(finished.error || finished.message || '探测任务失败');
    } else if (!finished.result) {
      // Succeeded with no summary proves nothing about any model.
      toast.error('探测任务结束但没有返回结果摘要');
    } else if (finished.result.cancelled) {
      // Checked before the counters: a cancelled sweep must never be toasted as a
      // success, however many models it happened to get through. Still `info` and
      // not `success` when nothing remained — the operator asked to stop and should
      // be told the request arrived too late to save anything, rather than reading a
      // plain success and assuming the cancel worked.
      toast.info(finished.result.remaining > 0
        ? `探测已取消：${finished.result.probed} 个模型已探测，${finished.result.remaining} 个未探测`
        : `探测已取消，但取消时全部 ${finished.result.probed} 个模型都已探测完，没有省下请求`);
    } else if (finished.result.probed === 0) {
      toast.info('本次没有匹配到任何模型，没有发出任何探测请求');
    } else {
      toast.success(`探测结束：${finished.result.probed} 个模型已探测`);
    }
    onRunFinished();
  }, [onRunFinished, toast]);

  /**
   * One interval per (task id, attempt), cleared both on a terminal status and
   * on unmount. `cancelled` additionally drops a response that lands after
   * teardown, so a closed page never writes state. Keying on `pollAttempt` as
   * well as `taskId` is what makes a give-up recoverable.
   */
  useEffect(() => {
    if (!taskId) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let consecutiveFailures = 0;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const poll = async () => {
      try {
        const response = await api.getModelProbeTask(taskId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setPollError('');
        setTask(response.task);
        setLogs((prev) => mergeTaskLogs(prev, response.task.logs));
        if (isTerminal(response.task.status)) {
          stop();
          announceTerminal(response.task);
        }
      } catch (error: any) {
        if (cancelled) return;
        consecutiveFailures += 1;
        const message = error?.message || '查询探测任务失败';
        setPollError(message);
        // A single blip is transient; three in a row means nobody is coming, so
        // stop rather than leave a dead run looking alive forever.
        if (consecutiveFailures >= 3) {
          stop();
          setPollStopped(true);
          toast.error(message);
        }
      }
    };

    void poll();
    timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stop();
    };
  }, [announceTerminal, pollAttempt, taskId, toast]);

  /**
   * `taskId` is component state, so before this a navigation away and back — or
   * any reload — lost a sweep that was still running and still spending quota,
   * leaving the panel with no sign it existed. Runs once on mount and adopts the
   * newest non-terminal probe task the server still knows about.
   *
   * A failure here is deliberately silent: not finding a sweep to rejoin is the
   * normal case, and an error banner about it would push the operator toward the
   * one button that costs money.
   */
  useEffect(() => {
    let cancelled = false;

    const reattach = async () => {
      try {
        const response = await api.getModelProbeTasks();
        if (cancelled || operatorStartedRef.current) return;
        const rows = Array.isArray(response?.tasks) ? response.tasks : [];
        // The list is newest-first, so the first match is the newest sweep.
        const running = rows.find(
          (row) => row.type === MODEL_PROBE_TASK_TYPE && !isTerminal(row.status),
        );
        if (!running) return;
        setReattached(true);
        setTaskId(running.id);
      } catch {
        // Intentionally ignored: see above.
      }
    };

    void reattach();
    return () => { cancelled = true; };
  }, []);

  /** Re-arms the interval for the same task without discarding the transcript. */
  const handleRetryPolling = () => {
    setPollStopped(false);
    setPollError('');
    setPollAttempt((prev) => prev + 1);
  };

  /**
   * Stops *following* the task; it does not stop the sweep. Without this the run
   * guard would convert an unreachable task into a permanently disabled button.
   */
  const handleStopFollowing = () => {
    setTaskId(null);
    setTask(null);
    setLogs([]);
    setPollError('');
    setPollStopped(false);
    setReused(false);
    setReattached(false);
    setCancelRequestedTaskId(null);
    notifiedTaskIdRef.current = null;
  };

  /**
   * Asks the server to stop the sweep. This does not stop it immediately: the
   * model currently in flight still completes, and the run ends after it. So the
   * panel keeps polling — the only honest end state is the one the task reports.
   *
   * A failure deliberately leaves the button live. The sweep is still spending
   * quota, and a button that latches off after one failed attempt would take away
   * the operator's only way to stop it.
   */
  const handleCancelRun = async () => {
    if (!taskId || cancelling || cancelRequested) return;
    setCancelling(true);
    try {
      const outcome = await api.cancelModelProbeRun(taskId);
      setCancelRequestedTaskId(taskId);
      if (outcome.status === 'already_finished') {
        // Not an error: the button is rendered while the sweep looks live, so a
        // sweep that finished between render and click is an ordinary race.
        toast.info('这次探测已经结束了，没有需要取消的部分');
      } else {
        toast.info('已请求取消：正在探测的这个模型结束后不再发起新的请求');
      }
    } catch (error: any) {
      toast.error(error?.message || '取消探测失败');
    } finally {
      setCancelling(false);
    }
  };

  /**
   * Three states, not two. `credentialVerified` describes the PRIMARY key only, so
   * a site whose primary fell back to cache while a secondary key fetched a live
   * catalog used to render as a flat failure — operators then checked the
   * connection page, where the same site refreshed fine. `partial` is that case.
   */
  const credentialStateOf = (site: ModelProbePreviewSite): 'verified' | 'partial' | 'cached' => {
    if (site.credentialVerified) return 'verified';
    return site.liveKeyCount > 0 ? 'partial' : 'cached';
  };

  // Only the genuinely cache-only sites belong in the warning banner: a site with a
  // live secondary key has a proven credential, just not the primary one.
  const unverifiedSites = useMemo(
    () => (preview?.sites ?? []).filter((site) => credentialStateOf(site) === 'cached'),
    [preview],
  );

  const partialSites = useMemo(
    () => (preview?.sites ?? []).filter((site) => credentialStateOf(site) === 'partial'),
    [preview],
  );

  const renderCredentialBadge = (site: ModelProbePreviewSite) => {
    const state = credentialStateOf(site);
    // `-soft` is what index.css actually defines. The `-bg` names this chip used
    // before are declared nowhere, so the background silently resolved to nothing.
    const palette = {
      verified: { bg: 'var(--color-success-soft)', fg: 'var(--color-success)', label: '已验证凭据 · 实时' },
      partial: {
        bg: 'var(--color-info-soft)',
        fg: 'var(--color-info)',
        label: `主 key 未验证 · ${site.liveKeyCount}/${site.probableKeyCount} 个 key 实时`,
      },
      cached: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning)', label: '未验证凭据 · 缓存' },
    }[state];

    return (
      <span
        data-testid={`model-probe-preview-credential-${site.siteId}`}
        data-credential-state={state}
        title={state === 'partial'
          ? '主 key 这次没能实时取到模型列表，但这个站点下另有 key 取到了。站点级判定（写入探测结果、同步路由）只认主 key，所以这里仍算未验证；但站点本身是通的，模型列表是各 key 的并集。'
          : undefined}
        style={{
          ...badgeBase,
          background: palette.bg,
          color: palette.fg,
          ...(state === 'partial' ? { cursor: 'help' } : null),
        }}
      >
        {palette.label}
      </span>
    );
  };

  const renderPreviewSite = (site: ModelProbePreviewSite) => {
    const hasDetails = site.liveFailure || site.notes.length > 0;

    return (
      <div
        key={site.siteId}
        data-testid={`model-probe-preview-site-${site.siteId}`}
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          position: 'relative',
        }}
      >
        {/* 简要信息：一行显示 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{site.siteName}</span>
          {renderCredentialBadge(site)}
          <span style={hintStyle}>
            {site.models.length} 个模型
          </span>
        </div>

        {/* 悬停详情：桌面端鼠标移过时显示 */}
        {!isMobile && hasDetails && (
          <div
            className="model-probe-site-details"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              minWidth: '100%',
              maxWidth: 400,
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: 12,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              zIndex: 10,
              display: 'none',
            }}
          >
            <div style={{ ...hintStyle, marginBottom: 6 }}>
              上游发现 {site.discoveredCount} 个模型
            </div>
            {site.liveFailure && (
              <div style={{ ...hintStyle, color: 'var(--color-warning)', marginBottom: 6 }}>
                实时获取失败（{site.liveFailure.kind}
                {site.liveFailure.status === null ? '' : ` / HTTP ${site.liveFailure.status}`}）：
                {site.liveFailure.message}
              </div>
            )}
            {site.notes.length > 0 && (
              <ul style={{ ...hintStyle, margin: 0, paddingLeft: 18 }}>
                {site.notes.map((note, index) => <li key={`${site.siteId}-note-${index}`}>{note}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* 移动端：直接展开显示详情 */}
        {isMobile && (
          <>
            <div style={hintStyle}>
              上游发现 {site.discoveredCount} 个模型
            </div>
            {site.liveFailure && (
              <div style={{ ...hintStyle, color: 'var(--color-warning)' }}>
                实时获取失败（{site.liveFailure.kind}
                {site.liveFailure.status === null ? '' : ` / HTTP ${site.liveFailure.status}`}）：
                {site.liveFailure.message}
              </div>
            )}
            {site.notes.length > 0 && (
              <ul style={{ ...hintStyle, margin: 0, paddingLeft: 18 }}>
                {site.notes.map((note, index) => <li key={`${site.siteId}-note-${index}`}>{note}</li>)}
              </ul>
            )}
          </>
        )}
      </div>
    );
  };

  const renderPreview = () => {
    if (!preview) return null;
    return (
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div data-testid="model-probe-preview-summary" style={{ fontSize: 13, fontWeight: 600 }}>
          共 {preview.totalModels} 个待探测模型，覆盖 {preview.sites.length} 个站点
        </div>

        {unverifiedSites.length > 0 && (
          <div
            className="alert alert-warning"
            data-testid="model-probe-preview-unverified-warning"
            style={{ cursor: 'help', position: 'relative' }}
            title={`${unverifiedSites.map((site) => site.siteName).join('、')}：实时获取模型列表没有成功，这里显示的是缓存内容。多数上游适配器在拿不到模型列表时只返回空数组，所以密钥被吊销看起来和「暂时取不到」一模一样。把这些站点当作可用之前，请先确认它们的 API Key 仍然有效。`}
          >
            {unverifiedSites.length} 个站点用缓存列表（凭据未验证）— 鼠标悬停查看详情
          </div>
        )}

        {partialSites.length > 0 && (
          <div
            className="alert alert-info"
            data-testid="model-probe-preview-partial-warning"
            style={{ cursor: 'help', position: 'relative' }}
            title={`${partialSites.map((site) => site.siteName).join('、')}：主 key 这次没能实时取到模型列表，但站点下另有 key 取到了，所以站点本身是通的。站点级判定（写入结果、同步路由）只认主 key，这些站点仍标为「主 key 未验证」。如果只是想确认站点可用，可以忽略；如果希望主 key 也走实时，请到连接管理页检查它的 API Key。`}
          >
            {partialSites.length} 个站点主 key 未验证、但有其它 key 实时可用 — 鼠标悬停查看详情
          </div>
        )}

        {preview.exceedsRunLimit && (
          <div className="alert alert-error" data-testid="model-probe-preview-exceeds-limit">
            目标数量超过单次上限，请收窄正则或缩小站点范围
          </div>
        )}

        {preview.invalidPatterns.length > 0 && (
          <div
            className="alert alert-error"
            data-testid="model-probe-preview-invalid-patterns"
            style={{ cursor: 'help' }}
            title={preview.invalidPatterns.map((entry) => `${entry.source} — ${entry.reason}`).join('\n')}
          >
            {preview.invalidPatterns.length} 条正则无效 — 鼠标悬停查看详情
          </div>
        )}

        {preview.skipped.length > 0 && (
          <div
            className="alert alert-warning"
            data-testid="model-probe-preview-skipped"
            style={{ cursor: 'help' }}
            title={preview.skipped.map((skip) => `${skip.siteName}（${skip.code}）：${skip.message}`).join('\n')}
          >
            {preview.skipped.length} 个站点将被跳过 — 鼠标悬停查看详情
          </div>
        )}

        {preview.sites.length === 0 ? (
          <div style={hintStyle}>没有站点进入本次探测范围。</div>
        ) : (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {preview.sites.map(renderPreviewSite)}
          </div>
        )}
      </div>
    );
  };

  const renderSummaryDetails = (
    invalidPatterns: ModelProbePreview['invalidPatterns'],
    skippedSites: ModelProbePreview['skipped'],
  ) => (
    <>
      {invalidPatterns.length > 0 && (
        <div
          className="alert alert-error"
          data-testid="model-probe-summary-invalid-patterns"
          style={{ marginTop: 10, cursor: 'help' }}
          title={invalidPatterns.map((entry) => `${entry.source} — ${entry.reason}`).join('\n')}
        >
          {invalidPatterns.length} 条正则无效 — 鼠标悬停查看详情
        </div>
      )}
      {skippedSites.length > 0 && (
        <div
          className="alert alert-warning"
          data-testid="model-probe-summary-skipped-sites"
          style={{ marginTop: 10, cursor: 'help' }}
          title={skippedSites.map((skip) => `${skip.siteName}（${skip.code}）：${skip.message}`).join('\n')}
        >
          {skippedSites.length} 个站点被跳过 — 鼠标悬停查看详情
        </div>
      )}
    </>
  );

  const renderCounter = (label: string, value: number | string) => (
    <div style={{ minWidth: 84 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
    </div>
  );

  const renderTerminal = (finished: ModelProbeTask) => {
    // Order matters: a failed task is reported as a failure and nothing else,
    // whatever partial fields it happens to carry.
    if (finished.status === 'failed') {
      return (
        <div className="alert alert-error" data-testid="model-probe-task-failure" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>探测任务失败，本次结论不可信</div>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>{finished.error || finished.message || '任务未提供失败原因'}</div>
        </div>
      );
    }

    const summary = finished.result;
    if (!summary) {
      return (
        <div className="alert alert-error" data-testid="model-probe-task-missing-summary" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>任务已结束，但没有返回结果摘要</div>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            没有摘要就无法判断任何模型的可用性，请勿把这次结束当作探测成功。可以查看下方日志，或重新发起一次探测。
          </div>
        </div>
      );
    }

    return (
      <div style={{ marginTop: 12 }}>
        {/*
          A cancelled sweep is not a finished one. The counters below describe
          only the part that ran, so this names the remainder before them — and
          says plainly that the unsupported verdicts were not applied to routing,
          because the run service withholds that sync when cancelled.

          Stated as "not marked unavailable" rather than "not written to the site
          disable list": `syncUnsupportedToRouting` never touches
          `site_disabled_models` on ANY path, so naming it here would imply a
          completed sweep does.
        */}
        {summary.cancelled && (summary.remaining > 0 ? (
          <div className="alert alert-warning" data-testid="model-probe-task-cancelled">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>这次探测已取消，不是一次完整的探测</div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              还有 {summary.remaining} 个模型没有被探测，它们既不算可用也不算不可用——只是没问过。
              下面的数字只覆盖已经跑完的那一部分。
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7, marginTop: 6 }}>
              本次的「不支持」结论未同步到路由：取消意味着这次探测的授权被收回，
              结论保留下来供查看，但不会把任何模型标记为不可用。
            </div>
          </div>
        ) : (
          /*
            The cancel arrived while the last model's probe was already in flight,
            so it stopped nothing. Rendering the banner above here read
            「不是一次完整的探测」 directly above 「还有 0 个模型没有被探测」, and told
            the operator the verdicts were withheld when the run service applies
            them — `remaining: 0` means every target was probed and paid for.
          */
          <div className="alert alert-info" data-testid="model-probe-task-cancelled">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>已取消，但取消到达时全部模型都探测完了</div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              取消请求赶在最后一个模型之后到达，所以没有省下任何请求，也没有漏掉任何模型。
              下面的数字覆盖了这次的全部目标，结论按正常完成处理。
            </div>
          </div>
        ))}

        {summary.probed === 0 && !summary.cancelled && (
          <div className="alert alert-warning" data-testid="model-probe-task-nothing-probed">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>本次没有匹配到任何模型，没有发出任何探测请求</div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              这不是「全部可用」，也不是「全部不可用」——它只说明筛选之后没有目标。
              空的模型匹配正则按设计匹配 0 个模型；如果你已经写了正则，请看下面列出的无效正则与被跳过的站点。
            </div>
          </div>
        )}

        <div
          data-testid="model-probe-task-summary"
          style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '10px 0' }}
        >
          {renderCounter('站点', summary.siteCount)}
          {renderCounter('已探测', summary.probed)}
          {renderCounter('可用', summary.supported)}
          {renderCounter('不支持', summary.unsupported)}
          {renderCounter('未确定', summary.inconclusive)}
          {renderCounter('已跳过', summary.skipped)}
          {/* `disabled` counts `model_availability` rows flipped to unavailable,
              not entries added to a site disable list. */}
          {renderCounter('标记不可用', summary.disabled)}
          {renderCounter('同步路由', summary.routingSynced ? '是' : '否')}
        </div>

        {renderSummaryDetails(summary.invalidPatterns, summary.skippedSites)}
      </div>
    );
  };

  const renderTask = () => {
    if (!taskId) return null;
    // `等待任务状态` may only be claimed while polling is genuinely still trying.
    // Once it has given up, the status is unknown, not pending.
    const taskStatusLabel = task
      ? ` · ${task.status}`
      : (pollStopped ? ' · 状态未知' : ' · 等待任务状态');
    return (
      <div style={{ marginTop: 16, borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>本次探测进度</div>
          {/*
            Spinner tracks "we are actively polling", not "a task object exists",
            so the window before the first answer shows motion — and a stopped
            poll shows none.
          */}
          {sweepInFlight && !pollStopped && <span className="spinner spinner-sm" />}
          <span style={hintStyle}>任务 {taskId}{taskStatusLabel}</span>
        </div>

        {reattached && (
          <div className="alert alert-info" data-testid="model-probe-task-reattached" style={{ marginTop: 10 }}>
            打开这个页面之前就已在运行的探测，已经自动接回它的进度。这不是新发起的探测，没有额外消耗额度。
          </div>
        )}

        {reused && (
          <div className="alert alert-info" data-testid="model-probe-task-reused" style={{ marginTop: 10 }}>
            已有一次范围等价的探测正在运行，本次没有新建任务，而是跟随那一次的进度。
          </div>
        )}

        {task && !isTerminal(task.status) && task.message && (
          <div style={{ ...hintStyle, marginTop: 8 }}>{task.message}</div>
        )}

        {pollError && !pollStopped && (
          <div className="alert alert-warning" data-testid="model-probe-task-poll-error" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>暂时无法获取任务状态，正在重试</div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>{pollError}</div>
          </div>
        )}

        {/*
          Polling gave up, but the sweep itself very likely did not: it is running
          on the server and still spending quota. So this says what stopped, and
          offers the two honest ways forward instead of leaving the panel stuck.
        */}
        {pollStopped && (
          <div className="alert alert-error" data-testid="model-probe-task-poll-stopped" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>已停止获取任务状态，进度不再更新</div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>{pollError}</div>
            <div style={{ fontSize: 12, lineHeight: 1.7, marginTop: 6 }}>
              这只代表本页拿不到状态，服务端的探测可能仍在运行并继续消耗额度，不要当作它已经结束。
              连接恢复后点「重试」继续跟随同一个任务；确认不再关心它时点「不再跟随」，之后才能发起新的探测。
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button
                type="button"
                data-testid="model-probe-task-poll-retry"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
                onClick={() => handleRetryPolling()}
              >
                重试
              </button>
              <button
                type="button"
                data-testid="model-probe-task-detach"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
                onClick={() => handleStopFollowing()}
              >
                不再跟随
              </button>
            </div>
          </div>
        )}

        {task && isTerminal(task.status) && renderTerminal(task)}

        {logs.length > 0 && (
          <div
            data-testid="model-probe-task-logs"
            style={{
              marginTop: 12,
              maxHeight: 240,
              overflowY: 'auto',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: 10,
              background: 'var(--color-bg)',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            {logs.map((entry) => (
              <div key={entry.seq}>
                <span style={{ color: 'var(--color-text-muted)' }}>[{formatLogTime(entry.createdAt)}]</span>
                {' '}
                {entry.message}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const busy = previewing || starting;

  return (
    <div className="card" data-testid="model-probe-run-panel" style={{ padding: 16, marginTop: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>发起探测</div>
        <div style={{ ...hintStyle, marginTop: 4 }}>
          探测会用站点自己的密钥发出真实请求，会消耗上游额度。先预览确认范围，再发起。
        </div>
        <div style={{ ...hintStyle, marginTop: 3 }} data-testid="model-probe-run-dedupe-hint">
          范围没有变化时再次发起并不会新开一次探测，服务端会识别出等价的任务，本页只是重新跟随它的进度；
          离开页面后回来也会自动接回仍在运行的那一次。
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6,
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            站点范围
          </span>
          {selectableSites.length > 0 && (
            <>
              <button
                type="button"
                data-testid="model-probe-scope-select-all"
                className="btn btn-ghost"
                style={scopeActionStyle}
                onClick={selectAllScopeSites}
              >
                全选
              </button>
              <button
                type="button"
                data-testid="model-probe-scope-clear"
                className="btn btn-ghost"
                style={scopeActionStyle}
                onClick={clearScopeSites}
              >
                清空
              </button>
              <button
                type="button"
                data-testid="model-probe-scope-invert"
                className="btn btn-ghost"
                style={scopeActionStyle}
                onClick={invertScopeSites}
              >
                反选
              </button>
              <span style={{ ...hintStyle, marginLeft: 'auto' }} data-testid="model-probe-scope-count">
                已选 {scopeSiteIds.length} / {selectableSites.length}
              </span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {selectableSites.length === 0 ? (
            <span style={hintStyle}>
              {hiddenDisabledSiteCount > 0
                ? '所有站点都已停用，没有可探测的站点。'
                : '还没有可探测的站点。'}
            </span>
          ) : selectableSites.map((site) => (
            <label key={site.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid={`model-probe-scope-site-${site.id}`}
                checked={scopeSiteIds.includes(site.id)}
                onChange={(event) => toggleScopeSite(site.id, event.target.checked)}
              />
              {site.name}
            </label>
          ))}
        </div>
        {/*
          An empty selection used to mean "every site" server-side. That reads as the
          opposite of what the checkboxes show, and after 反选 the operator lands on
          it by accident — one click away from spending quota on every site. The
          buttons are disabled instead, so the state cannot be acted on.
        */}
        {nothingSelected && (
          <div style={{ ...hintStyle, marginTop: 6 }} data-testid="model-probe-scope-empty-note">
            没有勾选任何站点。请至少选择一个，或点「全选」。
          </div>
        )}
        {/*
          Named rather than silently absent: a site vanishing from this list with no
          explanation reads as data loss, and the reason is one an operator can act on.
        */}
        {hiddenDisabledSiteCount > 0 && (
          <div style={{ ...hintStyle, marginTop: 6 }} data-testid="model-probe-scope-disabled-note">
            {hiddenDisabledSiteCount} 个已停用的站点未列出：探测会跳过它们，在站点管理里重新启用后才会出现。
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="model-probe-preview-button"
          className="btn btn-ghost"
          style={{ border: '1px solid var(--color-border)' }}
          onClick={() => handlePreview()}
          disabled={busy || nothingSelected}
        >
          {previewing ? <><span className="spinner spinner-sm" /> 预览中...</> : '预览探测范围'}
        </button>
        <button
          type="button"
          data-testid="model-probe-run-button"
          className="btn btn-primary"
          onClick={() => startRun(scopePayload)}
          disabled={busy || sweepInFlight || nothingSelected}
        >
          {starting ? <><span className="spinner spinner-sm" /> 发起中...</> : '发起探测'}
        </button>
        {/*
          Only offered while a sweep looks live. A running sweep is spending real
          quota one model at a time, and before this the only way to stop it was
          restarting the server — 不再跟随 merely stops watching it.
        */}
        {sweepInFlight && (
          <button
            type="button"
            data-testid="model-probe-cancel-button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => handleCancelRun()}
            disabled={cancelling || cancelRequested}
          >
            {cancelling ? <><span className="spinner spinner-sm" /> 取消中...</> : '取消探测'}
          </button>
        )}
      </div>

      {sweepInFlight && (
        <div style={{ ...hintStyle, marginTop: 10 }} data-testid="model-probe-run-active-hint">
          已有一次探测正在进行，发起按钮暂时不可用。改动站点范围后再发起并不会缩小这一次，而是额外新增一次探测，
          所以请先等它结束，或点「取消探测」提前停下它。
        </div>
      )}

      {cancelRequested && sweepInFlight && (
        <div className="alert alert-info" data-testid="model-probe-cancel-requested" style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>已请求取消，正在收尾</div>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            取消不会打断已经发出的那个请求：正在探测的模型会跑完，之后不再发起新的探测。
            已经得到的结论会保留，但这次不会同步到路由，也不会把任何模型标记为不可用。
          </div>
        </div>
      )}

      {previewError && (
        <div className="alert alert-error" data-testid="model-probe-preview-error" style={{ marginTop: 12 }}>
          {previewError}
        </div>
      )}
      {startError && (
        <div className="alert alert-error" data-testid="model-probe-run-error" style={{ marginTop: 12 }}>
          {startError}
        </div>
      )}

      {/*
        `run_limit_exceeded` deliberately has no confirm button. Resending with
        `confirmedTargetCount` would be refused again, so the only way forward is
        to narrow the scope — which is what this message says.
      */}
      {blocked && (
        <div className="alert alert-error" data-testid="model-probe-run-blocked" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>本次探测被拒绝，确认也无法通过</div>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>{blocked.message}</div>
          <div style={{ fontSize: 12, lineHeight: 1.7, marginTop: 6 }}>
            匹配到 {blocked.targetCount} 个目标，单次上限 {blocked.maxRunTargets} 个。
            请收窄「模型匹配正则」，或在上面只勾选部分站点后重试。
          </div>
        </div>
      )}

      {renderPreview()}
      {renderTask()}

      <CenteredModal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="确认发起探测"
        maxWidth={620}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        footer={(
          <>
            <button
              type="button"
              data-testid="model-probe-confirm-cancel"
              className="btn btn-ghost"
              onClick={() => setConfirming(null)}
            >
              取消
            </button>
            <button
              type="button"
              data-testid="model-probe-confirm-accept"
              className="btn btn-primary"
              onClick={() => handleConfirm()}
              disabled={starting}
            >
              {starting ? <><span className="spinner spinner-sm" /> 发起中...</> : '确认发起'}
            </button>
          </>
        )}
      >
        {confirming && (
          <div data-testid="model-probe-confirm-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="alert alert-warning" style={{ margin: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                本次将对 {confirming.targetCount} 个模型各发一次真实请求
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                这些请求会消耗对应站点账号的真实额度。确认后如果服务端重新计算出的目标数量已经变化，本次会再次被拒绝。
              </div>
            </div>
            <div style={hintStyle}>{confirming.message}</div>
            <div style={hintStyle} data-testid="model-probe-confirm-thresholds">
              服务端阈值：超过 {confirming.confirmTargetThreshold} 个需要二次确认，超过 {confirming.maxRunTargets} 个直接拒绝。
            </div>
          </div>
        )}
      </CenteredModal>
    </div>
  );
}

