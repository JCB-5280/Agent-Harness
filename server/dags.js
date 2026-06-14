// dags.js — persist every run-DAG as a named, auditable, reusable artifact.
//
// Naming convention (sortable + traceable):
//   dag-<YYYYMMDD>-<HHMMSS>-<objective-slug>-<shortid>.json
// e.g. dag-20260613-021455-add-csv-export-a1b2c3.json
//
// The artifact is a self-contained record of the graph: the objective, every node
// (role, title, payload, deps by local key), who authored it, and — once
// materialized — the mapping from local keys to real task ids. It lives in
// data/dags/ and is committed to git (durable, diffable, audit-friendly). Because
// it captures the full graph by local key, it can later be REPLAYED as a template
// for a new objective without re-planning.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDag } from './dag.js';
import { createDagTask, recordDag } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HARNESS_DATA || path.join(__dirname, '..', 'data');
const DAG_DIR = path.join(DATA, 'dags');

function slug(s) {
  return String(s || 'objective').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'objective';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function dagId(objective, d = new Date()) {
  const short = crypto.randomBytes(3).toString('hex');
  return `dag-${stamp(d)}-${slug(objective)}-${short}`;
}

// Materialize a validated graph into queued tasks + a committed artifact.
// nodes: [{ key, role, title, payload?, deps?:[key...] }]
// Returns { id, artifact, taskIds } or throws on an invalid graph.
export async function materializeDag({ objective, createdBy, project = null, nodes }) {
  const v = validateDag(nodes);
  if (!v.ok) throw new Error(`invalid DAG: ${v.error}`);

  const id = dagId(objective);
  mkdirSync(DAG_DIR, { recursive: true });

  // Create tasks in topological order so dependency ids exist before dependents.
  const idByKey = {};
  const taskIds = [];
  for (const key of v.order) {
    const n = nodes.find((x) => x.key === key);
    const depIds = (n.deps || []).map((k) => idByKey[k]);
    const taskId = await createDagTask({
      role: n.role,
      title: n.title,
      payload: { ...(n.payload || {}), dag_id: id, dag_key: key },
      createdBy,
      priority: n.priority ?? 50,
      project,
      deps: depIds,
      dagId: id,
      dagKey: key,
    });
    idByKey[key] = taskId;
    taskIds.push(taskId);
  }

  // The reusable spec: keep the graph by local key (replayable), plus this run's
  // key→id mapping for audit.
  const spec = {
    schema: 'dag/1',
    id,
    objective,
    createdBy,
    project,
    createdAt: new Date().toISOString(),
    executionOrder: v.order,
    nodes: nodes.map((n) => ({ key: n.key, role: n.role, title: n.title, deps: n.deps || [], payload: n.payload || {} })),
    keyToTaskId: idByKey,
  };

  const artifactPath = path.join(DAG_DIR, `${id}.json`);
  writeFileSync(artifactPath, JSON.stringify(spec, null, 2));
  await recordDag({ id, objective, createdBy, project, nodeCount: nodes.length, spec, artifact: artifactPath });

  return { id, artifact: artifactPath, taskIds };
}

// List saved DAG artifacts on disk (for the reuse picker / audit browser).
export function listDagArtifacts() {
  if (!existsSync(DAG_DIR)) return [];
  return readdirSync(DAG_DIR).filter((f) => f.endsWith('.json')).sort().reverse().map((f) => {
    try {
      const spec = JSON.parse(readFileSync(path.join(DAG_DIR, f), 'utf8'));
      return { file: f, id: spec.id, objective: spec.objective, nodeCount: spec.nodes?.length, createdAt: spec.createdAt };
    } catch { return { file: f, error: 'unreadable' }; }
  });
}

// Load a saved DAG and re-materialize it for a new objective (reuse as template).
export async function replayDag(file, { objective, createdBy, project = null } = {}) {
  const p = path.join(DAG_DIR, path.basename(file));
  if (!existsSync(p)) throw new Error('DAG artifact not found');
  const spec = JSON.parse(readFileSync(p, 'utf8'));
  return materializeDag({
    objective: objective || spec.objective,
    createdBy: createdBy || 'human:replay',
    project,
    nodes: spec.nodes, // graph by local key — re-resolved to fresh task ids
  });
}
