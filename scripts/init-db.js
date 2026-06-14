// Initialize the DuckDB schema. Safe to run repeatedly.
import { initSchema } from '../server/db.js';
await initSchema();
console.log('Schema initialized.');
process.exit(0);
