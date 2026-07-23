#!/usr/bin/env node
'use strict';

/**
 * Enables codex-review for the current git repository.
 *
 * The setup is project-local:
 * - registers UserPromptSubmit and Stop hooks in .claude/settings.local.json
 * - ignores local settings and the opt-in flag in git
 * - enables schedule-based mode selection for a new/unset config
 * - creates .codex-review-auto last, after the rest succeeds
 *
 * Usage:
 *   node setup-auto.js
 *   node setup-auto.js --enable-schedule
 *   node setup-auto.js --migrate-legacy-hooks
 *   node setup-auto.js --disable
 */

const { spawnSync, execFileSync } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

const {
  CONFIG_PATH,
  readConfig,
  withConfigLock,
  writeConfig,
} = require('./config-core.js');
const { validate } = require('./config.js');
const { renameAtomic } = require('./file-core.js');
const { resetClaims } = require('./state-core.js');
const { OPT_OUT_FILE, WORKTREE_RELATIVE } = require('./worktree-core.js');

const FLAG_FILE = '.codex-review-auto';
const SETUP_LOCK_FILE = '.codex-review-setup.lock';
const LOCAL_SETTINGS = join('.claude', 'settings.local.json');
const GLOBAL_SETTINGS = join(homedir(), '.claude', 'settings.json');
const WORKTREE_INCLUDE = '.worktreeinclude';
// `.claude/worktrees/` is not optional. Claude Code puts session worktrees there,
// inside the repository, and git does not ignore a nested worktree on its own: it
// surfaces as an untracked directory. The Stop hook's fingerprint pipes the
// untracked list into `git hash-object --stdin-paths`, which fails on a directory
// — so the hook would throw, fail open, and stop reviewing while still looking
// clean. Verified by reproducing it before adding this line.
const IGNORE_LINES = [
  '.claude/settings.local.json',
  `${WORKTREE_RELATIVE}/`,
  FLAG_FILE,
  OPT_OUT_FILE,
  SETUP_LOCK_FILE,
];
// Only what this skill needs to keep working inside a worktree, and only files
// that are already gitignored (which is all `.worktreeinclude` can copy).
// `.env`, keys and credentials are deliberately absent: the worktree docs show
// copying them, but this skill will not opt a repository into propagating
// secrets as a side effect of enabling code review.
const WORKTREE_INCLUDE_LINES = [FLAG_FILE, '.claude/settings.local.json'];
const STALE_LOCK_MS = 5 * 60 * 1000;

const die = (message) => {
  process.stderr.write(`codex-review: ${message}\n`);
  process.exit(1);
};

function gitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('git リポジトリ内で実行してください');
  }
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} のルートは JSON オブジェクトにしてください`);
    }
    return value;
  } catch (error) {
    throw new Error(`${path} を読み込めません: ${error.message}`);
  }
}

function readJsonSnapshot(snapshotValue) {
  if (!snapshotValue.existed) return {};
  try {
    const value = JSON.parse(snapshotValue.content.replace(/^\uFEFF/, ''));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ルートは JSON オブジェクトにしてください');
    }
    return value;
  } catch (error) {
    throw new Error(`${snapshotValue.path} を読み込めません: ${error.message}`);
  }
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const existingMode = existsSync(path) ? lstatSync(path).mode & 0o7777 : null;
  try {
    writeFileSync(tmp, content, existingMode === null ? undefined : { mode: existingMode });
    if (existingMode !== null) chmodSync(tmp, existingMode);
    renameAtomic(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }
}

function snapshot(path) {
  return {
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path, 'utf8') : null,
  };
}

function snapshotMatches(snapshotValue) {
  if (existsSync(snapshotValue.path) !== snapshotValue.existed) return false;
  if (!snapshotValue.existed) return true;
  return readFileSync(snapshotValue.path, 'utf8') === snapshotValue.content;
}

function assertSnapshotUnchanged(snapshotValue) {
  if (!snapshotMatches(snapshotValue)) {
    throw new Error(`${snapshotValue.path} がセットアップ中に変更されました。内容を上書きせず中止します`);
  }
}

function restore(snapshotValue) {
  if (snapshotValue.existed) {
    writeAtomic(snapshotValue.path, snapshotValue.content);
  } else if (existsSync(snapshotValue.path)) {
    unlinkSync(snapshotValue.path);
  }
}

function ensureRegularWriteTarget(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${path} は通常ファイルではありません。既存のパスを確認してください`);
  }
}

function ensureProjectWriteTarget(root, path) {
  const projectRoot = resolve(root);
  const target = resolve(path);
  const fromRoot = relative(projectRoot, target);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${target} は現在のリポジトリ内の書き込み先ではありません`);
  }

  const rootStat = lstatSync(projectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${projectRoot} は実ディレクトリのリポジトリルートではありません`);
  }

  const parts = fromRoot.split(/[\\/]+/).filter(Boolean);
  let current = projectRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${current} は実ディレクトリではありません。リポジトリ外への書き込みを防ぐため中止します`);
    }
  }
  ensureRegularWriteTarget(target);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function setupLockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value?.owner !== 'codex-review-setup' ||
      value?.version !== 1 ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !value.token.startsWith(`${value.pid}-`) ||
      typeof value.at !== 'string' ||
      Number.isNaN(Date.parse(value.at))
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function projectFileIsTracked(root, relativePath) {
  return spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', relativePath],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] }
  ).status === 0;
}

function setupLockIsTracked(root, relativePath = SETUP_LOCK_FILE) {
  return projectFileIsTracked(root, relativePath);
}

function finishSetupLockCleanup(root, lock, cleanupLock) {
  let claim;
  try {
    claim = statSync(cleanupLock);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const owner = setupLockOwner(cleanupLock);
  if (!owner || setupLockIsTracked(root, `${SETUP_LOCK_FILE}.cleanup`)) {
    throw new Error(
      `所有を確認できないcleanup lockを保持して中止します: ${cleanupLock}`
    );
  }
  try {
    const current = statSync(lock);
    if (
      sameFile(claim, current) &&
      Date.now() - claim.mtimeMs > STALE_LOCK_MS &&
      owner &&
      !processIsAlive(owner.pid) &&
      !setupLockIsTracked(root)
    ) {
      unlinkSync(lock);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    unlinkSync(cleanupLock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function releaseSetupLock(lock, token) {
  try {
    const current = JSON.parse(readFileSync(lock, 'utf8'));
    if (current.token === token) unlinkSync(lock);
  } catch {
    // A stale-lock helper may already have removed or replaced it.
  }
}

function withProjectSetupLock(root, action) {
  const lock = join(root, SETUP_LOCK_FILE);
  const cleanupLock = `${lock}.cleanup`;
  ensureProjectWriteTarget(root, lock);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(cleanupLock)) {
      finishSetupLockCleanup(root, lock, cleanupLock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      writeFileSync(
        lock,
        `${JSON.stringify({
          owner: 'codex-review-setup',
          version: 1,
          token,
          pid: process.pid,
          at: new Date().toISOString(),
        })}\n`,
        { flag: 'wx', mode: 0o600 }
      );
      acquired = true;
      if (existsSync(cleanupLock)) {
        releaseSetupLock(lock, token);
        acquired = false;
        finishSetupLockCleanup(root, lock, cleanupLock);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          try {
            linkSync(lock, cleanupLock);
          } catch (cleanupError) {
            if (!['EEXIST', 'ENOENT'].includes(cleanupError.code)) throw cleanupError;
          }
          finishSetupLockCleanup(root, lock, cleanupLock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (!acquired) throw new Error(`セットアップロックを10秒以内に取得できませんでした: ${lock}`);
  try {
    return action();
  } finally {
    releaseSetupLock(lock, token);
  }
}

function normalized(path) {
  return resolve(path).replace(/\\/g, '/');
}

function canonicalPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved).replace(/\\/g, '/');
  } catch {
    return resolved.replace(/\\/g, '/');
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((path) => {
    const canonical = canonicalPath(path);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hookCommand(path) {
  const script = normalized(path);
  if (process.platform === 'win32') {
    if (script.includes('"')) throw new Error(`hookのパスに引用符を含められません: ${script}`);
    if (script.includes('%')) {
      throw new Error(
        `hookのパスに%を含められません（Windows shellで環境変数展開されるため）: ${script}`
      );
    }
    return `node "${script}"`;
  }
  return `node '${script.replace(/'/g, `'\"'\"'`)}'`;
}

function isCodexReviewHandler(handler, scriptName) {
  if (!handler || typeof handler !== 'object') return false;
  const values = [
    typeof handler.command === 'string' ? handler.command : '',
    ...(Array.isArray(handler.args) ? handler.args.map(String) : []),
  ];
  return values.some((value) =>
    value.replace(/\\/g, '/').includes(`/codex-review/scripts/${scriptName}`)
  );
}

function installEvent(settings, eventName, scriptName, matcher = null) {
  if (settings.hooks === undefined) settings.hooks = {};
  if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new Error('settings.json の hooks は JSON オブジェクトにしてください');
  }

  const current = settings.hooks[eventName] ?? [];
  if (!Array.isArray(current)) throw new Error(`settings.json の hooks.${eventName} は配列にしてください`);

  const groups = [];
  for (const group of current) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`settings.json の hooks.${eventName} に不正な要素があります`);
    }
    if (!Array.isArray(group.hooks)) {
      throw new Error(`settings.json の hooks.${eventName}[].hooks は配列にしてください`);
    }
    const handlers = group.hooks;
    const kept = handlers.filter((handler) => !isCodexReviewHandler(handler, scriptName));
    if (kept.length || !handlers.some((handler) => isCodexReviewHandler(handler, scriptName))) {
      groups.push({ ...group, hooks: kept });
    }
  }

  groups.push({
    // Only letters and `|`, so Claude Code compares it as a list of exact tool
    // names rather than an unanchored regular expression.
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: 'command',
        command: hookCommand(join(__dirname, scriptName)),
        timeout: 30,
      },
    ],
  });
  settings.hooks[eventName] = groups;
}

/**
 * Branch session worktrees from the local HEAD.
 *
 * The default is `"fresh"`, which branches from `origin/<default-branch>` — for
 * this skill that is the wrong tree: a session would be isolated onto the remote's
 * state and review code the user never wrote, while their local commits went
 * missing. Only fills the key in when it is absent, so an explicit choice by the
 * user (or another tool) is never rewritten.
 */
function ensureBaseRef(settings) {
  if (settings.worktree === undefined) settings.worktree = {};
  if (
    settings.worktree === null ||
    typeof settings.worktree !== 'object' ||
    Array.isArray(settings.worktree)
  ) {
    throw new Error('settings.json の worktree は JSON オブジェクトにしてください');
  }
  if (Object.prototype.hasOwnProperty.call(settings.worktree, 'baseRef')) {
    return settings.worktree.baseRef === 'head';
  }
  settings.worktree.baseRef = 'head';
  return true;
}

/**
 * Additive, like the .gitignore handling: append only the missing lines so a
 * user's existing `.worktreeinclude` keeps whatever it already copies.
 */
function worktreeIncludeContent(path) {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = original.split(/\r?\n/);
  const missing = WORKTREE_INCLUDE_LINES.filter((entry) => !lines.includes(entry));
  if (!missing.length) return original;

  const prefix = original.length && !original.endsWith('\n') ? '\n' : '';
  const section = [
    '# codex-review: worktree でも自動レビューを動かすために複製する',
    ...missing,
    '',
  ].join('\n');
  return `${original}${prefix}${section}`;
}

function removeCodexReviewHandlers(settings, settingsPath) {
  const next = JSON.parse(JSON.stringify(settings));
  if (next.hooks === undefined) return { settings: next, removed: 0 };
  if (next.hooks === null || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    throw new Error(`${settingsPath} の hooks は JSON オブジェクトにしてください`);
  }

  let removed = 0;
  for (const [eventName, current] of Object.entries(next.hooks)) {
    if (!Array.isArray(current)) {
      throw new Error(`${settingsPath} の hooks.${eventName} は配列にしてください`);
    }
    const groups = [];
    for (const group of current) {
      if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks)) {
        throw new Error(`${settingsPath} の hooks.${eventName} に不正な要素があります`);
      }
      const kept = group.hooks.filter((handler) => {
        const isCodexReview =
          isCodexReviewHandler(handler, 'mark-prompt.js') ||
          isCodexReviewHandler(handler, 'stop-hook.js') ||
          isCodexReviewHandler(handler, 'worktree-guard.js');
        if (isCodexReview) removed += 1;
        return !isCodexReview;
      });
      if (kept.length) groups.push({ ...group, hooks: kept });
    }
    if (groups.length) next.hooks[eventName] = groups;
    else delete next.hooks[eventName];
  }
  return { settings: next, removed };
}

function ignoredContent(path) {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = original.split(/\r?\n/);
  const missing = IGNORE_LINES.filter((entry) => !lines.includes(entry));
  if (!missing.length) return original;

  const prefix = original.length && !original.endsWith('\n') ? '\n' : '';
  const section = [
    '# codex-review のローカル設定と ON/OFF スイッチ',
    ...missing,
    '',
  ].join('\n');
  return `${original}${prefix}${section}`;
}

function enableUnlocked(root) {
  const migrateLegacyHooks =
    process.argv.includes('--migrate-legacy-hooks') ||
    process.argv.includes('--migrate-global-hooks');
  const enableSchedule = process.argv.includes('--enable-schedule');
  const settingsPath = join(root, LOCAL_SETTINGS);
  const projectSettingsPath = join(root, '.claude', 'settings.json');
  const ignorePath = join(root, '.gitignore');
  const worktreeIncludePath = join(root, WORKTREE_INCLUDE);
  const flagPath = join(root, FLAG_FILE);
  const flagExisted = existsSync(flagPath);
  let flagCreated = false;
  if (projectFileIsTracked(root, LOCAL_SETTINGS.replace(/\\/g, '/'))) {
    throw new Error(
      [
        `${LOCAL_SETTINGS} はgit追跡済みのため変更しません。`,
        'このファイルには端末固有の絶対パスが入るため、publicリポジトリへコミットできません。',
        `追跡を外して内容を確認してから再実行してください: git rm --cached -- "${LOCAL_SETTINGS.replace(/\\/g, '/')}"`,
      ].join('\n')
    );
  }
  ensureProjectWriteTarget(root, flagPath);
  ensureProjectWriteTarget(root, settingsPath);
  ensureProjectWriteTarget(root, projectSettingsPath);
  ensureProjectWriteTarget(root, ignorePath);
  ensureProjectWriteTarget(root, worktreeIncludePath);

  const migrations = uniquePaths([GLOBAL_SETTINGS, projectSettingsPath])
    .map((path) => {
      const original = snapshot(path);
      const result = removeCodexReviewHandlers(readJsonSnapshot(original), path);
      return { path, original, ...result };
    })
    .filter((migration) => migration.removed > 0);
  const removedLegacyHooks = migrations.reduce((sum, migration) => sum + migration.removed, 0);
  for (const migration of migrations) ensureRegularWriteTarget(migration.path);
  if (removedLegacyHooks && !migrateLegacyHooks) {
    throw new Error(
      [
        `旧方式の codex-review hook が ${removedLegacyHooks} 件あります:`,
        ...migrations.map((migration) => `  ${migration.path} (${migration.removed} 件)`),
        '新旧の Stop hook が競合すると休日モードが正しく動かないため、まだ有効化していません。',
        'グローバルhookを使う他のリポジトリへの影響も確認してから、次を明示的に実行してください:',
        `  node "${join(__dirname, 'setup-auto.js')}" --migrate-legacy-hooks${enableSchedule ? ' --enable-schedule' : ''}`,
      ].join('\n')
    );
  }

  const projectOriginals = [
    ...migrations.map((migration) => migration.original),
    snapshot(settingsPath),
    snapshot(ignorePath),
    snapshot(worktreeIncludePath),
  ];
  const originalsByPath = new Map(projectOriginals.map((original) => [resolve(original.path), original]));
  const settings = readJson(settingsPath);
  installEvent(settings, 'UserPromptSubmit', 'mark-prompt.js');
  installEvent(settings, 'Stop', 'stop-hook.js');
  installEvent(settings, 'PreToolUse', 'worktree-guard.js', 'Edit|Write|NotebookEdit|Bash');
  const baseRefIsHead = ensureBaseRef(settings);
  const settingsContent = `${JSON.stringify(settings, null, 2)}\n`;
  const ignoreContent = ignoredContent(ignorePath);
  const worktreeIncludeContentValue = worktreeIncludeContent(worktreeIncludePath);

  // Snapshot and update the shared config in one critical section. Capturing the
  // rollback baseline before acquiring this lock could erase another session's
  // update if the project phase later failed.
  let configOriginal;
  let configGeneration;
  let scheduleEnabled;
  withConfigLock(() => {
    configOriginal = snapshot(CONFIG_PATH);
    const config = readConfig({ strict: true });
    if (!configOriginal.existed) {
      config.mode = 'inherit';
      config.schedule = { ...config.schedule, enabled: true };
    } else {
      const raw = readJsonSnapshot(configOriginal);
      const hasScheduleChoice =
        raw.schedule &&
        typeof raw.schedule === 'object' &&
        !Array.isArray(raw.schedule) &&
        Object.prototype.hasOwnProperty.call(raw.schedule, 'enabled');
      if (enableSchedule || !hasScheduleChoice) {
        config.schedule = { ...config.schedule, enabled: true };
      }
    }
    validate(config);
    scheduleEnabled = config.schedule.enabled === true;
    configGeneration = writeConfig(config);
  });
  const originals = [configOriginal, ...projectOriginals];
  const writtenContents = new Map();

  try {
    for (const migration of migrations) {
      if (resolve(migration.path) === resolve(projectSettingsPath)) {
        ensureProjectWriteTarget(root, migration.path);
      } else {
        ensureRegularWriteTarget(migration.path);
      }
      const original = originalsByPath.get(resolve(migration.path));
      assertSnapshotUnchanged(original);
      const content = `${JSON.stringify(migration.settings, null, 2)}\n`;
      writeAtomic(migration.path, content);
      writtenContents.set(resolve(migration.path), content);
    }
    ensureProjectWriteTarget(root, settingsPath);
    assertSnapshotUnchanged(originalsByPath.get(resolve(settingsPath)));
    writeAtomic(settingsPath, settingsContent);
    writtenContents.set(resolve(settingsPath), settingsContent);
    ensureProjectWriteTarget(root, ignorePath);
    assertSnapshotUnchanged(originalsByPath.get(resolve(ignorePath)));
    writeAtomic(ignorePath, ignoreContent);
    writtenContents.set(resolve(ignorePath), ignoreContent);
    ensureProjectWriteTarget(root, worktreeIncludePath);
    assertSnapshotUnchanged(originalsByPath.get(resolve(worktreeIncludePath)));
    writeAtomic(worktreeIncludePath, worktreeIncludeContentValue);
    writtenContents.set(resolve(worktreeIncludePath), worktreeIncludeContentValue);
    ensureProjectWriteTarget(root, flagPath);
    if (!existsSync(flagPath)) {
      writeFileSync(flagPath, '', { flag: 'wx' });
      flagCreated = true;
    }
    // A previous review may have been interrupted after taking its per-diff
    // claim. Explicitly enabling the feature is a fresh start, so do not leave
    // the unchanged worktree permanently skipped by that abandoned claim.
    resetClaims(root);
  } catch (error) {
    const rollbackErrors = [];
    for (const original of originals.reverse()) {
      try {
        if (original.path === CONFIG_PATH) {
          withConfigLock(() => {
            let currentGeneration = null;
            try {
              currentGeneration = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))._codex_review_generation;
            } catch {
              // A concurrent delete or malformed rewrite is not ours to replace.
            }
            if (currentGeneration !== configGeneration) {
              rollbackErrors.push(`${CONFIG_PATH}: 別セッションの更新を検出したため復元を省略`);
              return;
            }
            restore(original);
          });
          continue;
        }
        const expected = writtenContents.get(resolve(original.path));
        if (expected === undefined) continue;
        const current = existsSync(original.path) ? readFileSync(original.path, 'utf8') : null;
        if (current !== expected) {
          rollbackErrors.push(`${original.path}: 別セッションの更新を検出したため復元を省略`);
          continue;
        }
        restore(original);
      } catch (rollbackError) {
        rollbackErrors.push(`${original.path}: ${rollbackError.message}`);
      }
    }
    if (!flagExisted && flagCreated) {
      try {
        if (existsSync(flagPath)) unlinkSync(flagPath);
      } catch (rollbackError) {
        rollbackErrors.push(`${flagPath}: ${rollbackError.message}`);
      }
    }
    const suffix = rollbackErrors.length
      ? ` / ロールバックにも失敗: ${rollbackErrors.join(' / ')}`
      : '';
    throw new Error(`セットアップに失敗したため変更を元へ戻しました: ${error.message}${suffix}`);
  }

  process.stdout.write(
    [
      'codex-review: 自動レビューを有効にしました',
      `  hooks  : ${settingsPath}`,
      `  config : ${CONFIG_PATH}`,
      `  flag   : ${flagPath}`,
      scheduleEnabled
        ? '  mode   : 指示時刻による自動判定を有効化（詳細は `/codex-review config`）'
        : '  mode   : 既存のスケジュールOFFを保持（休日判定はまだ無効）',
      baseRefIsHead
        ? '  worktree: 実装セッションを専用ブランチ＋worktreeへ分離（現在のHEAD基準）'
        : '  worktree: 既存の worktree.baseRef 設定を保持したため、分離は origin 基準のままです',
      ...(baseRefIsHead
        ? []
        : [
            `           現在のHEADから分岐させる場合は ${settingsPath} の`,
            '           worktree.baseRef を "head" にしてください。',
          ]),
      '',
      'Claude Code の /hooks で UserPromptSubmit / Stop / PreToolUse が表示されることを確認してください。',
      scheduleEnabled
        ? '勤務日・時間を変える場合は `/codex-review auto` を実行してください。'
        : '休日モードを使うには `/codex-review auto` を実行してください。',
      ...(removedLegacyHooks
        ? [
            '',
            `旧方式のhook ${removedLegacyHooks} 件を削除しました。`,
            '他のリポジトリでも必要に応じて setup-auto.js を実行してください。',
          ]
        : []),
      '',
    ].join('\n')
  );
}

function enable(root) {
  return withProjectSetupLock(root, () => enableUnlocked(root));
}

function disable(root) {
  const flag = join(root, FLAG_FILE);
  ensureProjectWriteTarget(root, flag);
  if (existsSync(flag)) unlinkSync(flag);
  resetClaims(root);
  process.stdout.write(`codex-review: 自動レビューを無効にしました (${flag})\n`);
}

function usage() {
  return [
    '使い方:',
    '  node setup-auto.js [--enable-schedule] [--migrate-legacy-hooks]',
    '  node setup-auto.js --disable',
    '  node setup-auto.js --help',
    '',
  ].join('\n');
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const supported = new Set([
      '--enable-schedule',
      '--migrate-legacy-hooks',
      '--migrate-global-hooks',
      '--disable',
      '--help',
    ]);
    const unknown = args.filter((arg) => !supported.has(arg));
    if (unknown.length) {
      throw new Error(`未対応のオプションです: ${unknown.join(', ')}\n${usage()}`);
    }
    if (args.includes('--help')) {
      if (args.length !== 1) throw new Error(`--help は他のオプションと併用できません\n${usage()}`);
      process.stdout.write(usage());
      process.exit(0);
    }
    if (args.includes('--disable') && args.length !== 1) {
      throw new Error(`--disable は他のオプションと併用できません\n${usage()}`);
    }
    const root = gitRoot();
    if (args.includes('--disable')) {
      withProjectSetupLock(root, () => disable(root));
    }
    else enable(root);
  } catch (error) {
    die(error.message);
  }
}

module.exports = { hookCommand };
