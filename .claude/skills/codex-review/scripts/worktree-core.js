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
const { existsSync, realpathSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

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
const NAME_PATTERN = new RegExp(`^${NAME_PREFIX}[0-9a-f]{16}$`);
// Section for this skill's own repository-config records. Reads and writes go
// through the shared `.git/config`, which every worktree of the repository sees.
const CONFIG_SECTION = 'codexreview';

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

function isWorktreeName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value);
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
 * The path as the filesystem itself spells it: 8.3 short names expanded,
 * symlinks resolved, casing as recorded.
 *
 * Two names for one directory is not a curiosity on Windows. `%TEMP%` is
 * commonly the 8.3 form (`C:\Users\LONGNA~1\...`) while git answers with the
 * long one, and a `subst` drive or a symlinked checkout does the same thing.
 * Anything comparing "is this write inside the shared checkout?" by path
 * arithmetic then decides *no* for a path that plainly is, and a guard that
 * answers no fails open — silently, looking exactly like a tree that needed no
 * guarding.
 *
 * Walks up to the nearest existing ancestor, because the target of a write does
 * not exist yet by definition. Any resolution failure falls back to the plain
 * resolved path: a canonicalizer that throws would be worse than one that
 * occasionally agrees with `resolve()`.
 */
function canonicalPath(target) {
  let current = resolve(target);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` is `parent` itself or sits underneath it. Uses path
 * arithmetic rather than string prefixes so `/repo-2` is not read as inside
 * `/repo`. Callers comparing paths from different sources must canonicalize
 * both first — see canonicalPath().
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

/**
 * The inverse of worktreePath(): the session worktree name a checkout sits at,
 * or null when the path is not one of this skill's worktrees.
 *
 * Kept next to worktreePath so the two cannot drift. It exists because the merge
 * runs from inside the worktree with no session id to hand — the path is the
 * only identity available there, and it has to resolve to the same name the hook
 * derived from the session id.
 */
function worktreeNameFromPath(main, worktreeRoot) {
  const parent = join(resolve(main), ...WORKTREE_RELATIVE.split('/'));
  const rel = relative(parent, resolve(worktreeRoot));
  if (!rel || rel.includes(sep) || isAbsolute(rel)) return null;
  return isWorktreeName(rel) ? rel : null;
}

/**
 * The repository's common git directory: the same absolute path from every
 * worktree, and therefore the one identity all sessions of a repository agree
 * on. Anything that must be exclusive *across* worktrees — as opposed to within
 * one — has to be keyed on this rather than on a working-tree root.
 */
function commonGitDir(cwd) {
  return resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd).trim());
}

/**
 * Rejects anything git would not accept as a branch name.
 *
 * Guards both ends of the record: an invalid name is never written, and a
 * hand-edited or corrupted config can never reach a git argument. Deliberately
 * `check-ref-format <fullref>` rather than `--branch <name>`, because `--branch`
 * *expands* the `@{-1}` "previous branch" syntax instead of validating it, and a
 * validator that resolves its input is not a validator.
 */
function isBranchName(cwd, value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('-')) return false;
  try {
    git(['check-ref-format', `refs/heads/${value}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a worktree records the branch its work must go back to.
 *
 * Keyed by worktree name, not branch name: Claude Code names the branch when it
 * creates the worktree, so that name is not knowable at the moment the target
 * must be captured — whereas the worktree name is derived from the session id
 * and is. Stored in the repository config, which is shared by every worktree, so
 * a resumed session reads back exactly what the original one wrote.
 */
function mergeTargetKey(name) {
  if (!isWorktreeName(name)) throw new Error(`worktree名が不正です: ${name}`);
  return `${CONFIG_SECTION}.${name}.mergeInto`;
}

/**
 * Every value recorded for this worktree. Returns a list rather than a string
 * because a multi-valued key means the record is corrupt, and the caller must be
 * able to refuse rather than silently pick one.
 */
function readMergeTargets(main, name) {
  try {
    return git(['config', '--local', '--get-all', mergeTargetKey(name)], main)
      .split(/\r?\n/)
      .filter((line) => line !== '');
  } catch (error) {
    // Exit 1 is git's "no such key", which is simply "never recorded".
    if (error.status === 1) return [];
    throw error;
  }
}

function writeMergeTarget(main, name, branch) {
  if (!isBranchName(main, branch)) throw new Error(`ブランチ名が不正です: ${branch}`);
  git(['config', '--local', '--replace-all', mergeTargetKey(name), branch], main);
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
 *
 * `untracked: false` narrows this to tracked changes, for callers that only care
 * about work a git operation could disturb — merge refuses on its own when an
 * untracked file is in the way.
 */
function dirtyEntries(root, options = {}) {
  const args = ['-c', 'core.quotePath=false', 'status', '--porcelain'];
  if (options.untracked === false) args.push('--untracked-files=no');
  const output = git(args, root);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).split(' -> ').pop().trim();
      return !toPosix(path).startsWith(`${WORKTREE_RELATIVE}/`);
    });
}

/**
 * Git operations that leave a half-finished state behind. Starting anything on
 * top of one of these compounds an operation someone else left open, and an
 * `--abort` afterwards would unwind the wrong one.
 */
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
];

function gitDir(root) {
  return git(['rev-parse', '--path-format=absolute', '--git-dir'], root).trim();
}

/** The interrupted git operation blocking this checkout, or null when there is none. */
function inProgressOperation(root) {
  const dir = gitDir(root);
  return IN_PROGRESS.find((entry) => existsSync(join(dir, entry))) ?? null;
}

/**
 * The checked-out branch, or null when HEAD is not on one.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`, and the prefix is
 * stripped here rather than with `--short`. Both of those shorten a ref only as
 * far as it stays *unambiguous*: create a tag named `main` and either one starts
 * answering `heads/main`, which then becomes `refs/heads/heads/main` downstream
 * and fails to resolve (verified). Tags outrank heads in git's resolution order,
 * so this is not a hypothetical — and the failure lands on the merge, after the
 * work is done.
 *
 * Also resolves on an unborn branch, where `rev-parse HEAD` cannot: "which
 * branch is checked out" has an answer before the first commit.
 */
function currentBranch(root) {
  let ref;
  try {
    ref = git(['symbolic-ref', '--quiet', 'HEAD'], root).trim();
  } catch (error) {
    // Exit 1 is git's "HEAD is not a symbolic ref", i.e. detached.
    if (error.status === 1) return null;
    throw error;
  }
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/**
 * Branch names reach git only as `refs/heads/<name>`, never bare. A fully
 * qualified ref cannot start with `-`, so no branch name — however hostile, and
 * whoever created it — is parseable as an option, and a same-named tag cannot
 * shadow it (tags outrank heads in git's resolution order).
 */
function headsRef(branch) {
  return `refs/heads/${branch}`;
}

function commitOf(root, branch) {
  return git(['rev-parse', '--verify', `${headsRef(branch)}^{commit}`], root).trim();
}

function branchExists(root, branch) {
  try {
    git(['show-ref', '--verify', '--quiet', headsRef(branch)], root);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function isAncestor(root, ancestor, descendant) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant], root);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
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
  IN_PROGRESS,
  OPT_OUT_FILE,
  WORKTREE_RELATIVE,
  branchExists,
  canonicalPath,
  commitOf,
  commonGitDir,
  currentBranch,
  dirtyEntries,
  git,
  gitDir,
  headsRef,
  inProgressOperation,
  isAncestor,
  isBranchName,
  isEnabled,
  isInside,
  isLinkedWorktree,
  isOptedOut,
  isWorktreeName,
  listWorktrees,
  mainRoot,
  mergeTargetKey,
  readMergeTargets,
  registeredWorktree,
  samePath,
  sessionSlug,
  toPosix,
  worktreeName,
  worktreeNameFromPath,
  worktreePath,
  writeMergeTarget,
};
