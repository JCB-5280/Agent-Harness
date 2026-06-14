import { useState } from 'react';
import { Panel, Button, Chip, Table, SegmentedControl, TextInput, type Column } from '../ui/primitives';
import type { Task, SetupStatus, CostRow, WriteBackMode } from '../api/types';

export function SeedForm({ onSeed }: { onSeed: (title: string, project: string | null) => void }) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  return (
    <Panel title="Give the team work" tip="Type a goal and it goes to the PM agent, which breaks it into a task DAG. Don't enter dev-level tasks here.">
      <p className="hint">Objectives go to the PM agent, which decomposes them into a dependency graph.</p>
      <div className="seed-form">
        <TextInput value={title} placeholder="Objective, e.g. Add CSV export to the reporting API" onChange={setTitle} />
        <TextInput value={project} placeholder="Project (repo in workspace/)" onChange={setProject} />
        <Button variant="primary" onClick={() => { if (title.trim()) { onSeed(title.trim(), project.trim() || null); setTitle(''); } }}>Send to PM</Button>
      </div>
    </Panel>
  );
}

export function QueuePanel({ tasks, onRetry, onCancel }: { tasks: Task[]; onRetry: (id: number) => void; onCancel: (id: number) => void }) {
  const open = tasks.filter((t) => ['queued', 'in_progress', 'blocked', 'failed'].includes(t.status));
  const cols: Column<Task>[] = [
    { header: '#', cell: (t) => t.id, mono: true },
    { header: 'role', cell: (t) => t.role },
    { header: 'task', cell: (t) => <>{t.title}{t.dag_id && <span className="mono" style={{ color: 'var(--muted)' }}> · dag</span>}</> },
    { header: 'status', cell: (t) => <Chip label={t.status} /> },
    { header: '', cell: (t) =>
        ['failed', 'blocked'].includes(t.status) ? <Button variant="link" onClick={() => onRetry(t.id)}>retry</Button>
        : t.status === 'queued' ? <Button variant="link" onClick={() => onCancel(t.id)}>cancel</Button> : null },
  ];
  return (
    <Panel title="Queue" tip="Open work items across all roles. The colored spine shows which agent owns each task. Tasks only run when their DAG dependencies are done.">
      <Table columns={cols} rows={open} rowKey={(t) => t.id} roleOf={(t) => t.role} empty="queue is empty — seed an objective above" />
    </Panel>
  );
}

export function JiraPanel(props: {
  setup: SetupStatus | null;
  onModeChange: (m: WriteBackMode) => void; onSync: () => void; onReconfigure: () => void;
}) {
  const j = props.setup?.jira;
  return (
    <Panel title="Jira" tip="Your Jira board is the task input. The harness pulls matching issues into its queue and writes progress back. The toggle controls sub-tasks vs. comments.">
      {!j ? <p className="hint">Not connected.</p> : (
        <>
          <p className="hint">Connected to <span className="mono">{j.baseUrl}</span>
            {j.projectKey && <> · project <span className="mono">{j.projectKey}</span></>}
            {' '}· {j.tokenSource === 'env' ? 'token via env' : j.tokenSource === 'sealed' ? 'token encrypted at rest' : 'no token'}</p>
          <div style={{ margin: '8px 0' }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>When agents work an issue:</span>
            <SegmentedControl<WriteBackMode> value={j.writeBackMode}
              options={[{ value: 'comment', label: 'Comment with results' }, { value: 'subtask', label: 'Create sub-tasks' }]}
              onChange={props.onModeChange} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button variant="ghost" onClick={props.onSync}>Sync issues now</Button>
            <Button variant="ghost" onClick={props.onReconfigure}>Reconfigure</Button>
          </div>
        </>
      )}
    </Panel>
  );
}

export function CostsPanel({ costs }: { costs: CostRow[] }) {
  const cols: Column<CostRow>[] = [
    { header: 'role', cell: (c) => c.role },
    { header: 'runs', cell: (c) => c.runs, mono: true },
    { header: 'ok', cell: (c) => `${c.succeeded}/${c.runs}`, mono: true },
    { header: 'cost (USD)', cell: (c) => (c.cost_usd ?? '—'), mono: true },
  ];
  return (
    <Panel title="Costs by role" tip="Per-role session count, success rate, and dollar cost as reported by the model.">
      <Table columns={cols} rows={costs} rowKey={(c) => c.role} roleOf={(c) => c.role} empty="no runs yet" />
    </Panel>
  );
}
