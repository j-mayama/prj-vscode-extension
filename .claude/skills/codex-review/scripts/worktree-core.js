#!/usr/bin/env node
'use strict';

/**
 * Per-session worktree identity and detection.
 *
 * Several sessions sharing one checkout cannot be made safe after the fact: git
 * only ever reports "the diff of this tree", so session A's review necessarily
 * reads session B's half-written code, and A's mandatory fixes land on it. The
 * only structural fix is to stop sharing the checkout, which means each session
 * must move into its own worktree *before* its first write.
 *
 * Claude Code creates worktrees through the EnterWorktree tool, which only the
 * model can call — a hook cannot. So isolation is cooperative (mark-prompt.js
 * tells the model to move) plus enforced (worktree-guard.js denies writes that
 * would land in the shared checkout). This module holds the naming and detection
 * rules both sides depend on, so they cannot drift apart.
 *
 * Naming is derived, never stored: the same session id always yields the same
 * worktree name and path. That is what lets a resumed session find its existing
 * worktree without a registry to lose.
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

const MAX_BUFFER = 64 * 1024 * 1024;

const FLAG_FILE = '.codex-review-auto';
const OPT_OUT_FILE = '.codex-review-no-worktree';
const WORKTREE_RELATIVE = '.claude/worktrees';
// The nested worktree directory must be ignored or it lands in the main repo's
// own status as untracked. That is not cosmetic: fingerprint() feeds the
// untracked list to `git hash-object --stdin-paths`, git collapses the worktree
// to a directory entry, hash-object fails on a directory, and the Stop hook
// fails open — reviews stop running and look clean while doing it.
const IGNORE_LINE = `${WORKTREE_RELATIVE}/`;
const NAME_PREFIX = 'codex-';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Session ids are opaque. Hashing rather than sanitizing means the result is
 * always a legal branch name and path segment no matter what arrives, and two
 * different ids can never normalize onto the same worktree.
 */
function sessionSlug(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('session_id が取得できません');
  }
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

/** `codex-<16 hex>`: 22 chars, within EnterWorktree's 64-char / [A-Za-z0-9._-] rule. */
function worktreeName(sessionId) {
  return `${NAME_PREFIX}${sessionSlug(sessionId)}`;
}

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function samePath(left, right) {
  const normalize = (value) => {
    const canonical = toPosix(resolve(value)).replace(/\/+$/, '');
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  return normalize(left) === normalize(right);
}

/**
 * True when `child` is `parent` itself or sits underneath it. Uses path
 * arithmetic rather than string prefixes so `/repo-2` is not read as inside
 * `/repo`.
 */
function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Every worktree of this repository. The first entry is always the main one. */
function listWorktrees(cwd) {
  const output = git(['worktree', 'list', '--porcelain'], cwd);
  const entries = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, head: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    }
  }
  if (!entries.length) throw new Error('git worktree list を解釈できません');
  return entries;
}

/**
 * The shared checkout every session starts in. `git rev-parse --show-toplevel`
 * cannot be used: inside a linked worktree it returns that worktree, so the
 * shared root would be invisible exactly when it matters.
 */
function mainRoot(cwd) {
  return resolve(listWorktrees(cwd)[0].path);
}

/**
 * A linked worktree has its own gitdir under the shared one; the main worktree's
 * gitdir *is* the common dir.
 */
function isLinkedWorktree(cwd) {
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd).trim();
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd).trim();
  return !samePath(gitDir, commonDir);
}

function worktreePath(main, sessionId) {
  return join(main, ...WORKTREE_RELATIVE.split('/'), worktreeName(sessionId));
}

/** The session's worktree, but only when git still knows about it. */
function registeredWorktree(cwd, main, sessionId) {
  const expected = worktreePath(main, sessionId);
  if (!existsSync(expected)) return null;
  const found = listWorktrees(cwd).find((entry) => samePath(entry.path, expected));
  return found ? { ...found, path: resolve(found.path) } : null;
}

/**
 * Uncommitted changes in the shared checkout, ignoring the nested worktree
 * directory itself.
 *
 * Entering a worktree does not move these — git branches from a commit, so the
 * changes stay behind in the shared tree and the session silently works against
 * HEAD instead. Migrating them is explicitly out of scope (stash/reset/copy all
 * risk the user's work), so the honest move is to stop and say so.
 */
function dirtyEntries(root) {
  const output = git(['-c', 'core.quotePath=false', 'status', '--porcelain'], root);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).split(' -> ').pop().trim();
      return !toPosix(path).startsWith(`${WORKTREE_RELATIVE}/`);
    });
}

function isEnabled(main) {
  return existsSync(join(main, FLAG_FILE));
}

/** Explicit, per-repository escape hatch from isolation. */
function isOptedOut(main) {
  return existsSync(join(main, OPT_OUT_FILE));
}

module.exports = {
  FLAG_FILE,
  IGNORE_LINE,
  OPT_OUT_FILE,
  WORKTREE_RELATIVE,
  dirtyEntries,
  git,
  isEnabled,
  isInside,
  isLinkedWorktree,
  isOptedOut,
  listWorktrees,
  mainRoot,
  registeredWorktree,
  samePath,
  sessionSlug,
  toPosix,
  worktreeName,
  worktreePath,
};
