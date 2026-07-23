#!/usr/bin/env node
'use strict';

/**
 * Commits the shared checkout's tracked uncommitted changes so a session can
 * move into its own worktree.
 *
 * A session worktree is cut from HEAD, so anything uncommitted stays behind in
 * the shared checkout and the session silently starts from a different state
 * than the user is looking at. mark-prompt.js and worktree-guard.js therefore
 * stop rather than isolate, and offer the user a choice. This script is the
 * option that lets work continue: put those changes on the branch they are
 * already on, then isolate normally.
 *
 * It is deliberately the *only* migration this skill will perform. `stash`,
 * `reset` and `checkout` all move or discard the user's work; a commit adds to
 * history without touching a byte of it, and `--undo` puts it back. That
 * asymmetry is the whole reason this exists.
 *
 * ## Why staging happens in a private index
 *
 * Everything is staged in a byte copy of the index under `GIT_INDEX_FILE`, and
 * the commit is built with `commit-tree` + a compare-and-swap `update-ref`
 * (index-core.js). Three problems disappear at once:
 *
 * - **`git commit` runs hooks, and a hook can `git add` anything.** An untracked
 *   file staged by someone's pre-commit hook would land in this commit, and a
 *   post-hoc comparison could only report the damage. With no `git commit`,
 *   there is no commit hook, so the committed tree is exactly the tree that was
 *   shown to the user and approved.
 * - **A failure before publication must leave the index bit-identical.** Restoring through
 *   `write-tree` / `read-tree` cannot do that: a tree has no way to express
 *   intent-to-add or skip-worktree, and an `git add -N` entry comes back as a
 *   staged empty file (verified). Building privately and publishing only after
 *   every fallible validation is the only restore-free path that always works.
 * - **Ordinary staging would sweep in intent-to-add content.** `git add -u`
 *   stages the *contents* of an `git add -N` path (verified), which is a file
 *   the user has not actually added. Only paths that exist in HEAD are staged.
 *
 * ## Why the approval carries a fingerprint, and what is in it
 *
 * The set of changes is listed for the user in one process and committed in
 * another. Recomputing "everything dirty right now" at commit time would commit
 * whatever a parallel session added in between — work nobody approved. `--plan`
 * prints the complete set with a fingerprint over it, and `--confirm
 * <fingerprint>` refuses unless it still matches.
 *
 * The fingerprint covers the branch, HEAD, the porcelain status, **and the tree
 * that would be committed** — the last one is what binds the approval to file
 * *contents* rather than to a list of names. `git status --porcelain=v2` reports
 * each path's HEAD and index object ids but never the working tree's, so an
 * ordinary edit between `--plan` and `--confirm` leaves every status field
 * identical. Without the tree, "the user approved these three files" would
 * silently authorise whatever those three files happen to contain at commit
 * time. The tree is computed by git itself in the private index, so symlinks,
 * deletions, renames, filters, large files and non-ASCII names are all handled
 * exactly as the commit would handle them, and no file is read into this process.
 *
 * Computing it writes blobs and trees into `.git/objects` — content-addressed,
 * unreferenced, and collected by `git gc`. `--plan` changes no ref, no index and
 * no working-tree file.
 *
 * ## Two locks
 *
 * The repository-wide lock (lock-core.js) excludes other sessions of this skill,
 * merge-reviewed.js in particular. It says nothing to an ordinary `git add` in a
 * terminal, so git's own `index.lock` is held as well — from before the index is
 * observed until the new one is published. Copying the index and publishing it
 * later without that would silently discard anything staged in between.
 *
 * Usage:
 *   node commit-shared-wip.js [--plan]                  対象と fingerprint を表示（HEAD・index・作業ファイルは不変）
 *   node commit-shared-wip.js --confirm <fingerprint> [--message <message>]
 *   node commit-shared-wip.js --undo <commit>           直後のWIPコミットだけを取り消す
 *
 * Output (stdout):
 *   PLAN <fingerprint> …… 続けて対象一覧
 *   COMMITTED_WIP <sha> <branch> files=<count>
 *   UNDONE <branch> <sha>
 *   NO_CHANGES
 */

const { createHash } = require('node:crypto');
const { join } = require('node:path');

const {
  gitWithIndex,
  signsCommits,
  withIndexLock,
  withPrivateIndex,
  writeTree,
} = require('./index-core.js');
const { withLock } = require('./lock-core.js');
const { STATE_DIR, ensureStateDir, stateKey } = require('./state-core.js');
const {
  OPT_OUT_FILE,
  commonGitDir,
  currentBranch,
  git,
  gitDir,
  headsRef,
  inProgressOperation,
  isEnabled,
  isOptedOut,
  mainRoot,
  toPosix,
} = require('./worktree-core.js');

const DEFAULT_MESSAGE = 'WIP: codex-review worktree分離前の未コミット変更';

/** Matches merge-reviewed.js: long enough to queue behind a merge, short enough to surface a stuck holder. */
const LOCK_TIMEOUT_MS = 60 * 1000;

const SELF = __filename.replace(/\\/g, '/');

function die(message) {
  process.stderr.write(`codex-review: ${message}\n`);
  process.exit(1);
}

function parseArgs(args) {
  let mode = 'plan';
  let fingerprint = null;
  let message = null;
  let undo = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--plan') {
      if (mode !== 'plan') throw new Error('--plan と他のモードは同時に指定できません');
      continue;
    }
    if (arg === '--confirm' || arg === '--message' || arg === '--undo') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg}には値が必要です`);
      if (arg === '--confirm') {
        if (mode === 'undo') throw new Error('--confirm と --undo は同時に指定できません');
        mode = 'commit';
        fingerprint = value;
      } else if (arg === '--undo') {
        if (mode === 'commit') throw new Error('--confirm と --undo は同時に指定できません');
        mode = 'undo';
        undo = value;
      } else {
        message = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`未対応のオプションです: ${arg}`);
  }

  if (mode === 'commit' && !/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new Error(
      '--confirm には --plan が表示した16桁のfingerprintを指定してください。'
        + `対象を確認するには: node "${SELF}" --plan`,
    );
  }
  if (mode === 'undo' && !/^[0-9a-f]{7,64}$/.test(undo)) {
    throw new Error('--undo には取り消すWIPコミットのhashを指定してください');
  }
  if (message !== null && message.trim() === '') throw new Error('--messageが空です');
  if (mode !== 'commit' && message !== null) {
    throw new Error('--message は --confirm と一緒にだけ指定できます');
  }

  return { mode, fingerprint, undo, message: message ?? DEFAULT_MESSAGE };
}

function gitOutput(error) {
  return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
}

/** The commit HEAD points at, or null on an unborn branch. */
function headCommit(root) {
  try {
    return git(['rev-parse', '--verify', 'HEAD^{commit}'], root).trim();
  } catch (error) {
    if (error.status === 128) return null;
    throw error;
  }
}

/**
 * What this commit would contain, and what it deliberately leaves behind.
 *
 * Reads `--porcelain=v2 -z`, not v1: only v2 states each path's HEAD mode, and
 * that is what separates a real staged addition (`A`, the user staged it) from
 * an intent-to-add marker (`.A` with HEAD mode `000000`, the user did not).
 * v1 renders both in ways that need guessing.
 */
function survey(root) {
  const raw = git(
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=no'],
    root,
  );
  const fields = raw.split('\0');
  const include = [];
  const intentToAdd = [];
  const unmerged = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    const kind = record[0];

    if (kind === '1' || kind === '2') {
      const parts = record.split(' ');
      const xy = parts[1];
      const headMode = parts[3];
      // `1 XY sub mH mI mW hH hI <path>` — the path starts at field 8, and a
      // rename record carries one extra field (`<X><score>`) before it. Its
      // original path arrives as the next NUL-separated field, so it must be
      // consumed here or it would be read as a record of its own.
      const offset = kind === '2' ? 9 : 8;
      const path = parts.slice(offset).join(' ');
      const original = kind === '2' ? fields[index + 1] : null;
      if (kind === '2') index += 1;

      // Intent-to-add: declared, never staged. Its bytes are untracked content,
      // and untracked content stays in the shared checkout by design.
      if (headMode === '000000' && xy[0] === '.') {
        intentToAdd.push(path);
        continue;
      }
      include.push({ xy, path, original });
      continue;
    }

    if (kind === 'u') {
      unmerged.push(record.split(' ').slice(10).join(' '));
      continue;
    }
    // '?' / '!' cannot appear with --untracked-files=no, and anything else is
    // a format this parser does not understand.
    if (kind !== '?' && kind !== '!') {
      throw new Error(`git status --porcelain=v2 の出力を解釈できません: ${JSON.stringify(record)}`);
    }
  }

  return { raw, include, intentToAdd, unmerged };
}

/**
 * Binds the approval to the exact commit it was given for: the branch, the
 * commit it sits on, the reported change set, and `tree` — the content those
 * changes would actually commit.
 *
 * The tree is not decoration. Status output carries HEAD and index object ids
 * but no working-tree id, so editing an already-listed file changes nothing a
 * status-only fingerprint can see, and the approval would carry over to content
 * nobody looked at.
 */
function fingerprintOf(branch, head, tree, raw) {
  return createHash('sha256')
    .update(`${branch}\0${head}\0${tree}\0`)
    .update(raw)
    .digest('hex')
    .slice(0, 16);
}

function describe(entry) {
  return entry.original ? `${entry.xy} ${entry.original} -> ${entry.path}` : `${entry.xy} ${entry.path}`;
}

/**
 * Stages the surveyed changes into a private index and returns the resulting
 * tree — the exact content a commit would carry.
 *
 * `add -u` and nothing else: it updates only paths that already exist in the
 * index, so untracked files cannot be swept in, and the *contents* of an
 * intent-to-add path are left alone (`write-tree` drops i-t-a entries outright).
 * Paths are named one by one rather than left to default to the whole tree,
 * because a bare `git add -u` *would* stage intent-to-add content (verified).
 *
 * Only the current path of a rename is named. Status reports a rename record at
 * all only once it is staged, which means the original is already recorded as a
 * deletion in the index this copy came from — and naming it here would make git
 * fail the whole command with "pathspec did not match any files", since the
 * original exists in neither the index nor the working tree (verified).
 */
function stagedTree(shared, indexFile, include) {
  const paths = include.map((entry) => entry.path);
  gitWithIndex(['add', '-u', '--', ...paths], shared, indexFile);
  return writeTree(shared, indexFile);
}

/** Everything the plan and the commit both need, with the shared preconditions checked. */
function inspect(shared) {
  const blocked = inProgressOperation(shared);
  if (blocked) {
    throw new Error(`共有チェックアウトで${blocked}が進行中のためコミットしません。先に解消してください`);
  }

  // Before currentBranch(): `rev-parse --abbrev-ref HEAD` does not resolve on an
  // unborn branch, so asking for the branch first would report git's raw
  // "ambiguous argument 'HEAD'" instead of the situation the caller is in.
  const head = headCommit(shared);
  if (!head) {
    throw new Error(
      'このリポジトリにはまだコミットがありません。最初のコミットは利用者が内容を確認して作成してください',
    );
  }

  const branch = currentBranch(shared);
  if (!branch) {
    throw new Error(
      '共有チェックアウトがdetached HEADのためコミットしません。'
        + 'ブランチをcheckoutしてから実行してください（worktreeの統合先もブランチである必要があります）',
    );
  }

  const found = survey(shared);
  if (found.unmerged.length) {
    throw new Error(`未解決の衝突が残っているためコミットしません:\n${found.unmerged.join('\n')}`);
  }

  return { head, branch, ...found };
}

function plan(shared, dir) {
  const found = inspect(shared);

  if (found.include.length === 0) {
    process.stdout.write('NO_CHANGES\n');
    if (found.intentToAdd.length) {
      process.stdout.write(
        `NOTE: intent-to-add（git add -N）のエントリだけが残っています。未追跡と同じ扱いのため`
          + `コミットしません:\n${found.intentToAdd.map((path) => `  ${path}`).join('\n')}\n`,
      );
    }
    return 0;
  }

  // Read-only where it matters: this stages into a private copy of the index and
  // leaves refs, the real index and every working-tree file untouched. The blobs
  // and trees it writes are unreferenced objects that `git gc` collects.
  const fingerprint = withPrivateIndex(dir, 'wip-plan', (indexFile) =>
    fingerprintOf(found.branch, found.head, stagedTree(shared, indexFile, found.include), found.raw));

  process.stdout.write(`PLAN ${fingerprint}\n`);
  process.stdout.write(`branch: ${found.branch}\n`);
  process.stdout.write(`HEAD:   ${found.head}\n`);
  // Never truncated: an approval that hides its 21st entry is not an approval.
  process.stdout.write(`コミット対象 (${found.include.length}件):\n`);
  for (const entry of found.include) process.stdout.write(`  ${describe(entry)}\n`);

  if (found.intentToAdd.length) {
    process.stdout.write(
      `コミットしないもの (${found.intentToAdd.length}件・intent-to-add。未追跡と同じ扱い):\n`
        + `${found.intentToAdd.map((path) => `  ${path}`).join('\n')}\n`
        + '  → 残っている間はworktree分離もできません。`git rm --cached <path>` で解除するか、'
        + '利用者が内容を確認してコミットしてください\n',
    );
  }

  process.stdout.write(`実行するには: node "${SELF}" --confirm ${fingerprint}\n`);
  return 0;
}

/**
 * The commit itself, with git's `index.lock` already held by the caller.
 *
 * Everything is observed *after* the lock is taken. Reading the status, copying
 * the index and publishing the result is a read-modify-write against a file
 * shared by every git process in the repository, and observing it before the
 * lock would mean overwriting whatever landed in between — a `git add` from a
 * terminal, silently reverted to untracked.
 */
function commitUnderLocks(shared, dir, expected, message, publish) {
  const found = inspect(shared);

  if (found.include.length === 0) {
    process.stdout.write('NO_CHANGES\n');
    return 0;
  }

  let moved = null;
  try {
    return withPrivateIndex(dir, 'wip', (indexFile) => {
      const tree = stagedTree(shared, indexFile, found.include);
      const fingerprint = fingerprintOf(found.branch, found.head, tree, found.raw);
      if (fingerprint !== expected) {
        throw new Error(
          '確認された内容から対象が変わっているためコミットしません（ファイルの中身が変わった場合も含みます）。'
            + `\n  確認時: ${expected}\n  現在:   ${fingerprint}\n`
            + `もう一度 node "${SELF}" --plan で対象を確認し、ユーザーの合意を取り直してください`,
        );
      }

      if (tree === git(['rev-parse', `${found.head}^{tree}`], shared).trim()) {
        process.stdout.write('NO_CHANGES\n');
        return 0;
      }

      const args = ['commit-tree', tree, '-p', found.head];
      if (signsCommits(shared, git)) args.push('-S');
      args.push('-m', message);

      // No `git commit`, therefore no commit hooks: the committed tree is
      // exactly the tree computed above, and nothing can add an untracked file
      // to it. `update-ref` may still run a reference-transaction hook.
      const commit = git(args, shared).trim();

      // Compare-and-swap: if anything moved the branch while this ran, the ref is
      // not updated and nothing at all has changed.
      git(
        ['update-ref', '-m', `codex-review: ${message}`, headsRef(found.branch), commit, found.head],
        shared,
      );
      moved = commit;

      // Verify while publication is still reversible. A reference-transaction
      // hook can run inside update-ref and move HEAD even though commit hooks do
      // not run; if that happened, roll the ref back while the real index still
      // has its exact original bytes.
      const after = headCommit(shared);
      if (after !== commit || currentBranch(shared) !== found.branch) {
        throw new Error('ref更新後のHEADまたはブランチが想定と一致しないため、indexを公開しません');
      }

      // Publication is the commit point and deliberately the last fallible state
      // mutation. Once it succeeds, never roll the ref back on its own: doing so
      // would leave the new index paired with the old HEAD and destroy the
      // user's staged/unstaged distinction.
      publish(indexFile);
      moved = null;

      process.stdout.write(`COMMITTED_WIP ${commit} ${found.branch} files=${found.include.length}\n`);
      process.stdout.write(`UNDO: node "${SELF}" --undo ${commit}\n`);
      if (found.intentToAdd.length) {
        process.stdout.write(
          `NOTE: intent-to-add のエントリは含めていません。残っている間はworktree分離ができません:\n`
            + `${found.intentToAdd.map((path) => `  ${path}`).join('\n')}\n`,
        );
      }
      return 0;
    });
  } catch (error) {
    if (moved) {
      // The ref moved but the index could not be published. Put the branch back
      // rather than leave a commit whose index says it never happened.
      try {
        git(
          ['update-ref', '-m', 'codex-review: rollback WIP commit', headsRef(found.branch), found.head, moved],
          shared,
        );
      } catch (rollbackError) {
        throw new Error(
          `WIPコミットの取り消しに失敗しました。手動で確認してください（${found.branch} が ${moved} を指しています）:\n`
            + `${gitOutput(error) || error.message}\n${gitOutput(rollbackError)}`,
        );
      }
    }
    throw new Error(gitOutput(error) || error.message);
  }
}

/**
 * Undoes a WIP commit, but only while it is still the tip.
 *
 * The obvious `git reset --soft <old>` is wrong as printed advice: run it after
 * another commit lands and it drops that commit off the branch too. This checks
 * the tip and uses a compare-and-swap update, so a branch that moved on is left
 * alone rather than rewritten.
 */
function undoUnderLock(shared, target) {
  const blocked = inProgressOperation(shared);
  if (blocked) {
    throw new Error(`共有チェックアウトで${blocked}が進行中のため取り消しません。先に解消してください`);
  }

  const branch = currentBranch(shared);
  if (!branch) throw new Error('共有チェックアウトがdetached HEADのため取り消しません');

  let commit;
  try {
    commit = git(['rev-parse', '--verify', `${target}^{commit}`], shared).trim();
  } catch {
    throw new Error(`取り消し対象のコミットが見つかりません: ${target}`);
  }

  const head = headCommit(shared);
  if (head !== commit) {
    throw new Error(
      `取り消し対象は ${branch} の先端ではないため、何も変更しませんでした。\n`
        + `  先端: ${head}\n  対象: ${commit}\n`
        + '後から積まれたコミットまでブランチから外さないため、ここでは取り消しません。'
        + '内容を確認して手動で対応してください',
    );
  }

  const parents = git(['rev-list', '--parents', '-n', '1', commit], shared).trim().split(/\s+/).slice(1);
  if (parents.length !== 1) {
    throw new Error(`取り消せるのは親が1つのコミットだけです（親 ${parents.length} 個）: ${commit}`);
  }

  // Ref only: the index and the working tree keep the committed content, which
  // reappears as staged changes — the same end state as `reset --soft`.
  git(
    ['update-ref', '-m', 'codex-review: undo WIP commit', headsRef(branch), parents[0], commit],
    shared,
  );

  process.stdout.write(`UNDONE ${branch} ${parents[0]}\n`);
  process.stdout.write('（取り消した内容はステージ済みの変更として残っています）\n');
  return 0;
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const shared = mainRoot(cwd);

  if (!isEnabled(shared)) {
    throw new Error(
      'このリポジトリではcodex-reviewの自動レビューが有効ではないため、共有チェックアウトへコミットしません',
    );
  }
  if (isOptedOut(shared)) {
    throw new Error(
      `${toPosix(join(shared, OPT_OUT_FILE))} があるためworktree分離は行われません。`
        + 'このコミットは不要です（通常どおり作業してください）',
    );
  }

  const dir = gitDir(shared);

  // Read-only, so it needs no lock: the fingerprint is what makes the plan
  // meaningful later, not the instant it was taken.
  if (input.mode === 'plan') return plan(shared, dir);

  ensureStateDir();
  const lock = join(STATE_DIR, `${stateKey(commonGitDir(cwd))}.merge.lock`);
  return withLock(
    lock,
    () => {
      // `--undo` moves a ref and nothing else, so it never publishes an index and
      // has no reason to lock one.
      if (input.mode === 'undo') return undoUnderLock(shared, input.undo);
      return withIndexLock(dir, ({ publish }) =>
        commitUnderLocks(shared, dir, input.fingerprint, input.message, publish));
    },
    {
      label: `共有チェックアウト（${shared}）の更新ロック`,
      timeoutMs: LOCK_TIMEOUT_MS,
    },
  );
}

try {
  process.exitCode = main();
} catch (error) {
  die(error.stderr?.trim() || error.message);
}
