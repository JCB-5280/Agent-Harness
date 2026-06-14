// client.ts — the only place that talks to the harness API. Everything is typed.
//
// Mock mode: append ?mock=1 to the URL to run the whole dashboard with no backend
// (useful for developing against your enterprise component library before wiring
// the server). A small state switcher in mock mode flips between scenarios.

import type {
  Status, Task, Run, EventItem, Continuity, SetupStatus, DagArtifact, WriteBackMode,
} from './types';

const MOCK = new URLSearchParams(window.location.search).has('mock');
export const isMock = (): boolean => MOCK;

export type MockKey = 'alive' | 'mixed' | 'firstrun';
let mockState: MockKey = 'alive';
export const setMockState = (k: MockKey): void => { mockState = k; };
export const getMockState = (): MockKey => mockState;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}
async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

export interface DashboardSnapshot {
  status: Status;
  tasks: Task[];
  runs: Run[];
  events: EventItem[];
  continuity: Continuity;
  setup: SetupStatus;
  dags: DagArtifact[];
}

export const api = {
  async snapshot(): Promise<DashboardSnapshot> {
    if (MOCK) return mockSnapshot(mockState);
    const [status, tasks, runs, events, continuity, setup, dags] = await Promise.all([
      get<Status>('/api/status'),
      get<Task[]>('/api/tasks?limit=60'),
      get<Run[]>('/api/runs?limit=30'),
      get<EventItem[]>('/api/events?limit=30'),
      get<Continuity>('/api/continuity'),
      get<SetupStatus>('/api/setup/status'),
      get<DagArtifact[]>('/api/dags'),
    ]);
    return { status, tasks, runs, events, continuity, setup, dags };
  },
  seedObjective: (title: string, project: string | null) =>
    post('/api/tasks', { title, project }),
  retryTask: (id: number) => post(`/api/tasks/${id}/retry`),
  cancelTask: (id: number) => post(`/api/tasks/${id}/cancel`),
  pause: () => post('/api/control/pause'),
  resume: () => post('/api/control/resume'),
  checkpoint: () => post('/api/control/checkpoint'),
  setWriteBackMode: (mode: WriteBackMode) => post('/api/settings/writeback-mode', { mode }),
  setGapThreshold: (ms: number) => post('/api/settings/gap-threshold', { ms }),
  jiraSync: () => post('/api/setup/jira/sync'),
  saveJira: (cfg: Record<string, unknown>) => post('/api/setup/jira', cfg),
  testJira: () => post('/api/setup/jira/test'),
  transcriptUrl: (runId: number) => `/api/runs/${runId}/stream`,
};

// ---- mock scenarios (only used when ?mock=1) ----
function mockSnapshot(key: MockKey): DashboardSnapshot {
  return MOCKS[key];
}

const baseContinuity = (gap: boolean): Continuity => ({
  beatIntervalMs: 30000,
  gapThresholdMs: 120000,
  now: new Date().toISOString(),
  markers: [{ ts: '2026-06-13T01:30:00Z', tag: 'boot' }, { ts: '2026-06-13T02:02:52Z', tag: gap ? 'boot' : null }],
  gaps: gap
    ? [{ start: '2026-06-13T02:01:12Z', end: '2026-06-13T02:02:52Z', durationMs: 100000, endedWithBoot: true,
        lostSessions: [{ name: 'task116-dev-1.log', taskId: 116, role: 'dev', startedAt: '2026-06-13T01:58:00Z', transcriptUrl: '#' }] }]
    : [],
});

const MOCKS: Record<MockKey, DashboardSnapshot> = {
  alive: {
    status: { paused: false, lastHeartbeat: new Date().toISOString(), persistence: 'state-repo',
      queue: [{ role: 'dev', status: 'in_progress', n: 1 }, { role: 'dev', status: 'queued', n: 1 }, { role: 'qa', status: 'queued', n: 1 }],
      costs: [
        { role: 'pm', runs: 14, succeeded: 14, cost_usd: 2.10 }, { role: 'dev', runs: 38, succeeded: 34, cost_usd: 18.44 },
        { role: 'reviewer', runs: 22, succeeded: 22, cost_usd: 4.80 }, { role: 'qa', runs: 19, succeeded: 17, cost_usd: 6.05 },
        { role: 'comms', runs: 7, succeeded: 7, cost_usd: 0.42 }] },
    tasks: [
      mockTask(118, 'dev', 'Stream large result sets · BI', 'in_progress'),
      mockTask(119, 'dev', 'Add export button to dashboard · BI', 'queued'),
      mockTask(120, 'qa', 'Verify CSV export E2E + drift · BI', 'queued'),
      mockTask(121, 'pm', 'Plan: monthly active members tile · BI', 'queued'),
    ],
    runs: [
      mockRun(118, 'dev', null, null, 'now'), mockRun(117, 'dev', 'success', 46, '4m'),
      mockRun(116, 'reviewer', 'success', 12, '11m'), mockRun(115, 'qa', 'failure', 31, '18m'),
    ],
    events: [
      mockEvent('reviewer', 'pr_approved', 'Approved PR #42: CSV export endpoint', 'https://example/pr/42'),
      mockEvent('qa', 'defect', 'active_member off by 1.1% vs tolerance 0.5%', null),
      mockEvent('dev', 'pr_opened', 'PR #43: stream large result sets', 'https://example/pr/43'),
      mockEvent('comms', 'digest', 'Daily digest 2026-06-13; drift: 1 breach', null),
    ],
    continuity: baseContinuity(true),
    setup: mockSetup(true, 'subtask'),
    dags: [{ file: 'dag-20260613-021455-add-csv-export-a1b2c3.json', id: 'dag-20260613-021455-add-csv-export-a1b2c3', objective: 'Add CSV export to the reporting API', nodeCount: 4, createdAt: '2026-06-13T02:14:55Z' }],
  },
  mixed: {
    status: { paused: false, lastHeartbeat: new Date().toISOString(), persistence: 'state-repo',
      queue: [{ role: 'dev', status: 'queued', n: 1 }, { role: 'pm', status: 'blocked', n: 1 }],
      costs: [{ role: 'pm', runs: 6, succeeded: 6, cost_usd: 0.95 }, { role: 'dev', runs: 12, succeeded: 11, cost_usd: 5.30 }, { role: 'qa', runs: 5, succeeded: 5, cost_usd: 1.45 }] },
    tasks: [
      mockTask(121, 'pm', 'Confirm definition: active_member · BI', 'blocked'),
      mockTask(122, 'dev', 'Add region dimension to revenue model · BI', 'queued'),
      mockTask(120, 'qa', 'Verify CSV export E2E · BI', 'done'),
    ],
    runs: [mockRun(120, 'qa', 'success', 28, '6m'), mockRun(119, 'reviewer', 'success', 14, '14m')],
    events: [
      mockEvent('pm', 'alert', '1 metric needs human confirmation: active_member.md', null),
      mockEvent('comms', 'digest', 'Daily digest 2026-06-13; drift: steady', null),
    ],
    continuity: baseContinuity(false),
    setup: mockSetup(true, 'comment'),
    dags: [{ file: 'dag-20260613-014102-revenue-by-region-7f9c2e.json', id: 'dag-20260613-014102-revenue-by-region-7f9c2e', objective: 'Revenue by region (last quarter)', nodeCount: 3, createdAt: '2026-06-13T01:41:02Z' }],
  },
  firstrun: {
    status: { paused: false, lastHeartbeat: new Date().toISOString(), persistence: 'ephemeral', queue: [], costs: [] },
    tasks: [], runs: [], events: [],
    continuity: { beatIntervalMs: 30000, gapThresholdMs: 120000, now: new Date().toISOString(), markers: [{ ts: new Date().toISOString(), tag: 'boot' }], gaps: [] },
    setup: { secretStoreAvailable: true, envTokenPresent: false, jiraConfigured: false, jira: null },
    dags: [],
  },
};

function mockTask(id: number, role: string, title: string, status: Task['status']): Task {
  return { id, role, title, payload: '{}', status, priority: 10, created_by: 'jira', blocked_on: null, project: 'BI', attempts: status === 'blocked' ? 3 : 0, max_attempts: 3, created_at: '', updated_at: '' };
}
function mockRun(task_id: number, role: string, result: Run['result'], num_turns: number | null, when: string): Run {
  return { id: task_id, task_id, role, started_at: when, finished_at: result ? when : null, exit_code: 0, result, summary: 'mock summary', cost_usd: 0.3, num_turns, log_path: '/x', title: '' };
}
function mockEvent(role: string, kind: string, message: string, url: string | null): EventItem {
  return { id: Math.random(), role, task_id: null, kind, message, url, created_at: new Date().toISOString(), digested: false };
}
function mockSetup(configured: boolean, mode: WriteBackMode): SetupStatus {
  return { secretStoreAvailable: true, envTokenPresent: false, jiraConfigured: configured,
    jira: configured ? { baseUrl: 'acme.atlassian.net', email: 'me@corp.com', projectKey: 'BI', jql: null, writeBackMode: mode, subtaskType: 'Sub-task', tokenConfigured: true, tokenSource: 'sealed' } : null };
}

// Mock DAG detail for the DAG panel (keyed by dag id).
export const mockDagDetail: Record<string, import('./types').DagDetail> = {
  'dag-20260613-021455-add-csv-export-a1b2c3': {
    id: 'dag-20260613-021455-add-csv-export-a1b2c3', objective: 'Add CSV export to the reporting API',
    nodes: [
      { key: 'ep', role: 'dev', title: 'endpoint', deps: [] },
      { key: 'stream', role: 'dev', title: 'stream', deps: ['ep'] },
      { key: 'btn', role: 'dev', title: 'button', deps: ['ep'] },
      { key: 'qa', role: 'qa', title: 'verify', deps: ['stream', 'btn'] }],
    executionOrder: ['ep', 'stream', 'btn', 'qa'],
    statusByKey: { ep: 'done', stream: 'in_progress', btn: 'queued', qa: 'blocked' },
    deadlocks: [],
  },
  'dag-20260613-014102-revenue-by-region-7f9c2e': {
    id: 'dag-20260613-014102-revenue-by-region-7f9c2e', objective: 'Revenue by region (last quarter)',
    nodes: [
      { key: 'def', role: 'pm', title: 'define', deps: [] },
      { key: 'model', role: 'dev', title: 'model', deps: ['def'] },
      { key: 'qa', role: 'qa', title: 'verify', deps: ['model'] }],
    executionOrder: ['def', 'model', 'qa'],
    statusByKey: { def: 'blocked', model: 'queued', qa: 'queued' },
    deadlocks: [],
  },
};
