#!/usr/bin/env node
'use strict';

/**
 * worktree-guard.js が「共有チェックアウトのどのパスを書かせるか」の回帰テスト。
 *
 *   node --test .claude/skills/codex-review/tests/worktree-guard.test.js
 *
 * ここは許可リストの範囲そのものが仕様なので、denyされることだけでなく
 * **許可される対象が増えていないこと**を1件ずつ確かめる。
 *
 * かつては `.claude/` 配下を丸ごと許可していた。設定の置き場という理由づけだったが、
 * `.claude/skills/` や `.claude/agents/` は追跡対象の普通のプロジェクトファイルで、
 * スキル自体を開発するリポジトリでは**実際に編集するファイルだけガードが効かない**
 * 状態になっていた。前方一致で許可する実装に戻さないための境界テストでもある。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const { WORKTREE_GUARD, addWorktree, fixture, tryRun } = require('./helpers.js');

/**
 * PreToolUseイベントをguardへ渡し、判定を返す。
 * hookは許可のとき何も書かないので、空出力＝allow。
 */
function guard(fx, target, options = {}) {
  const cwd = options.cwd ?? fx.shared;
  const result = tryRun(['node', WORKTREE_GUARD], {
    cwd,
    env: fx.env,
    input: JSON.stringify({
      cwd,
      session_id: options.sessionId ?? 'session-guard',
      tool_name: options.tool ?? 'Write',
      tool_input: { file_path: options.absolute ?? join(options.root ?? fx.shared, target) },
    }),
  });
  assert.equal(result.code, 0, `hookは常に終了コード0で返す: ${result.stderr}`);
  const output = result.stdout.trim();
  if (!output) return { decision: 'allow', reason: null };
  const parsed = JSON.parse(output);
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision ?? 'allow',
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? null,
    systemMessage: parsed.systemMessage ?? null,
  };
}

/** 対象ファイルの親ディレクトリを作る（guardはパスの実在に依存しないが、実運用に近づける）。 */
function touch(fx, target, content = 'x') {
  const path = join(fx.shared, target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// 1. `.claude/` は丸ごと許可しない
// ---------------------------------------------------------------------------

test('共有ツリーの .claude/skills/ への書き込みは拒否する', (t) => {
  const fx = fixture(t);

  const result = guard(fx, '.claude/skills/example/SKILL.md');

  assert.equal(result.decision, 'deny', '.claude/配下でもスキル本体は共有ツリーで書かせない');
  assert.match(result.reason, /EnterWorktree\(name:/, '移動手順を提示する');
});

test('共有ツリーの .claude/settings.json への書き込みは拒否する', (t) => {
  const fx = fixture(t);
  touch(fx, '.claude/settings.json', '{}\n');

  const result = guard(fx, '.claude/settings.json');

  assert.equal(result.decision, 'deny', '追跡対象の共有設定は上書き競合そのもの');
});

test('共有ツリーの .claude/ 直下・その他サブディレクトリも拒否する', (t) => {
  const fx = fixture(t);

  for (const target of [
    '.claude/agents/reviewer.md',
    '.claude/commands/deploy.md',
    '.claude/CLAUDE.md',
    '.claude/settings.local.json.bak',
    '.claude/worktrees.txt',
  ]) {
    assert.equal(guard(fx, target).decision, 'deny', `${target} は許可しない`);
  }
});

test('許可リストの前方一致で通り抜けられない', (t) => {
  const fx = fixture(t);

  for (const target of [
    '.gitignore.bak',
    '.worktreeincludes/extra.txt',
    '.codex-review-auto.bak',
    'src/.claude/settings.local.json',
  ]) {
    assert.equal(guard(fx, target).decision, 'deny', `${target} は完全一致しないので許可しない`);
  }
});

// ---------------------------------------------------------------------------
// 2. 共有チェックアウトにしか置けないものは許可する
// ---------------------------------------------------------------------------

test('分離のON/OFFスイッチとセットアップ対象は許可する', (t) => {
  const fx = fixture(t);

  for (const target of [
    '.codex-review-auto',
    '.codex-review-no-worktree',
    '.gitignore',
    '.worktreeinclude',
    '.claude/settings.local.json',
  ]) {
    assert.equal(guard(fx, target).decision, 'allow', `${target} は共有ツリーで書けないと困る`);
  }
});

test('worktree置き場の中は許可する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-guard-worktree');

  const result = guard(fx, null, { absolute: join(wt.path, 'src', 'feature.ts') });

  assert.equal(result.decision, 'allow', 'worktreeへの書き込みは狙いどおりの結果');
});

test('リポジトリ外への書き込みには関与しない', (t) => {
  const fx = fixture(t);

  const result = guard(fx, null, { absolute: join(fx.base, 'outside.txt') });

  assert.equal(result.decision, 'allow');
});

// ---------------------------------------------------------------------------
// 3. 分離済みセッションには何も言わない
// ---------------------------------------------------------------------------

test('linked worktree内なら .claude/skills/ でも許可する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-guard-inside');

  const result = guard(fx, null, {
    cwd: wt.path,
    absolute: join(wt.path, '.claude', 'skills', 'example', 'SKILL.md'),
  });

  assert.equal(result.decision, 'allow', '分離済みなら共有ツリーの心配は無い');
});

test('自動レビューが無効なリポジトリでは判定しない', (t) => {
  const fx = fixture(t);
  require('node:fs').unlinkSync(join(fx.shared, '.codex-review-auto'));

  assert.equal(guard(fx, '.claude/skills/example/SKILL.md').decision, 'allow');
});

test('オプトアウトしているリポジトリでは判定しない', (t) => {
  const fx = fixture(t);
  writeFileSync(join(fx.shared, '.codex-review-no-worktree'), '');

  assert.equal(guard(fx, '.claude/skills/example/SKILL.md').decision, 'allow');
});
