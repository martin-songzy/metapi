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
  const [preview, setPreview] = useState<ModelProbePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

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
  const notifiedTaskIdRef = useRef<string | null>(null);

  const scopePayload = useMemo<ModelProbeRunPayload>(
    () => (scopeSiteIds.length > 0 ? { siteIds: [...scopeSiteIds].sort((a, b) => a - b) } : {}),
    [scopeSiteIds],
  );

  const toggleScopeSite = (siteId: number, checked: boolean) => {
    setScopeSiteIds((prev) => (
      checked ? [...prev.filter((id) => id !== siteId), siteId] : prev.filter((id) => id !== siteId)
    ));
  };

  const handlePreview = async () => {
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
    } else if (finished.result.probed === 0) {
      toast.info('本次没有匹配到任何模型，没有发出任何探测请求');
    } else {
      toast.success(`探测结束：${finished.result.probed} 个模型已探测`);
    }
    onRunFinished();
  }, [onRunFinished, toast]);

  /**
   * One interval per task id, cleared both on a terminal status and on unmount.
   * `cancelled` additionally drops a response that lands after teardown, so a
   * closed page never writes state.
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
  }, [announceTerminal, taskId, toast]);

  const unverifiedSites = useMemo(
    () => (preview?.sites ?? []).filter((site) => !site.credentialVerified),
    [preview],
  );

  const renderCredentialBadge = (site: ModelProbePreviewSite) => (
    <span
      data-testid={`model-probe-preview-credential-${site.siteId}`}
      style={{
        ...badgeBase,
        background: site.credentialVerified ? 'var(--color-success-bg)' : 'var(--color-warning-bg)',
        color: site.credentialVerified ? 'var(--color-success)' : 'var(--color-warning)',
      }}
    >
      {site.credentialVerified ? '已验证凭据 · 实时' : '未验证凭据 · 缓存'}
    </span>
  );

  const renderPreviewSite = (site: ModelProbePreviewSite) => (
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
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{site.siteName}</span>
        {renderCredentialBadge(site)}
      </div>
      <div style={hintStyle}>
        {site.models.length} 个待探测模型 · 上游发现 {site.discoveredCount} 个
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
    </div>
  );

  const renderPreview = () => {
    if (!preview) return null;
    return (
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div data-testid="model-probe-preview-summary" style={{ fontSize: 13, fontWeight: 600 }}>
          共 {preview.totalModels} 个待探测模型，覆盖 {preview.sites.length} 个站点
        </div>

        {unverifiedSites.length > 0 && (
          <div className="alert alert-warning" data-testid="model-probe-preview-unverified-warning">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              有 {unverifiedSites.length} 个站点用的是缓存模型列表，凭据未被验证
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              {unverifiedSites.map((site) => site.siteName).join('、')}
              ：实时获取模型列表没有成功，这里显示的是缓存内容。多数上游适配器在拿不到模型列表时只返回空数组，
              所以密钥被吊销看起来和「暂时取不到」一模一样。把这些站点当作可用之前，请先确认它们的 API Key 仍然有效。
            </div>
          </div>
        )}

        {preview.exceedsRunLimit && (
          <div className="alert alert-error" data-testid="model-probe-preview-exceeds-limit">
            本次匹配到的目标数量已超过服务端允许的单次上限，直接发起会被拒绝。请收窄模型匹配正则，或缩小站点范围。
          </div>
        )}

        {preview.invalidPatterns.length > 0 && (
          <div className="alert alert-error" data-testid="model-probe-preview-invalid-patterns">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>以下匹配正则无效，已被忽略：</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
              {preview.invalidPatterns.map((entry) => (
                <li key={entry.source}><code>{entry.source}</code> — {entry.reason}</li>
              ))}
            </ul>
          </div>
        )}

        {preview.skipped.length > 0 && (
          <div className="alert alert-warning" data-testid="model-probe-preview-skipped">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>以下站点本次不会被探测：</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
              {preview.skipped.map((skip) => (
                <li key={skip.siteId}>{skip.siteName}（{skip.code}）：{skip.message}</li>
              ))}
            </ul>
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
        <div className="alert alert-error" data-testid="model-probe-summary-invalid-patterns" style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            本次有 {invalidPatterns.length} 条匹配正则无法编译，已被忽略，探测范围因此变小：
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {invalidPatterns.map((entry) => (
              <li key={entry.source}><code>{entry.source}</code> — {entry.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {skippedSites.length > 0 && (
        <div className="alert alert-warning" data-testid="model-probe-summary-skipped-sites" style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>以下站点被跳过，没有产生任何结论：</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {skippedSites.map((skip) => (
              <li key={skip.siteId}>{skip.siteName}（{skip.code}）：{skip.message}</li>
            ))}
          </ul>
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
        {summary.probed === 0 && (
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
          {renderCounter('写入禁用', summary.disabled)}
          {renderCounter('同步路由', summary.routingSynced ? '是' : '否')}
        </div>

        {renderSummaryDetails(summary.invalidPatterns, summary.skippedSites)}
      </div>
    );
  };

  const renderTask = () => {
    if (!taskId) return null;
    return (
      <div style={{ marginTop: 16, borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>本次探测进度</div>
          {task && !isTerminal(task.status) && <span className="spinner spinner-sm" />}
          <span style={hintStyle}>任务 {taskId}{task ? ` · ${task.status}` : ' · 等待任务状态'}</span>
        </div>

        {reused && (
          <div className="alert alert-info" data-testid="model-probe-task-reused" style={{ marginTop: 10 }}>
            已有一次范围等价的探测正在运行，本次没有新建任务，而是跟随那一次的进度。
          </div>
        )}

        {task && !isTerminal(task.status) && task.message && (
          <div style={{ ...hintStyle, marginTop: 8 }}>{task.message}</div>
        )}

        {pollError && (
          <div className="alert alert-warning" data-testid="model-probe-task-poll-error" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>无法获取任务状态，进度可能已停止更新</div>
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>{pollError}</div>
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
    <div className="card" data-testid="model-probe-run-panel" style={{ padding: 18, marginTop: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>发起探测</div>
        <div style={{ ...hintStyle, marginTop: 6 }}>
          探测会用站点自己的密钥发出真实请求，会消耗上游额度。先预览确认范围，再发起。
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
          站点范围（不勾选表示全部符合条件的站点）
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {sites.length === 0 ? (
            <span style={hintStyle}>还没有可探测的站点。</span>
          ) : sites.map((site) => (
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
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="model-probe-preview-button"
          className="btn btn-ghost"
          style={{ border: '1px solid var(--color-border)' }}
          onClick={() => handlePreview()}
          disabled={busy}
        >
          {previewing ? <><span className="spinner spinner-sm" /> 预览中...</> : '预览探测范围'}
        </button>
        <button
          type="button"
          data-testid="model-probe-run-button"
          className="btn btn-primary"
          onClick={() => startRun(scopePayload)}
          disabled={busy}
        >
          {starting ? <><span className="spinner spinner-sm" /> 发起中...</> : '发起探测'}
        </button>
      </div>

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

