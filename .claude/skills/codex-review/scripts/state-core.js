#!/usr/bin/env node
'use strict';

/**
 * Shared repository-review state primitives.
 *
 * stop-hook.js, mark-prompt.js and setup-auto.js all update the same state and
 * claim files. Keeping the lock and atomic-write rules here prevents one
 * process from silently overwriting another process's reviewed/retry update.
 */

const { createHash, randomUUID } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { renameAtomic } = require('./file-core.js');
const { withLock } = require('./lock-core.js');

const STATE_DIR = join(homedir(), '.claude', 'codex-review-state');

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
}

function stateKey(root) {
  return createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
}

function statePath(root) {
  return join(STATE_DIR, `${stateKey(root)}.json`);
}

function claimPath(root, fingerprint) {
  return join(STATE_DIR, `${stateKey(root)}.${fingerprint.slice(0, 16)}.claim`);
}

function readState(root, options = {}) {
  const target = statePath(root);
  try {
    const value = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ルートがJSONオブジェクトではありません');
    }
    return value;
  } catch (error) {
    if (options.strict && error.code !== 'ENOENT') {
      throw new Error(`${target} を読み込めません: ${error.message}`);
    }
    return {};
  }
}

function writeState(root, state) {
  ensureStateDir();
  const target = statePath(root);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ root, ...state }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameAtomic(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }
}

function withStateLock(root, action) {
  ensureStateDir();
  return withLock(`${statePath(root)}.lock`, action, { label: 'レビュー状態の更新ロック' });
}

function clearClaimsUnlocked(root) {
  const prefix = `${stateKey(root)}.`;
  let entries = [];
  try {
    entries = readdirSync(STATE_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.claim')) continue;
    try {
      unlinkSync(join(STATE_DIR, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function resetClaims(root) {
  if (!existsSync(STATE_DIR)) return;
  return withStateLock(root, () => {
    const current = readState(root);
    clearClaimsUnlocked(root);
    if (Object.prototype.hasOwnProperty.call(current, 'retry')) {
      const updated = { ...current };
      delete updated.retry;
      writeState(root, updated);
    }
  });
}

module.exports = {
  STATE_DIR,
  claimPath,
  clearClaimsUnlocked,
  ensureStateDir,
  readState,
  resetClaims,
  stateKey,
  statePath,
  withStateLock,
  writeState,
};
