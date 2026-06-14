// types.ts — TypeScript shapes for every harness API response.
// These mirror server/api.js. Timestamps arrive as ISO strings (the server
// converts DuckDB micros → ISO) and ids as numbers.

export type TaskStatus = 'queued' | 'in_progress' | 'done' | 'failed' | 'blocked' | 'cancelled';
export type RunResult = 'success' | 'failure' | 'timeout' | 'crashed' | null;
export type WriteBackMode = 'comment' | 'subtask';

export interface QueueSummaryRow { role: string; status: TaskStatus; n: number }
export interface CostRow { role: string; runs: number; cost_usd: number | null; succeeded: number }

export interface Status {
  paused: boolean;
  lastHeartbeat: string | null;
  persistence: 'state-repo' | 'ephemeral';
  queue: QueueSummaryRow[];
  costs: CostRow[];
}

export interface Task {
  id: number;
  role: string;
  title: string;
  payload: string;                 // JSON string
  status: TaskStatus;
  priority: number;
  created_by: string;
  blocked_on: number | null;
  project: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  deps?: string | null;            // JSON array string
  dag_id?: string | null;
  dag_key?: string | null;
}

export interface Run {
  id: number;
  task_id: number;
  role: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  result: RunResult;
  summary: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  log_path: string | null;
  title: string;
}

export interface EventItem {
  id: number;
  role: string;
  task_id: number | null;
  kind: string;
  message: string;
  url: string | null;
  created_at: string;
  digested: boolean;
}

export interface Marker { ts: string; tag: string | null }
export interface LostSession { name: string; taskId: number; role: string; startedAt: string; transcriptUrl: string }
export interface Gap { start: string; end: string; durationMs: number; endedWithBoot: boolean; lostSessions?: LostSession[] }
export interface Continuity {
  beatIntervalMs: number;
  gapThresholdMs: number;
  now: string;
  markers: Marker[];
  gaps: Gap[];
}

export interface JiraConfig {
  baseUrl: string;
  email: string | null;
  projectKey: string | null;
  jql: string | null;
  writeBackMode: WriteBackMode;
  subtaskType: string;
  tokenConfigured: boolean;
  tokenSource: 'sealed' | 'env' | 'none';
}
export interface SetupStatus {
  secretStoreAvailable: boolean;
  envTokenPresent: boolean;
  jiraConfigured: boolean;
  jira: JiraConfig | null;
}

export interface DagArtifact { file: string; id: string; objective: string; nodeCount: number; createdAt: string }
export interface DagNode { key: string; role: string; title: string; deps: string[]; payload?: Record<string, unknown> }
export interface DagDetail {
  id: string;
  objective: string;
  nodes: DagNode[];
  executionOrder: string[];
  statusByKey: Record<string, TaskStatus>;
  deadlocks: { key: string; blockedBy: string[] }[];
}
