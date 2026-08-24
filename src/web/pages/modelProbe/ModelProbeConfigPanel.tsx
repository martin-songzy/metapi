import React, { useEffect, useMemo, useState } from 'react';
import { api, type ModelProbeConfig, type ModelProbeConfigLimits } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import ModernSelect from '../../components/ModernSelect.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import {
  configDraftFromConfig,
  configPayloadFromDraft,
  customUserAgentPresetValue,
  findInvalidInterestPatterns,
  hasCustomUserAgentPreset,
  splitConfigLines,
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

  // Re-seed whenever the page reloads the config so a refresh discards a stale draft.
  useEffect(() => {
    setDraft(configDraftFromConfig(config));
  }, [config]);

  const patternIssues = useMemo(
    () => findInvalidInterestPatterns(draft.interestPatternsText, limits),
    [draft.interestPatternsText, limits],
  );
  const patternCount = useMemo(
    () => splitConfigLines(draft.interestPatternsText).length,
    [draft.interestPatternsText],
  );
  const hasNoPatterns = patternCount === 0;

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
    <div className="card" data-testid="model-probe-config-panel" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>全局探测配置</div>
          <div style={hintStyle}>决定探测哪些模型、用什么提示词与请求头，以及怎样判定「模型不存在」。</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存全局配置'}
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={fieldLabelStyle}>模型匹配正则（每行一条，忽略大小写）</div>
        <textarea
          data-testid="model-probe-interest-patterns"
          value={draft.interestPatternsText}
          onChange={(event) => setDraft((prev) => ({ ...prev, interestPatternsText: event.target.value }))}
          placeholder={'例如：\ngpt-4o\n^claude-.*-sonnet'}
          aria-invalid={patternIssues.length > 0}
          style={{
            ...textareaStyle,
            borderColor: patternIssues.length > 0 ? 'var(--color-danger)' : 'var(--color-border)',
          }}
        />
        <div style={hintStyle}>
          只有匹配到的模型才会被探测。已配置 {patternCount} 条，最多 {limits.maxInterestPatterns} 条，单条最长 {limits.maxInterestPatternLength} 个字符。
        </div>

        {hasNoPatterns && (
          <div className="alert alert-warning" data-testid="model-probe-empty-patterns-warning" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>未配置匹配规则，不会探测任何模型</div>
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              这是刻意设计：空规则等于「不匹配任何模型」，避免在你表达意图前就把上游额度花在全量探测上。想开始探测，请先在上面填写至少一条正则。
            </div>
          </div>
        )}

        {patternIssues.length > 0 && (
          <div className="alert alert-error" data-testid="model-probe-pattern-issues" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>以下正则无效，保存前请修正：</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
              {patternIssues.map((issue) => (
                <li key={issue.source}>
                  <code>{issue.source}</code> — {issue.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <ResponsiveFormGrid columns={2}>
          <div>
            <div style={fieldLabelStyle}>探测提示词（每行一条，随机取用）</div>
            <textarea
              data-testid="model-probe-prompts"
              value={draft.promptsText}
              onChange={(event) => setDraft((prev) => ({ ...prev, promptsText: event.target.value }))}
              style={textareaStyle}
            />
            <div style={hintStyle}>最多 {limits.maxPrompts} 条。</div>
          </div>

          <div>
            <div style={fieldLabelStyle}>「模型不存在」关键词（每行一条）</div>
            <textarea
              data-testid="model-probe-error-keywords"
              value={draft.errorKeywordsText}
              onChange={(event) => setDraft((prev) => ({ ...prev, errorKeywordsText: event.target.value }))}
              style={textareaStyle}
            />
            <div style={hintStyle}>
              命中即判定为「不支持」，最多 {limits.maxErrorKeywords} 条。只放模型缺失类措辞：余额、限流、权限类文案会让整站模型被误判。
            </div>
          </div>
        </ResponsiveFormGrid>
      </div>

      <div style={{ marginBottom: 16 }}>
        <ResponsiveFormGrid columns={3}>
          <div>
            <div style={fieldLabelStyle}>默认 User-Agent</div>
            <ModernSelect
              data-testid="model-probe-default-user-agent"
              value={draft.defaultUserAgentId}
              onChange={(value) => setDraft((prev) => ({ ...prev, defaultUserAgentId: value }))}
              options={userAgentOptions}
            />
            {/*
              Only the 自定义 preset is editable here. Without this field the
              custom option could only ever mean "send nothing", so a custom UA
              was expressible per-site only. The two built-in presets keep their
              hand-maintained version strings.
            */}
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
                style={{ ...numberInputStyle, marginTop: 8 }}
              />
            )}
            <div style={hintStyle}>
              站点未单独设置时使用。
              {customUserAgentSelected && (
                customUserAgent.trim().length === 0
                  ? '当前为空，探测请求不会带 User-Agent。'
                  : '这一条会同时出现在站点的 User-Agent 选项里。'
              )}
            </div>
          </div>

          <div>
            <div style={fieldLabelStyle}>并发数</div>
            <input
              type="number"
              data-testid="model-probe-concurrency"
              value={draft.concurrencyText}
              min={limits.minConcurrency}
              max={limits.maxConcurrency}
              onChange={(event) => setDraft((prev) => ({ ...prev, concurrencyText: event.target.value }))}
              style={numberInputStyle}
            />
            <div style={hintStyle}>{limits.minConcurrency} ~ {limits.maxConcurrency}。</div>
          </div>

          <div>
            <div style={fieldLabelStyle}>单次请求超时（毫秒）</div>
            <input
              type="number"
              data-testid="model-probe-timeout"
              value={draft.timeoutMsText}
              min={limits.minTimeoutMs}
              max={limits.maxTimeoutMs}
              onChange={(event) => setDraft((prev) => ({ ...prev, timeoutMsText: event.target.value }))}
              style={numberInputStyle}
            />
            <div style={hintStyle}>{limits.minTimeoutMs} ~ {limits.maxTimeoutMs}。</div>
          </div>

          <div>
            <div style={fieldLabelStyle}>单次探测最大输出 token</div>
            <input
              type="number"
              data-testid="model-probe-max-tokens"
              value={draft.maxTokensText}
              min={limits.minMaxTokens}
              max={limits.maxMaxTokens}
              onChange={(event) => setDraft((prev) => ({ ...prev, maxTokensText: event.target.value }))}
              style={numberInputStyle}
            />
            <div style={hintStyle}>
              {limits.minMaxTokens} ~ {limits.maxMaxTokens}。这个额度包含模型的思考 token，太小会让模型还没输出正文就被截断，
              结果被判成「未确定 / 无可用内容」。推理模型如果频繁出现这种判定，就调大这个值。
            </div>
          </div>
        </ResponsiveFormGrid>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 12 }}>
        <input
          type="checkbox"
          data-testid="model-probe-sync-to-routing"
          checked={draft.syncToRouting}
          onChange={(event) => setDraft((prev) => ({ ...prev, syncToRouting: event.target.checked }))}
          style={{ marginTop: 3 }}
        />
        <span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>把探测结论同步到路由</span>
          <span
            data-testid="model-probe-sync-to-routing-hint"
            style={{ ...hintStyle, display: 'block', marginTop: 2 }}
          >
            开启后「不支持」的模型只在对应账号上被标记为不可用，并重建一次路由；
            人工添加的模型不受影响，站点级别的禁用名单也不会被改动。
            还需要服务端 PROXY_ROUTING_ENABLED=true 才会真的生效；关闭时探测只记录结果，不动路由。
          </span>
        </span>
      </label>

      <div style={hintStyle} data-testid="model-probe-run-limits">
        单次探测目标超过 {limits.confirmTargetThreshold} 个需要二次确认，超过 {limits.maxRunTargets} 个会被拒绝。
      </div>
    </div>
  );
}
