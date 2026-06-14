// spawn.js — runs one headless Claude Code session for a given role + task.
//
// Role resolution implements the ".agents convention": if the target project
// repo contains .agents/roles/<role>/, that definition wins; otherwise the
// harness defaults in roles/<role>/ apply. Teams customize their agents in
// their own repo; the harness stays a shared engine.
//
// NOTE: verify CLI flags against current Claude Code docs
// (https://docs.claude.com/en/docs/claude-code) — flags evolve. Contract used:
//   claude -p "<prompt>"            headless mode
//   --output-format json            structured result envelope on stdout
//   --allowedTools "..."            tool allowlist
//   --permission-mode acceptEdits   no interactive prompts
//   --max-turns N / --model M       ceilings + per-role model choice

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = process.env.HARNESS_DATA || path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA, 'logs');
const WORKSPACE = path.join(ROOT, 'workspace');

function resolveRoleDir(role, project) {
  if (project) {
    const override = path.join(WORKSPACE, project, '.agents', 'roles', role);
    if (existsSync(path.join(override, 'CLAUDE.md'))) return override;
  }
  return path.join(ROOT, 'roles', role);
}

function loadRole(role, project) {
  const dir = resolveRoleDir(role, project);
  const cfg = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const instructions = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  return { dir, cfg, instructions };
}

export function buildPrompt(role, task, instructions) {
  const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : (task.payload || {});
  return [
    `You are running as the **${role}** agent in an autonomous harness.`,
    ``,
    `## Standing instructions`,
    instructions,
    ``,
    `## Current task`,
    `Task #${task.id}: ${task.title}`,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    ``,
    `When finished, print a single line starting with RESULT_JSON: followed by`,
    `{"status":"done|failed|blocked","summary":"...","new_tasks":[{"role":"...","title":"...","payload":{}}],"events":[{"kind":"...","message":"...","url":null}]}`,
  ].join('\n');
}

export function runSession(role, task, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const { cfg, instructions } = loadRole(role, task.project);
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `task${task.id}-${role}-${Date.now()}.log`);
  const log = createWriteStream(logPath);

  // Sessions run inside the project repo when one is named, so the repo's own
  // CLAUDE.md (team conventions) loads naturally alongside our injected role.
  const cwd = task.project && existsSync(path.join(WORKSPACE, task.project))
    ? path.join(WORKSPACE, task.project)
    : WORKSPACE;

  const args = [
    '-p', buildPrompt(role, task, instructions),
    '--output-format', 'json',
    '--permission-mode', cfg.permissionMode || 'acceptEdits',
    '--max-turns', String(cfg.maxTurns || 50),
  ];
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.allowedTools?.length) args.push('--allowedTools', cfg.allowedTools.join(','));

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, HARNESS_ROLE: role, HARNESS_TASK_ID: String(task.id) },
    });

    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      log.write(`spawn error: ${err.message}\n`);
      log.end();
      resolve({ exitCode: -1, logPath, parsed: { status: 'failed', summary: `spawn error: ${err.message}` } });
    });

    child.stdout.on('data', (d) => { stdout += d; log.write(d); });
    child.stderr.on('data', (d) => log.write(d));

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      log.end();
      let parsed = null;
      const m = stdout.match(/RESULT_JSON:\s*(\{[\s\S]*?\})\s*$/m);
      try {
        if (m) parsed = JSON.parse(m[1]);
        else {
          const envelope = JSON.parse(stdout);
          parsed = { status: envelope.is_error ? 'failed' : 'done', summary: envelope.result?.slice(0, 500) };
          parsed._costUsd = envelope.total_cost_usd;
          parsed._numTurns = envelope.num_turns;
        }
      } catch { /* unparseable — orchestrator treats as failure */ }
      resolve({ exitCode, logPath, parsed });
    });
  });
}
