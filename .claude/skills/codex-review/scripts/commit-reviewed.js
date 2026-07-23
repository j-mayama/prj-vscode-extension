#!/usr/bin/env node
'use strict';

/**
 * Commits the complete reviewed worktree after verifying that it still matches
 * the fingerprint captured for the final Codex review. `--all` is the normal
 * isolated-session path: every tracked or untracked change produced in the
 * dedicated worktree is included, so generated files cannot be left behind.
 *
 * ## Why this never runs `git commit`
 *
 * The fingerprint proves that the tree Codex read is the tree that exists right
 * now. `git commit` then runs `pre-commit`, and a pre-commit hook may reformat a
 * file and `git add` it, or stage something untracked entirely — after the
 * verification, before the tree is written. The commit would contain content no
 * reviewer ever saw, and checking afterwards could only report it.
 *
 * So the commit is assembled instead: stage into a private index, `write-tree`,
 * `commit-tree`, and a compare-and-swap `update-ref`. The tree that is committed
 * is byte-for-byte the tree that was verified, no commit hook runs, and every
 * failure before publication leaves HEAD, the real index and the working tree
 * untouched — the real index is not written until the commit already exists.
 * (`update-ref` may invoke a `reference-transaction` hook, but it cannot change
 * the already-built commit tree.)
 *
 * A merge left in progress by merge-reviewed.js (`REVIEW_REQUIRED`) is committed
 * as a real merge commit: MERGE_HEAD supplies the second parent, exactly as
 * `git commit` would have, and the merge state files are cleared afterwards.
 *
 * Usage:
 *   node commit-reviewed.js --expected <fingerprint> --message <message> --all
 *   node commit-reviewed.js --expected <fingerprint> --message <message> -- <file>...
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

const {
  MAX_BUFFER,
  gitWithIndex,
  signsCommits,
  withIndexLock,
  withPrivateIndex,
  writeTree,
} = require('./index-core.js');
const { currentBranch, gitDir, headsRef, isLinkedWorktree } = require('./worktree-core.js');

function git(args, cwd, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function die(message) {
  process.stderr.write(`codex-review: ${message}\n`);
  process.exit(1);
}

function gitOutput(error) {
  return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
}

function parseArgs(args) {
  const separator = args.indexOf('--');
  const allIndex = args.indexOf('--all');
  if (separator === -1 && allIndex === -1) {
    throw new Error('--all、またはファイル一覧の前に -- を指定してください');
  }
  if (separator !== -1 && allIndex !== -1) {
    throw new Error('--all と個別ファイル一覧は同時に指定できません');
  }
  const boundary = separator === -1 ? args.length : separator;
  const options = args.slice(0, boundary).filter((arg) => arg !== '--all');
  const files = separator === -1 ? [] : args.slice(separator + 1);
  let expected = null;
  let message = null;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--expected' || option === '--message') {
      const value = options[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${option}には値が必要です`);
      if (option === '--expected') expected = value;
      else message = value;
      index += 1;
      continue;
    }
    throw new Error(`未対応のオプションです: ${option}`);
  }
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('--expectedには最終レビューの64桁fingerprintを指定してください');
  }
  if (!message || message.trim() === '') throw new Error('--messageを指定してください');
  const all = allIndex !== -1;
  if (!all && files.length === 0) throw new Error('コミット対象ファイルを1件以上指定してください');
  return { expected, message, files, all };
}

function nulPaths(output) {
  return output.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
}

function changedFiles(root, head) {
  // Without a commit there is nothing to diff against, and every staged path is
  // itself a change. `ls-files --cached` covers them; `diff HEAD` would just fail.
  const tracked = head
    ? nulPaths(git(['diff', '--name-only', '--no-renames', '-z', head], root))
    : nulPaths(git(['ls-files', '--cached', '-z'], root));
  const untracked = nulPaths(git(['ls-files', '--others', '--exclude-standard', '-z'], root));
  return [...new Set([...tracked, ...untracked])].sort();
}

function normalizeFiles(root, files) {
  const seen = new Set();
  const normalized = [];
  for (const input of files) {
    if (!input || isAbsolute(input)) throw new Error(`相対ファイルパスを指定してください: ${input}`);
    const absolute = resolve(root, input);
    const rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error(`リポジトリ直下のファイルを指定してください: ${input}`);
    }
    const path = rel.replace(/\\/g, '/');
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(path);
  }
  return normalized;
}

function fileSnapshot(root, files) {
  const snapshot = {};
  for (const file of files) {
    const absolute = resolve(root, file);
    try {
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        throw new Error(`ディレクトリではなく個別ファイルを指定してください: ${file}`);
      }
      const hash = createHash('sha256');
      if (stat.isSymbolicLink()) hash.update(`symlink:${readlinkSync(absolute)}`);
      else if (stat.isFile()) hash.update(readFileSync(absolute));
      else throw new Error(`通常ファイルまたはsymlinkではありません: ${file}`);
      snapshot[file] = hash.digest('hex');
    } catch (error) {
      if (error.code === 'ENOENT') snapshot[file] = null;
      else throw error;
    }
  }
  return snapshot;
}

function reviewedFingerprint(root) {
  const hook = resolve(__dirname, 'stop-hook.js');
  return execFileSync(process.execPath, [hook, '--print'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  }).trim();
}

function stagedFiles(root) {
  const output = git(['diff', '--cached', '--name-only', '-z'], root);
  return output.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
}

function outsideAllowed(paths, allowed) {
  return paths.filter((path) =>
    !allowed.has(process.platform === 'win32' ? path.toLowerCase() : path));
}

function unexpectedStaged(root, allowed) {
  return outsideAllowed(stagedFiles(root), allowed);
}

/** Paths whose conflict is still unresolved. Committing these would commit the markers. */
function unmergedPaths(root) {
  return nulPaths(git(['diff', '--name-only', '--diff-filter=U', '-z'], root));
}

/**
 * The commits an in-flight merge is pulling in. They become the extra parents,
 * because `git commit` is not there to add them and a merge recorded as a
 * single-parent commit loses the other side's history.
 */
function mergeParents(dir) {
  try {
    return readFileSync(join(dir, 'MERGE_HEAD'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * State files `git commit` clears once a merge is recorded. Left behind, the
 * next commit in this worktree would be turned into a second merge of the same
 * side.
 */
const MERGE_STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'SQUASH_MSG', 'AUTO_MERGE'];

/**
 * Sequencer operations this script refuses rather than emulates. `git commit`
 * advances their state machines (`.git/sequencer`, `rebase-merge/`), and a
 * hand-built commit would leave them describing a step that never happened.
 */
const SEQUENCER_FILES = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

function clearMergeState(dir) {
  const failed = [];
  for (const name of MERGE_STATE_FILES) {
    try {
      unlinkSync(join(dir, name));
    } catch (error) {
      if (error.code !== 'ENOENT') failed.push(`${name}: ${error.message}`);
    }
  }
  return failed;
}

/**
 * The merge command, printed next to every outcome inside a worktree.
 *
 * A commit in a linked worktree is invisible from everywhere else, so the merge
 * is not an optional follow-up — it is the second half of delivering the work.
 * Naming it here puts the next step in front of the caller at the one moment it
 * is certain to be read, rather than several hundred lines into a document.
 * stop-hook.js catches it if it is skipped anyway.
 */
function announceNextStep(root) {
  if (!isLinkedWorktree(root)) return;
  const merge = resolve(__dirname, 'merge-reviewed.js').replace(/\\/g, '/');
  process.stdout.write(`NEXT: node "${merge}"   # 元のブランチへmergeするまでがStep 7\n`);
}

/**
 * Everything from here on runs while this process holds `index.lock`, so no
 * other git process can stage anything between the fingerprint check and the
 * commit. The real index is written exactly once, by `publish`, after the commit
 * object already exists.
 */
function commitUnderIndexLock(root, dir, input, publish) {
  const blocked = SEQUENCER_FILES.find((name) => existsSync(join(dir, name)));
  if (blocked) {
    throw new Error(
      `${blocked} が残っている（cherry-pick / revert / rebase が進行中の）ためコミットしません。`
        + '先にそのgit操作を完了または中止してください',
    );
  }

  const branch = currentBranch(root);
  if (!branch) {
    throw new Error('detached HEADのためコミットしません。ブランチをcheckoutしてから再実行してください');
  }

  const unmerged = unmergedPaths(root);
  if (unmerged.length > 0) {
    throw new Error(
      '未解決の衝突が残っているためコミットしません。内容を解消したうえで '
        + '`git add -- <path>` で解決済みにしてから再実行してください:\n'
        + unmerged.join('\n'),
    );
  }

  let head = null;
  try {
    head = git(['rev-parse', '--verify', 'HEAD^{commit}'], root).trim();
  } catch (error) {
    // Exit 128 is an unborn branch: no commit to parent, and no old value to
    // compare-and-swap against.
    if (error.status !== 128) throw error;
  }

  const files = normalizeFiles(root, input.all ? changedFiles(root, head) : input.files);
  const parents = mergeParents(dir);
  if (head) parents.unshift(head);

  if (files.length === 0 && parents.length < 2) {
    process.stdout.write('NO_CHANGES\n');
    announceNextStep(root);
    return 0;
  }

  const allowed = new Set(files.map((path) =>
    process.platform === 'win32' ? path.toLowerCase() : path));
  const before = fileSnapshot(root, files);
  if (reviewedFingerprint(root) !== input.expected) {
    throw new Error('最終レビュー後に作業ツリーが変わっているためコミットしません');
  }
  const existingUnexpected = unexpectedStaged(root, allowed);
  if (existingUnexpected.length > 0) {
    throw new Error(`レビュー対象外のステージ済みファイルがあるためコミットしません: ${existingUnexpected.join(', ')}`);
  }

  return withPrivateIndex(dir, 'reviewed', (indexFile) => {
    // --all intentionally owns every visible change in this isolated worktree.
    // Staging the whole tree also handles an already-staged rename: its deleted
    // source no longer exists as a pathspec, so spelling every changed path after
    // `--` would make git add fail before it can stage the reviewed rename.
    if (input.all) gitWithIndex(['add', '-A', '--'], root, indexFile);
    else gitWithIndex(['add', '-A', '--', ...files], root, indexFile);

    const after = fileSnapshot(root, files);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('ステージ中にコミット対象が変わったためコミットしません');
    }

    // The staged set is checked against the reviewed set here, not against the
    // real index: this is the content the commit will actually carry.
    const staged = head
      ? nulPaths(gitWithIndex(
        ['diff-index', '--cached', '--name-only', '--no-renames', '-z', head],
        root,
        indexFile,
      ))
      : nulPaths(gitWithIndex(['ls-files', '--cached', '-z'], root, indexFile));
    const unexpected = outsideAllowed(staged, allowed);
    if (unexpected.length > 0) {
      throw new Error(`レビュー対象外のファイルがコミットに入るためコミットしません: ${unexpected.join(', ')}`);
    }

    const tree = writeTree(root, indexFile);
    const headTree = head ? git(['rev-parse', `${head}^{tree}`], root).trim() : null;
    // A merge must be recorded even when it changed nothing, or MERGE_HEAD stays
    // behind and the next commit re-merges. Otherwise an identical tree means
    // there is nothing to commit.
    if (tree === headTree && parents.length < 2) {
      process.stdout.write('NO_CHANGES\n');
      announceNextStep(root);
      return 0;
    }

    const args = ['commit-tree', tree];
    for (const parent of parents) args.push('-p', parent);
    if (signsCommits(root, git)) args.push('-S');
    args.push('-m', input.message);

    // No `git commit`, therefore no commit hooks: the committed tree is exactly
    // the tree verified above, and nothing can add an unreviewed file to it.
    // `update-ref` may still run a reference-transaction hook.
    const commit = git(args, root).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new Error(`git commit-tree が不正なコミットを返しました: ${JSON.stringify(commit)}`);
    }

    // Compare-and-swap: if anything moved the branch while this ran, the ref is
    // not updated and nothing at all has changed.
    git(
      ['update-ref', '-m', `codex-review: ${input.message}`, headsRef(branch), commit, head ?? ''],
      root,
    );

    try {
      // `update-ref` may run a reference-transaction hook. Verify its outcome
      // before the real index is published, while a rollback can still preserve
      // the user's exact staged/unstaged state.
      if (git(['rev-parse', 'HEAD'], root).trim() !== commit || currentBranch(root) !== branch) {
        throw new Error('ref更新後のHEADまたはブランチが想定と一致しません');
      }

      // Publication is the commit point. No ref-only rollback is allowed after
      // this succeeds because that would pair the old HEAD with the new index.
      publish(indexFile);
    } catch (error) {
      // Validation or publication failed while the real index was still
      // untouched. Put the branch back. A branch that did not exist before is
      // deleted rather than reset — with no old commit there is nothing to
      // point it at.
      try {
        git(
          head
            ? ['update-ref', '-m', 'codex-review: rollback reviewed commit', headsRef(branch), head, commit]
            : ['update-ref', '-d', headsRef(branch), commit],
          root,
        );
      } catch (rollbackError) {
        throw new Error(
          `コミットの取り消しに失敗しました。手動で確認してください（${branch} が ${commit} を指しています）:\n`
            + `${gitOutput(error) || error.message}\n${gitOutput(rollbackError)}`,
        );
      }
      throw new Error(`indexの公開前に検証または更新が失敗し、コミットを取り消しました:\n${gitOutput(error) || error.message}`);
    }

    const cleared = clearMergeState(dir);
    if (cleared.length > 0) {
      throw new Error(
        `コミット ${commit} は作成しましたが、merge状態ファイルを消せませんでした。`
          + `手動で削除してください:\n${cleared.join('\n')}`,
      );
    }

    if (input.all) {
      const remaining = changedFiles(root, commit);
      if (remaining.length > 0) {
        throw new Error(
          `コミット ${commit} を作成しましたが、専用worktreeに未コミットファイルが残っています: ${remaining.join(', ')}`,
        );
      }
    }

    process.stdout.write(`COMMITTED ${commit}\n`);
    announceNextStep(root);
    return 0;
  });
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  if (input.all && !isLinkedWorktree(root)) {
    throw new Error('--all はセッション専用worktree内でだけ使用できます');
  }
  const dir = gitDir(root);
  return withIndexLock(dir, ({ publish }) => commitUnderIndexLock(root, dir, input, publish));
}

try {
  process.exitCode = main();
} catch (error) {
  die(error.stderr?.trim() || error.message);
}
