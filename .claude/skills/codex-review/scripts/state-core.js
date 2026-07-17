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
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { renameAtomic } = require('./file-core.js');

const STATE_DIR = join(homedir(), '.claude', 'codex-review-state');
const STALE_LOCK_MS = 5 * 60 * 1000;

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

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value?.owner !== 'codex-review-state' ||
      value?.version !== 1 ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !value.token.startsWith(`${value.pid}-`) ||
      typeof value.at !== 'string' ||
      Number.isNaN(Date.parse(value.at))
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function finishLockCleanup(lock, cleanupLock) {
  let claim;
  try {
    claim = statSync(cleanupLock);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const owner = lockOwner(cleanupLock);
  if (!owner) {
    throw new Error(`所有を確認できないcleanup lockを保持して中止します: ${cleanupLock}`);
  }

  try {
    const current = statSync(lock);
    if (
      sameFile(claim, current) &&
      Date.now() - claim.mtimeMs > STALE_LOCK_MS &&
      !processIsAlive(owner.pid)
    ) {
      unlinkSync(lock);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    unlinkSync(cleanupLock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function releaseLock(lock, token) {
  try {
    const current = JSON.parse(readFileSync(lock, 'utf8'));
    if (current.token === token) unlinkSync(lock);
  } catch {
    // A stale-lock cleanup may already have removed or replaced it.
  }
}

function withStateLock(root, action) {
  ensureStateDir();
  const lock = `${statePath(root)}.lock`;
  const cleanupLock = `${lock}.cleanup`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acquired = false;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(cleanupLock)) {
      finishLockCleanup(lock, cleanupLock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      writeFileSync(
        lock,
        `${JSON.stringify({
          owner: 'codex-review-state',
          version: 1,
          token,
          pid: process.pid,
          at: new Date().toISOString(),
        })}\n`,
        { flag: 'wx', mode: 0o600 }
      );
      acquired = true;
      if (existsSync(cleanupLock)) {
        releaseLock(lock, token);
        acquired = false;
        finishLockCleanup(lock, cleanupLock);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          try {
            linkSync(lock, cleanupLock);
          } catch (cleanupError) {
            if (!['EEXIST', 'ENOENT'].includes(cleanupError.code)) throw cleanupError;
          }
          finishLockCleanup(lock, cleanupLock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  if (!acquired) throw new Error('レビュー状態の更新ロックを10秒以内に取得できませんでした');
  try {
    return action();
  } finally {
    releaseLock(lock, token);
  }
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
