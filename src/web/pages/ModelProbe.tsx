import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ModelProbeConfig,
  type ModelProbeConfigLimits,
  type ModelProbeSite,
} from '../api.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import ModelProbeConfigPanel from './modelProbe/ModelProbeConfigPanel.js';
import ModelProbeResultsPanel from './modelProbe/ModelProbeResultsPanel.js';
import ModelProbeRunPanel from './modelProbe/ModelProbeRunPanel.js';
import ModelProbeSitesPanel from './modelProbe/ModelProbeSitesPanel.js';

/**
 * Shell for the active model probe. It owns exactly one thing: the server state
 * both panels read (global config + limits + the site list). Every write lives in
 * the panel that owns the form, so a failed save cannot leave the shell holding a
 * value the server rejected.
 *
 * `limits` is always the server's own report — the confirmation threshold and the
 * per-run cap are never duplicated as local constants, so raising them server-side
 * needs no web change.
 */
export default function ModelProbe() {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [config, setConfig] = useState<ModelProbeConfig | null>(null);
  const [limits, setLimits] = useState<ModelProbeConfigLimits | null>(null);
  const [sites, setSites] = useState<ModelProbeSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Only a first (blocking) load may blank the page. */
  const [loadError, setLoadError] = useState('');
  /** A failed background refresh: surfaced next to the refresh button, non-destructively. */
  const [refreshError, setRefreshError] = useState('');
  /**
   * Bumped when a sweep reaches a terminal state. The results table owns its own
   * query, so the shell only tells it "something changed" rather than reaching
   * into its filters.
   */
  const [resultsRefreshToken, setResultsRefreshToken] = useState(0);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [configResponse, sitesResponse] = await Promise.all([
        api.getModelProbeConfig(),
        api.getModelProbeSites(),
      ]);
      setConfig(configResponse.config);
      setLimits(configResponse.limits);
      setSites(Array.isArray(sitesResponse.sites) ? sitesResponse.sites : []);
      setLoadError('');
      setRefreshError('');
    } catch (error: any) {
      const message = error?.message || '加载模型可用性配置失败';
      if (silent) {
        /**
         * A background refresh that fails must not throw away a page that still
         * works. Replacing the panels with an error card would drop the operator's
         * unsaved scope selection and half-typed config, and it would hide the
         * results of a sweep they just paid for — over a refresh they did not
         * depend on. The toast plus the inline notice say what happened; the last
         * good view stays put.
         */
        setRefreshError(message);
        toast.error(message);
      } else {
        setLoadError(message);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSiteSaved = (saved: ModelProbeSite) => {
    setSites((prev) => prev.map((site) => (site.id === saved.id ? saved : site)));
  };

  // Stable across renders so it never re-triggers the run panel's poll effect.
  const handleRunFinished = useCallback(() => {
    setResultsRefreshToken((prev) => prev + 1);
  }, []);

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">模型可用性</h2>
        <div className="page-actions">
          <button
            type="button"
            data-testid="model-probe-refresh-button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            onClick={() => { void load(true); }}
            disabled={loading || refreshing}
          >
            {refreshing ? <><span className="spinner spinner-sm" /> 刷新中...</> : '刷新'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <span className="spinner spinner-sm" />
        </div>
      ) : loadError || !config || !limits ? (
        <div className="card" style={{ padding: 24 }}>
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            {loadError || '模型可用性配置不可用'}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => { void load(); }}
          >
            重试
          </button>
        </div>
      ) : (
        <>
          {refreshError && (
            <div
              className="alert alert-warning"
              data-testid="model-probe-refresh-error"
              style={{ marginBottom: 12 }}
            >
              刷新失败：{refreshError}。下面显示的是上一次成功加载的数据，可能已经过时。
            </div>
          )}
          <ModelProbeConfigPanel
            config={config}
            limits={limits}
            onSaved={setConfig}
          />
          <ModelProbeSitesPanel
            sites={sites}
            userAgents={config.userAgents}
            isMobile={isMobile}
            onSaved={handleSiteSaved}
          />
          <ModelProbeRunPanel
            sites={sites}
            isMobile={isMobile}
            onRunFinished={handleRunFinished}
          />
          <ModelProbeResultsPanel
            sites={sites}
            isMobile={isMobile}
            refreshToken={resultsRefreshToken}
            onResultsCleared={() => setResultsRefreshToken((token) => token + 1)}
          />
        </>
      )}
    </div>
  );
}

