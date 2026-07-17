'use strict';

const { randomUUID } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { renameAtomic } = require('./file-core.js');

const CONFIG_PATH = join(homedir(), '.claude', 'codex-review.config.json');
const CODEX_HOME = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME)
  : join(homedir(), '.codex');
const MODELS_CACHE = join(CODEX_HOME, 'models_cache.json');
const CONFIG_LOCK = `${CONFIG_PATH}.lock`;
const STALE_LOCK_MS = 5 * 60 * 1000;
const REQUIRED_AUTO_FIX = ['P0', 'P1', 'P2'];

const DEFAULTS = {
  // A fresh unattended setup must not stop to ask which model to use. Inherit
  // Codex's model and effort until the user explicitly runs setup.
  mode: 'inherit',
  rounds: { work: 3, away: 2 },
  timeout_minutes: 15,
  retry: { max_attempts: 3, wait_seconds: [60, 300, 900] },
  unattended: { enabled: false, auto_fix: [...REQUIRED_AUTO_FIX] },
  schedule: {
    enabled: false,
    workdays: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '18:00',
  },
  // A completed codex-review commits its reviewed scope in every mode. This
  // fixed policy does not affect work performed outside the skill.
  auto_commit: true,
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  if (!isObject(base) || !isObject(override)) {
    return Array.isArray(override) ? [...override] : override;
  }

  const result = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = Array.isArray(value) ? [...value] : isObject(value) ? merge(value, {}) : value;
  }
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result
      ? merge(result[key], value)
      : Array.isArray(value)
        ? [...value]
        : isObject(value)
          ? merge({}, value)
          : value;
  }
  return result;
}

function migrateLegacyConfig(config) {
  const migrated = merge({}, config);
  // Configs from before `mode` existed selected a model explicitly. Preserve
  // that behavior instead of turning them into a model-inherit/effort-override
  // hybrid during upgrade.
  if (migrated.mode === undefined && typeof migrated.model === 'string' && migrated.model) {
    migrated.mode = 'explicit';
  }
  // Older runners ignored model/effort flags in inherit mode, so this inert
  // combination was previously valid. Drop the stale effort while reading old
  // files; a new `--set effort=...` mutation is still rejected by validation.
  if (migrated.mode === 'inherit') delete migrated.effort;
  const legacyRounds = migrated.max_rounds;
  if (Number.isInteger(legacyRounds) && legacyRounds >= 1) {
    if (migrated.rounds === undefined) {
      migrated.rounds = { work: legacyRounds, away: legacyRounds };
    } else if (isObject(migrated.rounds)) {
      migrated.rounds = { ...migrated.rounds };
      if (migrated.rounds.work === undefined) migrated.rounds.work = legacyRounds;
      if (migrated.rounds.away === undefined) migrated.rounds.away = legacyRounds;
    }
  }
  delete migrated.max_rounds;
  // v1.16 fixes the review policy at P0/P1/P2. Upgrade every previously valid
  // severity array, including an empty one, and remove P3 from automatic work.
  // Malformed arrays stay untouched so validation can report them honestly.
  if (
    Array.isArray(migrated.unattended?.auto_fix) &&
    migrated.unattended.auto_fix.every((severity) =>
      ['P0', 'P1', 'P2', 'P3'].includes(severity)) &&
    new Set(migrated.unattended.auto_fix).size === migrated.unattended.auto_fix.length
  ) {
    migrated.unattended = {
      ...migrated.unattended,
      auto_fix: [...REQUIRED_AUTO_FIX],
    };
  }
  // v1.17 makes committing part of the skill contract. Preserve the field for
  // compatibility with existing config files, but migrate every old value to
  // the fixed policy instead of allowing per-machine behavior to drift.
  migrated.auto_commit = true;
  return migrated;
}

function readConfig(options = {}) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (!isObject(raw)) {
      if (options.strict) throw new Error('設定ファイルのルートは JSON オブジェクトである必要があります');
      return merge(DEFAULTS, {});
    }
    return merge(DEFAULTS, migrateLegacyConfig(raw));
  } catch (error) {
    if (options.strict && error.code !== 'ENOENT') throw error;
    return merge(DEFAULTS, {});
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function configLockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value?.owner !== 'codex-review-config' ||
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

function finishConfigLockCleanup(cleanupLock) {
  let claim;
  try {
    claim = statSync(cleanupLock);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const owner = configLockOwner(cleanupLock);
  if (!owner) {
    throw new Error(`所有を確認できない設定cleanup lockを保持して中止します: ${cleanupLock}`);
  }

  try {
    const current = statSync(CONFIG_LOCK);
    if (
      sameFile(claim, current) &&
      Date.now() - claim.mtimeMs > STALE_LOCK_MS &&
      !processIsAlive(owner.pid)
    ) {
      unlinkSync(CONFIG_LOCK);
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

function releaseConfigLock(token) {
  try {
    const current = JSON.parse(readFileSync(CONFIG_LOCK, 'utf8'));
    if (current.token === token) unlinkSync(CONFIG_LOCK);
  } catch {
    // A stale-lock helper may already have removed or replaced it.
  }
}

function withConfigLock(action) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const cleanupLock = `${CONFIG_LOCK}.cleanup`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acquired = false;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(cleanupLock)) {
      finishConfigLockCleanup(cleanupLock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      writeFileSync(
        CONFIG_LOCK,
        `${JSON.stringify({
          owner: 'codex-review-config',
          version: 1,
          token,
          pid: process.pid,
          at: new Date().toISOString(),
        })}\n`,
        { flag: 'wx', mode: 0o600 }
      );
      acquired = true;
      if (existsSync(cleanupLock)) {
        releaseConfigLock(token);
        acquired = false;
        finishConfigLockCleanup(cleanupLock);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(CONFIG_LOCK).mtimeMs > STALE_LOCK_MS) {
          try {
            linkSync(CONFIG_LOCK, cleanupLock);
          } catch (cleanupError) {
            if (!['EEXIST', 'ENOENT'].includes(cleanupError.code)) throw cleanupError;
          }
          finishConfigLockCleanup(cleanupLock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  if (!acquired) throw new Error(`設定ロックを10秒以内に取得できませんでした: ${CONFIG_LOCK}`);
  try {
    return action();
  } finally {
    releaseConfigLock(token);
  }
}

function writeConfig(config) {
  if (existsSync(CONFIG_PATH)) {
    const stat = lstatSync(CONFIG_PATH);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${CONFIG_PATH} は通常ファイルではありません`);
    }
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const target = CONFIG_PATH;
  const tmp = `${target}.${process.pid}.tmp`;
  const existingMode = existsSync(target) ? lstatSync(target).mode & 0o7777 : 0o600;
  const generation = randomUUID();
  const persisted = { ...config, _codex_review_generation: generation };
  try {
    writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: existingMode });
    chmodSync(tmp, existingMode);
    renameAtomic(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }
  return generation;
}

module.exports = {
  CONFIG_PATH,
  CODEX_HOME,
  MODELS_CACHE,
  DEFAULTS,
  REQUIRED_AUTO_FIX,
  merge,
  migrateLegacyConfig,
  readConfig,
  withConfigLock,
  writeConfig,
};
