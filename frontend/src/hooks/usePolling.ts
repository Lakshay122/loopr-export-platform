import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data now, and again every `intervalMs` while `keepPolling(data)` is true.
 * Exports change in the background (scheduler, workers), so screens refresh themselves.
 * `key` decides when to start over (e.g. a different workspace or export).
 */
export function usePolling<T>(
  load: () => Promise<T>,
  key: string,
  intervalMs = 2000,
  keepPolling: (data: T | null) => boolean = () => true,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
  }, [key, refresh]);

  const active = keepPolling(data);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [key, active, intervalMs, refresh]);

  return { data, error, refresh };
}
