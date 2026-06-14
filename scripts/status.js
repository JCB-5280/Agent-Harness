// Quick console view of queue + recent activity.
import { getDb, initSchema } from '../server/db.js';

await initSchema();
const db = await getDb();
const q = async (sql) => (await db.runAndReadAll(sql)).getRowObjects();

console.log('\n== Queue by role/status ==');
console.table(await q(`SELECT role, status, count(*) AS n FROM tasks GROUP BY role, status ORDER BY role, status`));

console.log('== Next runnable ==');
console.table(await q(`SELECT id, role, title, priority FROM tasks WHERE status='queued' ORDER BY priority, created_at LIMIT 10`));

console.log('== Last 10 runs ==');
console.table(await q(`SELECT task_id, role, result, num_turns, round(cost_usd,3) AS cost, started_at FROM runs ORDER BY started_at DESC LIMIT 10`));

console.log('== Undigested events ==');
console.table(await q(`SELECT id, role, kind, message FROM events WHERE NOT digested ORDER BY created_at DESC LIMIT 15`));
process.exit(0);
