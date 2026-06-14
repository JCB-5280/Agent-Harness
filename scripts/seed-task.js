// Seed the queue with a first PM objective.
// Usage: node scripts/seed-task.js "Build a CSV upload endpoint" myrepo
import { initSchema, createTask } from '../server/db.js';

const [title, project] = process.argv.slice(2);
if (!title) {
  console.error('Usage: node scripts/seed-task.js "<objective>" [project]');
  process.exit(1);
}
await initSchema();
await createTask({
  role: 'pm',
  title,
  payload: { objective: title, notes: 'Seeded by human' },
  createdBy: 'human',
  priority: 10,
  project: project || null,
});
console.log('Seeded PM task:', title);
process.exit(0);
