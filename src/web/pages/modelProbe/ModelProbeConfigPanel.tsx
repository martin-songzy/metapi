import React, { useEffect, useMemo, useState } from 'react';
import { api, type ModelProbeConfig, type ModelProbeConfigLimits } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { HelpIcon } from '../../components/Tooltip.js';
import ModernSelect from '../../components/ModernSelect.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import {
  configDraftFromConfig,
  configPayloadFromDraft,
  createModelProbePatternRow,
  customUserAgentPresetValue,
  findInvalidPatternRows,
  hasCustomUserAgentPreset,
  patternRowsFromText,
  patternRowsToDisabled,
  patternRowsToPatterns,
  patternRowsToText,
  withCustomUserAgentValue,
  MODEL_PROBE_CUSTOM_UA_PRESET_ID,
  type ModelProbeConfigDraft,
} from './modelProbeTypes.js';

type ModelProbeConfigPanelProps = {
  config: ModelProbeConfig;
  limits: ModelProbeConfigLimits;
  onSaved: (next: ModelProbeConfig) => void;
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 6,
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-muted)',
  marginTop: 6,
  lineHeight: 1.6,
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 104,
  padding: '10px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 13,
  fontFamily: 'var(--font-mono, monospace)',
  outline: 'none',
  resize: 'vertical',
};

const numberInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 13,
  outline: 'none',
};

export default function ModelProbeConfigPanel({ config, limits, onSaved }: ModelProbeConfigPanelProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<ModelProbeConfigDraft>(() => configDraftFromConfig(config));
  const [saving, setSaving] = useState(false);
  /**
   * The batch editor's buffer, or `null` while the row list is showing.
   *
   * Held here rather than in the draft because it is a VIEW of the rows: the rows
   * stay authoritative, and an abandoned paste must not leave the draft holding text
   * nobody applied.
   */
  const [batchText, setBatchText] = useState<string | null>(null);

  // Re-seed whenever the page reloads the config so a refresh discards a stale draft.
  useEffect(() => {
    setDraft(configDraftFromConfig(config));
    setBatchText(null);
  }, [config]);

  const patternIssues = useMemo(
    () => findInvalidPatternRows(draft.patternRows, limits),
    [draft.patternRows, limits],
  );
  const issueByRow = useMemo(
    () => new Map(patternIssues.map((issue) => [issue.id, issue.reason])),
    [patternIssues],
  );

  const patterns = useMemo(() => patternRowsToPatterns(draft.patternRows), [draft.patternRows]);
  const disabledPatterns = useMemo(() => patternRowsToDisabled(draft.patternRows), [draft.patternRows]);
  const patternCount = patterns.length;
  const enabledPatternCount = patternCount - disabledPatterns.length;
  const hasNoPatterns = patternCount === 0;

  const updateRow = (id: string, source: string) => {
    setDraft((prev) => ({
      ...prev,
      patternRows: prev.patternRows.map((row) => (row.id === id ? { ...row, source } : row)),
    }));
  };

  const toggleRow = (id: string) => {
    setDraft((prev) => ({
      ...prev,
      patternRows: prev.patternRows.map((row) => (row.id === id ? { ...row, enabled: !row.enabled } : row)),
    }));
  };

  const removeRow = (id: string) => {
    setDraft((prev) => ({
      ...prev,
      patternRows: prev.patternRows.filter((row) => row.id !== id),
    }));
  };

  const addRow = () => {
    setDraft((prev) => ({
      ...prev,
      patternRows: [...prev.patternRows, createModelProbePatternRow()],
    }));
  };

  const setAllEnabled = (enabled: boolean) => {
    setDraft((prev) => ({
      ...prev,
      patternRows: prev.patternRows.map((row) => ({ ...row, enabled })),
    }));
  };

  const applyBatchText = () => {
    const text = batchText ?? '';
    setDraft((prev) => ({ ...prev, patternRows: patternRowsFromText(text, prev.patternRows) }));
    setBatchText(null);
  };

  const userAgentOptions = draft.userAgents.map((preset) => ({
    value: preset.id,
    label: preset.label,
    description: preset.value || '不发送 User-Agent',
  }));

  const customUserAgent = customUserAgentPresetValue(draft.userAgents);
  const customUserAgentSelected = draft.defaultUserAgentId === MODEL_PROBE_CUSTOM_UA_PRESET_ID
    && hasCustomUserAgentPreset(draft.userAgents);

  const handleSave = async () => {
    if (patternIssues.length > 0) {
      toast.error(`有 ${patternIssues.length} 条模型匹配正则无效，请先修正`);
      return;
    }

    setSaving(true);
    try {
      // `config` is the last saved record, and it is what a blanked numeric field
      // falls back to — see `clampDraftInteger`.
      const response = await api.saveModelProbeConfig(configPayloadFromDraft(draft, limits, config));
      onSaved(response.config);
      toast.success('全局探测配置已保存');
    } catch (error: any) {
      toast.error(error?.message || '保存全局探测配置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" data-testid="model-probe-config-panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>全局探测配置</div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存全局配置'}
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <div style={{ ...fieldLabelStyle, marginBottom: 0, display: 'flex', alignItems: 'center' }}>
            模型匹配正则（忽略大小写）
            <HelpIcon tooltip="只有勾选的正则会用于下一次预览和探测；取消勾选不会删除正则" />
          </div>
          <button
            type="button"
            data-testid="model-probe-patterns-batch-toggle"
            className="btn btn-ghost btn-sm"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => setBatchText((prev) => (prev === null ? patternRowsToText(draft.patternRows) : null))}
          >
            {batchText === null ? '批量编辑' : '返回列表'}
          </button>
        </div>

        {batchText !== null ? (
          <div data-testid="model-probe-patterns-batch">
            <textarea
              data-testid="model-probe-interest-patterns"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={'例如：\ngpt-4o\n^claude-.*-sonnet'}
              style={textareaStyle}
            />
            <div style={hintStyle}>
              每行一条，适合一次粘贴多条。应用后已有正则保持原来的勾选状态，新增的默认启用。
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                data-testid="model-probe-patterns-batch-apply"
                className="btn btn-ghost btn-sm"
                style={{ border: '1px solid var(--color-border)' }}
                onClick={applyBatchText}
              >
                应用
              </button>
              <button
                type="button"
                data-testid="model-probe-patterns-batch-cancel"
                className="btn btn-ghost btn-sm"
                onClick={() => setBatchText(null)}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div
            data-testid="model-probe-pattern-toggles"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                本轮启用（{enabledPatternCount}/{patternCount}）
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  data-testid="model-probe-patterns-select-all"
                  className="btn btn-ghost btn-sm"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={() => setAllEnabled(true)}
                >
                  全选
                </button>
                <button
                  type="button"
                  data-testid="model-probe-patterns-select-none"
                  className="btn btn-ghost btn-sm"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={() => setAllEnabled(false)}
                >
                  全不选
                </button>
                <button
                  type="button"
                  data-testid="model-probe-patterns-add"
                  className="btn btn-ghost btn-sm"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={addRow}
                >
                  + 添加一条
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {draft.patternRows.length === 0 && (
                <div data-testid="model-probe-pattern-rows-empty" style={{ ...hintStyle, marginTop: 0 }}>
                  还没有正则。点「+ 添加一条」，或用「批量编辑」一次粘贴多条。
                </div>
              )}
              {draft.patternRows.map((row, index) => {
                const reason = issueByRow.get(row.id);
                return (
                  <div key={row.id} data-testid={`model-probe-pattern-row-${index}`}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        data-testid={`model-probe-pattern-toggle-${index}`}
                        aria-label={`本轮启用 ${row.source || `第 ${index + 1} 条`}`}
                        checked={row.enabled}
                        onChange={() => toggleRow(row.id)}
                      />
                      <input
                        type="text"
                        data-testid={`model-probe-pattern-input-${index}`}
                        value={row.source}
                        onChange={(event) => updateRow(row.id, event.target.value)}
                        placeholder="例如 gpt-4o 或 ^claude-.*-sonnet"
                        aria-invalid={Boolean(reason)}
                        style={{
                          ...numberInputStyle,
                          flex: 1,
                          fontFamily: 'var(--font-mono, monospace)',
                          borderColor: reason ? 'var(--color-danger)' : 'var(--color-border)',
                        }}
                      />
                      <button
                        type="button"
                        data-testid={`model-probe-pattern-remove-${index}`}
                        className="btn btn-link btn-link-danger btn-sm"
                        aria-label={`删除 ${row.source || `第 ${index + 1} 条`}`}
                        onClick={() => removeRow(row.id)}
                      >
                        删除
                      </button>
                    </div>
                    {reason && (
                      <div
                        data-testid={`model-probe-pattern-error-${index}`}
                        style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 4, marginLeft: 26 }}
                      >
                        {reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ ...hintStyle, marginTop: 8 }}>
              已配置 {patternCount} 条，最多 {limits.maxInterestPatterns} 条
            </div>
          </div>
        )}

        {patternCount > 0 && enabledPatternCount === 0 && (
          <div className="alert alert-warning" data-testid="model-probe-no-enabled-patterns-warning" style={{ marginTop: 8 }}>
            所有正则都已取消勾选，不会探测任何模型
          </div>
        )}

        {hasNoPatterns && (
          <div className="alert alert-warning" data-testid="model-probe-empty-patterns-warning" style={{ marginTop: 8 }}>
            未配置匹配规则，不会探测任何模型
          </div>
        )}

        {patternIssues.length > 0 && (
          <div
            className="alert alert-error"
            data-testid="model-probe-pattern-issues"
            style={{ marginTop: 8, cursor: 'help' }}
            title={patternIssues.map((issue) => `${issue.source} — ${issue.reason}`).join('\n')}
          >
            {patternIssues.length} 条正则无效 — 鼠标悬停查看详情
          </div>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <ResponsiveFormGrid columns={2}>
          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              探测提示词
              <HelpIcon tooltip="每行一条，随机取用。探测请求会使用这些提示词之一" />
            </div>
            <textarea
              data-testid="model-probe-prompts"
              value={draft.promptsText}
              onChange={(event) => setDraft((prev) => ({ ...prev, promptsText: event.target.value }))}
              style={{ ...textareaStyle, minHeight: 80 }}
            />
          </div>

          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              「模型不存在」关键词
              <HelpIcon tooltip="每行一条。响应包含这些关键词即判定为「不支持」。只放模型缺失类措辞，不要放余额、限流、权限类文案" />
            </div>
            <textarea
              data-testid="model-probe-error-keywords"
              value={draft.errorKeywordsText}
              onChange={(event) => setDraft((prev) => ({ ...prev, errorKeywordsText: event.target.value }))}
              style={{ ...textareaStyle, minHeight: 80 }}
            />
          </div>
        </ResponsiveFormGrid>
      </div>

      <div style={{ marginBottom: 12 }}>
        <ResponsiveFormGrid columns={3}>
          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              默认 User-Agent
              <HelpIcon tooltip="站点未单独设置时使用" />
            </div>
            <ModernSelect
              data-testid="model-probe-default-user-agent"
              value={draft.defaultUserAgentId}
              onChange={(value) => setDraft((prev) => ({ ...prev, defaultUserAgentId: value }))}
              options={userAgentOptions}
            />
            {customUserAgentSelected && (
              <input
                type="text"
                data-testid="model-probe-default-user-agent-custom"
                value={customUserAgent}
                onChange={(event) => setDraft((prev) => ({
                  ...prev,
                  userAgents: withCustomUserAgentValue(prev.userAgents, event.target.value),
                }))}
                placeholder="留空表示不发送 User-Agent"
                style={{ ...numberInputStyle, marginTop: 6 }}
              />
            )}
          </div>

          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              站点间并发
              <HelpIcon tooltip={`${limits.minSiteConcurrency} ~ ${limits.maxSiteConcurrency}。同时探测多少个不同站点`} />
            </div>
            <input
              type="number"
              data-testid="model-probe-site-concurrency"
              value={draft.siteConcurrencyText}
              min={limits.minSiteConcurrency}
              max={limits.maxSiteConcurrency}
              onChange={(event) => setDraft((prev) => ({ ...prev, siteConcurrencyText: event.target.value }))}
              style={numberInputStyle}
            />
          </div>

          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              站点内模型并发
              <HelpIcon tooltip={`${limits.minModelConcurrency} ~ ${limits.maxModelConcurrency}。同一站点内同时探测多少个模型。两项相乘即同时在飞的请求数，全部计费`} />
            </div>
            <input
              type="number"
              data-testid="model-probe-model-concurrency"
              value={draft.modelConcurrencyText}
              min={limits.minModelConcurrency}
              max={limits.maxModelConcurrency}
              onChange={(event) => setDraft((prev) => ({ ...prev, modelConcurrencyText: event.target.value }))}
              style={numberInputStyle}
            />
          </div>

          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              单次请求超时（毫秒）
              <HelpIcon tooltip={`${limits.minTimeoutMs} ~ ${limits.maxTimeoutMs}`} />
            </div>
            <input
              type="number"
              data-testid="model-probe-timeout"
              value={draft.timeoutMsText}
              min={limits.minTimeoutMs}
              max={limits.maxTimeoutMs}
              onChange={(event) => setDraft((prev) => ({ ...prev, timeoutMsText: event.target.value }))}
              style={numberInputStyle}
            />
          </div>

          <div>
            <div style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center' }}>
              单次探测最大输出 token
              <HelpIcon tooltip={`${limits.minMaxTokens} ~ ${limits.maxMaxTokens}。包含思考 token，太小会让推理模型被截断并判定为「未确定」`} />
            </div>
            <input
              type="number"
              data-testid="model-probe-max-tokens"
              value={draft.maxTokensText}
              min={limits.minMaxTokens}
              max={limits.maxMaxTokens}
              onChange={(event) => setDraft((prev) => ({ ...prev, maxTokensText: event.target.value }))}
              style={numberInputStyle}
            />
          </div>
        </ResponsiveFormGrid>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
        <input
          type="checkbox"
          data-testid="model-probe-sync-to-routing"
          checked={draft.syncToRouting}
          onChange={(event) => setDraft((prev) => ({ ...prev, syncToRouting: event.target.checked }))}
          style={{ marginTop: 2 }}
        />
        <span style={{ fontSize: 13, display: 'flex', alignItems: 'center' }}>
          把探测结论同步到路由
          <HelpIcon tooltip="开启后「不支持」的模型只在对应账号上被标记为不可用，并重建一次路由。还需要服务端 PROXY_ROUTING_ENABLED=true 才会生效" />
        </span>
      </label>
    </div>
  );
}
