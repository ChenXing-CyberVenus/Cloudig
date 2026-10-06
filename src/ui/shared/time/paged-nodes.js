// A flat time-node picker must not silently stop at the Engine's per-page limit.
export function createTimeNodePager({ host, query, render, onError, signal, limit = 100 }) {
  let epoch = 0, loading = false, more = false, rows = [], args = {}, offset = 0;
  const load = async () => {
    if (loading || signal.aborted) return;
    const current = epoch; loading = true;
    try {
      const result = await query({ ...args, offset, limit });
      if (signal.aborted || current !== epoch) return;
      const batch = result.items ?? [];
      rows.push(...batch); offset += batch.length;
      more = batch.length > 0 && offset < (result.total ?? offset);
      const top = host.scrollTop; render(rows); host.scrollTop = top;
    } catch (error) { if (!signal.aborted && current === epoch) { more = false; onError?.(error); } }
    finally {
      if (current === epoch) {
        loading = false;
        if (!signal.aborted && more && host.clientHeight > 0 && host.scrollHeight <= host.clientHeight + 1) queueMicrotask(load);
      }
    }
  };
  host.addEventListener("scroll", () => { if (more && host.scrollTop + host.clientHeight >= host.scrollHeight - 100) load(); }, { signal });
  return {
    refresh(next = {}) { epoch++; args = next; rows = []; offset = 0; more = false; loading = false; host.scrollTop = 0; return load(); },
    dispose() { epoch++; more = false; loading = false; }
  };
}
