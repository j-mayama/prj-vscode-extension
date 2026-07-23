#!/usr/bin/env node
'use strict';

/**
 * worktree-core.js の、パス比較とブランチ名解決の単体テスト。
 *
 *   node --test .claude/skills/codex-review/tests/worktree-core.test.js
 *
 * どちらも「同じものに複数の名前がある」ことが原因で静かに壊れた箇所なので、
 * hook 経由ではなく関数として直接確かめる。
 *
 * `subst` ドライブと 8.3 短縮名の生成は、環境（権限・NTFS設定）に依存して
 * 作れないことがある。作れない場合はスキップし、**未確認として扱う**。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, isAbsolute } = require('node:path');

const { canonicalPath, currentBranch, isInside } = require('../scripts/worktree-core.js');

function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), 'codex core test '));
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // 一時ディレクトリなので、消せなくても放置する。
    }
  });
  return base;
}

test('canonicalPathは存在しない書き込み先でも絶対パスを返す', (t) => {
  const base = scratch(t);
  const target = join(base, 'not-created-yet', 'deep', 'file.txt');

  const resolved = canonicalPath(target);

  assert.ok(isAbsolute(resolved));
  assert.ok(resolved.endsWith(join('not-created-yet', 'deep', 'file.txt')));
  assert.ok(isInside(canonicalPath(base), resolved), '実在する祖先の配下だと判定できる');
});

test('canonicalPathは実在しないルートでもresolve結果へフォールバックする', () => {
  const target = process.platform === 'win32'
    ? 'Q:\\no-such-drive\\file.txt'
    : '/no-such-root-dir-for-test/file.txt';

  assert.equal(canonicalPath(target), require('node:path').resolve(target));
});

test('symlink経由のパスでも同じ実体だと判定できる', (t) => {
  const base = scratch(t);
  const real = join(base, 'real');
  const link = join(base, 'link');
  mkdirSync(join(real, 'sub'), { recursive: true });
  writeFileSync(join(real, 'sub', 'file.txt'), 'x');

  try {
    // Windowsではjunctionなら通常権限で作れる。symlinkは開発者モードが要る。
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('このマシンではsymlink / junctionを作成できないため未確認');
    return;
  }

  const viaLink = canonicalPath(join(link, 'sub', 'file.txt'));

  assert.ok(
    isInside(canonicalPath(real), viaLink),
    'link経由の書き込み先が、実体側のディレクトリ配下だと判定できる',
  );
  // 正規化しない場合はこの判定が false になる ＝ ガードが「共有ツリーの外」と
  // 誤判断して書き込みを許していた経路。
  assert.equal(
    isInside(real, join(link, 'sub', 'file.txt')),
    false,
    '素のパス演算では別物と判定される（これがfail-openの原因だった）',
  );
});

test('8.3短縮名で与えられても同じ実体だと判定できる', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows以外では8.3短縮名が存在しないため対象外');
    return;
  }
  const base = scratch(t);
  const long = join(base, 'a very long directory name');
  mkdirSync(long, { recursive: true });

  let short;
  try {
    // `dir /x` が短縮名を持たない環境（NtfsDisable8dot3NameCreation=1）もある。
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', '/a:d', base], { encoding: 'latin1' });
    const match = listing.match(/\s([A-Z0-9~]{1,8}(?:\.[A-Z0-9]{1,3})?)\s+a very long directory name/i);
    if (!match) throw new Error('no short name');
    short = join(base, match[1]);
  } catch {
    t.skip('このマシンでは8.3短縮名が生成されないため未確認');
    return;
  }

  assert.equal(
    canonicalPath(join(short, 'file.txt')).toLowerCase(),
    canonicalPath(join(long, 'file.txt')).toLowerCase(),
    '短縮名と長い名前が同じ実体に正規化される',
  );
});

test('currentBranchは同名タグがあっても heads/ を付けない', (t) => {
  const base = scratch(t);
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
    GIT_CONFIG_SYSTEM: join(base, 'gitconfig-system'),
  };
  const git = (args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });

  git(['init', '-b', 'main', '.']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'codex-review test']);
  writeFileSync(join(repo, 'a.txt'), 'x');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  git(['tag', 'main', 'HEAD']);

  assert.equal(
    git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    'heads/main',
    '前提: rev-parse は曖昧さを避けて heads/ を付ける',
  );
  assert.equal(currentBranch(repo), 'main');

  git(['checkout', '--detach']);
  assert.equal(currentBranch(repo), null, 'detached HEADではnull');
});
