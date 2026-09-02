import React, { useCallback, useEffect, useState } from 'react';

import { api, type ProxyPoolEntry } from '../../api.js';

/**
 * The proxy list — the ONE place a proxy address is entered.
 *
 * Sites and connections do not have address fields any more; they pick from this
 * list. That is the whole point of the panel, so it deliberately owns three things
 * the old scattered inputs could not:
 *
 *  - a NAME per proxy, so a site can show 「香港」 instead of an IP
 *  - a stable id, so renaming or re-addressing an entry never breaks a site that
 *    references it (edits are in place; every referrer follows automatically)
 *  - an honest delete, which tells the operator exactly what will be reset to
 *    「不走代理」 before it happens
 */

type ProxyPoolPanelProps = {
  inputStyle: React.CSSProperties;
  onToast: (kind: 'success' | 'error', message: string) => void;
  /** Bumped when an entry changes, so pages showing effective proxies can refetch. */
  onChanged?: () => void;
};

type TestState = { kind: 'success' | 'error'; text: string };

const PLACEHOLDER = '—';

export default function ProxyPoolPanel({ inputStyle, onToast, onChanged }: ProxyPoolPanelProps) {
  const [entries, setEntries] = useState<ProxyPoolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftName, setDraftName] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getProxyPool();
      setEntries(Array.isArray(res?.entries) ? res.entries : []);
    } catch (error) {
      onToast('error', (error as Error)?.message || '读取代理列表失败');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    const url = draftUrl.trim();
    if (!url) {
      onToast('error', '请填写代理地址');
      return;
    }
    setAdding(true);
    try {
      await api.createProxyPoolEntry({ url, ...(draftName.trim() ? { name: draftName.trim() } : {}) });
      setDraftName('');
      setDraftUrl('');
      await load();
      onChanged?.();
      onToast('success', '代理已添加');
    } catch (error) {
      onToast('error', (error as Error)?.message || '添加代理失败');
    } finally {
      setAdding(false);
    }
  };

  const beginEdit = (entry: ProxyPoolEntry) => {
    setEditingId(entry.id);
    setEditName(entry.name);
    setEditUrl(entry.url);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const url = editUrl.trim();
    if (!url) {
      onToast('error', '请填写代理地址');
      return;
    }
    setSaving(true);
    try {
      // The id survives, so every site pointing here switches to the new address
      // without being touched — the reason an operator can change a proxy once.
      await api.updateProxyPoolEntry(editingId, { name: editName.trim(), url });
      setEditingId(null);
      await load();
      onChanged?.();
      onToast('success', '代理已更新，引用它的站点已同时生效');
    } catch (error) {
      onToast('error', (error as Error)?.message || '更新代理失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (entry: ProxyPoolEntry) => {
    setBusyId(entry.id);
    setTestStates((prev) => ({ ...prev, [entry.id]: { kind: 'success', text: '测试中...' } }));
    try {
      const res = await api.testSystemProxy({ proxyUrl: entry.url });
      setTestStates((prev) => ({
        ...prev,
        [entry.id]: { kind: 'success', text: `连通（${res?.latencyMs ?? '?'} ms）` },
      }));
    } catch (error) {
      setTestStates((prev) => ({
        ...prev,
        [entry.id]: { kind: 'error', text: (error as Error)?.message || '测试失败' },
      }));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (entry: ProxyPoolEntry) => {
    setBusyId(entry.id);
    try {
      // Named before the confirm, not after: an operator agreeing to "delete this
      // proxy" has not agreed to silently unproxy six sites.
      const referrers = await api.getProxyPoolReferrers(entry.id);
      const siteNames = referrers?.siteNames ?? [];
      const accountLabels = referrers?.accountLabels ?? [];
      const affected = siteNames.length + accountLabels.length;

      const detail = affected === 0
        ? '当前没有站点或连接使用它。'
        : [
          `以下将改为「不走代理」：`,
          siteNames.length > 0 ? `· 站点 ${siteNames.length} 个：${siteNames.slice(0, 5).join('、')}${siteNames.length > 5 ? ' 等' : ''}` : '',
          accountLabels.length > 0 ? `· 连接 ${accountLabels.length} 个：${accountLabels.slice(0, 5).join('、')}${accountLabels.length > 5 ? ' 等' : ''}` : '',
        ].filter(Boolean).join('\n');

      if (!window.confirm(`删除代理「${entry.name}」？\n\n${detail}`)) {
        return;
      }

      await api.deleteProxyPoolEntry(entry.id);
      await load();
      onChanged?.();
      onToast('success', affected === 0
        ? '代理已删除'
        : `代理已删除，${affected} 项已改为不走代理`);
    } catch (error) {
      onToast('error', (error as Error)?.message || '删除代理失败');
    } finally {
      setBusyId(null);
    }
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '10px 0',
    borderBottom: '1px solid var(--color-border)',
    flexWrap: 'wrap',
  };

  return (
    <div className="card animate-slide-up stagger-3" style={{ padding: 20 }} data-testid="proxy-pool-panel">
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>代理</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12, lineHeight: 1.7 }}>
        代理地址只在这里维护。站点和连接不再各自填写地址，改为从这个列表里选择，
        所以同一个代理换了地址只需改这一处，引用它的站点会一起生效。
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '12px 0' }}>
          <span className="spinner spinner-sm" /> 读取中...
        </div>
      ) : entries.length === 0 ? (
        <div
          data-testid="proxy-pool-empty"
          style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '12px 0' }}
        >
          还没有代理。添加一个之后，站点和连接就能选它了。
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {entries.map((entry) => {
            const isEditing = editingId === entry.id;
            const testState = testStates[entry.id];
            return (
              <div key={entry.id} style={rowStyle} data-testid={`proxy-pool-row-${entry.id}`}>
                {isEditing ? (
                  <>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="名称"
                      data-testid="proxy-pool-edit-name"
                      style={{ ...inputStyle, width: 140 }}
                    />
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      placeholder="socks5://127.0.0.1:7890"
                      data-testid="proxy-pool-edit-url"
                      style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: 'var(--font-mono)' }}
                    />
                    <button
                      onClick={handleSaveEdit}
                      disabled={saving}
                      className="btn btn-primary btn-sm"
                      data-testid="proxy-pool-edit-save"
                    >
                      {saving ? '保存中...' : '保存'}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="btn btn-ghost btn-sm"
                      style={{ border: '1px solid var(--color-border)' }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ fontWeight: 600, fontSize: 13, minWidth: 100 }}>{entry.name || PLACEHOLDER}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 200,
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-text-muted)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {entry.url}
                    </span>
                    {testState && (
                      <span
                        style={{
                          fontSize: 12,
                          color: testState.kind === 'success'
                            ? 'var(--color-success)'
                            : 'var(--color-danger)',
                        }}
                      >
                        {testState.text}
                      </span>
                    )}
                    <button
                      onClick={() => handleTest(entry)}
                      disabled={busyId === entry.id}
                      className="btn btn-ghost btn-sm"
                      style={{ border: '1px solid var(--color-border)' }}
                      data-testid={`proxy-pool-test-${entry.id}`}
                    >
                      测试
                    </button>
                    <button
                      onClick={() => beginEdit(entry)}
                      className="btn btn-ghost btn-sm"
                      style={{ border: '1px solid var(--color-border)' }}
                      data-testid={`proxy-pool-edit-${entry.id}`}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(entry)}
                      disabled={busyId === entry.id}
                      className="btn btn-ghost btn-sm"
                      style={{ border: '1px solid var(--color-border)', color: 'var(--color-danger)' }}
                      data-testid={`proxy-pool-delete-${entry.id}`}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="名称（可留空）"
          data-testid="proxy-pool-new-name"
          style={{ ...inputStyle, width: 140 }}
        />
        <input
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
          data-testid="proxy-pool-new-url"
          style={{ ...inputStyle, flex: 1, minWidth: 220, fontFamily: 'var(--font-mono)' }}
        />
        <button
          onClick={handleAdd}
          disabled={adding}
          className="btn btn-primary"
          data-testid="proxy-pool-add"
        >
          {adding ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 添加中...</> : '+ 新增代理'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
        名称留空时会用地址的 host:port 顶上，之后可以再改。
      </div>
    </div>
  );
}
