import { useEffect, useRef, useState, useCallback } from 'react';
import { api, type DashboardSnapshot } from './api/client';

// Generic polling: runs fn now and every ms; pauses cleanly on unmount.
export function usePolling(fn: () => void | Promise<void>, ms: number): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = async () => { if (alive) await saved.current(); };
    void tick();
    const id = setInterval(() => { void tick(); }, ms);
    return () => { alive = false; clearInterval(id); };
  }, [ms]);
}

export interface DashboardState {
  data: DashboardSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
}

// Aggregates the whole dashboard snapshot and re-polls every `ms`.
export function useDashboard(ms = 5000): DashboardState {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setData(await api.snapshot()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  usePolling(refresh, ms);
  return { data, error, refresh };
}
