// Small shared helpers.
export function ago(ts: string | null): string {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (!Number.isFinite(s)) return String(ts);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
export function clockHM(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
