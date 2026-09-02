import { useCallback, useEffect, useState } from 'react';

import { api, type ProxyPoolEntry } from '../api.js';

/**
 * The proxy pool, for any page that renders a `ProxyRefPicker` or shows which entry a
 * row references.
 *
 * Four pages needed the same fetch-on-mount, so it lives here once. The optional call
 * matters: this runs on pages whose other data is already loading, and a pool that
 * cannot be read must degrade to "no entries to choose from" rather than take the
 * page down with it.
 */
export function useProxyPool(): {
  entries: ProxyPoolEntry[];
  reload: () => void;
} {
  const [entries, setEntries] = useState<ProxyPoolEntry[]>([]);

  const reload = useCallback(() => {
    void Promise.resolve(api.getProxyPool?.())
      .then((res) => {
        setEntries(Array.isArray(res?.entries) ? res.entries : []);
      })
      .catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { entries, reload };
}
