// continuity.js — the "is the chain unbroken?" layer.
//
// An independent timer (NOT the tick loop) writes a heartbeat every
// CONTINUITY_INTERVAL_MS. Because runSession awaits a child process without
// blocking the event loop, these beats keep firing even during a 30-minute
// session — so a long session does NOT look like a gap. That independence is what
// makes the lock-graph trustworthy.
//
// Each beat does two things:
//   1. inserts a row into the heartbeats table (drives the live "loop" lamp), and
//   2. appends an ISO timestamp to data/continuity.log (a durable marker chain that
//      persist.flushArtifacts() commits to the state repo frequently).
//
// On boot we append a 'boot' marker; the gap between the last pre-crash marker and
// the boot marker is the visible discontinuity. A gap longer than the (UI-editable)
// threshold is a broken link.

import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, getSetting, setSetting, heartbeat as dbHeartbeat } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HARNESS_DATA || path.join(__dirname, '..', 'data');
const LOG = path.join(DATA, 'continuity.log');

export const BEAT_INTERVAL_MS = Number(process.env.CONTINUITY_INTERVAL_MS || 30_000);
const DEFAULT_GAP_THRESHOLD_MS = Math.max(120_000, BEAT_INTERVAL_MS * 4); // ~4 missed beats
const MAX_MARKERS = 10_000; // ~3.5 days at 30s; truncated on boot

export async function gapThresholdMs() {
  const v = await getSetting('continuity.gapThresholdMs', null);
  return v ? Number(v) : DEFAULT_GAP_THRESHOLD_MS;
}
export async function setGapThresholdMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < BEAT_INTERVAL_MS) {
    throw new Error(`threshold must be a number ≥ the beat interval (${BEAT_INTERVAL_MS} ms)`);
  }
  await setSetting('continuity.gapThresholdMs', String(Math.round(n)));
}

function appendMarker(tag = '') {
  mkdirSync(DATA, { recursive: true });
  appendFileSync(LOG, `${new Date().toISOString()}${tag ? ' ' + tag : ''}\n`);
}

// Trim the marker file to the most recent MAX_MARKERS lines (called on boot).
function truncateMarkers() {
  if (!existsSync(LOG)) return;
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  if (lines.length > MAX_MARKERS) writeFileSync(LOG, lines.slice(-MAX_MARKERS).join('\n') + '\n');
}

async function beat() {
  try {
    appendMarker();
    await dbHeartbeat(''); // also feed the heartbeats table for the live lamp
  } catch (e) { console.error('continuity beat failed:', e.message); }
}

let timer = null;
export async function startContinuityBeat() {
  truncateMarkers();
  appendMarker('boot');                          // explicit restart marker
  await dbHeartbeat('boot');
  // Make the boot marker durable immediately via the telemetry sink (cheap, no git
  // churn), so even a crash seconds after start leaves the restart visible.
  try { const { flushTelemetry } = await import('./telemetry.js'); flushTelemetry(); } catch {}
  // prune old heartbeat rows so the parquet export stays small
  try { const db = await getDb(); await db.run(`DELETE FROM heartbeats WHERE ts < now() - INTERVAL 2 DAY`); } catch {}
  timer = setInterval(beat, BEAT_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}
export function stopContinuityBeat() { if (timer) clearInterval(timer); }

// ---- reading & gap detection (used by the API) ----

export function readMarkers(limit = 600) {
  if (!existsSync(LOG)) return [];
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    const [ts, tag] = l.split(/\s+/, 2);
    return { ts, t: Date.parse(ts), tag: tag || null };
  }).filter((m) => Number.isFinite(m.t));
}

// Detect gaps: consecutive markers spaced wider than the threshold.
export function detectGaps(markers, thresholdMs) {
  const gaps = [];
  for (let i = 1; i < markers.length; i++) {
    const dur = markers[i].t - markers[i - 1].t;
    if (dur > thresholdMs) {
      gaps.push({
        start: markers[i - 1].ts,
        end: markers[i].ts,
        durationMs: dur,
        endedWithBoot: markers[i].tag === 'boot',
      });
    }
  }
  return gaps;
}
