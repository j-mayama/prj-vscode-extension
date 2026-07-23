#!/usr/bin/env node
'use strict';

/**
 * Building commits without letting `git commit` near them.
 *
 * Every commit this skill creates has already been shown to someone — the user
 * approved a file list, or Codex reviewed a fingerprinted tree. `git commit`
 * cannot honour that: it runs `pre-commit`, and a pre-commit hook may reformat a
 * file and `git add` it, or stage something untracked entirely. Whatever the
 * hook does lands in the commit, and a comparison afterwards can only report the
 * damage. So the commit is assembled by hand — a private index, `write-tree`,
 * `commit-tree`, and a compare-and-swap `update-ref` — and no commit hook runs.
 * (`update-ref` may still invoke Git's `reference-transaction` hook, after the
 * commit tree is already fixed.)
 *
 * Two locks are involved and they are not the same thing:
 *
 * - `GIT_INDEX_FILE` points staging at a private copy, so nothing here can
 *   corrupt or half-write the index another process is using.
 * - git's own `index.lock` is what excludes *other git processes*. This skill's
 *   own lock (lock-core.js) only excludes other sessions of this skill; an
 *   ordinary `git add` in a terminal knows nothing about it. Publishing a
 *   private index without holding `index.lock` would silently overwrite whatever
 *   that `git add` had just staged.
 *
 * The lock is therefore held across the whole observe → stage → publish window,
 * not just the rename at the end. Anything observed before taking it may already
 * be false by the time the index is published, which is the entire failure this
 * exists to prevent. While it is held, a concurrent `git add` fails with git's
 * usual "Another git process seems to be running" — a visible, retryable
 * failure, which is the outcome to prefer over a silently discarded staging.
 */

const { execFileSync } = require('node:child_process');
const {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} = require('node:fs');
const { join } = require('node:path');

const { renameAtomic } = require('./file-core.js');

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * How long to wait for another git process to release `index.lock`.
 *
 * Short on purpose: an ordinary git command holds the index for milliseconds, so
 * anything longer than this is a stuck or crashed process, and waiting out a
 * stuck process just moves the failure later. A stale `index.lock` is never
 * removed here — git does not remove it either, because the process that left it
 * may still be alive and about to write.
 */
const INDEX_LOCK_TIMEOUT_MS = 5 * 1000;
const INDEX_LOCK_RETRY_MS = 50;

/**
 * "Someone else has it, try again" — not "this will never work". EEXIST is the
 * honest answer; the rest are the Windows sharing window while a lock file is
 * being handed from one holder to the next (same reasoning as lock-core.js).
 */
const CONTENDED = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'];

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** git with a private index. Nothing run through this can reach the real index. */
function gitWithIndex(args, root, indexFile) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
  });
}

function writeAll(fd, buffer) {
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written);
  }
}

/**
 * Runs `action` while holding git's `index.lock` for `dir`, following git's own
 * protocol: exclusive create, then rename over `index`.
 *
 * `action` receives `publish(source)`, which installs a private index file as the
 * real one by writing it into the lock this process already holds. Until that is
 * called the real index is not touched at all, so every pre-publication failure
 * path — including one that throws halfway through staging — leaves it
 * bit-identical.
 */
function withIndexLock(dir, action, options = {}) {
  const target = join(dir, 'index');
  const lock = join(dir, 'index.lock');
  const timeoutMs = options.timeoutMs ?? INDEX_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let fd = null;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (error) {
      if (!CONTENDED.includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `他のgitプロセスがindexを更新中のため、${Math.round(timeoutMs / 1000)}秒待っても`
            + `index.lockを取得できませんでした（${error.code}）。何も変更していません: ${lock}`,
        );
      }
      // A short wait rather than a spin: the holder is another process, and
      // burning a core does not make it release any sooner.
      sleep(INDEX_LOCK_RETRY_MS);
    }
  }

  let published = false;
  const publish = (source) => {
    if (published) throw new Error('indexは既に公開済みです');
    if (!existsSync(source)) {
      throw new Error(`公開するprivate indexがありません（gitが書き出していません）: ${source}`);
    }
    writeAll(fd, readFileSync(source));
    closeSync(fd);
    fd = null;
    renameAtomic(lock, target);
    published = true;
  };

  try {
    return action({ publish, indexPath: target, lockPath: lock });
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is being abandoned either way.
      }
    }
    if (!published) {
      try {
        unlinkSync(lock);
      } catch {
        // Leaving a stale lock behind would block every later git command, but
        // it is not worth masking the original failure to say so.
      }
    }
  }
}

/**
 * Runs `action(indexFile)` against a byte copy of the real index, removed
 * afterwards whatever happens.
 *
 * A byte copy rather than `read-tree`: every index attribute the user has —
 * intent-to-add, skip-worktree, assume-unchanged, resolve-undo — survives
 * untouched, and none of them can be reconstructed from a tree.
 *
 * When there is no index yet, the temporary file is left *absent* rather than
 * created empty: git reads a missing `GIT_INDEX_FILE` as an empty index and
 * writes it on the first change, but dies on a zero-byte one with "index file
 * smaller than expected" (verified).
 */
function withPrivateIndex(dir, label, action) {
  const temp = join(dir, `codex-review-${label}-index.${process.pid}`);
  const source = join(dir, 'index');
  try {
    if (existsSync(source)) copyFileSync(source, temp);
    else if (existsSync(temp)) unlinkSync(temp);
    return action(temp);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // A leftover temporary index is inert; it is not worth masking the
      // original failure to report it.
    }
  }
}

function assertTree(value) {
  const tree = value.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`git write-tree が不正なtreeを返しました: ${JSON.stringify(value)}`);
  }
  return tree;
}

/** The tree a private index would commit. Intent-to-add entries are not in it (git skips them). */
function writeTree(root, indexFile) {
  return assertTree(gitWithIndex(['write-tree'], root, indexFile));
}

/**
 * Whether this repository is configured to sign commits.
 *
 * `commit-tree` does not read `commit.gpgsign` on its own, so bypassing
 * `git commit` would silently start producing unsigned commits in a repository
 * that signs everything. Asked explicitly and passed through as `-S`.
 */
function signsCommits(root, git) {
  try {
    return git(['config', '--bool', '--get', 'commit.gpgsign'], root).trim() === 'true';
  } catch (error) {
    // Exit 1 is git's "no such key".
    if (error.status === 1) return false;
    throw error;
  }
}

module.exports = {
  INDEX_LOCK_TIMEOUT_MS,
  MAX_BUFFER,
  gitWithIndex,
  signsCommits,
  withIndexLock,
  withPrivateIndex,
  writeTree,
};
