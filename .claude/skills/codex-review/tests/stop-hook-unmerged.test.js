#!/usr/bin/env node
'use strict';

/**
 * 「レビュー・コミットまで終わって、mergeしていない」状態を Stop hook が検知するか。
 *
 *   node --test .claude/skills/codex-review/tests/stop-hook-unmerged.test.js
 *
 * commit-reviewed.js が成功すると作業ツリーはクリーンになり、差分fingerprintは
 * null になる。つまり**コミットが成功したことそのものが、レビュー用の検知を黙らせる**。
 * 統合が唯一検証されないステップになるのを防ぐのがこの検知で、ここが動かないと
 * 「mergeを忘れた」と「全部終わった」が見分けられない。
 *
 * 「通知したか」ではなく「merge-reviewed.js が実際に走ったか」で止まる点を重点的に
 * 確認する。通知しただけで黙る実装は、無視すれば素通りできてしまう。
 *
 * hookモードは `.codex-review-auto` がリポジトリのルートにある場合だけ動く。実運用では
 * `.worktreeinclude` がworktreeへ複製するが、`git worktree add` は複製しないので、
 * テストでは明示的に置く。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  addWorktree,
  commitIn,
  fixture,
  mergeReviewed,
  stopHook,
  tryRun,
} = require('./helpers.js');

/** 実運用の `.worktreeinclude` 相当。これが無いとhookは何もしない。 */
function armWorktree(wt) {
  writeFileSync(join(wt.path, '.codex-review-auto'), '');
  return wt;
}

function outputOf(result) {
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

function blockReason(result) {
  const output = outputOf(result);
  assert.ok(output, `blockされていない: ${JSON.stringify(result)}`);
  assert.equal(output.decision, 'block', JSON.stringify(output));
  return output.reason;
}

// ---------------------------------------------------------------------------
// 1. 未mergeを検知し、実行するまで繰り返す
// ---------------------------------------------------------------------------

test('未mergeのレビュー済みコミットがあるとStop hookがblockしてmergeコマンドを出す', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-unmerged'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const reason = blockReason(stopHook(fx, wt.path, 'session-unmerged'));

  assert.match(reason, /まだ元のブランチへmergeしていないコミット/);
  assert.match(reason, /merge-reviewed\.js/);
  assert.match(reason, /統合先   : main/);
});

test('通知を無視してmergeを実行しなければ、次のStopでも再度blockする', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-ignored'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  // merge-reviewed.js を一度も実行しないまま、3回続けて停止する。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reason = blockReason(stopHook(fx, wt.path));
    assert.match(reason, /merge-reviewed\.js/, `${attempt}回目もmergeを要求する`);
  }
});

test('mergeを実行して成功すれば、以後はblockしない', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-merged'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  blockReason(stopHook(fx, wt.path));

  const merged = mergeReviewed(fx, wt.path);
  assert.equal(merged.code, 0, merged.stderr);
  assert.match(merged.stdout, /^MERGED main/);

  const result = stopHook(fx, wt.path);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('mergeが正当に失敗したら、その結果を記録して以後は通す', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-merge-fails'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  // 共有側が別ブランチへ切り替わっている＝人が対処するしかない失敗。
  fx.git(['checkout', '-b', 'somewhere-else']);

  blockReason(stopHook(fx, wt.path));

  const merged = mergeReviewed(fx, wt.path);
  assert.equal(merged.code, 1, 'mergeは失敗する');
  assert.match(merged.stderr, /somewhere-else/);

  const first = stopHook(fx, wt.path);
  assert.equal(first.stdout.trim(), '', '失敗を記録した後はblockしない');
  const second = stopHook(fx, wt.path);
  assert.equal(second.stdout.trim(), '', '繰り返しても閉じ込めない');
});

test('新しいコミットを積んだら、失敗記録があっても再判定する', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-second-commit'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['checkout', '-b', 'somewhere-else']);
  assert.equal(mergeReviewed(fx, wt.path).code, 1);
  assert.equal(stopHook(fx, wt.path).stdout.trim(), '', '前提: 失敗記録で黙っている');

  commitIn(fx, wt.path, 'feature2.txt', 'more\n', 'add more');

  const reason = blockReason(stopHook(fx, wt.path));
  assert.match(reason, /merge-reviewed\.js/);
});

test('通知が上限に達したら、blockではなく診断を出して通す', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-limit'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  // MERGE_NOTICE_LIMIT = 5
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    blockReason(stopHook(fx, wt.path));
  }

  const result = stopHook(fx, wt.path);
  const output = outputOf(result);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(output.systemMessage, '無言では通さない');
  assert.match(output.systemMessage, /merge-reviewed\.js/);
  assert.equal(output.decision, undefined, '永久blockしない');
});

// ---------------------------------------------------------------------------
// 2. 統合先を確認できない場合も黙らない
// ---------------------------------------------------------------------------

test('統合先が記録されていないworktreeは、復旧方法つきでblockする', (t) => {
  const fx = fixture(t);
  // mark-prompt を通さずに作る = 統合先の記録が無い。
  const path = join(fx.shared, '.claude', 'worktrees', 'codex-0123456789abcdef');
  fx.git(['worktree', 'add', '-b', 'orphan-worktree', path, 'HEAD']);
  writeFileSync(join(path, '.codex-review-auto'), '');
  commitIn(fx, path, 'feature.txt', 'feature\n', 'add feature');

  const reason = blockReason(stopHook(fx, path));

  assert.match(reason, /統合先が記録されていません/);
  assert.match(reason, /git config --local --replace-all codexreview\.codex-0123456789abcdef\.mergeInto/);
});

test('統合先が複数記録されている場合もblockする', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-multi-target'));
  fx.git(['config', '--local', '--add', `codexreview.${wt.name}.mergeInto`, 'other-branch']);
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const reason = blockReason(stopHook(fx, wt.path));

  assert.match(reason, /統合先が複数記録されています/);
  assert.match(reason, /main, other-branch/);
});

test('統合先ブランチが削除されている場合もblockする', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-deleted-target'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['checkout', '-b', 'keep-something']);
  fx.git(['branch', '-D', 'main']);

  const reason = blockReason(stopHook(fx, wt.path));

  assert.match(reason, /統合先ブランチ main が存在しません/);
});

test('統合先の記録がブランチ名として不正な場合もblockする', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-invalid-target'));
  fx.git(['config', '--local', '--replace-all', `codexreview.${wt.name}.mergeInto`, '--upload-pack=evil']);
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const reason = blockReason(stopHook(fx, wt.path));

  assert.match(reason, /ブランチ名として不正/);
});

test('worktreeがdetached HEADの場合もblockする', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-detached'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  fx.git(['checkout', '--detach'], wt.path);

  const reason = blockReason(stopHook(fx, wt.path));

  assert.match(reason, /detached HEAD/);
});

// ---------------------------------------------------------------------------
// 3. blockしない場合
// ---------------------------------------------------------------------------

test('コミットが1つも無いworktreeではblockしない', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-no-commit'));

  const result = stopHook(fx, wt.path);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('共有チェックアウト（分離していない）ではblockしない', (t) => {
  const fx = fixture(t);
  commitIn(fx, fx.shared, 'feature.txt', 'feature\n', 'add feature');

  const result = stopHook(fx, fx.shared);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('codex-review が作ったものではないworktreeではblockしない', (t) => {
  const fx = fixture(t);
  const path = join(fx.shared, '.claude', 'worktrees', 'hand-made');
  fx.git(['worktree', 'add', '-b', 'hand-made-branch', path, 'HEAD']);
  writeFileSync(join(path, '.codex-review-auto'), '');
  commitIn(fx, path, 'feature.txt', 'feature\n', 'add feature');

  const result = stopHook(fx, path);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('未レビューの差分がある間は、mergeではなくレビューを要求する', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-dirty-first'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  writeFileSync(join(wt.path, 'feature.txt'), 'edited after commit\n');

  const reason = blockReason(stopHook(fx, wt.path));

  assert.match(reason, /まだ Codex レビューを通していない変更/);
  assert.doesNotMatch(reason, /まだ元のブランチへmergeしていない/);
});

test('自動レビューが有効でないworktreeでは何もしない', (t) => {
  const fx = fixture(t);
  // `.codex-review-auto` を置かない（armWorktreeを通さない）。
  const wt = addWorktree(fx, 'session-flagless');
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');

  const result = stopHook(fx, wt.path);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// 4. 状態ファイルが壊れていても閉じ込めない
// ---------------------------------------------------------------------------

test('状態ファイルが壊れていたら、診断を出して通す', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-broken-state'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  blockReason(stopHook(fx, wt.path));

  const { stateKey } = require('../scripts/state-core.js');
  const statePath = join(
    fx.home, '.claude', 'codex-review-state',
    `${stateKey(fx.git(['rev-parse', '--show-toplevel'], wt.path).trim())}.json`,
  );
  writeFileSync(statePath, '{ this is not json');

  const result = stopHook(fx, wt.path);
  const output = outputOf(result);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(output.systemMessage, '無言では通さない');
  assert.match(output.systemMessage, /確認ができませんでした/);
  assert.equal(output.decision, undefined, '永久blockしない');
});

test('mergeを求めるblockの後でも、通常のレビュー検知は動き続ける', (t) => {
  const fx = fixture(t);
  const wt = armWorktree(addWorktree(fx, 'session-review-after-merge-block'));
  commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  blockReason(stopHook(fx, wt.path));

  // merge衝突を専用worktreeへ戻した後の状態（未レビュー差分がある）を作る。
  writeFileSync(join(wt.path, 'feature.txt'), 'conflict resolution\n');

  const reason = blockReason(stopHook(fx, wt.path));
  assert.match(reason, /まだ Codex レビューを通していない変更/);
});

// ---------------------------------------------------------------------------
// 5. 同名タグ
// ---------------------------------------------------------------------------

test('統合先と同名のタグがあっても、正しいブランチへmergeする', (t) => {
  const fx = fixture(t);
  fx.git(['tag', 'main', 'HEAD']);
  const wt = armWorktree(addWorktree(fx, 'session-tag-shadow'));
  const head = commitIn(fx, wt.path, 'feature.txt', 'feature\n', 'add feature');
  const tagBefore = fx.git(['rev-parse', 'refs/tags/main']).trim();

  const merged = mergeReviewed(fx, wt.path);

  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(merged.stdout.trim(), `MERGED main ${head} fast-forward`);
  assert.equal(fx.git(['rev-parse', 'refs/heads/main']).trim(), head);
  assert.equal(fx.git(['rev-parse', 'refs/tags/main']).trim(), tagBefore, 'タグは動かない');
  assert.equal(stopHook(fx, wt.path).stdout.trim(), '', 'merge済みなのでblockしない');
});

test('同名タグがある状態で記録された統合先は heads/ 付きにならない', (t) => {
  const fx = fixture(t);
  fx.git(['tag', 'main', 'HEAD']);
  const wt = addWorktree(fx, 'session-tag-record');

  const recorded = tryRun(
    ['git', 'config', '--local', '--get-all', `codexreview.${wt.name}.mergeInto`],
    { cwd: fx.shared, env: fx.env },
  ).stdout.trim();

  assert.equal(recorded, 'main');
});
