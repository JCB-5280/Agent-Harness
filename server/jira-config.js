// jira-config.js — read/write the Jira connection config.
//
// Non-secret fields (base URL, email, project key, JQL, write-back mode, optional
// sub-task issue type) live as plain settings rows. The API token is sealed by
// secrets.js and stored as ciphertext; or, if you prefer the stricter path, supplied
// at runtime via the JIRA_API_TOKEN env var and never stored at all.

import { getSetting, setSetting } from './db.js';
import { seal, open, sealingAvailable, fingerprint } from './secrets.js';

const KEYS = {
  baseUrl: 'jira.baseUrl',
  email: 'jira.email',
  projectKey: 'jira.projectKey',
  jql: 'jira.jql',
  writeBackMode: 'jira.writeBackMode',     // 'subtask' | 'comment'
  subtaskType: 'jira.subtaskIssueType',    // instance-specific name, e.g. 'Sub-task'
  tokenEnc: 'jira.apiTokenEnc',            // sealed blob (never plaintext)
};

export const DEFAULT_WRITE_BACK_MODE = 'comment';

// Returns config WITHOUT the token (safe to send to the browser).
export async function getJiraConfigPublic() {
  const baseUrl = await getSetting(KEYS.baseUrl, null);
  if (!baseUrl) return null;
  const tokenEnc = await getSetting(KEYS.tokenEnc, null);
  const hasEnvToken = Boolean(process.env.JIRA_API_TOKEN);
  return {
    baseUrl,
    email: await getSetting(KEYS.email, null),
    projectKey: await getSetting(KEYS.projectKey, null),
    jql: await getSetting(KEYS.jql, null),
    writeBackMode: await getSetting(KEYS.writeBackMode, DEFAULT_WRITE_BACK_MODE),
    subtaskType: await getSetting(KEYS.subtaskType, 'Sub-task'),
    tokenConfigured: Boolean(tokenEnc) || hasEnvToken,
    tokenSource: tokenEnc ? 'sealed' : hasEnvToken ? 'env' : 'none',
  };
}

// Internal: full config INCLUDING the decrypted token, for making API calls.
export async function getJiraConfigWithToken() {
  const pub = await getJiraConfigPublic();
  if (!pub) return null;
  let token = process.env.JIRA_API_TOKEN || null; // env wins (stricter path)
  if (!token) {
    const enc = await getSetting(KEYS.tokenEnc, null);
    if (enc) token = open(enc);
  }
  if (!token) return null;
  return { ...pub, token };
}

export async function saveJiraConfig({ baseUrl, email, projectKey, jql, subtaskType, apiToken }) {
  if (baseUrl) await setSetting(KEYS.baseUrl, baseUrl.replace(/\/+$/, ''));
  if (email !== undefined) await setSetting(KEYS.email, email || '');
  if (projectKey !== undefined) await setSetting(KEYS.projectKey, projectKey || '');
  if (jql !== undefined) await setSetting(KEYS.jql, jql || '');
  if (subtaskType !== undefined) await setSetting(KEYS.subtaskType, subtaskType || 'Sub-task');

  // Token handling: only seal if one was provided AND we're not using the env path.
  if (apiToken) {
    if (process.env.JIRA_API_TOKEN) {
      // Env token takes precedence; don't store a competing copy.
      return { stored: false, reason: 'JIRA_API_TOKEN env present; using that instead of storing.' };
    }
    if (!sealingAvailable()) {
      throw new Error('Cannot store the API token: HARNESS_SECRET_KEY is not set. Set it from your secret manager, or provide the token via the JIRA_API_TOKEN env var instead.');
    }
    await setSetting(KEYS.tokenEnc, seal(apiToken));
    return { stored: true, fingerprint: fingerprint(apiToken) };
  }
  return { stored: false };
}

export async function setWriteBackMode(mode) {
  if (!['subtask', 'comment'].includes(mode)) throw new Error('mode must be "subtask" or "comment"');
  await setSetting(KEYS.writeBackMode, mode);
}
