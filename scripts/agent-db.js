// Minimal read/mark interface agents may call from inside their sessions.
// Intentionally narrow: agents get read access + digest marking, nothing else.
// All writes to tasks/runs go through the orchestrator's RESULT_JSON contract.
import { getDb, initSchema } from '../server/db.js';

await initSchema();
const db = await getDb();
const cmd = process.argv[2];

if (cmd === 'events:undigested') {
  const r = await db.runAndReadAll(`SELECT id, role, kind, message, url, created_at FROM events WHERE NOT digested ORDER BY created_at`);
  console.log(JSON.stringify(r.getRowObjects(), null, 2));
} else if (cmd === 'runs:recent') {
  const r = await db.runAndReadAll(`SELECT task_id, role, result, summary, cost_usd, started_at FROM runs ORDER BY started_at DESC LIMIT 25`);
  console.log(JSON.stringify(r.getRowObjects(), null, 2));
} else if (cmd === 'tasks:open') {
  const r = await db.runAndReadAll(`SELECT id, role, title, status, blocked_on FROM tasks WHERE status IN ('queued','in_progress','blocked') ORDER BY priority`);
  console.log(JSON.stringify(r.getRowObjects(), null, 2));
} else if (cmd === 'events:mark-digested') {
  const ids = process.argv.slice(3).map(Number).filter(Boolean);
  if (ids.length) await db.run(`UPDATE events SET digested = true WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  console.log('Marked:', ids.join(', ') || '(none)');
} else {
  console.error('Commands: events:undigested | runs:recent | tasks:open | events:mark-digested <ids...>');
  process.exit(1);
}
process.exit(0);
