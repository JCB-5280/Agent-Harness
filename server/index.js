// index.js — single process: restore state → API + dashboard → tick loop.
//
// Boot order matters on an ephemeral platform:
//   1. restoreState()      pull last export from the state repo
//   2. importIfRestored()  load it into a fresh DuckDB file
//   3. initSchema()        idempotent CREATEs (no-ops after import)
//   4. sweepStale()        requeue tasks stranded by the previous container
//   5. serve + loop        UI is alive even while a session is running
//
// Run with EXACTLY ONE replica. The orchestrator is the single DB writer;
// two replicas means two writers and two agents claiming the same tasks.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, sweepStaleInProgress } from './db.js';
import { restoreState, importIfRestored, restoreArtifacts, checkpoint, persistenceEnabled } from './persist.js';
import { restoreTelemetry, telemetryTarget } from './telemetry.js';
import { registerApi } from './api.js';
import { tick } from './orchestrator.js';
import { startContinuityBeat, BEAT_INTERVAL_MS } from './continuity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const CHECKPOINT_MINUTES = Number(process.env.CHECKPOINT_MINUTES || 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const restored = restoreState();
  console.log('persistence:', persistenceEnabled() ? `state repo (${restored.reason})` : 'DISABLED — state dies with the container');
  await importIfRestored(restored);
  restoreArtifacts();          // durable copies from git (completed transcripts, digests)
  restoreTelemetry();          // high-frequency telemetry from the sink (continuity chain, in-flight transcripts)
  console.log('telemetry sink:', telemetryTarget());
  await initSchema();

  const requeued = await sweepStaleInProgress(45);
  if (requeued.length) console.log('requeued stale in_progress tasks:', requeued.join(', '));

  // Independent heartbeat — keeps beating during long sessions, so the lock-graph
  // only shows a gap when the process was actually down.
  await startContinuityBeat();
  console.log('continuity heartbeat every', BEAT_INTERVAL_MS, 'ms');

  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public') });
  registerApi(app);
  // SPA fallback: any non-API, non-asset path returns index.html so the React app
  // handles routing (deep links and refreshes work). API 404s stay JSON.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`dashboard + API on :${PORT}`);

  // periodic checkpoint independent of run completions
  setInterval(() => checkpoint('periodic checkpoint').catch((e) => console.error('checkpoint failed:', e.message)),
    CHECKPOINT_MINUTES * 60_000);

  // graceful shutdown: most platforms send SIGTERM before recycling
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`${sig} → final checkpoint`);
      try { await checkpoint(`shutdown (${sig})`); } catch {}
      process.exit(0);
    });
  }

  console.log('orchestrator loop started; polling every', POLL_INTERVAL_MS, 'ms');
  for (;;) {
    try {
      const n = await tick();
      if (n === 0) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error('tick failed:', err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

boot();
