'use strict';

/**
 * 隔離リポジトリと、テストからスクリプトを呼ぶための共通ヘルパー。
 *
 * どのテストファイルも一時ディレクトリの隔離gitリポジトリで実行し、ホーム
 * ディレクトリも一時ディレクトリへ差し替える（`HOME` / `USERPROFILE`）。
 * 利用者の `~/.claude/codex-review-state/` と実際のgit設定には触れない。
 *
 * 一時ディレクトリ名には**意図的に空白を含める**。gitの引数をシェル経由で
 * 組み立てていれば、ここで壊れる。
 */

const { execFile, execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { stateKey } = require('../scripts/state-core.js');
const { worktreeName } = require('../scripts/worktree-core.js');

const SCRIPTS = resolve(__dirname, '..', 'scripts');
const MERGE_REVIEWED = join(SCRIPTS, 'merge-reviewed.js');
const MARK_PROMPT = join(SCRIPTS, 'mark-prompt.js');
const WORKTREE_GUARD = join(SCRIPTS, 'worktree-guard.js');
const COMMIT_REVIEWED = join(SCRIPTS, 'commit-reviewed.js');
const COMMIT_SHARED_WIP = join(SCRIPTS, 'commit-shared-wip.js');
const STOP_HOOK = join(SCRIPTS, 'stop-hook.js');
const SETUP_AUTO = join(SCRIPTS, 'setup-auto.js');
const DOCTOR = join(SCRIPTS, 'doctor.js');

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
 * 揃えないと worktree 自体が未追跡として見え、fingerprint が壊れる。
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
  // hookはイベントJSONに無い値をこの2つの環境変数から補う。テストをClaude Code内で
  // 実行すると実セッションの値が継承され、「session_idが無い場合」を検証したつもりの
  // テストが常に「session_idがある場合」を通ってしまう。イベント入力だけを入力にする。
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PROJECT_DIR;

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

function gitOperationFile(fx, cwd, name) {
  const dir = fx.git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd).trim();
  return join(dir, name);
}

function reviewedCommitAll(fx, cwd, message) {
  const fingerprint = run(['node', STOP_HOOK, '--print'], { cwd, env: fx.env }).trim();
  return tryRun([
    'node', COMMIT_REVIEWED,
    '--expected', fingerprint,
    '--message', message,
    '--all',
  ], { cwd, env: fx.env });
}

/** Stop hook をフックとして起動する（イベントJSONをstdinで渡す）。 */
function stopHook(fx, cwd, sessionId = null) {
  return tryRun(['node', STOP_HOOK], {
    cwd,
    env: fx.env,
    input: JSON.stringify({ cwd, session_id: sessionId }),
  });
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

module.exports = {
  COMMIT_REVIEWED,
  COMMIT_SHARED_WIP,
  DOCTOR,
  MARK_PROMPT,
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
  stopHook,
  tryRun,
};
