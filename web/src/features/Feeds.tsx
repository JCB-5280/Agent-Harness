import { Panel, Chip, Button, Table, type Column } from '../ui/primitives';
import { ago } from '../util';
import type { Run, EventItem } from '../api/types';

export function RunsPanel({ runs, onOpenTranscript }: { runs: Run[]; onOpenTranscript: (r: Run) => void }) {
  const cols: Column<Run>[] = [
    { header: 'task', cell: (r) => `#${r.task_id}`, mono: true },
    { header: 'role', cell: (r) => r.role },
    { header: 'result', cell: (r) => <Chip label={r.result ?? 'running'} /> },
    { header: 'turns', cell: (r) => (r.num_turns ?? '—'), mono: true },
    { header: 'when', cell: (r) => ago(r.started_at), mono: true },
    { header: '', cell: (r) => <Button variant="link" onClick={() => onOpenTranscript(r)}>transcript</Button> },
  ];
  return (
    <Panel title="Recent runs" tip="Each agent session with result, turns, and timing. Open a transcript to read what the agent did — streamed live while it runs.">
      <Table columns={cols} rows={runs} rowKey={(r) => r.id} roleOf={(r) => r.role} empty="no runs yet" />
    </Panel>
  );
}

export function EventFeed({ events }: { events: EventItem[] }) {
  return (
    <Panel title="Event feed" tip="Milestones agents emit for humans: PRs opened/approved, defects, alerts, digests.">
      <ul className="feed">
        {events.length === 0 && <li className="mono" style={{ color: 'var(--muted)' }}>no events yet</li>}
        {events.map((e) => (
          <li key={e.id} style={{ borderLeftColor: `var(--role-${e.role}, var(--rule))` }}>
            <span className="kind">{e.kind}</span>{e.message}
            {e.url && <> <a href={e.url} target="_blank" rel="noopener noreferrer">open</a></>}
            <span className="mono" style={{ color: 'var(--muted)' }}> · {ago(e.created_at)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
