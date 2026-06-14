// persist.js — durability for ephemeral containers.
//
// The container's filesystem is disposable; GitHub is not. So GitHub is the
// system of record:
//   - Code the agents produce  → already durable (they commit and push constantly)
//   - Harness state (DuckDB)   → exported to parquet and committed to a STATE_REPO
//   - Digests + session logs   → committed alongside the export
//
// Boot:      clone STATE_REPO, IMPORT the last export into a fresh DuckDB file.
// Runtime:   checkpoint() after every completed run and on a timer.
// Restart:   lose at most one in-flight session (the stale sweep requeues its
//            task; the dev agent's own WIP commits mean little real work is lost).
//
// If STATE_REPO is unset, everything still works — state just lives and dies
// with the container (fine for local docker compose with a volume).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = process.env.HARNESS_DATA || path.join(ROOT, 'data');
const STATE_DIR = path.join(DATA, 'state');          // working clone of STATE_REPO
const EXPORT_DIR = path.join(STATE_DIR, 'export');   // DuckDB parquet export lives here
const STATE_REPO = process.env.STATE_REPO || null;   // e.g. https://x-access-token:${GH_TOKEN}@github.yourcorp.com/org/harness-state.git

// Forensic artifacts copied into the state repo alongside the DB export.
const ARTIFACT_DIRS = ['digests', 'logs'];
const ARTIFACT_FILES = ['continuity.log'];

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: STATE_DIR, stdio: 'pipe', ...opts }).toString();

// One mutex guards all git operations on the single state clone, so the periodic
// artifact flush and the end-of-run checkpoint never run git commands concurrently.
let gitBusy = false;

function commitAndPush(note) {
  git(['add', '-A']);
  try {
    git(['-c', `user.name=${process.env.GIT_AUTHOR_NAME || 'agent-harness'}`,
         '-c', `user.email=${process.env.GIT_AUTHOR_EMAIL || 'harness@local'}`,
         'commit', '-m', note]);
  } catch { return false; /* nothing to commit */ }
  git(['push']);
  return true;
}

function copyArtifactsIntoState() {
  for (const dir of ARTIFACT_DIRS) {
    const src = path.join(DATA, dir);
    if (existsSync(src)) cpSync(src, path.join(STATE_DIR, dir), { recursive: true });
  }
  for (const f of ARTIFACT_FILES) {
    const src = path.join(DATA, f);
    if (existsSync(src)) cpSync(src, path.join(STATE_DIR, f));
  }
}

export function persistenceEnabled() {
  return Boolean(STATE_REPO);
}

// ---------------------------------------------------------------
// restoreState(): call BEFORE opening/initializing the database.
// ---------------------------------------------------------------
export function restoreState() {
  mkdirSync(DATA, { recursive: true });
  if (!STATE_REPO) return { restored: false, reason: 'STATE_REPO not set' };

  if (!existsSync(path.join(STATE_DIR, '.git'))) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    execFileSync('git', ['clone', '--depth', '1', STATE_REPO, STATE_DIR], { stdio: 'pipe' });
  } else {
    git(['pull', '--ff-only']);
  }
  const hasExport = existsSync(path.join(EXPORT_DIR, 'load.sql'));
  return { restored: hasExport, reason: hasExport ? 'export found' : 'state repo empty (first boot)' };
}

// Run right after creating the DuckDB connection, before schema init.
export async function importIfRestored(restoredInfo) {
  if (!restoredInfo?.restored) return false;
  const db = await getDb();
  await db.run(`IMPORT DATABASE '${EXPORT_DIR.replaceAll("'", "''")}'`);
  return true;
}

// restoreArtifacts(): copy logs/digests/continuity from the state clone back into
// data/ so transcript paths resolve and the continuity chain is intact after a
// restart. Call on boot after restoreState(), regardless of whether a DB export
// existed (forensic artifacts may exist even on an otherwise-empty first state repo).
export function restoreArtifacts() {
  if (!STATE_REPO || !existsSync(path.join(STATE_DIR, '.git'))) return;
  for (const dir of ARTIFACT_DIRS) {
    const src = path.join(STATE_DIR, dir);
    if (existsSync(src)) { mkdirSync(path.join(DATA, dir), { recursive: true }); cpSync(src, path.join(DATA, dir), { recursive: true }); }
  }
  for (const f of ARTIFACT_FILES) {
    const src = path.join(STATE_DIR, f);
    if (existsSync(src)) cpSync(src, path.join(DATA, f));
  }
}

// ---------------------------------------------------------------
// checkpoint(): export DB + copy artifacts, commit, push.
// Cheap when nothing changed (git commit no-ops).
// ---------------------------------------------------------------
export async function checkpoint(note = 'checkpoint') {
  if (!STATE_REPO || gitBusy) return false;
  gitBusy = true;
  try {
    const db = await getDb();
    // Export to a fresh dir, then swap in, so a crash mid-export never corrupts
    // the last good export.
    const tmp = path.join(DATA, `export-tmp-${Date.now()}`);
    await db.run(`EXPORT DATABASE '${tmp.replaceAll("'", "''")}' (FORMAT PARQUET)`);
    rmSync(EXPORT_DIR, { recursive: true, force: true });
    cpSync(tmp, EXPORT_DIR, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    copyArtifactsIntoState();
    return commitAndPush(note);
  } finally {
    gitBusy = false;
  }
}

// ---------------------------------------------------------------
// flushArtifacts(): commit ONLY the logs/digests/continuity (no DB export).
// Lightweight, called on a short timer WHILE a session is running so an
// interrupted session's partial transcript and the continuity chain survive a
// crash. Skips if any git op is already in flight.
// ---------------------------------------------------------------
export async function flushArtifacts(note = 'flush artifacts') {
  if (!STATE_REPO || gitBusy) return false;
  gitBusy = true;
  try {
    copyArtifactsIntoState();
    return commitAndPush(note);
  } finally {
    gitBusy = false;
  }
}
