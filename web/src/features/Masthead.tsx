import { Lamp, Info, Button, Banner } from '../ui/primitives';
import { ago } from '../util';
import type { Status, Task, SetupStatus } from '../api/types';

export function Masthead(props: {
  status: Status | null;
  onPause: () => void; onCheckpoint: () => void;
}) {
  const s = props.status;
  const hbAge = s?.lastHeartbeat ? (Date.now() - new Date(s.lastHeartbeat).getTime()) / 1000 : Infinity;
  const loopState = !s ? 'off' : s.paused ? 'warn' : hbAge < 180 ? 'on' : 'off';
  const loopLabel = `loop${s?.paused ? ' (paused)' : loopState === 'off' ? ' (stale)' : ''}`;
  const persistState = s?.persistence === 'state-repo' ? 'on' : 'warn';
  const persistLabel = s?.persistence === 'state-repo' ? 'state: durable' : 'state: ephemeral';

  return (
    <header className="masthead">
      <div><h1>Shift Log</h1><span className="sub">agent harness</span></div>
      <div className="masthead-right">
        <Lamp state={loopState} label={loopLabel} />
        <Info tip="Green and pulsing means the heartbeat is fresh and the loop is alive. Amber means paused. Red means the heartbeat has gone stale — the process may be down." />
        <Lamp state={persistState} label={persistLabel} />
        <Info tip="Durable means state is checkpointed to the git state repo and survives a restart. Ephemeral means no state repo is configured." />
        <Button variant="ghost" onClick={props.onPause}>{s?.paused ? 'Resume' : 'Pause'}</Button>
        <Info tip="Pause stops new sessions from starting. A running session finishes first." />
        <Button variant="ghost" onClick={props.onCheckpoint}>Checkpoint now</Button>
      </div>
    </header>
  );
}

export function SetupBanner({ show, onOpen }: { show: boolean; onOpen: () => void }) {
  if (!show) return null;
  return (
    <Banner tone="info">
      <span>Finish setup to connect your Jira board.</span>
      <Button variant="primary" onClick={onOpen}>Open setup</Button>
    </Banner>
  );
}

export function NeedsHuman({ tasks, setup }: { tasks: Task[]; setup: SetupStatus | null }) {
  const blocked = tasks.filter((t) => t.status === 'blocked' || (t.status === 'failed' && t.attempts >= t.max_attempts));
  if (blocked.length === 0) return null;
  return (
    <Banner tone="warn">
      <div style={{ width: '100%' }}>
        <h2 style={{ font: '700 13px var(--sans)', textTransform: 'uppercase', letterSpacing: '1px', margin: '0 0 6px', color: 'var(--warn)' }}>Needs a human</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {blocked.map((t) => (
            <li key={t.id} style={{ margin: '3px 0' }}>
              <span className="mono">#{t.id}</span> [{t.role}] {t.title} — <em>{t.status}</em>
              {' '}<span className="mono" style={{ color: 'var(--muted)' }}>· {ago(t.updated_at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Banner>
  );
}
