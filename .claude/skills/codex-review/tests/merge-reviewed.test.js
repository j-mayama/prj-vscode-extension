#!/usr/bin/env node
'use strict';

/**
 * merge-reviewed.js を中心とした、worktree分離フロー全体の自動テスト。
 *
 *   node --test .claude/skills/codex-review/tests/
 *
 * すべて一時ディレクトリの隔離gitリポジトリで実行する。ホームディレクトリも
 * 一時ディレクトリへ差し替えるため（`HOME` / `USERPROFILE`）、利用者の
 * `~/.claude/codex-review-state/` と実際のgit設定には触れない。
 *
 * 検証は終了コードだけで行わない。実行前後のHEAD・`git status`・sentinelファイルの
 * 内容を比較し、「失敗したときに何も壊していないこと」まで確認する。
 *
 * 一時ディレクトリ名には**意図的に空白を含める**。gitの引数をシェル経由で
 * 組み立てていれば、ここで壊れる。
 */


const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const { withLock } = require('../scripts/lock-core.js');
const { worktreeName } = require('../scripts/worktree-core.js');
const { checkOutFile } = require('../scripts/run-review.js');
const {
  COMMIT_REVIEWED,
  DOCTOR,
  MERGE_REVIEWED,
  SCRIPTS,
  SETUP_AUTO,
  STOP_HOOK,
  WORKTREE_GUARD,
  addWorktree,
  commitIn,
  fixture,
  gitOperationFile,
  isAncestor,
  markPrompt,
  mergeReviewed,
  recordedTarget,
  reviewedCommitAll,
  run,
  runAsync,
  shaOf,
  sleep,
  state,
  tryRun,
} = require('./helpers.js');

// ---------------------------------------------------------------------------
// 1. fast-forward merge
// ---------------------------------------------------------------------------

test('fast-forwardできる場合はmergeコミットを作らずに統合する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-ff');

  assert.equal(recordedTarget(fx, wt.name), 'main', 'worktree作成時に統合先が記録されている');

  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `MERGED main ${head} fast-forward`);
  assert.equal(shaOf(fx, 'refs/heads/main'), head, 'mainがworktreeのHEADへ進んでいる');
  assert.equal(readFileSync(join(fx.shared, 'feature.txt'), 'utf8'), 'feature\n', '共有側の作業ツリーにも反映される');
  assert.equal(state(fx).status, '', '共有チェックアウトはcleanのまま');
});

// ---------------------------------------------------------------------------
// 2. 分岐後のmerge commit
// ---------------------------------------------------------------------------

test('分岐している場合はmergeコミットを作って統合する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-diverged');

  const theirs = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  const ours = commitIn(fx, fx.shared, 'other.txt', 'other\n', 'add other');

  const result = mergeReviewed(fx, wt.path);
  assert.equal(result.code, 0, result.stderr);

  const [, branch, sha, kind] = result.stdout.trim().split(' ');
  assert.equal(branch, 'main');
  assert.equal(kind, 'merge-commit');
  assert.notEqual(sha, theirs);
  assert.ok(isAncestor(fx, theirs, sha), 'worktreeのコミットがmainに入っている');
  assert.ok(isAncestor(fx, ours, sha), '共有側のコミットも残っている');
  assert.equal(readFileSync(join(fx.shared, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(readFileSync(join(fx.shared, 'other.txt'), 'utf8'), 'other\n');

  // gitへは refs/heads/<name> で渡すが、履歴には `refs/heads/` を漏らさない。
  assert.equal(
    fx.git(['log', '-1', '--pretty=%s']).trim(),
    `Merge branch '${wt.branch}'`,
    'mergeコミットのメッセージがgitの慣習どおり',
  );
});

// ---------------------------------------------------------------------------
// 3. 同じコマンドの2回実行（冪等性）
// ---------------------------------------------------------------------------

test('2回実行しても2回目はUP_TO_DATEでHEADを動かさない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-twice');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const first = mergeReviewed(fx, wt.path);
  assert.equal(first.code, 0, first.stderr);
  const after = state(fx);

  const second = mergeReviewed(fx, wt.path);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim(), 'UP_TO_DATE main');
  assert.deepEqual(state(fx), after, '2回目はHEAD・statusとも変化しない');
});

// ---------------------------------------------------------------------------
// 4. 共有側に未コミットの追跡変更がある場合、sentinelが不変
// ---------------------------------------------------------------------------

test('共有側に未コミットの追跡変更があるとmergeせず、sentinelを書き換えない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-dirty');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  writeFileSync(join(fx.shared, 'sentinel.txt'), 'sentinel-uncommitted-edit\n');
  const before = state(fx);
  const sentinelBefore = readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8');

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /未コミット変更があるためmergeしません/);
  assert.equal(readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'), sentinelBefore, 'sentinelの内容が不変');
  assert.equal(sentinelBefore, 'sentinel-uncommitted-edit\n');
  assert.deepEqual(state(fx), before, 'HEAD・statusとも実行前と一致');
  assert.ok(!existsSync(join(fx.shared, 'feature.txt')), 'mergeが一切適用されていない');
});

// ---------------------------------------------------------------------------
// 5. 衝突を専用worktreeへ移し、再レビュー・コミット後に再試行する
// ---------------------------------------------------------------------------

test('衝突したら共有側を変えず専用worktreeで解消・再コミットしてmergeを再試行する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-conflict');

  const sourceCommit = commitIn(fx, wt.path, 'shared-file.txt', 'from worktree\n', 'edit in worktree');
  const targetCommit = commitIn(fx, fx.shared, 'shared-file.txt', 'from shared\n', 'edit in shared');

  const before = state(fx);
  const contentBefore = readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8');
  const diffBefore = fx.git(['diff', 'HEAD']);

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `REVIEW_REQUIRED main ${targetCommit} conflicts=1`);
  assert.deepEqual(state(fx), before, 'HEAD・statusとも実行前と一致');
  assert.equal(readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8'), contentBefore, '衝突マーカーが残っていない');
  assert.equal(fx.git(['diff', 'HEAD']), diffBefore, 'indexにも差分が残っていない');
  assert.ok(!existsSync(join(fx.shared, '.git', 'MERGE_HEAD')), 'merge途中の状態が残っていない');
  assert.ok(existsSync(gitOperationFile(fx, wt.path, 'MERGE_HEAD')), '専用worktreeだけがmerge途中になる');
  assert.match(readFileSync(join(wt.path, 'shared-file.txt'), 'utf8'), /<{7}/, '専用worktreeには解消対象がある');

  writeFileSync(join(wt.path, 'shared-file.txt'), 'from shared\nfrom worktree\n');
  fx.git(['add', '--', 'shared-file.txt'], wt.path);
  const committed = reviewedCommitAll(fx, wt.path, 'resolve reviewed integration');
  assert.equal(committed.code, 0, committed.stderr);
  assert.match(committed.stdout, /COMMITTED [0-9a-f]{40,64}/);
  assert.ok(!existsSync(gitOperationFile(fx, wt.path, 'MERGE_HEAD')), 'レビュー済み解消結果をコミットした');

  const retried = mergeReviewed(fx, wt.path);
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(retried.stdout, /^MERGED main [0-9a-f]{40,64} fast-forward\s*$/);
  assert.equal(readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8'), 'from shared\nfrom worktree\n');
  fx.git(['merge-base', '--is-ancestor', sourceCommit, 'main']);
  fx.git(['merge-base', '--is-ancestor', targetCommit, 'main']);
});

test('3セッションが同じ行を変更しても解消・再レビュー・再試行で全コミットを統合する', (t) => {
  const fx = fixture(t);
  const sessions = ['parallel-a', 'parallel-b', 'parallel-c'].map((id) => addWorktree(fx, id));
  const commits = sessions.map((wt, index) =>
    commitIn(fx, wt.path, 'shared-file.txt', `session-${index + 1}\n`, `session ${index + 1}`));

  const first = mergeReviewed(fx, sessions[0].path);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^MERGED main /);

  for (let index = 1; index < sessions.length; index += 1) {
    const prepared = mergeReviewed(fx, sessions[index].path);
    assert.equal(prepared.code, 0, prepared.stderr);
    assert.match(prepared.stdout, /^REVIEW_REQUIRED main [0-9a-f]{40,64} conflicts=1\s*$/);

    const combined = Array.from({ length: index + 1 }, (_, item) => `session-${item + 1}`).join('\n');
    writeFileSync(join(sessions[index].path, 'shared-file.txt'), `${combined}\n`);
    fx.git(['add', '--', 'shared-file.txt'], sessions[index].path);
    const committed = reviewedCommitAll(fx, sessions[index].path, `resolve session ${index + 1} integration`);
    assert.equal(committed.code, 0, committed.stderr);

    const retried = mergeReviewed(fx, sessions[index].path);
    assert.equal(retried.code, 0, retried.stderr);
    assert.match(retried.stdout, /^MERGED main [0-9a-f]{40,64} fast-forward\s*$/);
  }

  assert.equal(readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8'), 'session-1\nsession-2\nsession-3\n');
  for (const commit of commits) fx.git(['merge-base', '--is-ancestor', commit, 'main']);
});

// ---------------------------------------------------------------------------
// 6. merge対象と衝突する未追跡ファイルが保持される
// ---------------------------------------------------------------------------

test('merge先と同じ未追跡ファイルを未コミット内容として保持したまま統合する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-untracked-clash');

  const reviewed = commitIn(fx, wt.path, 'feature.txt', 'from worktree\n', 'add feature');
  writeFileSync(join(fx.shared, 'feature.txt'), 'untracked local work\n');

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `MERGED main ${reviewed} fast-forward preserved-untracked=1`);
  assert.equal(
    readFileSync(join(fx.shared, 'feature.txt'), 'utf8'),
    'untracked local work\n',
    '未追跡ファイルの内容が保持されている',
  );
  assert.equal(fx.git(['show', 'HEAD:feature.txt']), 'from worktree\n', 'mergeコミットにはレビュー済み内容が入る');
  assert.match(state(fx).status, /^ M feature\.txt/m, 'ローカル内容は未コミット変更として残る');
  assert.ok(!existsSync(join(fx.shared, '.git', 'MERGE_HEAD')), 'merge途中の状態が残っていない');
});

// ---------------------------------------------------------------------------
// 7. 衝突しない未追跡ファイルが、成功時にも保持される
// ---------------------------------------------------------------------------

test('mergeが成功しても、無関係な未追跡ファイルは消さない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-untracked-keep');
  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  writeFileSync(join(fx.shared, 'scratch.txt'), 'local scratch\n');

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(shaOf(fx, 'refs/heads/main'), head);
  assert.equal(readFileSync(join(fx.shared, 'scratch.txt'), 'utf8'), 'local scratch\n', '未追跡ファイルが残っている');
});

test('分岐後も同一パスの未追跡内容を保持してmerge commitを作る', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-untracked-diverged');
  const theirs = commitIn(fx, wt.path, 'feature.txt', 'from worktree\n', 'add feature');
  const ours = commitIn(fx, fx.shared, 'other.txt', 'other\n', 'add other');
  writeFileSync(join(fx.shared, 'feature.txt'), 'local draft\n');

  const result = mergeReviewed(fx, wt.path);
  assert.equal(result.code, 0, result.stderr);
  const [, branch, merged, kind, preserved] = result.stdout.trim().split(' ');
  assert.equal(branch, 'main');
  assert.equal(kind, 'merge-commit');
  assert.equal(preserved, 'preserved-untracked=1');
  assert.ok(isAncestor(fx, theirs, merged));
  assert.ok(isAncestor(fx, ours, merged));
  assert.equal(fx.git(['show', `${merged}:feature.txt`]), 'from worktree\n');
  assert.equal(readFileSync(join(fx.shared, 'feature.txt'), 'utf8'), 'local draft\n');
  assert.match(state(fx).status, /^ M feature\.txt/m);
});

// ---------------------------------------------------------------------------
// 8. source / target の detached HEAD
// ---------------------------------------------------------------------------

test('worktreeがdetached HEADならmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-detached-source');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['checkout', '--detach'], wt.path);

  const before = state(fx);
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /worktreeがdetached HEAD/);
  assert.deepEqual(state(fx), before);
});

test('共有チェックアウトがdetached HEADならmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-detached-target');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['checkout', '--detach']);

  const before = state(fx);
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /共有チェックアウトがdetached HEAD/);
  assert.deepEqual(state(fx), before);
});

// ---------------------------------------------------------------------------
// 9. 既存のmerge / rebase等が進行中
// ---------------------------------------------------------------------------

test('共有側でmergeが進行中なら、そのmergeに触らず失敗する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-merge-in-progress');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  // 共有側で人間が衝突したmergeを抱えている状態を作る。
  fx.git(['checkout', '-b', 'other']);
  commitIn(fx, fx.shared, 'shared-file.txt', 'from other\n', 'edit in other');
  fx.git(['checkout', 'main']);
  commitIn(fx, fx.shared, 'shared-file.txt', 'from main\n', 'edit in main');
  const conflicted = tryRun(['git', 'merge', 'other'], { cwd: fx.shared, env: fx.env });
  assert.equal(conflicted.code, 1, '前提: 共有側のmergeが衝突している');
  assert.ok(existsSync(join(fx.shared, '.git', 'MERGE_HEAD')), '前提: MERGE_HEADがある');

  const mergeHeadBefore = readFileSync(join(fx.shared, '.git', 'MERGE_HEAD'), 'utf8');
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /MERGE_HEADが進行中/);
  assert.equal(
    readFileSync(join(fx.shared, '.git', 'MERGE_HEAD'), 'utf8'),
    mergeHeadBefore,
    '他プロセスのmergeをabortしていない',
  );
});

test('共有側でrebaseが進行中なら、mergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-rebase-in-progress');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  fx.git(['checkout', '-b', 'topic']);
  commitIn(fx, fx.shared, 'shared-file.txt', 'from topic\n', 'edit in topic');
  fx.git(['checkout', 'main']);
  commitIn(fx, fx.shared, 'shared-file.txt', 'from main\n', 'edit in main');
  fx.git(['checkout', 'topic']);
  const rebasing = tryRun(['git', 'rebase', 'main'], { cwd: fx.shared, env: fx.env });
  assert.notEqual(rebasing.code, 0, '前提: rebaseが衝突している');

  const result = mergeReviewed(fx, wt.path);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rebase-merge|rebase-apply/, 'rebase進行中として検出する');
});

// ---------------------------------------------------------------------------
// 10. パスに空白、ブランチ名に `/`
// ---------------------------------------------------------------------------

test('統合先のブランチ名に / を含んでいても統合できる', (t) => {
  const fx = fixture(t, { branch: 'feature/deploy-target' });
  const wt = addWorktree(fx, 'session-slash-branch');

  assert.equal(recordedTarget(fx, wt.name), 'feature/deploy-target');
  assert.ok(fx.shared.includes(' '), '前提: パスに空白が含まれている');

  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `MERGED feature/deploy-target ${head} fast-forward`);
  assert.equal(shaOf(fx, 'refs/heads/feature/deploy-target'), head);
});

// ---------------------------------------------------------------------------
// 11. worktree作成後に共有側を別ブランチへ切り替えた場合（P1の再現テスト）
// ---------------------------------------------------------------------------

test('worktree作成後に共有側が別ブランチへ切り替わったら、どちらへもmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-switched');
  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const mainBefore = shaOf(fx, 'refs/heads/main');
  fx.git(['checkout', '-b', 'unrelated-current-branch']);
  const unrelatedBefore = shaOf(fx, 'refs/heads/unrelated-current-branch');

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /統合先は main/);
  assert.equal(shaOf(fx, 'refs/heads/main'), mainBefore, 'mainは変わっていない');
  assert.equal(
    shaOf(fx, 'refs/heads/unrelated-current-branch'),
    unrelatedBefore,
    '現在checkout中の無関係なブランチへmergeしていない',
  );
  assert.ok(!isAncestor(fx, head, unrelatedBefore), 'worktreeのコミットがどちらにも入っていない');
  assert.equal(state(fx).status, '', '共有チェックアウトはcleanのまま');
});

test('セッション再開で共有チェックアウトへ戻っても、統合先の記録を上書きしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-resume');
  assert.equal(recordedTarget(fx, wt.name), 'main', '前提: 作成時にmainが記録されている');
  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  // 利用者が共有チェックアウトを別ブランチへ切り替える。
  fx.git(['checkout', '-b', 'release-v2']);
  const releaseBefore = shaOf(fx, 'refs/heads/release-v2');
  const mainBefore = shaOf(fx, 'refs/heads/main');

  // セッションを再開すると cwd は worktree の *外*（共有チェックアウト）に戻る。
  // mark-prompt.js の EnterWorktree(path:) 経路と worktree-guard.js の
  // 「再開したセッションを既存worktreeへ戻す」分岐は、まさにこの状態のためにある。
  // ここで記録を取り直すと、記録と現在ブランチが揃って書き換わり、
  // merge-reviewed.js の照合をすり抜けて別ブランチへmergeしてしまう。
  markPrompt(fx, 'session-resume');
  assert.equal(recordedTarget(fx, wt.name), 'main', '再開しても記録が上書きされない');

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1, 'release-v2へmergeしない');
  assert.match(result.stderr, /統合先は main/);
  assert.equal(shaOf(fx, 'refs/heads/release-v2'), releaseBefore, 'release-v2は変わっていない');
  assert.equal(shaOf(fx, 'refs/heads/main'), mainBefore, 'mainも変わっていない');
  assert.ok(!isAncestor(fx, head, releaseBefore), 'worktreeのコミットが別ブランチに入っていない');
});

// ---------------------------------------------------------------------------
// 12. 2つのworktreeから同時実行するストレステスト
// ---------------------------------------------------------------------------

test('2つのworktreeから同時にmergeしても共有チェックアウトが壊れない', { timeout: 300000 }, async (t) => {
  const ROUNDS = 20;

  for (let round = 0; round < ROUNDS; round += 1) {
    const fx = fixture(t);
    const first = addWorktree(fx, `session-stress-a-${round}`);
    const second = addWorktree(fx, `session-stress-b-${round}`);

    // 別ファイルを触るので、直列化さえされていれば必ず両方入る。
    const firstHead = commitIn(fx, first.path, 'a.txt', `a-${round}\n`, 'add a');
    const secondHead = commitIn(fx, second.path, 'b.txt', `b-${round}\n`, 'add b');

    const results = await Promise.all([
      runAsync(['node', MERGE_REVIEWED], { cwd: first.path, env: fx.env }),
      runAsync(['node', MERGE_REVIEWED], { cwd: second.path, env: fx.env }),
    ]);

    for (const [index, result] of results.entries()) {
      assert.equal(result.code, 0, `round ${round} / worktree ${index}: ${result.stderr}`);
    }

    const head = shaOf(fx, 'HEAD');
    assert.equal(fx.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main', `round ${round}: HEADがmainのまま`);
    assert.equal(shaOf(fx, 'refs/heads/main'), head, `round ${round}: HEADとmainが一致`);
    assert.equal(fx.git(['status', '--porcelain']), '', `round ${round}: 共有チェックアウトがclean`);
    assert.ok(!existsSync(join(fx.shared, '.git', 'MERGE_HEAD')), `round ${round}: merge途中が残っていない`);
    assert.ok(!existsSync(join(fx.shared, '.git', 'index.lock')), `round ${round}: index.lockが残っていない`);

    // 片方が他方のmergeをabortしていれば、そのコミットは到達不能になる。
    assert.ok(isAncestor(fx, firstHead, head), `round ${round}: 1つ目のmergeが残っている`);
    assert.ok(isAncestor(fx, secondHead, head), `round ${round}: 2つ目のmergeが残っている`);
    assert.equal(readFileSync(join(fx.shared, 'a.txt'), 'utf8'), `a-${round}\n`);
    assert.equal(readFileSync(join(fx.shared, 'b.txt'), 'utf8'), `b-${round}\n`);

    const fsck = tryRun(['git', 'fsck'], { cwd: fx.shared, env: fx.env });
    assert.equal(fsck.code, 0, `round ${round}: git fsck が失敗した: ${fsck.stderr}`);

    assert.ok(!existsSync(fx.lockPath), `round ${round}: mergeロックが解放されている`);
  }
});

// ---------------------------------------------------------------------------
// 13. 異常な記録・欠損した対象ブランチ・非gitディレクトリ
// ---------------------------------------------------------------------------

test('統合先が記録されていないとmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-no-record');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['config', '--local', '--unset-all', `codexreview.${wt.name}.mergeInto`]);

  const before = state(fx);
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /統合先が記録されていない/);
  assert.deepEqual(state(fx), before);
});

test('統合先の記録が不正な値ならmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-bad-record');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  // gitの引数として解釈されうる値、かつブランチ名として不正な値。
  fx.git(['config', '--local', '--replace-all', `codexreview.${wt.name}.mergeInto`, '--upload-pack=touch owned']);

  const before = state(fx);
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /ブランチ名として不正/);
  assert.deepEqual(state(fx), before);
  assert.ok(!existsSync(join(fx.shared, 'owned')), 'オプションとして実行されていない');
});

test('統合先が複数記録されていたらmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-multi-record');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['config', '--local', '--add', `codexreview.${wt.name}.mergeInto`, 'other']);

  const result = mergeReviewed(fx, wt.path);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /複数記録されている/);
});

test('記録された統合先ブランチが存在しないとmergeしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-missing-branch');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['config', '--local', '--replace-all', `codexreview.${wt.name}.mergeInto`, 'deleted-branch']);

  const before = state(fx);
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /存在しないためmergeしません/);
  assert.deepEqual(state(fx), before);
});

test('gitリポジトリでないディレクトリでは安全に失敗する', (t) => {
  const fx = fixture(t);
  const outside = join(fx.base, 'not a repo');
  mkdirSync(outside, { recursive: true });

  const result = mergeReviewed(fx, outside);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /codex-review:/);
});

test('codex-reviewが作ったworktreeでなければmergeしない', (t) => {
  const fx = fixture(t);
  const foreign = join(fx.base, 'foreign worktree');
  fx.git(['worktree', 'add', '-b', 'foreign', foreign, 'HEAD']);
  commitIn(fx, foreign, 'feature.txt', 'feature\n', 'add feature');

  const before = state(fx);
  const result = mergeReviewed(fx, foreign);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /codex-reviewが作成したものではない/);
  assert.deepEqual(state(fx), before);
});

test('worktree分離していなければ何もしない', (t) => {
  const fx = fixture(t);
  const result = mergeReviewed(fx, fx.shared);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'SKIPPED not-linked-worktree');
});

// ---------------------------------------------------------------------------
// 14. ロックの解放
// ---------------------------------------------------------------------------

test('成功時にも失敗時にもmergeロックを解放する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-lock-release');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const ok = mergeReviewed(fx, wt.path);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(!existsSync(fx.lockPath), '成功後にロックが残っていない');

  // 衝突させて再レビュー準備経路を通す。
  commitIn(fx, wt.path, 'shared-file.txt', 'from worktree\n', 'edit in worktree');
  commitIn(fx, fx.shared, 'shared-file.txt', 'from shared\n', 'edit in shared');
  const retry = mergeReviewed(fx, wt.path);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /^REVIEW_REQUIRED /);
  assert.ok(!existsSync(fx.lockPath), '再レビュー準備後にもロックが残っていない');
  fx.git(['merge', '--abort'], wt.path);
});

// ---------------------------------------------------------------------------
// 15. 稼働中ロックを別プロセスが削除しない
// ---------------------------------------------------------------------------

test('稼働中プロセスが持つ古いロックは、staleでも奪わない', (t) => {
  const fx = fixture(t);
  const lock = join(fx.home, 'live.lock');
  mkdirSync(fx.home, { recursive: true });

  // このテストプロセス自身をロック所有者にする（＝確実に稼働中）。
  const marker = JSON.stringify({
    owner: 'codex-review-state',
    version: 1,
    token: `${process.pid}-live`,
    pid: process.pid,
    at: new Date().toISOString(),
  });
  writeFileSync(lock, `${marker}\n`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);

  assert.throws(
    () => withLock(lock, () => 'ran', { timeoutMs: 500, label: 'テストロック' }),
    /取得できませんでした/,
    '稼働中の所有者がいる間は取得できない',
  );
  assert.ok(existsSync(lock), 'ロックファイルを削除していない');
  assert.equal(readFileSync(lock, 'utf8'), `${marker}\n`, 'ロックの内容も書き換えていない');
});

test('staleだが所有者が稼働中でも、指定した時間まで待ってから諦める', (t) => {
  const fx = fixture(t);
  const lock = join(fx.home, 'live-timeout.lock');

  // stale判定に入る（mtimeが古い）が所有者は稼働中、という経路。
  // ここは回収せずに再試行するため、試行回数で予算を数えると一瞬で使い切り、
  // 「N秒待った」と言いながら即失敗する。実時間で計っていることを確認する。
  writeFileSync(
    lock,
    `${JSON.stringify({
      owner: 'codex-review-state',
      version: 1,
      token: `${process.pid}-live`,
      pid: process.pid,
      at: new Date().toISOString(),
    })}\n`,
  );
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);

  const started = Date.now();
  assert.throws(
    () => withLock(lock, () => 'ran', { timeoutMs: 2000, label: 'テストロック' }),
    /取得できませんでした/,
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 1900, `指定時間まで待つ（実測 ${waited}ms）`);
  assert.ok(existsSync(lock), '稼働中の所有者のロックを削除していない');
});

test('停止したプロセスの古いロックは回収する', (t) => {
  const fx = fixture(t);
  const lock = join(fx.home, 'dead.lock');

  // 存在しないPID。0未満やInteger以外は所有者マーカーとして弾かれるため、
  // 実在しない大きなPIDを使う。
  const deadPid = 0x7ffffffe;
  writeFileSync(
    lock,
    `${JSON.stringify({
      owner: 'codex-review-state',
      version: 1,
      token: `${deadPid}-dead`,
      pid: deadPid,
      at: new Date().toISOString(),
    })}\n`,
  );
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);

  assert.equal(withLock(lock, () => 'ran', { timeoutMs: 5000, label: 'テストロック' }), 'ran');
  assert.ok(!existsSync(lock), '実行後は解放されている');
});

test('多数のプロセスが奪い合っても、待機側が落ちず相互排他が保たれる', { timeout: 120000 }, async (t) => {
  const fx = fixture(t);
  const lock = join(fx.home, 'contended.lock');
  const counter = join(fx.home, 'counter.txt');
  const worker = join(fx.home, 'worker.js');
  const WORKERS = 8;
  const TIMES = 25;

  writeFileSync(counter, '0');
  // 解放（unlink）と取得（open wx）が競合する窓を、意図的に高頻度で踏ませる。
  // Windowsではこの窓で EEXIST ではなく EPERM が返るため、EEXIST しか再試行
  // しないと「待っていた側」が落ちる。臨界区間を read→write にしてあるので、
  // 相互排他が壊れれば最終カウントが足りなくなる。
  writeFileSync(
    worker,
    [
      `const { withLock } = require(${JSON.stringify(join(SCRIPTS, 'lock-core.js'))});`,
      "const { readFileSync, writeFileSync } = require('node:fs');",
      'const [lock, counter, times] = process.argv.slice(2);',
      'for (let i = 0; i < Number(times); i += 1) {',
      "  withLock(lock, () => {",
      "    const n = Number(readFileSync(counter, 'utf8'));",
      '    writeFileSync(counter, String(n + 1));',
      "  }, { timeoutMs: 60000, label: 'テストロック' });",
      '}',
    ].join('\n'),
  );

  const results = await Promise.all(
    Array.from({ length: WORKERS }, () =>
      runAsync(['node', worker, lock, counter, String(TIMES)], { env: fx.env })),
  );

  const crashed = results.filter((r) => r.code !== 0);
  assert.equal(
    crashed.length,
    0,
    `待機中のプロセスが落ちた: ${crashed.map((r) => r.stderr.trim().split('\n')[0]).join(' / ')}`,
  );
  assert.equal(
    Number(readFileSync(counter, 'utf8')),
    WORKERS * TIMES,
    '相互排他が保たれ、更新が失われていない',
  );
  assert.ok(!existsSync(lock), 'ロックが解放されている');
});

test('mergeロックを保持している間は、他プロセスがgit操作を始めない', { timeout: 60000 }, async (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-lock-wait');
  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  mkdirSync(join(fx.home, '.claude', 'codex-review-state'), { recursive: true });
  writeFileSync(
    fx.lockPath,
    `${JSON.stringify({
      owner: 'codex-review-state',
      version: 1,
      token: `${process.pid}-holder`,
      pid: process.pid,
      at: new Date().toISOString(),
    })}\n`,
  );

  const before = state(fx);
  const pending = runAsync(['node', MERGE_REVIEWED], { cwd: wt.path, env: fx.env });

  await sleep(1500);
  assert.deepEqual(state(fx), before, 'ロック保持中はgit操作を始めていない');
  assert.ok(existsSync(fx.lockPath), '保持中のロックを奪っていない');

  rmSync(fx.lockPath);
  const result = await pending;

  assert.equal(result.code, 0, result.stderr);
  assert.equal(shaOf(fx, 'refs/heads/main'), head, 'ロック解放後にmergeできている');
  assert.ok(!existsSync(fx.lockPath), '自分のロックは解放している');
});

// ---------------------------------------------------------------------------
// 共有側の未追跡ファイルと、専用worktreeで生成したファイル
// ---------------------------------------------------------------------------

test('共有側が未追跡ファイルだけなら確認を求めずworktree移動を指示する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'local-only.txt'), 'keep local\n');

  const result = markPrompt(fx, 'session-untracked-advisory');
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /EnterWorktree\(name:/);
  assert.doesNotMatch(context, /未コミット変更をコミット/);
  assert.equal(recordedTarget(fx, worktreeName('session-untracked-advisory')), 'main');
  assert.equal(readFileSync(join(fx.shared, 'local-only.txt'), 'utf8'), 'keep local\n');
});

test('共有側のBash実行は専用worktreeへ移るまで拒否する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'local-only.txt'), 'keep local\n');

  const result = tryRun(['node', WORKTREE_GUARD], {
    cwd: fx.shared,
    env: fx.env,
    input: JSON.stringify({
      cwd: fx.shared,
      session_id: 'session-bash-guard',
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /EnterWorktree\(name:/);
  assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason, /未コミット変更をコミット/);
  assert.equal(readFileSync(join(fx.shared, 'local-only.txt'), 'utf8'), 'keep local\n');
});

test('session_idが無い共有側のBashもfail-openせず拒否する', (t) => {
  const fx = fixture(t);
  const result = tryRun(['node', WORKTREE_GUARD], {
    cwd: fx.shared,
    env: fx.env,
    input: JSON.stringify({
      cwd: fx.shared,
      tool_name: 'Bash',
      tool_input: { command: 'git status --short' },
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /session_id/);
});

/**
 * Bashは対象を見ずに拒否するので、パスを比較する経路（Edit / Write /
 * NotebookEdit）はここでしか通らない。`%TEMP%` が 8.3 短縮名を返す環境では、
 * gitの返す長いパスと綴りが食い違い、比較が「共有ツリーの外」と答えて
 * **ガードが黙って書き込みを許す**。実際にそうなっていた。
 */
test('共有ツリーへのWriteも拒否する（パスの綴りが違ってもfail-openしない）', (t) => {
  const fx = fixture(t);

  const result = tryRun(['node', WORKTREE_GUARD], {
    cwd: fx.shared,
    env: fx.env,
    input: JSON.stringify({
      cwd: fx.shared,
      session_id: 'session-write-guard',
      tool_name: 'Write',
      tool_input: { file_path: join(fx.shared, 'new-file.txt') },
    }),
  });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /EnterWorktree\(name:/);
});

test('未コミット変更があるWriteのdeny理由に、コミットして分離する手段が入る', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'uncommitted\n');

  const result = tryRun(['node', WORKTREE_GUARD], {
    cwd: fx.shared,
    env: fx.env,
    input: JSON.stringify({
      cwd: fx.shared,
      session_id: 'session-dirty-guard',
      tool_name: 'Write',
      tool_input: { file_path: join(fx.shared, 'new-file.txt') },
    }),
  });

  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /未コミットの変更が残っているため/);
  assert.match(reason, /commit-shared-wip\.js" --confirm/);
  assert.match(reason, /stash \/ reset \/ checkout/);
  assert.equal(
    readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'),
    'uncommitted\n',
    'hookは何も変更しない',
  );
});

test('UserPromptSubmitの案内にも、コミットして分離する選択肢が入る', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'uncommitted\n');

  const result = markPrompt(fx, 'session-dirty-advisory');

  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /現在のブランチへコミットしてから分離する/);
  assert.match(context, /commit-shared-wip\.js" --confirm/);
  assert.doesNotMatch(context, /EnterWorktree\(name:/, '分離できない間は移動を指示しない');
});

test('commit-reviewed --allは専用worktreeで生成した未追跡ファイルもコミットする', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-commit-all');
  writeFileSync(join(wt.path, 'generated.txt'), 'generated in session\n');
  writeFileSync(join(wt.path, 'shared-file.txt'), 'edited in session\n');
  const fingerprint = run(['node', STOP_HOOK, '--print'], { cwd: wt.path, env: fx.env }).trim();

  const result = tryRun([
    'node', COMMIT_REVIEWED,
    '--expected', fingerprint,
    '--message', 'include complete session',
    '--all',
  ], { cwd: wt.path, env: fx.env });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /COMMITTED [0-9a-f]{40,64}/);
  assert.equal(fx.git(['status', '--porcelain'], wt.path), '', '専用worktreeに未コミット差分が残らない');
  assert.equal(fx.git(['show', 'HEAD:generated.txt'], wt.path), 'generated in session\n');
  assert.equal(fx.git(['show', 'HEAD:shared-file.txt'], wt.path), 'edited in session\n');
});

test('commit-reviewed --allはrename元の削除も含める', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-commit-rename');
  fx.git(['mv', 'shared-file.txt', 'renamed-file.txt'], wt.path);
  const fingerprint = run(['node', STOP_HOOK, '--print'], { cwd: wt.path, env: fx.env }).trim();
  const result = tryRun([
    'node', COMMIT_REVIEWED,
    '--expected', fingerprint,
    '--message', 'include rename',
    '--all',
  ], { cwd: wt.path, env: fx.env });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.git(['status', '--porcelain'], wt.path), '');
  assert.ok(!existsSync(join(wt.path, 'shared-file.txt')));
  assert.equal(fx.git(['show', 'HEAD:renamed-file.txt'], wt.path), 'base\n');
});

test('run-reviewはリポジトリ内へレビュー出力を作らない', (t) => {
  const fx = fixture(t);
  const output = join(fx.shared, 'codex-review-output.txt');
  assert.match(checkOutFile(output, fx.shared, fx.env), /レビュー出力はリポジトリ外/);
  assert.ok(!existsSync(output), 'リポジトリ内に出力ファイルを作っていない');
});

test('setupとdoctorはBashを含む同じPreToolUse matcherを正常と判定する', (t) => {
  const fx = fixture(t);
  const setup = tryRun(['node', SETUP_AUTO, '--enable-schedule'], { cwd: fx.shared, env: fx.env });
  assert.equal(setup.code, 0, setup.stderr);

  const settings = JSON.parse(readFileSync(join(fx.shared, '.claude', 'settings.local.json'), 'utf8'));
  const guard = settings.hooks.PreToolUse.find((group) =>
    group.hooks.some((hook) => hook.command.includes('worktree-guard.js')));
  assert.equal(guard.matcher, 'Edit|Write|NotebookEdit|Bash');

  const doctor = tryRun(['node', DOCTOR], { cwd: fx.shared, env: fx.env });
  assert.match(doctor.stdout, /\[OK\] hooks: UserPromptSubmit \/ PreToolUse \/ Stop を確認/);
  assert.doesNotMatch(doctor.stdout, /競合または旧登録/);
});
