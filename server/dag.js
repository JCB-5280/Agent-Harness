// dag.js — pure task-graph logic. No I/O, no DB; fully unit-testable.
//
// A planner (PM, or a team's lead) emits tasks with local handles and dependencies:
//   nodes = [{ key:'a', role:'dev', title:'...', deps:[] },
//            { key:'b', role:'dev', title:'...', deps:['a'] },
//            { key:'c', role:'qa',  title:'...', deps:['a','b'] }]
//
// Because an LLM authors this graph, it can emit a cycle or a dangling dependency.
// validateDag() rejects those BEFORE anything is queued — a malformed graph never
// reaches the task table.

// Returns { ok, error, order } where order is a valid topological execution order.
export function validateDag(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, error: 'no nodes' };

  const keys = new Set();
  for (const n of nodes) {
    if (!n.key) return { ok: false, error: 'a node is missing its key' };
    if (keys.has(n.key)) return { ok: false, error: `duplicate key: ${n.key}` };
    keys.add(n.key);
  }
  // dangling dependency check
  for (const n of nodes) {
    for (const d of n.deps || []) {
      if (!keys.has(d)) return { ok: false, error: `node ${n.key} depends on unknown key ${d}` };
      if (d === n.key) return { ok: false, error: `node ${n.key} depends on itself` };
    }
  }
  // Kahn's algorithm: topological sort; if it can't consume all nodes there's a cycle.
  const indeg = new Map(nodes.map((n) => [n.key, (n.deps || []).length]));
  const dependents = new Map(nodes.map((n) => [n.key, []]));
  for (const n of nodes) for (const d of n.deps || []) dependents.get(d).push(n.key);

  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  const order = [];
  while (queue.length) {
    const k = queue.shift();
    order.push(k);
    for (const dep of dependents.get(k)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.key)).map((n) => n.key);
    return { ok: false, error: `cycle detected among: ${stuck.join(', ')}` };
  }
  return { ok: true, order };
}

// Given the graph and the set of completed task keys, which keys are runnable now?
// A node is runnable when every dependency is in doneKeys.
export function runnableKeys(nodes, doneKeys) {
  const done = doneKeys instanceof Set ? doneKeys : new Set(doneKeys);
  return nodes.filter((n) => (n.deps || []).every((d) => done.has(d))).map((n) => n.key);
}

// Deadlock: a node that can never run because a dependency reached a terminal
// non-done state (failed/cancelled). Returns the blocked node keys and why.
export function deadlockedKeys(nodes, statusByKey) {
  const terminalDead = new Set(
    Object.entries(statusByKey).filter(([, s]) => s === 'failed' || s === 'cancelled').map(([k]) => k),
  );
  const out = [];
  for (const n of nodes) {
    const blockers = (n.deps || []).filter((d) => terminalDead.has(d));
    const self = statusByKey[n.key];
    if (blockers.length && self !== 'done' && self !== 'cancelled') {
      out.push({ key: n.key, blockedBy: blockers });
    }
  }
  return out;
}
