#!/usr/bin/env node
'use strict';

/**
 * merge-reviewed.js の自動テスト。
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
const { execFile, execFileSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { stateKey } = require('../scripts/state-core.js');
const { withLock } = require('../scripts/lock-core.js');
const { worktreeName } = require('../scripts/worktree-core.js');

const SCRIPTS = resolve(__dirname, '..', 'scripts');
const MERGE_REVIEWED = join(SCRIPTS, 'merge-reviewed.js');
const MARK_PROMPT = join(SCRIPTS, 'mark-prompt.js');

// 空白入りのプレフィックス。パスがシェルで再解釈されるなら全テストが落ちる。
const TMP_PREFIX = 'codex merge test ';

function run(args, options = {}) {
  return execFileSync(args[0], args.slice(1), {
    encoding: 'utf8',
    // `input` is silently dropped when stdio[0] is 'ignore', so stdin has to be
    // a pipe whenever the caller has something to feed the process.
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...options,
  });
}

/** 終了コードを例外にせず、stdout / stderr と一緒に返す。 */
function tryRun(args, options) {
  try {
    return { code: 0, stdout: run(args, options), stderr: '' };
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message),
    };
  }
}

function runAsync(args, options) {
  return new Promise((done) => {
    execFile(args[0], args.slice(1), { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      done({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * 隔離リポジトリ一式。
 *
 * `setup-auto.js` が作る構成に合わせる（フラグ・`.gitignore`・worktree置き場）。
 * 揃えないと mark-prompt.js は「共有ツリーがdirty」と判断し、統合先を記録しない。
 */
function fixture(t, options = {}) {
  const base = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // 一時ディレクトリなので、Windowsのread-onlyなpackファイルで消せなくても放置する。
    }
  });

  const home = join(base, 'home dir');
  const shared = join(base, 'shared checkout');
  mkdirSync(home, { recursive: true });
  mkdirSync(shared, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // 利用者のグローバル設定（merge.ff / commit.gpgsign 等）を持ち込まない。
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CONFIG_SYSTEM: join(home, 'gitconfig-system'),
    GIT_TERMINAL_PROMPT: '0',
  };

  const branch = options.branch ?? 'main';
  const git = (args, cwd = shared) => run(['git', ...args], { cwd, env });

  git(['init', '-b', branch, '.']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'codex-review test']);
  git(['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(shared, '.gitignore'), '.codex-review-auto\n.claude/settings.local.json\n.claude/worktrees/\n');
  writeFileSync(join(shared, 'sentinel.txt'), 'sentinel-original\n');
  writeFileSync(join(shared, 'shared-file.txt'), 'base\n');
  git(['add', '.gitignore', 'sentinel.txt', 'shared-file.txt']);
  git(['commit', '-m', 'initial']);
  writeFileSync(join(shared, '.codex-review-auto'), '');

  const commonDir = resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const lockPath = join(home, '.claude', 'codex-review-state', `${stateKey(commonDir)}.merge.lock`);

  return { base, home, shared, env, git, branch, lockPath };
}

/**
 * 実際の `UserPromptSubmit` hook を通して統合先を記録する。テスト側で
 * `git config` を直接書くと、記録経路そのものが検証されない。
 */
function markPrompt(fx, sessionId) {
  return tryRun(['node', MARK_PROMPT], {
    cwd: fx.shared,
    env: fx.env,
    input: JSON.stringify({ cwd: fx.shared, session_id: sessionId }),
  });
}

/** mark-prompt で統合先を記録してから、そのセッションのworktreeを作る。 */
function addWorktree(fx, sessionId) {
  markPrompt(fx, sessionId);
  const name = worktreeName(sessionId);
  const path = join(fx.shared, '.claude', 'worktrees', name);
  const branch = `worktree-${name}`;
  fx.git(['worktree', 'add', '-b', branch, path, 'HEAD']);
  return { name, path, branch };
}

function commitIn(fx, cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  fx.git(['add', '--', file], cwd);
  fx.git(['commit', '-m', message], cwd);
  return fx.git(['rev-parse', 'HEAD'], cwd).trim();
}

function mergeReviewed(fx, cwd) {
  return tryRun(['node', MERGE_REVIEWED], { cwd, env: fx.env });
}

function state(fx) {
  return {
    head: fx.git(['rev-parse', 'HEAD']).trim(),
    branch: fx.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    status: fx.git(['status', '--porcelain']),
  };
}

function shaOf(fx, ref, cwd = fx.shared) {
  return fx.git(['rev-parse', '--verify', ref], cwd).trim();
}

function isAncestor(fx, ancestor, descendant) {
  return tryRun(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: fx.shared,
    env: fx.env,
  }).code === 0;
}

function recordedTarget(fx, name) {
  return tryRun(['git', 'config', '--local', '--get-all', `codexreview.${name}.mergeInto`], {
    cwd: fx.shared,
    env: fx.env,
  }).stdout.trim();
}

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
// 5. 衝突時にabortされ、HEAD・index・working treeが実行前と一致
// ---------------------------------------------------------------------------

test('衝突したらabortして、HEAD・index・working treeを実行前へ戻す', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-conflict');

  commitIn(fx, wt.path, 'shared-file.txt', 'from worktree\n', 'edit in worktree');
  commitIn(fx, fx.shared, 'shared-file.txt', 'from shared\n', 'edit in shared');

  const before = state(fx);
  const contentBefore = readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8');
  const diffBefore = fx.git(['diff', 'HEAD']);

  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /mergeに失敗しました/);
  assert.deepEqual(state(fx), before, 'HEAD・statusとも実行前と一致');
  assert.equal(readFileSync(join(fx.shared, 'shared-file.txt'), 'utf8'), contentBefore, '衝突マーカーが残っていない');
  assert.equal(fx.git(['diff', 'HEAD']), diffBefore, 'indexにも差分が残っていない');
  assert.ok(!existsSync(join(fx.shared, '.git', 'MERGE_HEAD')), 'merge途中の状態が残っていない');
});

// ---------------------------------------------------------------------------
// 6. merge対象と衝突する未追跡ファイルが保持される
// ---------------------------------------------------------------------------

test('mergeが上書きする未追跡ファイルがあると、mergeせず内容を保持する', (t) => {
  const fx = fixture(t);
  const wt = addWorktree(fx, 'session-untracked-clash');

  commitIn(fx, wt.path, 'feature.txt', 'from worktree\n', 'add feature');
  writeFileSync(join(fx.shared, 'feature.txt'), 'untracked local work\n');

  const before = state(fx);
  const result = mergeReviewed(fx, wt.path);

  assert.equal(result.code, 1);
  assert.equal(
    readFileSync(join(fx.shared, 'feature.txt'), 'utf8'),
    'untracked local work\n',
    '未追跡ファイルの内容が保持されている',
  );
  assert.deepEqual(state(fx), before, 'HEAD・statusとも実行前と一致');
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

  // 衝突させて失敗経路を通す。
  commitIn(fx, wt.path, 'shared-file.txt', 'from worktree\n', 'edit in worktree');
  commitIn(fx, fx.shared, 'shared-file.txt', 'from shared\n', 'edit in shared');
  const ng = mergeReviewed(fx, wt.path);
  assert.equal(ng.code, 1);
  assert.ok(!existsSync(fx.lockPath), '失敗後にもロックが残っていない');
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
