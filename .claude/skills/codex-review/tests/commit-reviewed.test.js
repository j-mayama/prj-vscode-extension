#!/usr/bin/env node
'use strict';

/**
 * commit-reviewed.js の自動テスト。
 *
 *   node --test .claude/skills/codex-review/tests/commit-reviewed.test.js
 *
 * このスクリプトの保証は「Codexが読んだ内容と、実際にコミットされる内容が一致する」
 * ことだけなので、終了コードではなく **commit tree の中身** で確かめる。
 *
 * とくに `pre-commit` hook は、fingerprint検証を通った**あと**にファイルを書き換えて
 * `git add` できる。`git commit` を使っている限り、その差し替えは必ずコミットに入り、
 * 事後比較では「入ってしまったこと」を報告できるだけになる。そのため
 * commit-tree で組み立てる実装になっており、ここではhookが動かないことを
 * 「hookが書いたはずの内容がcommit treeに無い」形で確認する。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  COMMIT_REVIEWED,
  STOP_HOOK,
  addWorktree,
  fixture,
  gitOperationFile,
  run,
  tryRun,
} = require('./helpers.js');

function fingerprintOf(fx, cwd) {
  return run(['node', STOP_HOOK, '--print'], { cwd, env: fx.env }).trim();
}

function commitAll(fx, cwd, message, expected) {
  return tryRun([
    'node', COMMIT_REVIEWED,
    '--expected', expected ?? fingerprintOf(fx, cwd),
    '--message', message,
    '--all',
  ], { cwd, env: fx.env });
}

/** 共有 `.git/hooks/` はworktreeからも使われる。ここへ置けば実運用と同じ経路になる。 */
function installHook(fx, name, script) {
  const dir = join(fx.shared, '.git', 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

function treeFiles(fx, cwd, ref = 'HEAD') {
  return fx.git(['ls-tree', '-r', '--name-only', ref], cwd).split(/\r?\n/).filter(Boolean);
}

function snapshot(fx, cwd) {
  return {
    head: fx.git(['rev-parse', 'HEAD'], cwd).trim(),
    // detached HEADでは解決しないので、失敗を空文字として許容する。
    branch: tryRun(['git', 'symbolic-ref', '--quiet', 'HEAD'], { cwd, env: fx.env }).stdout.trim(),
    status: fx.git(['status', '--porcelain=v2', '--untracked-files=all'], cwd),
    index: readFileSync(gitOperationFile(fx, cwd, 'index')),
  };
}

// ---------------------------------------------------------------------------
// 1. hook にコミット内容を差し替えさせない
// ---------------------------------------------------------------------------

test('pre-commit hookが対象ファイルを書き換えてstageしても、未レビュー内容はコミットへ入らない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-hook-rewrite');
  writeFileSync(join(wt.path, 'feature.txt'), 'reviewed content\n');
  installHook(fx, 'pre-commit', '#!/bin/sh\nprintf "tampered\\n" > feature.txt\ngit add feature.txt\n');

  const result = commitAll(fx, wt.path, 'add reviewed feature');

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^COMMITTED [0-9a-f]{40,64}$/m);
  assert.equal(
    fx.git(['show', 'HEAD:feature.txt'], wt.path),
    'reviewed content\n',
    'レビュー済みの内容がそのままコミットされている',
  );
  assert.equal(
    readFileSync(join(wt.path, 'feature.txt'), 'utf8'),
    'reviewed content\n',
    '作業ファイルもhookに書き換えられていない',
  );
  assert.equal(fx.git(['status', '--porcelain'], wt.path), '', 'コミット後の未コミット差分が無い');
});

test('pre-commit hookが未追跡ファイルを作ってstageしても、コミットへ入らない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-hook-untracked');
  writeFileSync(join(wt.path, 'feature.txt'), 'reviewed content\n');
  installHook(
    fx,
    'pre-commit',
    '#!/bin/sh\nprintf "secret\\n" > from-hook.txt\ngit add from-hook.txt\n',
  );

  const result = commitAll(fx, wt.path, 'add reviewed feature');

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    !treeFiles(fx, wt.path).includes('from-hook.txt'),
    'hookが作ろうとしたファイルはcommit treeに無い',
  );
  assert.ok(!existsSync(join(wt.path, 'from-hook.txt')), 'そもそもhookが動いていない');
});

test('pre-commit hookが失敗してもレビュー済みコミットは成立する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-hook-failing');
  writeFileSync(join(wt.path, 'feature.txt'), 'reviewed content\n');
  installHook(fx, 'pre-commit', '#!/bin/sh\nexit 1\n');

  const result = commitAll(fx, wt.path, 'add reviewed feature');

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.git(['show', 'HEAD:feature.txt'], wt.path), 'reviewed content\n');
});

// ---------------------------------------------------------------------------
// 2. レビュー済みの全変更がコミットされる
// ---------------------------------------------------------------------------

test('追跡変更・未追跡・削除・renameをまとめてコミットし、作業ツリーがクリーンになる', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-full-commit');
  writeFileSync(join(wt.path, 'sentinel.txt'), 'edited by session\n');
  writeFileSync(join(wt.path, 'generated.txt'), 'generated\n');
  fx.git(['mv', 'shared-file.txt', 'renamed-file.txt'], wt.path);
  unlinkSync(join(wt.path, '.gitignore'));

  const result = commitAll(fx, wt.path, 'reviewed changes');

  assert.equal(result.code, 0, result.stderr);
  const files = treeFiles(fx, wt.path);
  assert.equal(fx.git(['show', 'HEAD:sentinel.txt'], wt.path), 'edited by session\n');
  assert.equal(fx.git(['show', 'HEAD:generated.txt'], wt.path), 'generated\n');
  assert.ok(files.includes('renamed-file.txt'), 'rename後のパスが入っている');
  assert.ok(!files.includes('shared-file.txt'), 'rename前のパスは消えている');
  assert.ok(!files.includes('.gitignore'), '削除が反映されている');
  assert.equal(fx.git(['status', '--porcelain'], wt.path), '', '未コミット差分が残らない');
  assert.match(result.stdout, /^NEXT: node ".+merge-reviewed\.js"/m, 'merge手順を出す');
});

test('指定ファイルに変更が無ければNO_CHANGESでHEADを動かさない', (t) => {
  const fx = fixture(t);
  // 別ファイルだけが変更された状態。fingerprintは空にならないが、指定した
  // sentinel.txt には commit すべき差分が無い。
  writeFileSync(join(fx.shared, 'shared-file.txt'), 'edited elsewhere\n');
  const before = snapshot(fx, fx.shared);

  const result = tryRun([
    'node', COMMIT_REVIEWED,
    '--expected', fingerprintOf(fx, fx.shared),
    '--message', 'nothing to do',
    '--', 'sentinel.txt',
  ], { cwd: fx.shared, env: fx.env });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.split(/\r?\n/)[0], 'NO_CHANGES');
  assert.deepEqual(snapshot(fx, fx.shared), before);
});

// ---------------------------------------------------------------------------
// 3. 安全に失敗する
// ---------------------------------------------------------------------------

test('最終fingerprintと一致しなければ、HEADもindexも変えずに失敗する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-stale-fingerprint');
  writeFileSync(join(wt.path, 'feature.txt'), 'reviewed content\n');
  const reviewed = fingerprintOf(fx, wt.path);

  // レビュー後に作業ツリーが変わった状況。
  writeFileSync(join(wt.path, 'feature.txt'), 'written after the review\n');
  const before = snapshot(fx, wt.path);

  const result = commitAll(fx, wt.path, 'should not land', reviewed);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /最終レビュー後に作業ツリーが変わっている/);
  assert.deepEqual(snapshot(fx, wt.path), before, 'HEAD・branch・status・indexがバイト単位で不変');
  assert.equal(readFileSync(join(wt.path, 'feature.txt'), 'utf8'), 'written after the review\n');
});

test('未解決の衝突が残っているとコミットしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-unmerged');
  fx.git(['checkout', '-b', 'other'], wt.path);
  writeFileSync(join(wt.path, 'shared-file.txt'), 'from other\n');
  fx.git(['commit', '-am', 'edit in other'], wt.path);
  fx.git(['checkout', '-'], wt.path);
  writeFileSync(join(wt.path, 'shared-file.txt'), 'from session\n');
  fx.git(['commit', '-am', 'edit in session'], wt.path);
  const conflicted = tryRun(['git', 'merge', 'other'], { cwd: wt.path, env: fx.env });
  assert.equal(conflicted.code, 1, '前提: mergeが衝突している');
  const before = snapshot(fx, wt.path);

  const result = commitAll(fx, wt.path, 'should not land');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /未解決の衝突/);
  assert.deepEqual(snapshot(fx, wt.path), before);
});

test('detached HEADではコミットしない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-detached');
  fx.git(['checkout', '--detach'], wt.path);
  writeFileSync(join(wt.path, 'feature.txt'), 'reviewed content\n');
  const before = snapshot(fx, wt.path);

  const result = commitAll(fx, wt.path, 'should not land');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /detached HEAD/);
  assert.deepEqual(snapshot(fx, wt.path), before);
});

test('他プロセスがindex.lockを持っていたら、何も変更せず失敗する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-index-lock');
  writeFileSync(join(wt.path, 'feature.txt'), 'reviewed content\n');
  const lock = gitOperationFile(fx, wt.path, 'index.lock');
  writeFileSync(lock, 'held by another git process');
  t.after(() => {
    if (existsSync(lock)) unlinkSync(lock);
  });
  const before = snapshot(fx, wt.path);

  const result = commitAll(fx, wt.path, 'should not land');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /index\.lock/);
  assert.deepEqual(snapshot(fx, wt.path), before);
  assert.ok(existsSync(lock), '他プロセスのlockを奪わない');
});

test('ref更新後の検証が失敗しても、公開前なので実indexを変更しない', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-ref-hook');
  const originalBranch = fx.git(['symbolic-ref', '--short', 'HEAD'], wt.path).trim();
  const originalHead = fx.git(['rev-parse', 'HEAD'], wt.path).trim();
  fx.git(['branch', 'hook-target'], wt.path);
  writeFileSync(join(wt.path, 'sentinel.txt'), 'reviewed content\n');
  const expected = fingerprintOf(fx, wt.path);
  const indexBefore = readFileSync(gitOperationFile(fx, wt.path, 'index'));

  // `update-ref`が起動するreference-transaction hookで、このworktreeの
  // HEADだけを動かし、ref更新後・index公開前の検証を失敗させる。
  const headFile = gitOperationFile(fx, wt.path, 'HEAD').replace(/\\/g, '/');
  installHook(
    fx,
    'reference-transaction',
    [
      '#!/bin/sh',
      'if [ "$1" = "committed" ]; then',
      `  printf '%s\\n' 'ref: refs/heads/hook-target' > "${headFile}"`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );

  const result = commitAll(fx, wt.path, 'must roll back before publish', expected);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /indexの公開前/);
  assert.equal(
    fx.git(['rev-parse', `refs/heads/${originalBranch}`], wt.path).trim(),
    originalHead,
    '更新した元ブランチのrefは元へ戻す',
  );
  assert.equal(
    fx.git(['symbolic-ref', '--short', 'HEAD'], wt.path).trim(),
    'hook-target',
    '検証失敗の前提としてhookがHEADを動かしている',
  );
  assert.deepEqual(
    readFileSync(gitOperationFile(fx, wt.path, 'index')),
    indexBefore,
    '実indexはバイト単位で不変',
  );
  assert.equal(
    tryRun(['git', 'diff', '--cached', '--quiet'], { cwd: wt.path, env: fx.env }).code,
    0,
    '元は未ステージだった変更を勝手にstageしない',
  );
  assert.notEqual(
    tryRun(['git', 'diff', '--quiet'], { cwd: wt.path, env: fx.env }).code,
    0,
    '作業ファイルの変更は未ステージのまま残る',
  );
});

test('--all はセッション専用worktreeの外では使えない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, 'sentinel.txt'), 'edited\n');
  const before = snapshot(fx, fx.shared);

  const result = commitAll(fx, fx.shared, 'should not land');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /専用worktree内でだけ/);
  assert.deepEqual(snapshot(fx, fx.shared), before);
});
