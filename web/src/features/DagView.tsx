import { useEffect, useState } from 'react';
import { Panel } from '../ui/primitives';
import { isMock, mockDagDetail } from '../api/client';
import type { DagArtifact, DagDetail, TaskStatus } from '../api/types';

const STATUS_COLOR: Record<string, string> = {
  done: 'var(--ok)', in_progress: 'var(--idle)', queued: '#cdd6e0', blocked: 'var(--warn)', failed: 'var(--fail)', cancelled: '#cdd6e0',
};

// Assign each node an (x = depth, y = order-within-depth) for a simple layered layout.
function layout(detail: DagDetail): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const compute = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    if (seen.has(key)) return 0;
    seen.add(key);
    const node = detail.nodes.find((n) => n.key === key);
    const d = !node || node.deps.length === 0 ? 0 : 1 + Math.max(...node.deps.map((dk) => compute(dk, seen)));
    depth.set(key, d);
    return d;
  };
  for (const n of detail.nodes) compute(n.key, new Set());
  const byDepth = new Map<number, string[]>();
  for (const n of detail.nodes) {
    const d = depth.get(n.key) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n.key);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, keys] of byDepth) keys.forEach((k, i) => pos.set(k, { x: d, y: i }));
  return pos;
}

export function DagView({ dags, onNodeClick }: { dags: DagArtifact[]; onNodeClick: (label: string) => void }) {
  const [detail, setDetail] = useState<DagDetail | null>(null);
  const latest = dags[0];

  useEffect(() => {
    let alive = true;
    if (!latest) { setDetail(null); return; }
    if (isMock()) { setDetail(mockDagDetail[latest.id] ?? null); return; }
    fetch(`/api/dags/${encodeURIComponent(latest.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DagDetail | null) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [latest?.id]);

  if (!latest || !detail) return null;

  const pos = layout(detail);
  const COLW = 150, ROWH = 64, R = 26, padX = 30, padY = 24;
  const maxX = Math.max(...[...pos.values()].map((p) => p.x));
  const maxY = Math.max(...[...pos.values()].map((p) => p.y));
  const W = padX * 2 + maxX * COLW + R * 2 + 60;
  const H = padY * 2 + maxY * ROWH + R * 2;
  const at = (key: string) => { const p = pos.get(key)!; return { cx: padX + R + p.x * COLW, cy: padY + R + p.y * ROWH }; };

  return (
    <Panel title="Active DAG" tip="The current run's task graph. Independent branches run in parallel and converge at a shared node. Click a node to see its task. Every run-DAG is saved as a named artifact you can audit or replay.">
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>{detail.objective} · {detail.id}</div>
      <div style={{ overflowX: 'auto' }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#aab6c4" /></marker></defs>
          {detail.nodes.flatMap((n) => n.deps.map((d) => {
            const a = at(d), b = at(n.key);
            return <line key={`${d}-${n.key}`} x1={a.cx + R} y1={a.cy} x2={b.cx - R} y2={b.cy} stroke="#aab6c4" strokeWidth={2} markerEnd="url(#arrow)" />;
          }))}
          {detail.nodes.map((n) => {
            const p = at(n.key); const st = (detail.statusByKey[n.key] ?? 'queued') as TaskStatus;
            const light = st === 'queued' || st === 'cancelled';
            return (
              <g key={n.key} style={{ cursor: 'pointer' }} onClick={() => onNodeClick(`${n.key} (${n.role}) — ${st}`)}>
                <circle cx={p.cx} cy={p.cy} r={R} fill={STATUS_COLOR[st]} stroke="#10161d" strokeWidth={1.5} />
                <text x={p.cx} y={p.cy - 1} textAnchor="middle" fontSize={10} fill={light ? '#445' : '#fff'} fontFamily="var(--mono)">{n.title}</text>
                <text x={p.cx} y={p.cy + 10} textAnchor="middle" fontSize={8} fill={light ? '#667' : '#eef'} fontFamily="var(--mono)">{n.role}</text>
              </g>
            );
          })}
        </svg>
      </div>
      {detail.deadlocks.length > 0 && (
        <div className="mono" style={{ color: 'var(--fail)', fontSize: 11, marginTop: 6 }}>
          deadlocked: {detail.deadlocks.map((d) => d.key).join(', ')} (a dependency failed)
        </div>
      )}
      <div className="dag-legend">
        <span><i style={{ background: 'var(--ok)' }} />done</span>
        <span><i style={{ background: 'var(--idle)' }} />in progress</span>
        <span><i style={{ background: '#cdd6e0' }} />queued</span>
        <span><i style={{ background: 'var(--warn)' }} />blocked</span>
      </div>
    </Panel>
  );
}
