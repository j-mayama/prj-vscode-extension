#!/usr/bin/env node
'use strict';

/**
 * commit-shared-wip.js の自動テスト。
 *
 *   node --test .claude/skills/codex-review/tests/commit-shared-wip.test.js
 *
 * このスクリプトは、このスキルが利用者の作業へ加える唯一の移送手段なので、
 * 「何を残したか」を終了コードではなくファイル内容とindexの意味で確認する。
 *
 * 各検証では、実行前後で次を比較する。
 *
 * - HEAD / branch / `git status --porcelain=v2`
 * - index の内容（`git ls-files -s -t --debug` ではなく、意味が変わる `ls-files -s` と
 *   intent-to-add の有無）
 * - 作業ツリーのファイル内容
 * - 未追跡ファイル一覧
 * - commit の tree
 * - merge / rebase 進行状態
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const {
  COMMIT_SHARED_WIP,
  WORKTREE_GUARD,
  fixture,
  run,
  runAsync,
  sleep,
  tryRun,
} = require('./helpers.js');

function wip(fx, args, cwd = fx.shared) {
  return tryRun(['node', COMMIT_SHARED_WIP, ...args], { cwd, env: fx.env });
}

function planOf(fx) {
  const result = wip(fx, ['--plan']);
  assert.equal(result.code, 0, result.stderr);
  const match = result.stdout.match(/^PLAN ([0-9a-f]{16})$/m);
  return { result, fingerprint: match ? match[1] : null };
}

/** 確認 → 実行の2段階をまとめて行う（通常の使い方）。 */
function planAndCommit(fx, extra = []) {
  const { fingerprint } = planOf(fx);
  assert.ok(fingerprint, 'planがfingerprintを出す');
  return wip(fx, ['--confirm', fingerprint, ...extra]);
}

/**
 * 実行前後で比較する状態一式。git が「意味」として持っているものを取り、
 * 終了コードだけの合格を避ける。
 */
function snapshot(fx, cwd = fx.shared) {
  const git = (args) => fx.git(args, cwd);
  // unborn branchでは `rev-parse HEAD` が解決しないので、両方とも失敗を許容する。
  const head = tryRun(['git', 'rev-parse', 'HEAD'], { cwd, env: fx.env });
  return {
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: tryRun(['git', 'symbolic-ref', '--quiet', 'HEAD'], { cwd, env: fx.env }).stdout.trim(),
    statusV2: git(['status', '--porcelain=v2', '--untracked-files=all']),
    index: git(['ls-files', '-s']),
    untracked: git(['ls-files', '--others', '--exclude-standard']),
    tree: head.code === 0 ? git(['rev-parse', 'HEAD^{tree}']).trim() : null,
    merging: existsSync(join(cwd, '.git', 'MERGE_HEAD')),
  };
}

function files(fx, names, cwd = fx.shared) {
  return Object.fromEntries(names.map((name) => {
    const path = join(cwd, name);
    return [name, existsSync(path) ? readFileSync(path, 'utf8') : null];
  }));
}

function indexBytes(fx) {
  return readFileSync(join(fx.shared, '.git', 'index'));
}

async function waitFor(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`条件が成立しませんでした: ${label}`);
    await sleep(20);
  }
}

/** 共有ツリーへの書き込みをguardへ問い合わせ、deny理由を返す（許可ならnull）。 */
function guardReason(fx, sessionId = 'session-guard') {
  const result = tryRun(['node', WORKTREE_GUARD], {
    cwd: fx.shared,
    env: fx.env,
    input: JSON.stringify({
      cwd: fx.shared,
      session_id: sessionId,
      tool_name: 'Write',
      tool_input: { file_path: join(fx.shared, 'new-file.txt') },
    }),
  });
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason ?? null;
}

// ---------------------------------------------------------------------------
// 1. 二段階確認（--plan → --confirm <fingerprint>）
// ---------------------------------------------------------------------------

test('--planはHEAD・index・作業ファイルを変えず、対象の全件とfingerprintを表示する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  writeFileSync(join(fx.shared, 'untracked.txt'), 'untracked\n');
  const before = snapshot(fx);

  const { result, fingerprint } = planOf(fx);

  assert.ok(fingerprint, 'fingerprintが表示される');
  assert.match(result.stdout, /コミット対象 \(1件\)/);
  assert.match(result.stdout, /sentinel\.txt/);
  assert.doesNotMatch(result.stdout, /untracked\.txt/, '未追跡は対象に出さない');
  assert.match(result.stdout, /--confirm [0-9a-f]{16}/);
  assert.deepEqual(snapshot(fx), before, '--planは何も変更しない');
});

test('--planは21件以上でも省略せず全件を出す', (t) => {
  const fx = fixture(t);
  const names = Array.from({ length: 25 }, (_, index) => `file-${String(index).padStart(2, '0')}.txt`);
  for (const name of names) writeFileSync(join(fx.shared, name), 'base\n');
  fx.git(['add', '--', ...names]);
  fx.git(['commit', '-m', 'add many files']);
  for (const name of names) writeFileSync(join(fx.shared, name), 'edited\n');

  const { result } = planOf(fx);

  assert.match(result.stdout, /コミット対象 \(25件\)/);
  for (const name of names) {
    assert.match(result.stdout, new RegExp(name.replace('.', '\\.')), `${name} が一覧にある`);
  }
  assert.doesNotMatch(result.stdout, /他 \d+ 件/, '省略表記を出さない');
});

test('確認後に対象が変わったら、何も変更せず拒否する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const { fingerprint } = planOf(fx);

  // 別プロセスが追加の変更を入れた状況。
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'added by another session\n');
  const before = snapshot(fx);
  const contents = files(fx, ['sentinel.txt', 'shared-file.txt']);

  const result = wip(fx, ['--confirm', fingerprint]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /対象が変わっているためコミットしません/);
  assert.deepEqual(snapshot(fx), before, 'HEAD・index・statusとも実行前と一致');
  assert.deepEqual(files(fx, ['sentinel.txt', 'shared-file.txt']), contents);
});

test('fingerprintの形式が不正なら変更前に拒否する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const before = snapshot(fx);

  const result = wip(fx, ['--confirm', 'yes']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /16桁のfingerprint/);
  assert.deepEqual(snapshot(fx), before);
});

// ---------------------------------------------------------------------------
// 2. 正常系
// ---------------------------------------------------------------------------

test('追跡ファイルの変更だけをコミットし、未追跡ファイルは残す', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited before isolation\n');
  writeFileSync(join(fx.shared, 'untracked.txt'), 'untracked keep\n');
  const before = snapshot(fx);

  const result = planAndCommit(fx);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^COMMITTED_WIP [0-9a-f]{40,64} main files=1$/m);
  assert.match(result.stdout, /^UNDO: node ".+commit-shared-wip\.js" --undo [0-9a-f]{40,64}$/m);

  const after = snapshot(fx);
  assert.notEqual(after.head, before.head, 'HEADが進む');
  assert.equal(after.branch, before.branch);
  assert.equal(fx.git(['status', '--porcelain', '--untracked-files=no']), '', '追跡変更は残らない');
  assert.equal(fx.git(['show', 'HEAD:sentinel.txt']), 'edited before isolation\n');
  assert.equal(after.untracked, before.untracked, '未追跡一覧が不変');
  assert.equal(readFileSync(join(fx.shared, 'untracked.txt'), 'utf8'), 'untracked keep\n');
  assert.ok(!fx.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('untracked.txt'),
    '未追跡ファイルはcommit treeに入っていない');
  assert.equal(after.merging, false);
});

test('ステージ済みと未ステージが混在していてもまとめてコミットする', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'staged edit\n');
  fx.git(['add', '--', 'sentinel.txt']);
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'unstaged edit\n');

  const result = planAndCommit(fx);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /files=2/);
  assert.equal(fx.git(['show', 'HEAD:sentinel.txt']), 'staged edit\n');
  assert.equal(fx.git(['show', 'HEAD:shared-file.txt']), 'unstaged edit\n');
  assert.equal(fx.git(['status', '--porcelain']), '', '共有ツリーがクリーンになる');
});

test('--messageでコミットメッセージを指定できる', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');

  assert.equal(planAndCommit(fx, ['--message', 'save work in progress']).code, 0);
  assert.equal(fx.git(['log', '-1', '--pretty=%s']).trim(), 'save work in progress');
});

test('コミット後は共有ツリーがクリーンになり、guardが分離を指示する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited before isolation\n');

  assert.match(guardReason(fx), /未コミットの変更が残っているため/, '前提: 分離できない状態');
  assert.equal(planAndCommit(fx).code, 0);

  const reason = guardReason(fx);
  assert.match(reason, /EnterWorktree\(name:/, 'コミット後は分離手順が案内される');
  assert.doesNotMatch(reason, /未コミットの変更が残っているため/);
});

test('空白入りパスと / 入りブランチ名でも動く', (t) => {
  const fx = fixture(t, { branch: 'feature/deploy-target' });
  const name = 'dir with space/file with space.txt';
  run(['node', '-e', 'require("fs").mkdirSync(process.argv[1],{recursive:true})',
    join(fx.shared, 'dir with space')], { env: fx.env });
  writeFileSync(join(fx.shared, name), 'base\n');
  fx.git(['add', '--', name]);
  fx.git(['commit', '-m', 'add spaced file']);
  writeFileSync(join(fx.shared, name), 'edited\n');

  const result = planAndCommit(fx);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /COMMITTED_WIP [0-9a-f]{40,64} feature\/deploy-target files=1/);
  assert.equal(fx.git(['show', `HEAD:${name}`]), 'edited\n');
});

test('統合先ブランチと同名のタグがあってもrefs/headsを更新する', (t) => {
  const fx = fixture(t);
  fx.git(['tag', 'main', 'HEAD']);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const tagBefore = fx.git(['rev-parse', 'refs/tags/main']).trim();

  const result = planAndCommit(fx);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.git(['rev-parse', 'refs/tags/main']).trim(), tagBefore, 'タグは動かない');
  assert.equal(
    fx.git(['rev-parse', 'refs/heads/main']).trim(),
    fx.git(['rev-parse', 'HEAD']).trim(),
    'ブランチが進んでいる',
  );
});

// ---------------------------------------------------------------------------
// 3. index を壊さない
// ---------------------------------------------------------------------------

test('intent-to-addのファイルはコミットせず、indexのi-t-aも保持する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  writeFileSync(join(fx.shared, 'planned.txt'), 'planned content\n');
  fx.git(['add', '-N', '--', 'planned.txt']);
  const before = snapshot(fx);
  assert.match(before.statusV2, /planned\.txt/, '前提: i-t-aエントリがある');

  const { result, fingerprint } = planOf(fx);
  assert.match(result.stdout, /intent-to-add/);
  const committed = wip(fx, ['--confirm', fingerprint]);

  assert.equal(committed.code, 0, committed.stderr);
  assert.match(committed.stdout, /files=1/, 'i-t-aは対象件数に入らない');
  assert.ok(
    !fx.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('planned.txt'),
    'i-t-aのファイルはcommit treeに入っていない',
  );
  // i-t-a は index に「HEADに無いエントリ」として残り続ける。
  assert.match(fx.git(['status', '--porcelain']), /^ A planned\.txt$/m, 'i-t-aのまま残る');
  assert.equal(readFileSync(join(fx.shared, 'planned.txt'), 'utf8'), 'planned content\n');
});

test('コミットに失敗してもindexは1バイトも変わらない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'staged edit\n');
  fx.git(['add', '--', 'sentinel.txt']);
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'unstaged edit\n');
  writeFileSync(join(fx.shared, 'planned.txt'), 'planned\n');
  fx.git(['add', '-N', '--', 'planned.txt']);

  const { fingerprint } = planOf(fx);
  const indexPath = join(fx.shared, '.git', 'index');
  const indexBefore = readFileSync(indexPath);
  const before = snapshot(fx);

  // commit-tree が使う identity を壊して、ref更新の直前で失敗させる。
  fx.git(['config', '--unset', 'user.email']);
  fx.git(['config', '--unset', 'user.name']);
  const result = wip(fx, ['--confirm', fingerprint, '--message', 'should not land']);

  assert.equal(result.code, 1);
  assert.deepEqual(snapshot(fx), before, 'HEAD・branch・status・index・treeが実行前と一致');
  assert.deepEqual(readFileSync(indexPath), indexBefore, 'indexファイルがバイト単位で不変');
  assert.equal(readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'), 'staged edit\n');
  assert.equal(readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8'), 'unstaged edit\n');
  assert.match(fx.git(['status', '--porcelain']), /^ A planned\.txt$/m, 'i-t-aが失われていない');
});

test('ref更新後の検証が失敗しても、公開前なので実indexを変更しない', (t) => {
  const fx = fixture(t);
  const originalBranch = fx.git(['symbolic-ref', '--short', 'HEAD']).trim();
  const originalHead = fx.git(['rev-parse', 'HEAD']).trim();
  fx.git(['branch', 'hook-target']);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'unstaged edit\n');
  const { fingerprint } = planOf(fx);
  const indexBefore = indexBytes(fx);

  // `update-ref`はcommit hookを動かさない代わりにreference-transaction
  // hookを動かす。このhookでHEADを動かし、ref更新後の検証を確実に失敗させる。
  const headFile = join(fx.shared, '.git', 'HEAD').replace(/\\/g, '/');
  const hook = join(fx.shared, '.git', 'hooks', 'reference-transaction');
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'if [ "$1" = "committed" ]; then',
      `  printf '%s\\n' 'ref: refs/heads/hook-target' > "${headFile}"`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(hook, 0o755);

  const result = wip(fx, ['--confirm', fingerprint, '--message', 'must roll back before publish']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /indexを公開しません/);
  assert.equal(
    fx.git(['rev-parse', `refs/heads/${originalBranch}`]).trim(),
    originalHead,
    '更新した元ブランチのrefは元へ戻す',
  );
  assert.equal(
    fx.git(['symbolic-ref', '--short', 'HEAD']).trim(),
    'hook-target',
    '検証失敗の前提としてhookがHEADを動かしている',
  );
  assert.deepEqual(indexBytes(fx), indexBefore, '実indexはバイト単位で不変');
  assert.equal(
    tryRun(['git', 'diff', '--cached', '--quiet'], { cwd: fx.shared, env: fx.env }).code,
    0,
    '元は未ステージだった変更を勝手にstageしない',
  );
  assert.notEqual(
    tryRun(['git', 'diff', '--quiet'], { cwd: fx.shared, env: fx.env }).code,
    0,
    '作業ファイルの変更は未ステージのまま残る',
  );
});

test('pre-commitフックが未追跡ファイルをstageしてもコミットへ入らない', (t) => {
  const fx = fixture(t);
  const hook = join(fx.shared, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\ngit add secret-from-hook.txt\n', { mode: 0o755 });
  writeFileSync(join(fx.shared, 'secret-from-hook.txt'), 'must not be committed\n');
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');

  const result = planAndCommit(fx);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    !fx.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('secret-from-hook.txt'),
    'hookがstageしようとしたファイルはcommit treeに入っていない',
  );
  assert.match(
    fx.git(['status', '--porcelain']),
    /^\?\? secret-from-hook\.txt$/m,
    '未追跡のまま残っている',
  );
});

// ---------------------------------------------------------------------------
// 4. 何もしない場合
// ---------------------------------------------------------------------------

test('未コミット変更が無ければNO_CHANGESでHEADを動かさない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'untracked.txt'), 'untracked only\n');
  const before = snapshot(fx);

  const result = wip(fx, ['--plan']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'NO_CHANGES');
  assert.deepEqual(snapshot(fx), before, '未追跡ファイルだけならコミットしない');
});

test('未知のオプションは変更前に拒否する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const before = snapshot(fx);

  const result = wip(fx, ['--confirm', '0123456789abcdef', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /未対応のオプション/);
  assert.deepEqual(snapshot(fx), before);
});

test('自動レビューが有効でないリポジトリではコミットしない', (t) => {
  const fx = fixture(t);
  unlinkSync(join(fx.shared, '.codex-review-auto'));
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const before = snapshot(fx);

  const result = wip(fx, ['--plan']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /自動レビューが有効ではない/);
  assert.deepEqual(snapshot(fx), before);
});

test('分離をオプトアウトしているリポジトリではコミットしない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, '.codex-review-no-worktree'), '');
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const before = snapshot(fx);

  const result = wip(fx, ['--plan']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /worktree分離は行われません/);
  assert.deepEqual(snapshot(fx), before);
});

test('detached HEADではコミットしない', (t) => {
  const fx = fixture(t);
  fx.git(['checkout', '--detach']);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const before = snapshot(fx);

  const result = wip(fx, ['--plan']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /detached HEAD/);
  assert.deepEqual(snapshot(fx), before);
});

test('コミットが1つも無いリポジトリでは、最初のコミットを勝手に作らない', (t) => {
  const fx = fixture(t);
  fx.git(['checkout', '--orphan', 'fresh-start']);
  fx.git(['rm', '-r', '--cached', '.']);
  fx.git(['add', '--', 'sentinel.txt']);
  const before = snapshot(fx);

  const result = wip(fx, ['--plan']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /まだコミットがありません/);
  assert.deepEqual(snapshot(fx), before);
  assert.equal(readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'), 'sentinel-original\n');
});

test('merge進行中は、そのmergeに触らずコミットしない', (t) => {
  const fx = fixture(t);
  fx.git(['checkout', '-b', 'other']);
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'from other\n');
  fx.git(['commit', '-am', 'edit in other']);
  fx.git(['checkout', 'main']);
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'from main\n');
  fx.git(['commit', '-am', 'edit in main']);
  const conflicted = tryRun(['git', 'merge', 'other'], { cwd: fx.shared, env: fx.env });
  assert.equal(conflicted.code, 1, '前提: mergeが衝突している');

  const mergeHeadBefore = readFileSync(join(fx.shared, '.git', 'MERGE_HEAD'), 'utf8');
  const before = snapshot(fx);

  const result = wip(fx, ['--plan']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /MERGE_HEADが進行中/);
  assert.equal(
    readFileSync(join(fx.shared, '.git', 'MERGE_HEAD'), 'utf8'),
    mergeHeadBefore,
    '他プロセスのmergeに触っていない',
  );
  assert.deepEqual(snapshot(fx), before);
});

// ---------------------------------------------------------------------------
// 5. --undo
// ---------------------------------------------------------------------------

test('--undoは直後なら成功し、変更をステージ済みとして戻す', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited before isolation\n');
  writeFileSync(join(fx.shared, 'untracked.txt'), 'untracked\n');
  const before = snapshot(fx);

  const committed = planAndCommit(fx);
  const wipCommit = committed.stdout.match(/COMMITTED_WIP ([0-9a-f]{40,64})/)[1];

  const undone = wip(fx, ['--undo', wipCommit]);

  assert.equal(undone.code, 0, undone.stderr);
  assert.match(undone.stdout, new RegExp(`^UNDONE main ${before.head}$`, 'm'));
  assert.equal(fx.git(['rev-parse', 'HEAD']).trim(), before.head, 'HEADが元へ戻る');
  assert.equal(
    readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'),
    'edited before isolation\n',
    '編集内容が失われない',
  );
  assert.match(fx.git(['status', '--porcelain']), /^M {2}sentinel\.txt$/m, 'ステージ済みとして戻る');
  assert.equal(snapshot(fx).untracked, before.untracked, '未追跡一覧が不変');
});

test('--undoは後続コミットがあると何も変更せず拒否する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const committed = planAndCommit(fx);
  const wipCommit = committed.stdout.match(/COMMITTED_WIP ([0-9a-f]{40,64})/)[1];

  writeFileSync(join(fx.shared, 'shared-file.txt'), 'later work\n');
  fx.git(['commit', '-am', 'later commit']);
  const before = snapshot(fx);
  const contents = files(fx, ['sentinel.txt', 'shared-file.txt']);

  const result = wip(fx, ['--undo', wipCommit]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /先端ではないため/);
  assert.deepEqual(snapshot(fx), before, 'HEAD・index・statusとも実行前と一致');
  assert.deepEqual(files(fx, ['sentinel.txt', 'shared-file.txt']), contents);
});

test('--undoは存在しないコミットを指定すると何も変更しない', (t) => {
  const fx = fixture(t);
  const before = snapshot(fx);

  const result = wip(fx, ['--undo', '0123456789abcdef0123456789abcdef01234567']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /見つかりません/);
  assert.deepEqual(snapshot(fx), before);
});

// ---------------------------------------------------------------------------
// 6. 冪等性・並行実行
// ---------------------------------------------------------------------------

test('同じfingerprintで2回実行しても2回目はコミットしない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const { fingerprint } = planOf(fx);

  assert.equal(wip(fx, ['--confirm', fingerprint]).code, 0);
  const after = snapshot(fx);

  const second = wip(fx, ['--confirm', fingerprint]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim(), 'NO_CHANGES');
  assert.deepEqual(snapshot(fx), after, '履歴もindexも増えない');
});

// ---------------------------------------------------------------------------
// 7. fingerprintは「一覧」ではなく「実際にコミットする内容」に結び付く
// ---------------------------------------------------------------------------

test('--plan後に中身だけ書き換えたら、同じfingerprintでは拒否する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'approved content\n');
  const { fingerprint } = planOf(fx);

  // 一覧・件数・`git status` の出力はすべて同じまま、中身だけ差し替える。
  // porcelain=v2 はHEADとindexのobject idしか持たないため、作業ツリーの
  // 内容変更はstatusのどのフィールドにも現れない。
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'swapped after approval\n');
  const before = snapshot(fx);
  const indexBefore = indexBytes(fx);
  assert.equal(
    before.statusV2,
    fx.git(['status', '--porcelain=v2', '--untracked-files=all']),
    '前提: statusは書き換え前後で同一',
  );

  const result = wip(fx, ['--confirm', fingerprint]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /対象が変わっているためコミットしません/);
  assert.deepEqual(snapshot(fx), before, 'HEAD・index・statusとも実行前と一致');
  assert.deepEqual(indexBytes(fx), indexBefore, 'indexファイルがバイト単位で不変');
  assert.equal(
    readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'),
    'swapped after approval\n',
    '作業ファイルも書き戻さない',
  );
});

test('fingerprintは内容が同じなら安定し、1バイト違えば変わる', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'approved content\n');

  const first = planOf(fx).fingerprint;
  const again = planOf(fx).fingerprint;
  assert.equal(again, first, '同じ状態なら同じ値になる（--confirmが通らないと使えない）');

  writeFileSync(join(fx.shared, 'sentinel.txt'), 'approved contenT\n');
  assert.notEqual(planOf(fx).fingerprint, first, '1バイトの違いで変わる');
});

test('--planはHEAD・index・作業ファイルを変更しない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  fx.git(['add', '--', 'sentinel.txt']);
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'unstaged\n');
  const before = snapshot(fx);
  const indexBefore = indexBytes(fx);
  const contents = files(fx, ['sentinel.txt', 'shared-file.txt']);

  assert.ok(planOf(fx).fingerprint);

  assert.deepEqual(snapshot(fx), before);
  assert.deepEqual(indexBytes(fx), indexBefore, 'indexファイルがバイト単位で不変');
  assert.deepEqual(files(fx, ['sentinel.txt', 'shared-file.txt']), contents);
});

test('削除・rename・空白入り・非ASCIIの名前でも内容に結び付く', (t) => {
  const fx = fixture(t);
  const spaced = 'dir with space/日本語 ファイル.txt';
  mkdirSync(join(fx.shared, 'dir with space'), { recursive: true });
  writeFileSync(join(fx.shared, spaced), 'base\n');
  writeFileSync(join(fx.shared, 'to-delete.txt'), 'delete me\n');
  fx.git(['add', '--', spaced, 'to-delete.txt']);
  fx.git(['commit', '-m', 'add fixtures']);

  writeFileSync(join(fx.shared, spaced), 'edited\n');
  unlinkSync(join(fx.shared, 'to-delete.txt'));
  fx.git(['mv', 'shared-file.txt', 'renamed-file.txt']);
  const { result, fingerprint } = planOf(fx);
  assert.match(result.stdout, /コミット対象 \(3件\)/);
  assert.match(result.stdout, /shared-file\.txt -> renamed-file\.txt/);

  // rename・削除はそのまま、非ASCIIファイルの中身だけ差し替える。
  writeFileSync(join(fx.shared, spaced), 'swapped\n');
  const rejected = wip(fx, ['--confirm', fingerprint]);
  assert.equal(rejected.code, 1, '内容が変わったので拒否する');
  assert.match(rejected.stderr, /対象が変わっているためコミットしません/);

  const retried = planAndCommit(fx);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(fx.git(['show', `HEAD:${spaced}`]), 'swapped\n');
  assert.ok(!fx.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('to-delete.txt'), '削除が入る');
  assert.equal(fx.git(['show', 'HEAD:renamed-file.txt']), 'base\n', 'rename後のパスで入る');
  assert.equal(fx.git(['status', '--porcelain', '--untracked-files=no']), '');
});

test('symlinkの向き先が変わっただけでも拒否する', (t) => {
  const fx = fixture(t);
  // 3つとも中身は同一。リンクの「向き先」だけが違う状態を作る。
  for (const name of ['target-a.txt', 'target-b.txt', 'target-c.txt']) {
    writeFileSync(join(fx.shared, name), 'same bytes\n');
  }
  try {
    symlinkSync('target-a.txt', join(fx.shared, 'link.txt'), 'file');
  } catch {
    t.skip('このマシンではsymlinkを作成できないため未確認');
    return;
  }
  fx.git(['add', '--', 'target-a.txt', 'target-b.txt', 'target-c.txt', 'link.txt']);
  if (!fx.git(['ls-files', '-s', '--', 'link.txt']).startsWith('120000')) {
    t.skip('gitがsymlinkとして記録しない環境のため未確認（core.symlinks=false）');
    return;
  }
  fx.git(['commit', '-m', 'add symlink']);

  const relink = (target) => {
    unlinkSync(join(fx.shared, 'link.txt'));
    symlinkSync(target, join(fx.shared, 'link.txt'), 'file');
  };

  relink('target-b.txt');
  const { fingerprint } = planOf(fx);

  // 承認後、また別のファイルへ向け直す。HEAD比較では両方とも同じ ` M link.txt` で、
  // indexのobject idも変わらない。中身をhashしていなければ区別できない。
  relink('target-c.txt');
  const before = snapshot(fx);
  const result = wip(fx, ['--confirm', fingerprint]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /対象が変わっているためコミットしません/);
  assert.deepEqual(snapshot(fx), before);

  // 承認どおりの向き先へ戻せば、そのfingerprintでコミットできる。
  relink('target-b.txt');
  const committed = wip(fx, ['--confirm', fingerprint]);
  assert.equal(committed.code, 0, committed.stderr);
  assert.equal(fx.git(['show', 'HEAD:link.txt']).trim(), 'target-b.txt', 'リンク先を記録している');
});

test('改行を含むファイル名でも内容に結び付く', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windowsのファイル名に改行を含められないため対象外');
    return;
  }
  const fx = fixture(t);
  const name = 'line\nbreak.txt';
  writeFileSync(join(fx.shared, name), 'base\n');
  fx.git(['add', '--', name]);
  fx.git(['commit', '-m', 'add newline name']);
  writeFileSync(join(fx.shared, name), 'approved\n');

  const { fingerprint } = planOf(fx);
  writeFileSync(join(fx.shared, name), 'swapped\n');

  const result = wip(fx, ['--confirm', fingerprint]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /対象が変わっているためコミットしません/);
});

// ---------------------------------------------------------------------------
// 8. 通常のgitプロセスとの index 競合
// ---------------------------------------------------------------------------

test('他プロセスがindex.lockを保持していたら、何も変更せず失敗する', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const { fingerprint } = planOf(fx);
  const lock = join(fx.shared, '.git', 'index.lock');
  writeFileSync(lock, 'held by another git process');
  t.after(() => {
    if (existsSync(lock)) unlinkSync(lock);
  });
  const before = snapshot(fx);
  const indexBefore = indexBytes(fx);

  const result = wip(fx, ['--confirm', fingerprint]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /index\.lock/);
  assert.deepEqual(snapshot(fx), before, 'HEAD・index・statusとも実行前と一致');
  assert.deepEqual(indexBytes(fx), indexBefore);
  assert.equal(readFileSync(lock, 'utf8'), 'held by another git process', '他プロセスのlockを奪わない');
});

test('--confirmの最中に別プロセスがgit addすると、そのgit addがlockで失敗する', async (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'approved edit\n');
  writeFileSync(join(fx.shared, 'late.txt'), 'staged by another process\n');
  const { fingerprint } = planOf(fx);

  // reference-transaction hook は update-ref の最中に走る。つまり
  // 「indexをコピーし終えたが、まだ公開していない」区間に必ず入る。
  // 固定sleepではなくファイルによる待ち合わせで、その1点に競合を作る。
  const started = join(fx.base, 'barrier-started').replace(/\\/g, '/');
  const go = join(fx.base, 'barrier-go').replace(/\\/g, '/');
  const hook = join(fx.shared, '.git', 'hooks', 'reference-transaction');
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      `: > "${started}"`,
      'i=0',
      `while [ ! -f "${go}" ] && [ "$i" -lt 600 ]; do`,
      '  i=$((i+1))',
      '  sleep 0.05',
      'done',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(hook, 0o755);

  const confirmed = runAsync(
    ['node', COMMIT_SHARED_WIP, '--confirm', fingerprint],
    { cwd: fx.shared, env: fx.env },
  );
  await waitFor(() => existsSync(started), 'WIPコミットがupdate-refまで進む');

  const late = tryRun(['git', 'add', '--', 'late.txt'], { cwd: fx.shared, env: fx.env });
  writeFileSync(go, '');
  const result = await confirmed;

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /COMMITTED_WIP [0-9a-f]{40,64} main files=1/);
  assert.notEqual(late.code, 0, '割り込んだgit addはindex.lockで失敗する');
  assert.match(late.stderr, /index\.lock|Another git process/);

  // 相手のstageは成立していないが、内容も未追跡という状態も失われていない。
  assert.equal(
    readFileSync(join(fx.shared, 'late.txt'), 'utf8'),
    'staged by another process\n',
    '割り込んだファイルの内容が消えていない',
  );
  assert.match(fx.git(['status', '--porcelain']), /^\?\? late\.txt$/m, '未追跡のまま残っている');
  assert.ok(
    !fx.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('late.txt'),
    '承認していないファイルがWIPコミットへ混ざっていない',
  );
  assert.equal(fx.git(['show', 'HEAD:sentinel.txt']), 'approved edit\n');
});

test('merge-reviewedと同時に実行しても共有チェックアウトが壊れない', async (t) => {
  const fx = fixture(t);
  const { addWorktree, commitIn, MERGE_REVIEWED } = require('./helpers.js');
  const wt = addWorktree(fx, 'session-concurrent-wip');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const { fingerprint } = planOf(fx);

  const [merged, committed] = await Promise.all([
    runAsync(['node', MERGE_REVIEWED], { cwd: wt.path, env: fx.env }),
    runAsync(['node', COMMIT_SHARED_WIP, '--confirm', fingerprint], { cwd: fx.shared, env: fx.env }),
  ]);

  // どちらが先でも、共有チェックアウトは一貫した状態で終わる。
  const after = snapshot(fx);
  assert.equal(after.branch, 'refs/heads/main');
  assert.equal(after.merging, false, 'merge途中の状態が残っていない');
  assert.equal(
    readFileSync(join(fx.shared, 'sentinel.txt'), 'utf8'),
    'edited\n',
    '未コミット変更の内容が失われていない',
  );

  const outcomes = [merged, committed].map((result) => result.code);
  assert.ok(outcomes.includes(0), `少なくとも片方は成功する: ${JSON.stringify([merged, committed])}`);

  if (committed.code === 0 && /COMMITTED_WIP/.test(committed.stdout)) {
    assert.equal(fx.git(['show', 'HEAD:sentinel.txt']).includes('edited'), true);
  }
  if (merged.code === 0 && /MERGED/.test(merged.stdout)) {
    assert.ok(existsSync(join(fx.shared, 'feature.txt')), 'merge結果が反映されている');
  }
});
