import React, { useEffect, useMemo, useState } from 'react';
import { api, type ModelProbeSite, type ModelProbeUserAgentPreset } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import ModernSelect from '../../components/ModernSelect.js';
import ResponsiveFilterPanel from '../../components/ResponsiveFilterPanel.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import {
  MODEL_PROBE_UA_SITE_CUSTOM,
  modelProbeEndpointOptions,
  normalizeModelProbeEndpointType,
  siteConfigPayloadFromDraft,
  siteDraftEquals,
  siteDraftFromSite,
  siteUserAgentOptions,
  type ModelProbeSiteDraft,
} from './modelProbeTypes.js';

type ModelProbeSitesPanelProps = {
  sites: ModelProbeSite[];
  userAgents: ModelProbeUserAgentPreset[];
  isMobile: boolean;
  onSaved: (site: ModelProbeSite) => void;
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 6,
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

function buildDrafts(
  sites: readonly ModelProbeSite[],
  userAgents: readonly ModelProbeUserAgentPreset[],
): Record<number, ModelProbeSiteDraft> {
  const drafts: Record<number, ModelProbeSiteDraft> = {};
  for (const site of sites) {
    drafts[site.id] = siteDraftFromSite(site, userAgents);
  }
  return drafts;
}

/**
 * Whether a site's STORED settings differ from the defaults.
 *
 * Reads the site record, not the draft, so the marker tracks what is saved rather
 * than what is being typed — an unsaved edit is already signalled by the save
 * button becoming enabled.
 *
 * This exists because the desktop layout now shows one site at a time. Listing
 * every site was what the operator asked to remove, but it did make overrides
 * visible at a glance, and losing that entirely would leave no way to find the
 * sites you had customised without clicking through the whole dropdown.
 */
export function siteHasProbeOverride(site: ModelProbeSite): boolean {
  const endpointOverridden = normalizeModelProbeEndpointType(site.probeEndpointType) !== 'auto';
  const userAgentOverridden = String(site.probeUserAgent ?? '').trim().length > 0;
  return endpointOverridden || userAgentOverridden;
}

export default function ModelProbeSitesPanel({
  sites,
  userAgents,
  isMobile,
  onSaved,
}: ModelProbeSitesPanelProps) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<number, ModelProbeSiteDraft>>(
    () => buildDrafts(sites, userAgents),
  );
  const [savingSiteId, setSavingSiteId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);

  // Re-seed from the server list so a page refresh drops stale drafts instead of
  // showing edits against rows that no longer exist.
  useEffect(() => {
    setDrafts(buildDrafts(sites, userAgents));
  }, [sites, userAgents]);

  const endpointOptions = useMemo(() => modelProbeEndpointOptions(), []);
  const userAgentOptions = useMemo(() => siteUserAgentOptions(userAgents), [userAgents]);

  const filteredSites = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return sites;
    return sites.filter((site) => (
      `${site.name} ${site.url} ${site.platform}`.toLowerCase().includes(needle)
    ));
  }, [keyword, sites]);

  const updateDraft = (siteId: number, patch: Partial<ModelProbeSiteDraft>) => {
    setDrafts((prev) => {
      const current = prev[siteId];
      if (!current) return prev;
      return { ...prev, [siteId]: { ...current, ...patch } };
    });
  };

  /**
   * Keeps the desktop selection pointing at a site that is actually listed.
   *
   * Both directions matter: the initial render has no selection, and narrowing the
   * keyword filter can drop the selected site out of the list — leaving it selected
   * would render a config block for a site the operator can no longer see.
   */
  const selectableSiteIds = filteredSites.map((site) => site.id).join(',');
  useEffect(() => {
    const ids = selectableSiteIds ? selectableSiteIds.split(',').map(Number) : [];
    if (ids.length === 0) {
      setSelectedSiteId(null);
      return;
    }
    setSelectedSiteId((current) => (
      current !== null && ids.includes(current) ? current : (ids[0] as number)
    ));
  }, [selectableSiteIds]);

  const overriddenSiteCount = useMemo(
    () => sites.filter((site) => siteHasProbeOverride(site)).length,
    [sites],
  );

  const siteSelectOptions = useMemo(() => filteredSites.map((site) => ({
    value: String(site.id),
    // The marker rides on the label because `ModernSelect` renders options as
    // plain text; there is no per-option slot for a badge.
    label: siteHasProbeOverride(site) ? `${site.name} ● 已自定义` : site.name,
  })), [filteredSites]);

  const selectedSite = filteredSites.find((site) => site.id === selectedSiteId) ?? null;

  const handleSave = async (site: ModelProbeSite) => {
    const draft = drafts[site.id];
    if (!draft) return;

    setSavingSiteId(site.id);
    try {
      const response = await api.saveModelProbeSiteConfig(
        site.id,
        siteConfigPayloadFromDraft(draft, userAgents),
      );
      onSaved(response.site);
      toast.success(`已保存 ${site.name} 的探测设置`);
    } catch (error: any) {
      toast.error(error?.message || `保存 ${site.name} 的探测设置失败`);
    } finally {
      setSavingSiteId(null);
    }
  };

  const filterFields = (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        type="text"
        data-testid="model-probe-site-keyword"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="按站点名 / 地址 / 平台搜索"
        style={{ ...textInputStyle, flex: '1 1 220px', minWidth: 180 }}
      />
      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {filteredSites.length} / {sites.length} 个站点
      </span>
    </div>
  );

  /**
   * A non-active site is silently skipped by the run service, so leaving its
   * status off this table lets an operator carefully tune probe settings for a
   * site that will never be probed. The settings are still editable — a site can
   * be re-enabled from 站点管理 — but the row has to say the sweep will pass it by.
   */
  const renderStatusBadge = (site: ModelProbeSite) => {
    const status = site.status || 'active';
    if (status === 'active') return null;
    return (
      <span
        className="badge badge-warning"
        data-testid={`model-probe-site-inactive-${site.id}`}
        title="站点已停用，批量探测会跳过它，不消耗配额"
      >
        已停用 · 探测会跳过
      </span>
    );
  };

  const renderEndpointSelect = (site: ModelProbeSite, draft: ModelProbeSiteDraft) => (
    <ModernSelect
      data-testid={`model-probe-site-endpoint-${site.id}`}
      size="sm"
      value={draft.probeEndpointType}
      onChange={(value) => updateDraft(site.id, {
        probeEndpointType: normalizeModelProbeEndpointType(value),
      })}
      options={endpointOptions}
    />
  );

  const renderUserAgentControl = (site: ModelProbeSite, draft: ModelProbeSiteDraft) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <ModernSelect
        data-testid={`model-probe-site-user-agent-${site.id}`}
        size="sm"
        value={draft.userAgentChoice}
        onChange={(value) => updateDraft(site.id, { userAgentChoice: value })}
        options={userAgentOptions}
      />
      {draft.userAgentChoice === MODEL_PROBE_UA_SITE_CUSTOM && (
        <>
          <input
            type="text"
            data-testid={`model-probe-site-user-agent-custom-${site.id}`}
            value={draft.customUserAgent}
            onChange={(event) => updateDraft(site.id, { customUserAgent: event.target.value })}
            // A blank override is stored as `''`, and the server reads `''` as
            // "inherit the global default preset" — never as "omit the header".
            placeholder="留空表示继承全局默认 UA"
            style={textInputStyle}
          />
          {draft.customUserAgent.trim().length === 0 && (
            <div
              data-testid={`model-probe-site-user-agent-blank-${site.id}`}
              style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.6 }}
            >
              留空保存后等于「继承全局」，选择框也会显示回继承全局，这是正常的，不是设置被丢弃。
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderSaveButton = (site: ModelProbeSite, draft: ModelProbeSiteDraft) => {
    const pristine = siteDraftEquals(draft, siteDraftFromSite(site, userAgents));
    return (
      <button
        type="button"
        data-testid={`model-probe-site-save-${site.id}`}
        className="btn btn-ghost"
        style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
        onClick={() => { void handleSave(site); }}
        disabled={savingSiteId === site.id || pristine}
      >
        {savingSiteId === site.id ? <><span className="spinner spinner-sm" /> 保存中...</> : '保存'}
      </button>
    );
  };

  return (
    <div className="card" data-testid="model-probe-sites-panel" style={{ padding: 18 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>站点探测设置</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6, lineHeight: 1.6 }}>
          每个站点可单独指定探测使用的接口类型与 User-Agent。接口类型选「自动」时按站点平台能力推导；User-Agent 选「继承全局」时使用上方的默认预设。
          <br />
          站点这一列只有「继承全局」和「发送某个具体 UA」两种状态：留空即继承，无法只让单个站点不发送 UA。
          确实需要完全不发送时，请把上方的「默认 User-Agent」设为「自定义 / 不发送」，并让这些站点保持继承全局。
        </div>
      </div>

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={filterOpen}
        onMobileOpen={() => setFilterOpen(true)}
        onMobileClose={() => setFilterOpen(false)}
        mobileTitle="筛选站点"
        mobileContent={filterFields}
        desktopContent={<div style={{ marginBottom: 12 }}>{filterFields}</div>}
      />

      {filteredSites.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <div className="empty-state-title">没有匹配的站点</div>
          <div className="empty-state-desc">调整搜索条件，或先到站点管理里添加站点。</div>
        </div>
      ) : isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredSites.map((site) => {
            const draft = drafts[site.id];
            if (!draft) return null;
            return (
              <MobileCard
                key={site.id}
                title={site.name}
                subtitle={site.url}
                headerActions={renderStatusBadge(site)}
                footerActions={renderSaveButton(site, draft)}
              >
                <MobileField label="平台" value={<span className="badge badge-muted">{site.platform}</span>} />
                <MobileField label="接口类型" stacked value={renderEndpointSelect(site, draft)} />
                <MobileField label="User-Agent" stacked value={renderUserAgentControl(site, draft)} />
              </MobileCard>
            );
          })}
        </div>
      ) : (
        <div data-testid="model-probe-site-selector-layout">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ flex: '1 1 280px', minWidth: 220 }}>
              <div style={labelStyle}>选择站点</div>
              <ModernSelect
                data-testid="model-probe-site-selector"
                size="sm"
                value={selectedSiteId === null ? '' : String(selectedSiteId)}
                onChange={(value) => setSelectedSiteId(Number(value))}
                options={siteSelectOptions}
              />
            </div>
            <div
              data-testid="model-probe-site-override-count"
              style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingBottom: 8 }}
            >
              {overriddenSiteCount > 0
                ? `${overriddenSiteCount} 个站点已自定义（下拉中标 ●）`
                : '所有站点都使用默认设置'}
            </div>
          </div>

          {selectedSite && drafts[selectedSite.id] ? (() => {
            const site = selectedSite;
            const draft = drafts[site.id] as ModelProbeSiteDraft;
            return (
              <div
                data-testid={`model-probe-site-config-${site.id}`}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{site.name}</span>
                  <span className="badge badge-muted">{site.platform}</span>
                  {renderStatusBadge(site)}
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{site.url}</span>
                </div>

                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 200px', minWidth: 180 }}>
                    <div style={labelStyle}>接口类型</div>
                    {renderEndpointSelect(site, draft)}
                  </div>
                  <div style={{ flex: '1 1 260px', minWidth: 220 }}>
                    <div style={labelStyle}>User-Agent</div>
                    {renderUserAgentControl(site, draft)}
                  </div>
                </div>

                <div>{renderSaveButton(site, draft)}</div>
              </div>
            );
          })() : null}
        </div>
      )}
    </div>
  );
}
