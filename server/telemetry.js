// telemetry.js — the high-frequency sink, separate from git.
//
// THE COMMIT-VOLUME FIX: git was doing two jobs — durable state checkpoints (a good
// fit) and high-frequency forensic flushing every ~45s (which spammed the repo).
// We split them:
//   - Durable state (DB parquet export, digests, completed transcripts) → GIT, on
//     events only (run completion, settings change, gap recorded, SIGTERM, a slow
//     periodic safety net). Low commit volume.
//   - High-frequency telemetry (heartbeat chain + in-flight partial transcripts) →
//     this SINK, flushed often and cheaply. No git history churn.
//
// The sink is just a directory (TELEMETRY_DIR). In production point it at a MOUNTED
// BUCKET (GCS via gcsfuse, S3 via CSI/s3fs) — the platform handles bucket auth on
// the mount, so no SDK and no credentials live in the app. Locally it's a plain
// dir. We write whole-file snapshots (overwrite), which behave correctly on bucket
// mounts that don't support append. If TELEMETRY_DIR is unset it defaults to a
// local dir (fine for dev; ephemeral in prod, which only costs mid-session forensic
// granularity on a hard crash — see README).

import { mkdirSync, existsSync, cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HARNESS_DATA || path.join(__dirname, '..', 'data');
const SINK = process.env.TELEMETRY_DIR || path.join(DATA, 'telemetry');

// What the sink carries: the continuity chain and the live session transcripts.
const SINK_FILES = ['continuity.log'];
const SINK_DIRS = ['logs'];

export function telemetryTarget() {
  return process.env.TELEMETRY_DIR ? `bucket/dir: ${SINK}` : `local dir: ${SINK} (set TELEMETRY_DIR to a mounted bucket for durable telemetry)`;
}

// Copy current telemetry from data/ into the sink (overwrite). Cheap; call often.
export function flushTelemetry() {
  try {
    mkdirSync(SINK, { recursive: true });
    for (const f of SINK_FILES) {
      const src = path.join(DATA, f);
      if (existsSync(src)) cpSync(src, path.join(SINK, f));
    }
    for (const d of SINK_DIRS) {
      const src = path.join(DATA, d);
      if (existsSync(src)) cpSync(src, path.join(SINK, d), { recursive: true });
    }
    return true;
  } catch (e) {
    console.error('telemetry flush failed:', e.message);
    return false;
  }
}

// On boot, pull telemetry from the sink back into data/ so the continuity chain and
// any interrupted transcripts are available for gap detection and forensics.
export function restoreTelemetry() {
  try {
    for (const f of SINK_FILES) {
      const src = path.join(SINK, f);
      if (existsSync(src)) { mkdirSync(DATA, { recursive: true }); cpSync(src, path.join(DATA, f)); }
    }
    for (const d of SINK_DIRS) {
      const src = path.join(SINK, d);
      if (existsSync(src)) { mkdirSync(path.join(DATA, d), { recursive: true }); cpSync(src, path.join(DATA, d), { recursive: true }); }
    }
    return true;
  } catch (e) {
    console.error('telemetry restore failed:', e.message);
    return false;
  }
}
