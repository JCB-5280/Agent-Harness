// jira.js — sync Jira issues into the local queue and reflect progress back.
//
// Jira is an INPUT/OUTPUT SURFACE over the local DuckDB queue, not the queue itself.
// The local queue stays the fast, auditable, restart-survivable coordination store;
// Jira is where humans live. This module pulls issues in and writes status back.
//
// WRITE-BACK MODE (runtime toggle, set in the UI):
//   'subtask' — each agent role task becomes a Jira sub-task under the parent issue.
//   'comment' — the parent issue gets comments at milestones + a result when done.
//
// ADAPT TO YOUR INSTANCE: the marked spots below depend on your Jira project's
// configuration (Cloud vs Data Center, workflow statuses, transition IDs, the
// sub-task issue-type name, custom JQL). Defaults target Jira Cloud REST v3 with
// email + API-token basic auth. Verify against your instance before relying on
// write-back, especially status transitions (their IDs are instance-specific).

import { getJiraConfigWithToken } from './jira-config.js';
import { createTask, taskExistsForJiraKey, addEvent } from './db.js';

// ---------- pure helpers (no network; unit-testable) ----------

export function authHeader(email, token) {
  // Jira Cloud: basic auth with email:token. (Data Center PATs use Bearer — adapt.)
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

export function defaultJql(projectKey) {
  // ADAPT: narrow this to the statuses that mean "ready for the agents" in your
  // workflow, e.g. `AND status = "Ready for Dev"`. Broad default shown.
  return `project = ${projectKey} AND statusCategory != Done ORDER BY priority DESC, created ASC`;
}

// Map a Jira issue to a PM objective task for the local queue.
export function mapIssueToTask(issue, projectKey) {
  const f = issue.fields || {};
  return {
    role: 'pm',
    title: f.summary || `(${issue.key})`,
    createdBy: 'jira',
    priority: 10,
    project: projectKey,
    payload: {
      kind: 'objective',
      objective: f.summary || '',
      description: typeof f.description === 'string' ? f.description : '(see Jira)',
      jira_key: issue.key,            // dedupe + write-back anchor
      jira_parent: issue.key,
      review_rounds: 0,
      clarify_rounds: 0,
    },
  };
}

// Build the REST payload for a sub-task under a parent issue.
export function buildSubtaskPayload(parentKey, projectKey, subtaskType, task) {
  return {
    fields: {
      project: { key: projectKey },
      parent: { key: parentKey },
      issuetype: { name: subtaskType || 'Sub-task' },
      summary: `[${task.role}] ${task.title}`.slice(0, 250),
    },
  };
}

// Build a comment body (Atlassian Document Format) for milestone/result write-back.
export function buildCommentPayload(text) {
  return {
    body: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text).slice(0, 30000) }] }],
    },
  };
}

// ---------- network calls ----------

async function jreq(cfg, method, path, body) {
  const res = await fetch(cfg.baseUrl + path, {
    method,
    headers: {
      Authorization: authHeader(cfg.email, cfg.token),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.errorMessages?.join('; ') || json?.message || text?.slice(0, 300) || res.statusText;
    throw new Error(`Jira ${method} ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

// Validate credentials + reachability. Used by the setup wizard's "Test" step.
export async function testConnection(cfg) {
  const me = await jreq(cfg, 'GET', '/rest/api/3/myself');
  return { ok: true, accountId: me.accountId, displayName: me.displayName, emailMatches: me.emailAddress?.toLowerCase() === cfg.email?.toLowerCase() };
}

export async function fetchIssues(cfg, max = 25) {
  const jql = encodeURIComponent(cfg.jql || defaultJql(cfg.projectKey));
  const data = await jreq(cfg, 'GET', `/rest/api/3/search?jql=${jql}&maxResults=${max}&fields=summary,description,status,priority`);
  return data.issues || [];
}

// Pull new issues into the local queue (dedup by jira_key).
export async function syncFromJira() {
  const cfg = await getJiraConfigWithToken();
  if (!cfg) return { pulled: 0, skipped: 'jira not configured' };
  let pulled = 0;
  const issues = await fetchIssues(cfg);
  for (const issue of issues) {
    if (await taskExistsForJiraKey(issue.key)) continue;
    await createTask(mapIssueToTask(issue, cfg.projectKey));
    await addEvent({ role: 'pm', kind: 'info', message: `Pulled ${issue.key} from Jira`, url: `${cfg.baseUrl}/browse/${issue.key}` });
    pulled++;
  }
  return { pulled };
}

// Reflect a task's progress back to Jira per the active write-back mode.
// `event` is a short milestone label: 'started' | 'pr_opened' | 'done' | 'blocked' | 'failed'.
export async function writeBackToJira(task, event, detail = '') {
  const cfg = await getJiraConfigWithToken();
  if (!cfg) return { skipped: 'jira not configured' };
  const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : (task.payload || {});
  const parent = payload.jira_parent || payload.jira_key;
  if (!parent) return { skipped: 'task has no jira anchor' };

  if (cfg.writeBackMode === 'subtask') {
    // Sub-task fidelity. We create one sub-task per substantive role task the first
    // time we see it; subsequent events comment on the parent to avoid sub-task spam.
    // ADAPT: status transitions (moving the sub-task through your workflow) need your
    // instance's transition IDs; left as a comment rather than guessed.
    if (event === 'started' && ['dev', 'reviewer', 'qa'].includes(task.role) && !payload.jira_subtask) {
      try {
        const sub = await jreq(cfg, 'POST', '/rest/api/3/issue',
          buildSubtaskPayload(parent, cfg.projectKey, cfg.subtaskType, task));
        return { createdSubtask: sub.key };
      } catch (e) { return { error: e.message }; }
    }
    await jreq(cfg, 'POST', `/rest/api/3/issue/${parent}/comment`,
      buildCommentPayload(`[${task.role}] ${event}${detail ? ': ' + detail : ''}`));
    return { commented: parent };
  }

  // Comment mode: parent issue gets milestone comments + results.
  await jreq(cfg, 'POST', `/rest/api/3/issue/${parent}/comment`,
    buildCommentPayload(`Agent update — [${task.role}] ${event}${detail ? ': ' + detail : ''}`));
  return { commented: parent };
}
