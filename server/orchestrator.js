// orchestrator.js — the tick loop, still deliberately dumb.
import {
  claimNextDagTask, finishTask, createTask, startRun, finishRun,
  addEvent, getSetting,
} from './db.js';
import { runSession } from './spawn.js';
import { checkpoint } from './persist.js';
import { flushTelemetry } from './telemetry.js';
import { materializeDag } from './dags.js';
import { validateDag } from './dag.js';
import { syncFromJira, writeBackToJira } from './jira.js';

const ARTIFACT_FLUSH_MS = Number(process.env.ARTIFACT_FLUSH_MS || 45_000);

const ROLE_ORDER = (process.env.ROLE_ORDER || 'reviewer,qa,dev,pm,comms').split(',').map((s) => s.trim());
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);

// Turn an agent's declared follow-up work into tasks. If the agent expressed a
// graph (new_tasks carry `key` + `deps`), materialize it as an audited DAG;
// otherwise fall back to flat task creation. This is how a planner/leader's
// decomposition becomes a saved, replayable graph.
async function applyNewTasks(parsedTasks, { createdBy, project }) {
  const tasks = parsedTasks || [];
  const isGraph = tasks.length > 1 && tasks.some((t) => t.key && Array.isArray(t.deps));
  if (isGraph) {
    const nodes = tasks.map((t) => ({ key: t.key, role: t.role, title: t.title, payload: t.payload || {}, deps: t.deps || [] }));
    const v = validateDag(nodes);
    if (v.ok) {
      const objective = tasks[0]?.payload?.objective || `${createdBy} plan`;
      const { id } = await materializeDag({ objective, createdBy, project, nodes });
      console.log(`  ↳ materialized DAG ${id} (${nodes.length} nodes)`);
      return;
    }
    await addEvent({ role: createdBy, kind: 'alert', message: `Planner emitted an invalid DAG (${v.error}); tasks not created`, url: null });
    console.error('  ✗ invalid DAG from planner:', v.error);
    return;
  }
  for (const t of tasks) {
    if (t.role && t.title) {
      await createTask({ ...t, createdBy, project: t.payload?.repo || project });
      console.log(`  ↳ new ${t.role} task: ${t.title}`);
    }
  }
}

export async function processTask(role, task) {
  console.log(`[${new Date().toISOString()}] ${role} ← task #${task.id}: ${task.title}`);
  const runId = await startRun(task.id, role, null);
  // Reflect "started" to Jira (no-op if Jira off or task has no anchor). Never fatal.
  writeBackToJira(task, 'started').catch((e) => console.error('jira write-back (started) failed:', e.message));

  // Forensic durability: while this session runs, commit its growing transcript (and
  // the continuity chain) to the state repo every ARTIFACT_FLUSH_MS, so a crash
  // mid-session still leaves a readable trail up to the last flush.
  // Forensic durability without git churn: while this session runs, snapshot its
  // growing transcript and the continuity chain to the telemetry sink every
  // ARTIFACT_FLUSH_MS. The sink (a mounted bucket in prod) absorbs the high-frequency
  // writes; git only sees durable checkpoints on events.
  const flushTimer = setInterval(
    () => { flushTelemetry(); },
    ARTIFACT_FLUSH_MS,
  );
  if (flushTimer.unref) flushTimer.unref();

  let exitCode, logPath, parsed;
  try {
    ({ exitCode, logPath, parsed } = await runSession(role, task));
  } finally {
    clearInterval(flushTimer);
  }

  const status = parsed?.status === 'done' ? 'done'
    : parsed?.status === 'blocked' ? 'blocked'
    : 'failed';

  await finishRun(runId, {
    exitCode,
    result: status === 'done' ? 'success' : 'failure',
    summary: parsed?.summary || '(no summary returned)',
    costUsd: parsed?._costUsd,
    numTurns: parsed?._numTurns,
  });
  // Requeue failures until attempts are exhausted; then park as 'failed'
  // so the dashboard's needs-human strip surfaces it.
  const exhausted = Number(task.attempts) + 1 >= Number(task.max_attempts);
  await finishTask(task.id, status === 'failed' ? (exhausted ? 'failed' : 'queued') : status);

  await applyNewTasks(parsed?.new_tasks, { createdBy: role, project: task.project });
  for (const e of parsed?.events || []) {
    if (e.kind && e.message) await addEvent({ role, taskId: task.id, ...e });
  }
  console.log(`  ✓ #${task.id} → ${status} (exit ${exitCode}, log: ${logPath})`);

  // Reflect terminal state to Jira (comment, or sub-task in subtask mode). Non-fatal.
  if (status !== 'queued') {
    writeBackToJira(task, status, parsed?.summary || '')
      .catch((e) => console.error('jira write-back (terminal) failed:', e.message));
  }

  // Durability boundary: state survives even if the platform recycles us now.
  await checkpoint(`run: task #${task.id} (${role}) → ${status}`);
}

export async function tick() {
  if ((await getSetting('paused', 'false')) === 'true') return 0;

  // Pull any new Jira issues into the queue (no-op if Jira not configured). Non-fatal.
  try { await syncFromJira(); }
  catch (e) { console.error('jira sync failed:', e.message); }

  let dispatched = 0;
  for (const role of ROLE_ORDER) {
    if (dispatched >= MAX_CONCURRENT) break;
    const task = await claimNextDagTask(role);
    if (task) {
      dispatched++;
      await processTask(role, task); // serial by default
    }
  }
  return dispatched;
}
