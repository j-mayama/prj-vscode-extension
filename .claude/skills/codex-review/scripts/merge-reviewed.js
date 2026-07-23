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
 *   REVIEW_REQUIRED <branch> <sha> conflicts=<count>
 *   UP_TO_DATE <branch>
 *   SKIPPED <reason>
 */

const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');

const { withLock } = require('./lock-core.js');
const {
  STATE_DIR,
  ensureStateDir,
  readState,
  stateKey,
  withStateLock,
  writeState,
} = require('./state-core.js');
const {
  branchExists,
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
  isLinkedWorktree,
  mainRoot,
  mergeTargetKey,
  readMergeTargets,
  worktreeNameFromPath,
} = require('./worktree-core.js');

/**
 * Long enough that a session queued behind another session's merge waits it out
 * rather than reporting a failure the user would have to resolve by hand; short
 * enough to surface a genuinely stuck holder instead of hanging the turn.
 */
const LOCK_TIMEOUT_MS = 60 * 1000;

class ReviewRequired extends Error {
  constructor(target, targetHead, sourceHead) {
    super(`${target}の${targetHead}を${sourceHead}へ取り込み、競合解消後に再レビューする必要があります`);
    this.target = target;
    this.targetHead = targetHead;
    this.sourceHead = sourceHead;
  }
}

function die(message) {
  process.stderr.write(`codex-review: ${message}\n`);
  process.exit(1);
}

function gitOutput(error) {
  return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
}

/**
 * Computes the recursive merge result without touching an index or worktree.
 * Exit 1 plus a leading tree id is git merge-tree's documented conflict result;
 * every other failure remains fatal rather than being mistaken for a conflict.
 */
function mergeTreePlan(root, left, right) {
  try {
    const output = git(['merge-tree', '--write-tree', left, right], root);
    const tree = output.split(/\r?\n/, 1)[0].trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error(`git merge-tree が不正なtreeを返しました: ${JSON.stringify(tree)}`);
    }
    return { conflicted: false, tree };
  } catch (error) {
    const output = gitOutput(error);
    const tree = output.split(/\r?\n/, 1)[0].trim();
    if (error.status === 1 && /^[0-9a-f]{40,64}$/.test(tree)) {
      return { conflicted: true, tree };
    }
    throw new Error(`merge結果を事前計算できませんでした:\n${output || error.message}`);
  }
}

function nulPaths(output) {
  return output.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
}

function pathsCollide(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Visible untracked files that a source tree would turn into tracked paths. */
function untrackedCollisions(root, sourceHead) {
  const untracked = nulPaths(git(['ls-files', '--others', '--exclude-standard', '-z'], root));
  if (untracked.length === 0) return [];
  const incoming = nulPaths(git(['ls-tree', '-r', '--name-only', '-z', sourceHead], root));
  return untracked.filter((local) => incoming.some((tracked) => pathsCollide(local, tracked)));
}

/** Hash local bytes so a no-checkout merge can prove it did not overwrite them. */
function localSnapshot(root, files) {
  return Object.fromEntries(files.map((file) => {
    const absolute = resolve(root, file);
    const stat = lstatSync(absolute);
    const hash = createHash('sha256');
    if (stat.isSymbolicLink()) hash.update(`symlink:${readlinkSync(absolute)}`);
    else if (stat.isFile()) hash.update(readFileSync(absolute));
    else throw new Error(`未追跡パスが通常ファイルまたはsymlinkではありません: ${file}`);
    return [file, hash.digest('hex')];
  }));
}

/**
 * Advance the target without checking out the merged tree. This is used only
 * when a visible untracked file occupies a path the source commit tracks.
 * `git merge` would stop to avoid overwriting it; updating the ref and then the
 * index with `reset --mixed` keeps the local bytes untouched. The path becomes
 * an ordinary unstaged tracked modification, while the reviewed bytes live in
 * the target commit.
 */
function mergePreservingUntracked(shared, source, target, before, sourceHead, collisions, mergeTree) {
  const localBefore = localSnapshot(shared, collisions);
  let merged;
  let kind;

  if (isAncestor(shared, before, sourceHead)) {
    merged = sourceHead;
    kind = 'fast-forward';
  } else {
    merged = git(
      ['commit-tree', mergeTree, '-p', before, '-p', sourceHead, '-m', `Merge branch '${source}'`],
      shared,
    ).trim();
    kind = 'merge-commit';
  }

  const targetRef = headsRef(target);
  let refUpdated = false;
  try {
    git(['update-ref', '-m', `merge ${source} (preserve local untracked files)`, targetRef, merged, before], shared);
    refUpdated = true;
    git(['reset', '--mixed', '--quiet', merged], shared);
  } catch (error) {
    if (!refUpdated) {
      throw new Error(`未追跡ファイル保持mergeを開始できませんでした（HEADは変更していません）:\n${gitOutput(error)}`);
    }
    // reset --mixed never writes working-tree files. If updating the real index
    // still fails, put the branch and index back before reporting the failure.
    try {
      git(['update-ref', '-m', `rollback failed merge ${source}`, targetRef, before, merged], shared);
      git(['reset', '--mixed', '--quiet', before], shared);
    } catch (rollbackError) {
      throw new Error(
        `未追跡ファイル保持mergeの復元に失敗しました。手動確認が必要です:\n`
          + `${gitOutput(error)}\n${gitOutput(rollbackError)}`,
      );
    }
    throw new Error(`未追跡ファイル保持mergeに失敗し、元のHEADへ戻しました:\n${gitOutput(error)}`);
  }

  const localAfter = localSnapshot(shared, collisions);
  if (JSON.stringify(localAfter) !== JSON.stringify(localBefore)) {
    throw new Error('merge後に未追跡ファイルの内容が変化しました。手動確認が必要です');
  }
  if (inProgressOperation(shared)) {
    throw new Error('未追跡ファイル保持merge後にgit操作途中の状態が残っています');
  }
  if (currentBranch(shared) !== target || commitOf(shared, target) !== merged) {
    throw new Error('未追跡ファイル保持merge後のブランチまたはHEADが想定と一致しません');
  }
  if (!isAncestor(shared, sourceHead, merged)) {
    throw new Error('未追跡ファイル保持mergeにレビュー済みコミットが含まれていません');
  }

  process.stdout.write(`MERGED ${target} ${merged} ${kind} preserved-untracked=${collisions.length}\n`);
  return 0;
}

/** Paths still requiring human/agent resolution in this session worktree. */
function conflictedPaths(root) {
  return nulPaths(git(['diff', '--name-only', '--diff-filter=U', '-z'], root));
}

/**
 * Move a conflict out of the shared checkout and into this session's isolated
 * worktree. `--no-commit --no-ff` deliberately leaves even a clean integration
 * uncommitted: the combined result must pass Codex review before it can move the
 * target branch.
 */
function prepareReview(worktree, source, request) {
  if (currentBranch(worktree) !== source) {
    throw new Error(`再レビュー準備前にworktreeのブランチが${source}から変わりました`);
  }
  if (commitOf(worktree, source) !== request.sourceHead) {
    throw new Error('再レビュー準備前にworktreeのHEADが変わりました。現在の状態からmergeを再実行してください');
  }
  const blocked = inProgressOperation(worktree);
  if (blocked) {
    throw new Error(`専用worktreeで${blocked}が進行中です。解消・再レビュー・コミット後にmergeを再実行してください`);
  }
  const dirty = dirtyEntries(worktree);
  if (dirty.length > 0) {
    throw new Error(`専用worktreeに未コミット変更があるため再レビュー用mergeを開始しません:\n${dirty.join('\n')}`);
  }

  let detail = '';
  try {
    git([
      'merge', '--no-commit', '--no-ff', '-m',
      `Merge branch '${request.target}' into '${source}' for review`,
      request.targetHead,
    ], worktree);
  } catch (error) {
    detail = gitOutput(error);
  }

  const pending = mergeHeads(worktree);
  if (!pending || pending.length !== 1 || pending[0] !== request.targetHead) {
    throw new Error(
      `再レビュー用mergeを開始できませんでした（期待MERGE_HEAD=${request.targetHead}）:\n${detail}`,
    );
  }
  const conflicts = conflictedPaths(worktree);
  process.stdout.write(
    `REVIEW_REQUIRED ${request.target} ${request.targetHead} conflicts=${conflicts.length}\n`,
  );
  return 0;
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

  // Tracked changes still stop a normal merge. A visible untracked file is
  // different: if the source tracks the same path, use a no-checkout merge that
  // preserves its bytes as an unstaged local modification.
  const dirty = dirtyEntries(shared, { untracked: false });
  if (dirty.length) {
    throw new Error(
      `共有チェックアウト（${target}）に未コミット変更があるためmergeしません。`
        + `コミットするか退避してから統合してください:\n${dirty.join('\n')}`,
    );
  }

  const fastForward = isAncestor(shared, before, sourceHead);
  let mergeTree = null;
  if (!fastForward) {
    const plan = mergeTreePlan(shared, before, sourceHead);
    if (plan.conflicted) throw new ReviewRequired(target, before, sourceHead);
    mergeTree = plan.tree;
  }

  const collisions = untrackedCollisions(shared, sourceHead);
  if (collisions.length > 0) {
    return mergePreservingUntracked(shared, source, target, before, sourceHead, collisions, mergeTree);
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
    throw new ReviewRequired(target, before, sourceHead);
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

/**
 * Records that this source commit was actually run through a merge, and how it
 * went. stop-hook.js reads this to tell "nobody tried" from "tried and it could
 * not be done", which are the two situations that need opposite handling: the
 * first has to keep asking, the second must not trap the session.
 *
 * Keyed on the source commit, so a new commit is judged on its own. Deliberately
 * best effort: the merge has already happened by the time this runs, and losing
 * the note costs at most one extra reminder — throwing here would turn a
 * successful merge into a failed command.
 */
function recordAttempt(worktreeRoot, sourceHead, result) {
  try {
    withStateLock(worktreeRoot, () => {
      const state = readState(worktreeRoot, { strict: true });
      writeState(worktreeRoot, {
        ...state,
        merge: { head: sourceHead, result, at: new Date().toISOString() },
      });
    });
  } catch (error) {
    process.stderr.write(
      `codex-review: merge結果を状態ファイルへ記録できませんでした（${error.message}）。`
        + 'Stop hookが同じmergeをもう一度要求する可能性があります\n',
    );
  }
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

  // Captured before anything is attempted, so every outcome below — including a
  // failure to even resolve the target — is attributed to the commit the caller
  // asked to integrate.
  const sourceHead = commitOf(cwd, source);

  let target;
  try {
    target = recordedTarget(shared, name);
  } catch (error) {
    recordAttempt(worktreeRoot, sourceHead, 'failed');
    throw error;
  }

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
  try {
    const code = withLock(lock, () => mergeUnderLock(shared, source, target), {
      label: `共有チェックアウト（${shared}）のmergeロック`,
      timeoutMs: LOCK_TIMEOUT_MS,
    });
    recordAttempt(worktreeRoot, sourceHead, 'completed');
    return code;
  } catch (error) {
    if (!(error instanceof ReviewRequired)) {
      recordAttempt(worktreeRoot, sourceHead, 'failed');
      throw error;
    }
    let code;
    try {
      code = prepareReview(worktreeRoot, source, error);
    } catch (prepareError) {
      recordAttempt(worktreeRoot, sourceHead, 'failed');
      throw prepareError;
    }
    recordAttempt(worktreeRoot, sourceHead, 'review-required');
    return code;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  die(error.stderr?.trim() || error.message);
}
