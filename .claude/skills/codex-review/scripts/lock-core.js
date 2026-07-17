#!/usr/bin/env node
'use strict';

/**
 * Cross-process advisory locking.
 *
 * Two kinds of work in this skill are read-modify-write against something shared
 * by every session of a repository: the review state files, and the merge into
 * the shared checkout. Both need the same guarantees, and getting any of them
 * subtly wrong is the kind of bug that only shows up under real concurrency:
 *
 * - exclusive creation (`wx`), so two processes cannot both believe they won
 * - an owner marker, so a foreign file at the same path is never mistaken for a
 *   lock this skill may reclaim
 * - a liveness check, so a lock held by a running process is never stolen no
 *   matter how long it has been held
 * - release keyed by token, so a process can only ever drop its own lock
 *
 * Stale reclaim is the delicate part. Checking age and then unlinking races
 * another reclaimer: between the check and the unlink the lock may have been
 * released and re-taken, and the unlink would then delete a live lock. So the
 * reclaim itself is arbitrated by a hard link to the lock's inode — the winner
 * of `link()` is the only process that may delete, and it re-verifies the inode
 * still matches before doing so.
 */

const {
  existsSync,
  linkSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');

const OWNER = 'codex-review-state';
const OWNER_VERSION = 1;
const STALE_LOCK_MS = 5 * 60 * 1000;
const RETRY_MS = 100;
const DEFAULT_TIMEOUT_MS = 10 * 1000;

/**
 * "Someone else has it, try again" — not "this will never work".
 *
 * EEXIST is the honest answer. The rest are Windows: `open(wx)` against a lock
 * whose unlink is still pending fails the CreateFile with a sharing/access
 * denial rather than a clean EEXIST. That happens precisely when a lock is being
 * handed from one holder to the next — i.e. under the contention this lock
 * exists to handle — and treating it as fatal kills the waiter instead of making
 * it wait. file-core.js already reads the same codes as a transient Windows
 * sharing window; this is the same window, one syscall over.
 */
const CONTENDED = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * The parsed marker of a lock this skill owns, or null for anything else —
 * unparsable, truncated, or written by another tool. Callers must treat null as
 * "not mine to touch" rather than "safe to remove".
 */
function lockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value?.owner !== OWNER ||
      value?.version !== OWNER_VERSION ||
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
    // EPERM means a process exists that this user may not signal.
    return error.code !== 'ESRCH';
  }
}

/**
 * Completes a reclaim already claimed via `cleanupLock`. Deletes the lock only
 * when it is still the same inode that was claimed, has been idle past the stale
 * window, and its owning process is gone — so a lock that was released and
 * re-taken in the meantime, or one whose owner is still running, survives.
 */
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

/** Drops the lock only when this token still owns it. */
function releaseLock(lock, token) {
  try {
    const current = JSON.parse(readFileSync(lock, 'utf8'));
    if (current.token === token) unlinkSync(lock);
  } catch {
    // A stale-lock cleanup may already have removed or replaced it.
  }
}

/**
 * Runs `action` while holding `lock`, and releases it on every exit path.
 *
 * Throws without running `action` when the lock cannot be taken within the
 * timeout, so callers can treat acquisition failure as "did not start".
 */
function withLock(lock, action, options = {}) {
  const label = options.label ?? 'ロック';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A deadline, not an attempt count. Counting attempts assumes every iteration
  // sleeps, and the stale-lock paths deliberately do not — a lock held past the
  // stale window by a *live* process re-checks without sleeping, so a counted
  // budget drains in milliseconds and the caller is told it waited the full
  // timeout. Wall-clock is the thing the caller actually asked for.
  const deadline = Date.now() + timeoutMs;
  const cleanupLock = `${lock}.cleanup`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acquired = false;
  let contention = null;

  for (;;) {
    if (existsSync(cleanupLock)) {
      finishLockCleanup(lock, cleanupLock);
    } else {
      try {
        writeFileSync(
          lock,
          `${JSON.stringify({
            owner: OWNER,
            version: OWNER_VERSION,
            token,
            pid: process.pid,
            at: new Date().toISOString(),
          })}\n`,
          { flag: 'wx', mode: 0o600 }
        );
        acquired = true;
        // A reclaim that started before this write could still delete the lock
        // just taken. Yield to it and retry rather than run unprotected.
        if (existsSync(cleanupLock)) {
          releaseLock(lock, token);
          acquired = false;
          finishLockCleanup(lock, cleanupLock);
        } else {
          break;
        }
      } catch (error) {
        if (!CONTENDED.includes(error.code)) throw error;
        // Kept so a genuine permission problem does not masquerade as a plain
        // timeout after the deadline expires.
        contention = error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
            try {
              linkSync(lock, cleanupLock);
            } catch (cleanupError) {
              if (!['EEXIST', 'ENOENT'].includes(cleanupError.code)) throw cleanupError;
            }
            // Only reclaims when the owner is gone; a live owner's lock survives
            // this and the wait below is what keeps that from spinning.
            finishLockCleanup(lock, cleanupLock);
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
        }
      }
    }
    if (Date.now() >= deadline) break;
    sleep(RETRY_MS);
  }

  if (!acquired) {
    // EEXIST is the ordinary "someone else holds it" case and adds nothing. Any
    // other code means the open kept failing for a reason worth naming — a real
    // permission problem would otherwise be indistinguishable from a busy lock.
    const why = contention && contention.code !== 'EEXIST' ? `（最後のエラー: ${contention.code}）` : '';
    throw new Error(`${label}を${Math.round(timeoutMs / 1000)}秒以内に取得できませんでした${why}`);
  }
  try {
    return action();
  } finally {
    releaseLock(lock, token);
  }
}

module.exports = {
  STALE_LOCK_MS,
  lockOwner,
  processIsAlive,
  withLock,
};
