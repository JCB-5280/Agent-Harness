// api.js — REST + SSE surface for the dashboard.
//
// Phase 1 scope (deliberate): observe everything, control little.
//   read:    status, tasks, runs (+ transcript), events, roles, costs
//   write:   seed an objective, retry/cancel a task, pause/resume the loop
// Role-config editing and deeper controls are phase 3, behind corp SSO.
//
// AUTH: none built in. Do not expose this beyond your org's ingress;
// put corp SSO / IAP in front of it. See README "Safety model".

import {
  queueSummary, listTasks, listRuns, listEvents, getRun, createTask,
  updateTaskStatus, getSetting, setSetting, lastHeartbeat, costByRole,
} from './db.js';
import { persistenceEnabled, checkpoint } from './persist.js';
import { getJiraConfigPublic, saveJiraConfig, setWriteBackMode, getJiraConfigWithToken } from './jira-config.js';
import { testConnection, syncFromJira } from './jira.js';
import { sealingAvailable } from './secrets.js';
import { readMarkers, detectGaps, gapThresholdMs, setGapThresholdMs, BEAT_INTERVAL_MS } from './continuity.js';
import { listDags, getDagSpec, dagTasks } from './db.js';
import { listDagArtifacts, replayDag } from './dags.js';
import { deadlockedKeys } from './dag.js';
import { readdirSync, existsSync as fexists, createReadStream as fcreate, statSync as fstat } from 'node:fs';
import { readFileSync, existsSync, watch, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// BigInt-safe JSON (DuckDB returns BIGINTs and {micros} timestamps)
const fix = (v) => {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && 'micros' in v) return new Date(Number(v.micros) / 1000).toISOString();
  return v;
};
const json = (reply, obj) =>
  reply.type('application/json').send(JSON.stringify(obj, (_, v) => fix(v)));

export function registerApi(app) {
  app.get('/api/status', async (_req, reply) => {
    json(reply, {
      paused: (await getSetting('paused', 'false')) === 'true',
      lastHeartbeat: await lastHeartbeat(),
      persistence: persistenceEnabled() ? 'state-repo' : 'ephemeral',
      queue: await queueSummary(),
      costs: await costByRole(),
    });
  });

  app.get('/api/tasks', async (req, reply) =>
    json(reply, await listTasks({ status: req.query.status || null, limit: Number(req.query.limit || 100) })));

  app.post('/api/tasks', async (req, reply) => {
    const { title, project = null, role = 'pm', payload = {} } = req.body || {};
    if (!title) return reply.code(400).send({ error: 'title required' });
    await createTask({
      role, title, createdBy: 'human:ui', priority: 10, project,
      payload: { objective: title, ...payload },
    });
    json(reply, { ok: true });
  });

  app.post('/api/tasks/:id/retry', async (req, reply) => {
    await updateTaskStatus(Number(req.params.id), 'queued');
    json(reply, { ok: true });
  });

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    await updateTaskStatus(Number(req.params.id), 'cancelled');
    json(reply, { ok: true });
  });

  app.get('/api/runs', async (req, reply) =>
    json(reply, await listRuns({ limit: Number(req.query.limit || 50) })));

  app.get('/api/runs/:id/log', async (req, reply) => {
    const run = await getRun(Number(req.params.id));
    if (!run?.log_path || !existsSync(run.log_path)) return reply.code(404).send({ error: 'no transcript' });
    reply.type('text/plain');
    return reply.send(createReadStream(run.log_path));
  });

  // SSE tail of a live (or finished) transcript — the no-SSH lifeline.
  app.get('/api/runs/:id/stream', async (req, reply) => {
    const run = await getRun(Number(req.params.id));
    if (!run?.log_path || !existsSync(run.log_path)) return reply.code(404).send({ error: 'no transcript' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let offset = 0;
    const push = () => {
      try {
        const size = statSync(run.log_path).size;
        if (size > offset) {
          const stream = createReadStream(run.log_path, { start: offset, end: size - 1 });
          stream.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n')) {
              reply.raw.write(`data: ${line}\n\n`);
            }
          });
          offset = size;
        }
      } catch { /* file rotated/gone */ }
    };
    push();
    const watcher = watch(run.log_path, push);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => { watcher.close(); clearInterval(ping); });
  });

  app.get('/api/events', async (req, reply) =>
    json(reply, await listEvents({ limit: Number(req.query.limit || 50) })));

  app.get('/api/roles', async (_req, reply) => {
    // Metadata-driven: discover whatever role definitions exist under roles/,
    // rather than assuming a fixed five. (Project-local .agents/roles overrides are
    // resolved per-task at spawn time.)
    const rolesDir = path.join(ROOT, 'roles');
    const discovered = fexists(rolesDir)
      ? readdirSync(rolesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
    const out = discovered.map((role) => {
      const dir = path.join(rolesDir, role);
      let config = {}, instructions = '';
      try { config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch {}
      try { instructions = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'); } catch {}
      return { role, config, instructions };
    });
    json(reply, out);
  });

  app.post('/api/control/pause', async (_req, reply) => {
    await setSetting('paused', 'true');
    json(reply, { ok: true, paused: true });
  });

  app.post('/api/control/resume', async (_req, reply) => {
    await setSetting('paused', 'false');
    json(reply, { ok: true, paused: false });
  });

  app.post('/api/control/checkpoint', async (_req, reply) => {
    const done = await checkpoint('manual checkpoint via UI');
    json(reply, { ok: true, committed: done });
  });

  // ---- setup wizard + Jira ----

  // What the wizard needs to render: is the secret store available, is Jira set up.
  app.get('/api/setup/status', async (_req, reply) => {
    const jira = await getJiraConfigPublic();
    json(reply, {
      secretStoreAvailable: sealingAvailable(),   // is HARNESS_SECRET_KEY set?
      envTokenPresent: Boolean(process.env.JIRA_API_TOKEN),
      jiraConfigured: Boolean(jira),
      jira, // never includes the token
    });
  });

  // Save Jira config. The token (if provided) is sealed by secrets.js, never stored
  // in plaintext; throws if no master key and no env token.
  app.post('/api/setup/jira', async (req, reply) => {
    const { baseUrl, email, projectKey, jql, subtaskType, apiToken } = req.body || {};
    if (!baseUrl) return reply.code(400).send({ error: 'baseUrl required' });
    try {
      const result = await saveJiraConfig({ baseUrl, email, projectKey, jql, subtaskType, apiToken });
      await checkpoint('setup: jira config updated');
      json(reply, { ok: true, token: result }); // result has fingerprint or {stored:false}, never the token
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  // Test the connection using the stored/env token. Used by the wizard "Test" step.
  app.post('/api/setup/jira/test', async (_req, reply) => {
    const cfg = await getJiraConfigWithToken();
    if (!cfg) return reply.code(400).send({ error: 'Jira not configured, or token unavailable.' });
    try {
      const r = await testConnection(cfg);
      json(reply, { ok: true, ...r });
    } catch (e) {
      reply.code(502).send({ error: e.message });
    }
  });

  // Pull issues now (the loop also does this each tick when configured).
  app.post('/api/setup/jira/sync', async (_req, reply) => {
    try { json(reply, { ok: true, ...(await syncFromJira()) }); }
    catch (e) { reply.code(502).send({ error: e.message }); }
  });

  // The runtime write-back toggle: 'subtask' | 'comment'.
  app.post('/api/settings/writeback-mode', async (req, reply) => {
    const { mode } = req.body || {};
    try { await setWriteBackMode(mode); await checkpoint(`setting: writeBackMode=${mode}`); json(reply, { ok: true, mode }); }
    catch (e) { reply.code(400).send({ error: e.message }); }
  });

  // ---- continuity / forensic ----

  const LOG_DIR = path.join(ROOT, 'data', 'logs');

  // Parse a transcript filename: task<id>-<role>-<startMs>.log
  function parseTranscript(name) {
    const m = name.match(/^task(\d+)-([a-z]+)-(\d+)\.log$/);
    if (!m) return null;
    return { name, taskId: Number(m[1]), role: m[2], startedAt: new Date(Number(m[3])).toISOString(), startMs: Number(m[3]) };
  }

  function listTranscripts() {
    if (!fexists(LOG_DIR)) return [];
    return readdirSync(LOG_DIR).map(parseTranscript).filter(Boolean)
      .sort((a, b) => b.startMs - a.startMs);
  }

  // The lock-graph + gap ledger. Correlates each gap to the sessions that were
  // running when it began (incomplete transcripts started before the gap end).
  app.get('/api/continuity', async (_req, reply) => {
    const threshold = await gapThresholdMs();
    const markers = readMarkers(600);
    const gaps = detectGaps(markers, threshold);

    // Which transcripts correspond to a completed run? (run row with finished_at)
    const runs = await listRuns({ limit: 500 });
    const completedPaths = new Set(runs.filter((r) => r.finished_at && r.log_path).map((r) => path.basename(r.log_path)));
    const transcripts = listTranscripts();

    for (const g of gaps) {
      const gapStart = Date.parse(g.start), gapEnd = Date.parse(g.end);
      g.lostSessions = transcripts
        .filter((t) => !completedPaths.has(t.name) && t.startMs <= gapEnd && t.startMs >= gapStart - 3 * 60 * 60 * 1000)
        .map((t) => ({ ...t, transcriptUrl: `/api/transcripts/${encodeURIComponent(t.name)}/log` }));
    }

    json(reply, {
      beatIntervalMs: BEAT_INTERVAL_MS,
      gapThresholdMs: threshold,
      now: new Date().toISOString(),
      markers: markers.map((m) => ({ ts: m.ts, tag: m.tag })),
      gaps,
    });
  });

  app.get('/api/transcripts', async (_req, reply) => {
    const runs = await listRuns({ limit: 500 });
    const completedPaths = new Set(runs.filter((r) => r.finished_at && r.log_path).map((r) => path.basename(r.log_path)));
    json(reply, listTranscripts().map((t) => ({ ...t, completed: completedPaths.has(t.name) })));
  });

  // Serve a transcript by filename (path-sanitized). Works even when no run row
  // exists (e.g. a session that died mid-flight before its run was checkpointed).
  app.get('/api/transcripts/:name/log', async (req, reply) => {
    const name = path.basename(req.params.name); // strip any path components
    if (!parseTranscript(name)) return reply.code(400).send({ error: 'bad transcript name' });
    const p = path.join(LOG_DIR, name);
    if (!fexists(p)) return reply.code(404).send({ error: 'transcript not found' });
    reply.type('text/plain');
    return reply.send(fcreate(p));
  });

  app.post('/api/settings/gap-threshold', async (req, reply) => {
    const { ms } = req.body || {};
    try { await setGapThresholdMs(ms); await checkpoint(`setting: gapThresholdMs=${ms}`); json(reply, { ok: true, gapThresholdMs: Number(ms) }); }
    catch (e) { reply.code(400).send({ error: e.message }); }
  });

  // ---- DAGs (audit + reuse) ----

  // Saved DAG artifacts on disk — the audit/reuse browser.
  app.get('/api/dags', async (_req, reply) => json(reply, listDagArtifacts()));

  // Live DAG detail: the graph plus each node's current task status, and any
  // deadlocked nodes (a dep reached a terminal-failed state).
  app.get('/api/dags/:id', async (req, reply) => {
    const rec = await getDagSpec(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'dag not found' });
    const spec = typeof rec.spec === 'string' ? JSON.parse(rec.spec) : rec.spec;
    const tasks = await dagTasks(req.params.id);
    const statusByKey = {};
    for (const t of tasks) if (t.dag_key) statusByKey[t.dag_key] = t.status;
    const deadlocks = deadlockedKeys(spec.nodes || [], statusByKey);
    json(reply, { id: rec.id, objective: rec.objective, nodes: spec.nodes, executionOrder: spec.executionOrder, statusByKey, deadlocks, tasks });
  });

  // Replay a saved DAG as a template for a new objective.
  app.post('/api/dags/:file/replay', async (req, reply) => {
    const { objective, project } = req.body || {};
    try {
      const r = await replayDag(req.params.file, { objective, createdBy: 'human:ui', project: project || null });
      await checkpoint(`dag replay → ${r.id}`);
      json(reply, { ok: true, ...r });
    } catch (e) { reply.code(400).send({ error: e.message }); }
  });
}
