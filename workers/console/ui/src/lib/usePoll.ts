import { useCallback, useEffect, useRef, useState } from "react";

/** Load once, then refresh every `intervalMs` while the tab is visible (0 = no refresh). */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 0, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const value = await loadRef.current();
      if (id === seq.current) { setData(value); setError(null); }
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!intervalMs) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, intervalMs);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh };
}
