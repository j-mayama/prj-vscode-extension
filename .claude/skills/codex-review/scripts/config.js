#!/usr/bin/env node
'use strict';

/**
 * Reads and writes ~/.claude/codex-review.config.json.
 *
 * Config writing lives in a script rather than in the skill's prose because it
 * has to come out identical every run. A model or effort the CLI rejects does
 * not fail here — it fails minutes later as a dead review, so values are checked
 * against Codex's own model cache before they are saved.
 *
 * Usage:
 *   node config.js --show
 *   node config.js --set effort=medium --set rounds.work=3
 *   node config.js --set unattended.enabled=true
 *   node config.js --preset weekend    離席・週末向け（無人モード ON）
 *   node config.js --preset weekday    通常向け（無人モード OFF）
 *
 * Presets deliberately do not touch `model` or `effort`: which values are legal
 * depends on the model, so those stay an explicit choice.
 */

const {
  chmodSync,
  constants: FS_CONSTANTS,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
} = require('node:fs');

const { currentMode, parseHM, DAY_NAMES } = require('./schedule.js');
const {
  CONFIG_PATH,
  DEFAULTS,
  MODELS_CACHE,
  REQUIRED_AUTO_FIX,
  readConfig,
  withConfigLock,
  writeConfig,
} = require('./config-core.js');

const PRESETS = {
  weekend: { 'unattended.enabled': true, 'schedule.enabled': false },
  weekday: { 'unattended.enabled': false, 'schedule.enabled': false },
  // 時刻から自動で切り替える。weekend/weekday の手動切り替えは不要になる。
  auto: { 'schedule.enabled': true },
};

const SETTABLE_KEYS = new Set([
  'mode',
  'model',
  'effort',
  'rounds.work',
  'rounds.away',
  'timeout_minutes',
  'retry.max_attempts',
  'retry.wait_seconds',
  'unattended.enabled',
  'schedule.enabled',
  'schedule.workdays',
  'schedule.start',
  'schedule.end',
]);

const die = (msg) => {
  process.stderr.write(`codex-review: ${msg}\n`);
  process.exit(1);
};

/** Codex keeps its own list of live models; that is the only honest source for what is valid. */
function models() {
  try {
    const j = JSON.parse(readFileSync(MODELS_CACHE, 'utf8'));
    return Array.isArray(j.models) ? j.models.filter((m) => m.visibility === 'list') : [];
  } catch {
    return [];
  }
}

function efforts(slug) {
  const m = models().find((x) => x.slug === slug);
  return m && Array.isArray(m.supported_reasoning_levels)
    ? m.supported_reasoning_levels.map((l) => l.effort)
    : [];
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  if (
    keys.some((key) => !key || ['__proto__', 'prototype', 'constructor'].includes(key))
  ) {
    throw new Error(`設定キー '${path}' は使用できません`);
  }
  let node = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  node[keys.at(-1)] = value;
}

/** Settings whose value is a list. Without this, `--set schedule.workdays=6` would store the number 6. */
const ARRAY_PATHS = new Set(['schedule.workdays', 'unattended.auto_fix', 'retry.wait_seconds']);

function parseScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function parseValue(path, raw) {
  if (ARRAY_PATHS.has(path) && raw === '') return [];
  const parts = raw.split(',').map((v) => parseScalar(v.trim()));
  if (ARRAY_PATHS.has(path)) return parts;
  return parts.length > 1 ? parts : parts[0];
}

function validate(config) {
  const known = models().map((m) => m.slug);
  if (!['explicit', 'inherit'].includes(config.mode)) {
    throw new Error(`mode は explicit か inherit にしてください（現在: ${config.mode}）`);
  }
  if (
    config.mode === 'explicit' &&
    (typeof config.model !== 'string' || config.model.trim() === '')
  ) {
    throw new Error('mode=explicit では model を指定してください');
  }
  if (
    config.effort !== undefined &&
    config.effort !== '' &&
    typeof config.effort !== 'string'
  ) {
    throw new Error(`effort は文字列にしてください（現在: ${JSON.stringify(config.effort)}）`);
  }
  if (config.mode === 'inherit' && config.effort) {
    throw new Error('mode=inherit では effort を上書きできません。モデルも指定するか effort を空にしてください');
  }
  if (config.mode === 'explicit' && config.model && known.length && !known.includes(config.model)) {
    throw new Error(`モデル '${config.model}' は現在のモデル一覧にありません。有効: ${known.join(' / ')}`);
  }
  if (config.mode === 'explicit' && config.effort && config.model) {
    const valid = efforts(config.model);
    if (valid.length && !valid.includes(config.effort)) {
      throw new Error(`effort '${config.effort}' は ${config.model} では使えません。有効: ${valid.join(' / ')}`);
    }
  }
  for (const key of ['work', 'away']) {
    const v = config.rounds?.[key];
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`rounds.${key} は 1 以上の整数にしてください（現在: ${v}）`);
    }
  }
  if (!Number.isInteger(config.timeout_minutes) || config.timeout_minutes < 1) {
    throw new Error(`timeout_minutes は 1 以上の整数にしてください（現在: ${config.timeout_minutes}）`);
  }
  if (!Number.isInteger(config.retry?.max_attempts) || config.retry.max_attempts < 1) {
    throw new Error(`retry.max_attempts は 1 以上の整数にしてください（現在: ${config.retry?.max_attempts}）`);
  }
  if (
    !Array.isArray(config.retry?.wait_seconds) ||
    config.retry.wait_seconds.length === 0 ||
    config.retry.wait_seconds.some((v) => !Number.isInteger(v) || v < 0)
  ) {
    throw new Error(`retry.wait_seconds は 0 以上の整数の配列にしてください（現在: ${JSON.stringify(config.retry?.wait_seconds)}）`);
  }
  if (typeof config.unattended?.enabled !== 'boolean') {
    throw new Error(`unattended.enabled は true か false にしてください（現在: ${config.unattended?.enabled}）`);
  }
  const autoFix = config.unattended?.auto_fix;
  if (
    !Array.isArray(autoFix) ||
    autoFix.length !== REQUIRED_AUTO_FIX.length ||
    REQUIRED_AUTO_FIX.some((severity) => !autoFix.includes(severity))
  ) {
    throw new Error(`unattended.auto_fix は固定値 ${REQUIRED_AUTO_FIX.join('/')} にしてください（現在: ${JSON.stringify(autoFix)}）`);
  }
  if (config.auto_commit !== true) {
    throw new Error(`auto_commit は固定値 true にしてください（現在: ${config.auto_commit}）`);
  }
  // Checked whether or not scheduling is enabled. Gating this on `enabled` would
  // let a bad value save quietly today and only break on the day it is turned on.
  const s = config.schedule ?? {};
  const start = parseHM(s.start);
  const end = parseHM(s.end);
  if (start === null) throw new Error(`schedule.start は HH:MM 形式で指定してください（現在: ${s.start}）`);
  if (end === null) throw new Error(`schedule.end は HH:MM 形式で指定してください（現在: ${s.end}）`);
  if (start >= end) throw new Error(`schedule.start は end より前にしてください（現在: ${s.start}〜${s.end}）`);
  if (
    !Array.isArray(s.workdays) ||
    s.workdays.length === 0 ||
    s.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(s.workdays).size !== s.workdays.length
  ) {
    throw new Error(`schedule.workdays は 0〜6 の整数の配列にしてください（0 = 日曜 / 現在: ${JSON.stringify(s.workdays)}）`);
  }
  if (typeof s.enabled !== 'boolean') {
    throw new Error(`schedule.enabled は true か false にしてください（現在: ${s.enabled}）`);
  }
}

function show(config) {
  const valid = config.model ? efforts(config.model) : [];
  const workRounds = Number.isInteger(config.rounds?.work) ? config.rounds.work : '不正';
  const awayRounds = Number.isInteger(config.rounds?.away) ? config.rounds.away : '不正';
  const retryAttempts = Number.isInteger(config.retry?.max_attempts) ? config.retry.max_attempts : '不正';
  const retryWaits = Array.isArray(config.retry?.wait_seconds)
    ? config.retry.wait_seconds.join(', ')
    : '不正';
  const autoFix = Array.isArray(config.unattended?.auto_fix)
    ? config.unattended.auto_fix.join('/')
    : '設定不正';
  process.stdout.write(`設定: ${CONFIG_PATH}${existsSync(CONFIG_PATH) ? '' : '（未作成・既定値を表示）'}\n\n`);
  process.stdout.write(`  モデル設定    : ${config.mode === 'inherit' ? 'Codex 本体を継承' : '明示指定'}\n`);
  process.stdout.write(`  モデル        : ${config.model ?? '(未設定)'}${config.mode === 'inherit' ? '  ※ inherit のため未使用' : ''}\n`);
  process.stdout.write(`  effort        : ${config.effort || '(Codex 本体を継承)'}\n`);
  if (valid.length) process.stdout.write(`                  選べる値: ${valid.join(' / ')}\n`);
  process.stdout.write(`  レビュー回数  : 通常 ${workRounds} 回 / 離席 ${awayRounds} 回\n`);
  process.stdout.write(`  timeout_minutes: ${config.timeout_minutes}\n`);
  process.stdout.write(`  retry         : ${retryAttempts} 回 / 待機 ${retryWaits} 秒\n`);

  const { mode, reason, schedule } = currentMode(config);
  const away = mode === 'away' || (mode === null && config.unattended?.enabled === true);
  if (schedule.enabled === true) {
    const days = Array.isArray(schedule.workdays)
      ? schedule.workdays.map((d) => DAY_NAMES[d] ?? '?').join('')
      : '不正';
    process.stdout.write(`  スケジュール  : ON（勤務 ${days} ${schedule.start}〜${schedule.end}）\n`);
    process.stdout.write(`  → 今は        : ${away ? '離席モード' : '通常モード'}（${reason}）\n`);
  } else if (schedule.enabled === false) {
    process.stdout.write(`  スケジュール  : OFF（手動切り替え）\n`);
    process.stdout.write(`  → 今は        : ${away ? '離席モード' : '通常モード'}\n`);
  } else {
    process.stdout.write(`  スケジュール  : 設定不正\n`);
    process.stdout.write(`  → 今は        : 通常モード（${reason}）\n`);
  }
  process.stdout.write(`     ${away
    ? `指摘は ${autoFix} を自動修正・P3 は対象外・${awayRounds} 回まで`
    : `指摘は ${autoFix} を必須修正・P3 は対象外・${workRounds} 回まで`}\n`);
  process.stdout.write('  自動コミット  : ON（codex-review完了時・通常/離席）\n');
}

function applyArgs(config, args) {
  let changed = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--set') {
      const pair = args[++i];
      if (!pair || !pair.includes('=')) throw new Error('--set は key=value の形式で指定してください');
      const [key, ...rest] = pair.split('=');
      if (!SETTABLE_KEYS.has(key)) {
        throw new Error(
          `変更できない設定キーです: ${key}\n有効: ${[...SETTABLE_KEYS].join(' / ')}`
        );
      }
      setPath(config, key, parseValue(key, rest.join('=')));
      changed = true;
    } else if (args[i] === '--preset') {
      const name = args[++i];
      if (!PRESETS[name]) {
        throw new Error(`preset は ${Object.keys(PRESETS).join(' / ')} のいずれかです`);
      }
      for (const [k, v] of Object.entries(PRESETS[name])) {
        setPath(config, k, v);
      }
      changed = true;
    }
  }
  return changed;
}

function validateCliArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--show' || arg === '--reset') continue;
    if (arg === '--set' || arg === '--preset') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        throw new Error(`${arg} には値を指定してください`);
      }
      i += 1;
      continue;
    }
    throw new Error(`未対応のオプションです: ${arg}`);
  }
}

function backupConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  const stat = lstatSync(CONFIG_PATH);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${CONFIG_PATH} は通常ファイルではありません`);
  }
  const backup = `${CONFIG_PATH}.bak.${Date.now()}.${process.pid}`;
  copyFileSync(CONFIG_PATH, backup, FS_CONSTANTS.COPYFILE_EXCL);
  chmodSync(backup, stat.mode & 0o7777);
  return backup;
}

function main() {
  const args = process.argv.slice(2);
  try {
    validateCliArgs(args);
  } catch (error) {
    die(error.message);
  }
  const resetting = args.includes('--reset');
  const mutating = resetting || args.includes('--set') || args.includes('--preset');
  let config;
  let changed = false;
  let backup = null;
  try {
    if (mutating) {
      const result = withConfigLock(() => {
        const latest = resetting ? structuredClone(DEFAULTS) : readConfig({ strict: true });
        if (resetting) backup = backupConfig();
        const didChange = applyArgs(latest, args);
        if (didChange || resetting) {
          validate(latest);
          writeConfig(latest);
        }
        return { config: latest, changed: didChange || resetting };
      });
      config = result.config;
      changed = result.changed;
    } else {
      config = readConfig({ strict: true });
    }
  } catch (error) {
    die(`${CONFIG_PATH} を更新できません (${error.message})`);
  }

  if (changed) {
    process.stdout.write('保存しました。\n\n');
    if (backup) process.stdout.write(`  バックアップ: ${backup}\n\n`);
  }
  show(config);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { validate };
