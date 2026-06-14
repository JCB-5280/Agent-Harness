import { useEffect, useRef, useState } from 'react';
import { Panel, Info } from '../ui/primitives';
import { fmtDur, clockHM } from '../util';
import type { Continuity, LostSession } from '../api/types';

export function ContinuityPanel(props: {
  continuity: Continuity | null;
  onThresholdChange: (ms: number) => void;
  onOpenTranscript: (s: LostSession) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [threshSec, setThreshSec] = useState<number | null>(null);
  const c = props.continuity;

  useEffect(() => {
    const measure = () => setWidth(hostRef.current?.clientWidth || 560);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => { if (c && threshSec === null) setThreshSec(Math.round(c.gapThresholdMs / 1000)); }, [c, threshSec]);

  const H = 46, y = 22, W = width;

  function chain() {
    if (!c || c.markers.length < 2) return <span className="mono" style={{ color: 'var(--muted)' }}>building chain…</span>;
    const segs: JSX.Element[] = [];
    const hasGap = c.gaps.length > 0;
    if (hasGap) {
      segs.push(<line key="a" x1={2} y1={y} x2={W * 0.42} y2={y} stroke="var(--ok)" strokeWidth={3} />);
      const m = W * 0.52;
      segs.push(<line key="b1" x1={W * 0.42} y1={y} x2={m - 9} y2={y} stroke="var(--fail)" strokeWidth={3} strokeDasharray="3 3" />);
      segs.push(<line key="b2" x1={m + 9} y1={y} x2={W * 0.62} y2={y} stroke="var(--fail)" strokeWidth={3} strokeDasharray="3 3" />);
      segs.push(<text key="lk" x={m} y={y + 5} textAnchor="middle" fontSize={14}>🔓</text>);
      segs.push(<line key="c" x1={W * 0.62} y1={y} x2={W - 2} y2={y} stroke="var(--ok)" strokeWidth={3} />);
    } else {
      segs.push(<line key="ok" x1={2} y1={y} x2={W - 2} y2={y} stroke="var(--ok)" strokeWidth={3} />);
    }
    const first = c.markers[0].ts;
    return (
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {segs}
        <text x={2} y={H - 2} fontSize={10} fill="var(--muted)">{clockHM(first)}</text>
        <text x={W - 2} y={H - 2} fontSize={10} fill="var(--muted)" textAnchor="end">now</text>
      </svg>
    );
  }

  return (
    <Panel title="Continuity" tip="A heartbeat every 30s, independent of agent work. An unbroken chain means the process ran continuously; a broken link (🔓) marks a window when the harness was down, and any session mid-flight then is listed below with its recovered transcript.">
      <div ref={hostRef} style={{ width: '100%', height: H, margin: '4px 0 10px' }}>{chain()}</div>
      <div className="lockgraph-legend">
        <span><i className="lk-ok" /> continuous</span>
        <span><i className="lk-gap" /> gap (down)</span>
        <span>flag gaps over{' '}
          <input className="thresh-input" type="number" min={1} value={threshSec ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value); setThreshSec(v);
              if (v > 0) props.onThresholdChange(Math.round(v * 1000));
            }} />{' '}s
          <Info tip="How long the chain must go silent before it counts as a gap rather than jitter. Default ≈ four missed beats." />
        </span>
      </div>
      <ul className="feed">
        {(!c || c.gaps.length === 0) && <li className="mono" style={{ color: 'var(--muted)' }}>no gaps — chain unbroken</li>}
        {c?.gaps.slice().reverse().map((g, i) => (
          <li key={i} className="gap-row">
            <span className="kind">{g.endedWithBoot ? 'restart' : 'gap'}</span>down {fmtDur(g.durationMs)}
            <div className="gap-when">{g.start} → {g.end}</div>
            <div className="lost">
              {g.lostSessions && g.lostSessions.length > 0
                ? <>lost in this gap: {g.lostSessions.map((s, j) => (
                    <span key={j}>{j > 0 && ', '}<a onClick={() => props.onOpenTranscript(s)} style={{ cursor: 'pointer' }}>task #{s.taskId} {s.role}</a></span>))}</>
                : 'no session was mid-flight'}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
