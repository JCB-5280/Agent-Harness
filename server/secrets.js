// secrets.js — encryption at rest for sensitive config (the Jira API token).
//
// Design: the setup wizard captures the token, but we never write it in plaintext.
// It is sealed with AES-256-GCM using a key derived (scrypt) from a master secret
// that comes ONLY from the environment / your secret manager:
//
//     HARNESS_SECRET_KEY   — the master key (any sufficiently long string)
//
// The sealed blob (salt | iv | authTag | ciphertext, base64) is what gets stored in
// the settings table and therefore checkpointed to the git state repo. The blob is
// useless without HARNESS_SECRET_KEY, so the repo never contains a usable credential.
//
// Fail-safe: if HARNESS_SECRET_KEY is absent we REFUSE to seal — callers must either
// set the master key or provide the token directly via env (JIRA_API_TOKEN). We never
// silently fall back to storing plaintext.

import crypto from 'node:crypto';

const MASTER = () => process.env.HARNESS_SECRET_KEY || '';

export function sealingAvailable() {
  return MASTER().length >= 16; // refuse trivially short master keys
}

function deriveKey(salt) {
  return crypto.scryptSync(MASTER(), salt, 32);
}

export function seal(plaintext) {
  if (!sealingAvailable()) {
    throw new Error('HARNESS_SECRET_KEY is not set (or too short); refusing to store a secret in plaintext.');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ct]).toString('base64');
}

export function open(blobB64) {
  if (!sealingAvailable()) {
    throw new Error('HARNESS_SECRET_KEY is not set; cannot decrypt stored secret.');
  }
  const buf = Buffer.from(blobB64, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ct = buf.subarray(44);
  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Never log or serialize a token; use this to confirm presence without exposure.
export function fingerprint(plaintext) {
  return 'sha256:' + crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 12);
}
