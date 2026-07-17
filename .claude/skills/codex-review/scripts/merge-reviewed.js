#!/usr/bin/env node
'use strict';

/**
 * Merges this session's reviewed branch back into the branch its worktree was
 * created from.
 *
 * Committing inside a linked worktree lands on `codex-<slug>`'s branch and
 * nowhere else: the shared checkout keeps its own HEAD and its own files, so
 * anything served from it — a local site, a dev server, the branch the user is
 * actually looking at — never sees the reviewed work. The commit is only half of
 * "done"; without this the change is invisible outside the worktree.
 *
 * Two things make this more than "run git merge".
 *
 * **The target is a recorded fact, not an observation.** The shared checkout's
 * current branch answers "what is checked out right now", which is a different
 * question from "where did this work come from". A session runs for a long time;
 * the user may `git switch` while it does. Reading the branch here would quietly
 * put reviewed work on whatever unrelated branch happened to be showing at the
 * end. mark-prompt.js records the target at the moment the worktree is cut, and
 * this script only ever verifies against that record — never re-derives it.
 *
 * **The shared checkout has one index and one working tree**, shared by every
 * worktree of the repository. Two sessions finishing at once would interleave
 * their check / merge / abort sequences against that single tree: `index.lock`
 * and `update_ref` failures, and — worst — the loser observing a `MERGE_HEAD` it
 * did not create and aborting the winner's merge, leaving the shared checkout
 * half-merged. So the whole sequence, from re-checking preconditions through the
 * merge, any abort, and the final HEAD verification, runs under one lock keyed on
 * the repository's *common git directory* — the one name every worktree of the
 * repository agrees on. A per-worktree lock would not exclude anything.
 *
 * Only ever aborts a merge this process started, identified by MERGE_HEAD
 * matching the source commit. A merge someone else began is reported, not undone.
 *
 * Never pushes: reaching a remote stays a human decision.
 *
 * Usage:
 *   node merge-reviewed.js
 *
 * Output (stdout, one line):
 *   MERGED <branch> <sha> fast-forward|merge-commit
 *   UP_TO_DATE <branch>
 *   SKIPPED <reason>
 */

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const { withLock } = require('./lock-core.js');
const { STATE_DIR, ensureStateDir, stateKey } = require('./state-core.js');
const {
  commonGitDir,
  dirtyEntries,
  git,
  isBranchName,
  isLinkedWorktree,
  mainRoot,
  mergeTargetKey,
  readMergeTargets,
  worktreeNameFromPath,
} = require('./worktree-core.js');

/**
 * A merge started on top of one of these would compound an operation the user
 * (or another session) left half-finished, and `--abort` would then unwind the
 * wrong one.
 */
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
];

/**
 * Long enough that a session queued behind another session's merge waits it out
 * rather than reporting a failure the user would have to resolve by hand; short
 * enough to surface a genuinely stuck holder instead of hanging the turn.
 */
const LOCK_TIMEOUT_MS = 60 * 1000;

function die(message) {
  process.stderr.write(`codex-review: ${message}\n`);
  process.exit(1);
}

function gitDir(root) {
  return git(['rev-parse', '--path-format=absolute', '--git-dir'], root).trim();
}

function inProgressOperation(root) {
  const dir = gitDir(root);
  return IN_PROGRESS.find((entry) => existsSync(join(dir, entry))) ?? null;
}

/** The checked-out branch, or null when HEAD is detached. */
function currentBranch(root) {
  const name = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
  return name === 'HEAD' ? null : name;
}

/**
 * Branch names reach git only as `refs/heads/<name>`, never bare. A fully
 * qualified ref cannot start with `-`, so no branch name — however hostile, and
 * whoever created it — is parseable as an option.
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

function gitOutput(error) {
  return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
}

/**
 * The commits an in-flight merge is pulling in, or null when none is in flight.
 * Read rather than inferred: it is the only evidence of *whose* merge this is.
 */
function mergeHeads(root) {
  try {
    return readFileSync(join(gitDir(root), 'MERGE_HEAD'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Everything a failed merge must leave exactly as it found it. */
function snapshot(root) {
  return {
    head: git(['rev-parse', 'HEAD'], root).trim(),
    branch: currentBranch(root),
    status: git(['-c', 'core.quotePath=false', 'status', '--porcelain'], root),
  };
}

function assertRestored(root, before, detail) {
  const after = snapshot(root);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  throw new Error(
    'mergeに失敗し、共有チェックアウトが実行前の状態に戻っていません。手動で確認してください:\n'
      + `${detail}\n実行前: ${JSON.stringify(before)}\n現在: ${JSON.stringify(after)}`,
  );
}

/**
 * The branch this worktree must merge into, from the record written when it was
 * created. Every failure here is deliberately fatal rather than a fallback to
 * the current branch: not knowing where the work belongs is exactly the state in
 * which guessing does damage.
 */
function recordedTarget(shared, name) {
  const values = readMergeTargets(shared, name);
  const key = mergeTargetKey(name);
  const fix = `記録し直すには共有チェックアウトで: git config --local --replace-all ${key} <ブランチ名>`;

  if (values.length === 0) {
    throw new Error(
      `このworktree（${name}）の統合先が記録されていないためmergeしません。\n`
        + `統合先はworktree作成時にUserPromptSubmit hookが記録します。記録前に作られたworktreeか、記録に失敗しています。\n${fix}`,
    );
  }
  if (values.length > 1) {
    throw new Error(
      `このworktree（${name}）の統合先が複数記録されているためmergeしません: ${values.join(', ')}\n${fix}`,
    );
  }
  const target = values[0];
  if (!isBranchName(shared, target)) {
    throw new Error(`記録された統合先がブランチ名として不正なためmergeしません: ${JSON.stringify(target)}\n${fix}`);
  }
  return target;
}

/**
 * The merge itself. Every precondition is re-checked here rather than before the
 * lock: anything observed outside it may already be false by the time the merge
 * runs, which is the whole reason the lock exists.
 */
function mergeUnderLock(shared, source, target) {
  // First, and before anything reads HEAD: an interrupted rebase leaves HEAD
  // detached, so checking the branch first would report "detached HEAD" and hide
  // the operation that actually needs finishing.
  const blocked = inProgressOperation(shared);
  if (blocked) {
    throw new Error(`共有チェックアウトで${blocked}が進行中のためmergeしません`);
  }

  if (!branchExists(shared, target)) {
    throw new Error(
      `統合先として記録されたブランチ ${target} が存在しないためmergeしません（削除・改名された可能性があります）`,
    );
  }

  const current = currentBranch(shared);
  if (!current) {
    throw new Error(
      `共有チェックアウトがdetached HEADのためmergeしません。統合先 ${target} をcheckoutしてから再実行してください`,
    );
  }
  if (current !== target) {
    throw new Error(
      `共有チェックアウトは ${current} をcheckoutしていますが、このworktreeの統合先は ${target} です。`
        + `別のブランチへmergeしないため中止しました。${target} をcheckoutしてから再実行してください`,
    );
  }

  const sourceHead = commitOf(shared, source);
  const before = commitOf(shared, target);
  if (isAncestor(shared, sourceHead, before)) {
    process.stdout.write(`UP_TO_DATE ${target}\n`);
    return 0;
  }

  // Untracked files are not a reason to stop: git refuses on its own if the
  // merge would overwrite one. Tracked changes are — `git merge --abort` is
  // documented as unable to reconstruct uncommitted work in some cases, so a
  // conflict here could destroy whatever the shared checkout was holding.
  const dirty = dirtyEntries(shared, { untracked: false });
  if (dirty.length) {
    throw new Error(
      `共有チェックアウト（${target}）に未コミット変更があるためmergeしません。`
        + `コミットするか退避してから統合してください:\n${dirty.join('\n')}`,
    );
  }

  const restorePoint = snapshot(shared);

  // `--ff` is spelled out because it is otherwise `merge.ff`'s to decide, and a
  // repository set to `only` would reject every merge that another session got
  // to first. Fast-forward moves the reviewed commit onto the target as-is and
  // writes no commit at all; only a diverged target needs one.
  //
  // The message is set rather than left to git. Passing `refs/heads/<name>` is
  // what keeps a branch name from ever being read as an option or shadowed by a
  // same-named tag (tags outrank heads in git's resolution order), but git would
  // then title the commit "Merge branch 'refs/heads/x'" — the qualified ref leaks
  // into the user's permanent history. Spelling out git's own conventional
  // wording keeps the safe ref and the ordinary log entry.
  try {
    git(
      ['merge', '--ff', '--no-edit', '-m', `Merge branch '${source}'`, headsRef(source)],
      shared,
    );
  } catch (error) {
    const detail = gitOutput(error);
    const pending = mergeHeads(shared);

    if (pending === null) {
      // git declined before starting — an untracked file in the way, most
      // often. Nothing was begun, so there is nothing to unwind.
      assertRestored(shared, restorePoint, detail);
      throw new Error(`${target}へのmergeに失敗しました（${target}は${before.slice(0, 7)}のままです）:\n${detail}`);
    }

    // The lock makes this unreachable between two of these scripts, so a
    // MERGE_HEAD that is not ours means a human started a merge here. Unwinding
    // it would destroy their conflict resolution.
    if (pending.length !== 1 || pending[0] !== sourceHead) {
      throw new Error(
        `${target}へのmergeに失敗し、このスクリプトが開始していないmerge（MERGE_HEAD=${pending.join(', ')}）が`
          + `進行中です。他プロセスのmergeを中断しないため、そのままにしました。手動で確認してください:\n${detail}`,
      );
    }

    try {
      git(['merge', '--abort'], shared);
    } catch (abortError) {
      throw new Error(
        `${target}へのmergeが衝突し、中断にも失敗しました。共有チェックアウトがmerge途中の状態です`
          + `（手動で解決するか git merge --abort してください）:\n${detail}\n${gitOutput(abortError)}`,
      );
    }
    assertRestored(shared, restorePoint, detail);
    throw new Error(`${target}へのmergeに失敗しました（${target}は${before.slice(0, 7)}のままです）:\n${detail}`);
  }

  // Still under the lock: a merge that reported success but left the checkout
  // somewhere unexpected must not be reported as delivered.
  const merged = commitOf(shared, target);
  const settled = inProgressOperation(shared);
  if (settled) {
    throw new Error(`mergeは成功しましたが、共有チェックアウトに${settled}が残っています。手動で確認してください`);
  }
  if (currentBranch(shared) !== target) {
    throw new Error(`mergeは成功しましたが、共有チェックアウトのHEADが${target}ではありません。手動で確認してください`);
  }
  if (!isAncestor(shared, sourceHead, merged)) {
    throw new Error(
      `mergeは成功しましたが、${target}（${merged.slice(0, 7)}）に${source}の内容が入っていません。手動で確認してください`,
    );
  }

  const kind = merged === sourceHead ? 'fast-forward' : 'merge-commit';
  process.stdout.write(`MERGED ${target} ${merged} ${kind}\n`);
  return 0;
}

function main() {
  const cwd = process.cwd();

  // Without isolation the commit already landed on the branch the user is on,
  // so there is nothing to move.
  if (!isLinkedWorktree(cwd)) {
    process.stdout.write('SKIPPED not-linked-worktree\n');
    return 0;
  }

  const source = currentBranch(cwd);
  if (!source) throw new Error('worktreeがdetached HEADのためmergeしません');

  const shared = mainRoot(cwd);
  const worktreeRoot = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const name = worktreeNameFromPath(shared, worktreeRoot);
  if (!name) {
    throw new Error(
      `このworktree（${worktreeRoot}）はcodex-reviewが作成したものではないためmergeしません。`
        + '統合先の記録が無いため、どのブランチへ統合すべきか判断できません',
    );
  }

  const target = recordedTarget(shared, name);
  if (target === source) {
    process.stdout.write('SKIPPED same-branch\n');
    return 0;
  }

  // Keyed on the common git directory, so every worktree of this repository
  // contends for the same lock. Everything above is read-only; acquisition
  // failure therefore returns having changed nothing at all. Not merging is
  // recoverable, a half-merged shared checkout is the thing worth avoiding.
  ensureStateDir();
  const lock = join(STATE_DIR, `${stateKey(commonGitDir(cwd))}.merge.lock`);
  return withLock(lock, () => mergeUnderLock(shared, source, target), {
    label: `共有チェックアウト（${shared}）のmergeロック`,
    timeoutMs: LOCK_TIMEOUT_MS,
  });
}

try {
  process.exitCode = main();
} catch (error) {
  die(error.stderr?.trim() || error.message);
}
