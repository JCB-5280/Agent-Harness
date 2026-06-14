// db.js — thin wrapper around DuckDB for the harness.
// Uses the official @duckdb/node-api ("neo") client.
// One writer (the orchestrator process) keeps things simple:
// agents request DB changes by emitting JSON to stdout (see spawn.js),
// or by calling scripts/agent-db.js inside their session.

import { DuckDBInstance } from '@duckdb/node-api';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In-memory by default: the database is a rebuildable cache held in RAM, and the
// git state repo (parquet export) is the only persistence. Set HARNESS_DB to a file
// path for local dev if you want a disk-backed DB instead.
const DB_PATH = process.env.HARNESS_DB || ':memory:';

let instance, conn;

export async function getDb() {
  if (!conn) {
    instance = await DuckDBInstance.create(DB_PATH);
    conn = await instance.connect();
  }
  return conn;
}

export async function initSchema() {
  const db = await getDb();
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.run(schema);
}

// --- task queue ------------------------------------------------

export async function claimNextTask(role) {
  const db = await getDb();
  // Highest priority queued task for this role whose blocker (if any) is done.
  const reader = await db.runAndReadAll(
    `SELECT t.* FROM tasks t
     LEFT JOIN tasks b ON t.blocked_on = b.id
     WHERE t.role = ?
       AND t.status = 'queued'
       AND t.attempts < t.max_attempts
       AND (t.blocked_on IS NULL OR b.status = 'done')
     ORDER BY t.priority ASC, t.created_at ASC
     LIMIT 1`,
    [role],
  );
  const rows = reader.getRowObjects();
  if (rows.length === 0) return null;
  const task = rows[0];
  await db.run(
    `UPDATE tasks SET status = 'in_progress',
       attempts = attempts + 1,
       updated_at = current_timestamp
     WHERE id = ?`,
    [task.id],
  );
  return task;
}

export async function finishTask(taskId, status) {
  const db = await getDb();
  await db.run(
    `UPDATE tasks SET status = ?, updated_at = current_timestamp WHERE id = ?`,
    [status, taskId],
  );
}

export async function createTask({ role, title, payload = {}, createdBy, priority = 50, blockedOn = null, project = null }) {
  const db = await getDb();
  await db.run(
    `INSERT INTO tasks (role, title, payload, created_by, priority, blocked_on, project)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [role, title, JSON.stringify(payload), createdBy, priority, blockedOn, project],
  );
}

// --- runs & events ---------------------------------------------

export async function startRun(taskId, role, logPath) {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `INSERT INTO runs (task_id, role, log_path) VALUES (?, ?, ?) RETURNING id`,
    [taskId, role, logPath],
  );
  return reader.getRowObjects()[0].id;
}

export async function finishRun(runId, { exitCode, result, summary, costUsd, numTurns }) {
  const db = await getDb();
  await db.run(
    `UPDATE runs SET finished_at = current_timestamp, exit_code = ?, result = ?,
       summary = ?, cost_usd = ?, num_turns = ?
     WHERE id = ?`,
    [exitCode ?? null, result ?? null, summary ?? null, costUsd ?? null, numTurns ?? null, runId],
  );
}

export async function addEvent({ role, taskId = null, kind, message, url = null }) {
  const db = await getDb();
  await db.run(
    `INSERT INTO events (role, task_id, kind, message, url) VALUES (?, ?, ?, ?, ?)`,
    [role, taskId, kind, message, url],
  );
}

export async function heartbeat(note = '') {
  const db = await getDb();
  await db.run(`INSERT INTO heartbeats (note) VALUES (?)`, [note]);
}

// --- settings & API queries -------------------------------------

export async function getSetting(key, fallback = null) {
  const db = await getDb();
  const r = await db.runAndReadAll(`SELECT value FROM settings WHERE key = ?`, [key]);
  const rows = r.getRowObjects();
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, String(value)],
  );
}

export async function sweepStaleInProgress(maxAgeMinutes = 45) {
  // Container restarts strand tasks in 'in_progress'. Requeue them on boot.
  const db = await getDb();
  const r = await db.runAndReadAll(
    `UPDATE tasks SET status = 'queued', updated_at = current_timestamp
     WHERE status = 'in_progress'
       AND updated_at < current_timestamp - INTERVAL (?) MINUTE
     RETURNING id`,
    [maxAgeMinutes],
  );
  return r.getRowObjects().map((x) => x.id);
}

export async function queueSummary() {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT role, status, count(*)::INT AS n FROM tasks GROUP BY role, status`);
  return r.getRowObjects();
}

export async function listTasks({ status = null, limit = 100 } = {}) {
  const db = await getDb();
  const r = status
    ? await db.runAndReadAll(`SELECT * FROM tasks WHERE status = ? ORDER BY priority, created_at LIMIT ?`, [status, limit])
    : await db.runAndReadAll(`SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?`, [limit]);
  return r.getRowObjects();
}

export async function listRuns({ limit = 50 } = {}) {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT r.*, t.title FROM runs r JOIN tasks t ON t.id = r.task_id
     ORDER BY r.started_at DESC LIMIT ?`, [limit]);
  return r.getRowObjects();
}

export async function listEvents({ limit = 50, undigestedOnly = false } = {}) {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT * FROM events ${undigestedOnly ? 'WHERE NOT digested' : ''}
     ORDER BY created_at DESC LIMIT ?`, [limit]);
  return r.getRowObjects();
}

export async function getRun(id) {
  const db = await getDb();
  const r = await db.runAndReadAll(`SELECT * FROM runs WHERE id = ?`, [id]);
  return r.getRowObjects()[0] || null;
}

export async function updateTaskStatus(id, status) {
  const db = await getDb();
  await db.run(`UPDATE tasks SET status = ?, updated_at = current_timestamp WHERE id = ?`, [status, id]);
}

export async function lastHeartbeat() {
  const db = await getDb();
  const r = await db.runAndReadAll(`SELECT max(ts) AS ts FROM heartbeats`);
  return r.getRowObjects()[0]?.ts || null;
}

export async function costByRole() {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT role, count(*)::INT AS runs, round(sum(cost_usd), 2) AS cost_usd,
            sum(CASE WHEN result='success' THEN 1 ELSE 0 END)::INT AS succeeded
     FROM runs GROUP BY role ORDER BY role`);
  return r.getRowObjects();
}

// --- Jira issue dedupe (sync layer) ----------------------------

export async function taskExistsForJiraKey(jiraKey) {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT id FROM tasks WHERE json_extract_string(payload, '$.jira_key') = ? LIMIT 1`,
    [jiraKey],
  );
  return r.getRowObjects().length > 0;
}

export async function tasksWithJiraKey(limit = 200) {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT id, role, title, status, payload FROM tasks
     WHERE json_extract_string(payload, '$.jira_key') IS NOT NULL
     ORDER BY updated_at DESC LIMIT ?`, [limit]);
  return r.getRowObjects();
}

// --- DAG-aware task claiming & persistence ---------------------

// Claim the next runnable task for a role under DAG semantics: a task is runnable
// when it has no unmet dependencies. We filter cheaply in SQL, then check the deps
// array in JS (correct and simple at single-writer scale).
export async function claimNextDagTask(role) {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `SELECT * FROM tasks
     WHERE role = ? AND status = 'queued' AND attempts < max_attempts
     ORDER BY priority ASC, created_at ASC`,
    [role],
  );
  const candidates = reader.getRowObjects();
  if (candidates.length === 0) return null;

  // Resolve which task ids are 'done' (for dependency checks).
  const doneReader = await db.runAndReadAll(`SELECT id FROM tasks WHERE status = 'done'`);
  const done = new Set(doneReader.getRowObjects().map((r) => Number(r.id)));

  for (const task of candidates) {
    let deps = [];
    if (task.deps) { try { deps = JSON.parse(task.deps); } catch { deps = []; } }
    // legacy single-dep support
    if ((!deps || deps.length === 0) && task.blocked_on != null) deps = [Number(task.blocked_on)];
    const runnable = (deps || []).every((d) => done.has(Number(d)));
    if (!runnable) continue;
    await db.run(
      `UPDATE tasks SET status='in_progress', attempts=attempts+1, updated_at=now() WHERE id = ?`,
      [task.id],
    );
    return task;
  }
  return null;
}

// Insert a task that belongs to a DAG, with resolved dependency ids.
export async function createDagTask({ role, title, payload = {}, createdBy, priority = 50, project = null, deps = [], dagId = null, dagKey = null }) {
  const db = await getDb();
  const reader = await db.runAndReadAll(
    `INSERT INTO tasks (role, title, payload, created_by, priority, project, deps, dag_id, dag_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [role, title, JSON.stringify(payload), createdBy, priority, project, JSON.stringify(deps), dagId, dagKey],
  );
  return Number(reader.getRowObjects()[0].id);
}

export async function recordDag({ id, objective, createdBy, project, nodeCount, spec, artifact }) {
  const db = await getDb();
  await db.run(
    `INSERT INTO dags (id, objective, created_by, project, node_count, spec, artifact)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    [id, objective, createdBy, project, nodeCount, JSON.stringify(spec), artifact],
  );
}

export async function listDags(limit = 50) {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT id, objective, created_by, project, node_count, artifact, status, created_at
     FROM dags ORDER BY created_at DESC LIMIT ?`, [limit]);
  return r.getRowObjects();
}

export async function getDagSpec(id) {
  const db = await getDb();
  const r = await db.runAndReadAll(`SELECT * FROM dags WHERE id = ?`, [id]);
  return r.getRowObjects()[0] || null;
}

// Tasks belonging to a dag, with status — for the dashboard's graph view and
// deadlock detection.
export async function dagTasks(dagId) {
  const db = await getDb();
  const r = await db.runAndReadAll(
    `SELECT id, role, title, status, deps, dag_key FROM tasks WHERE dag_id = ? ORDER BY id`, [dagId]);
  return r.getRowObjects();
}
