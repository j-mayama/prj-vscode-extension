#!/usr/bin/env node
'use strict';

/**
 * Checks whether this machine can run a codex-review, and repairs what is safely
 * repairable. Written for containers, where the skill often lands in a fresh
 * image with no CLI and no credentials.
 *
 * Usage:
 *   node doctor.js          check and report; exit 0 when ready, 1 when not
 *   node doctor.js --fix    additionally install the Codex CLI when missing
 *
 * Installing is opt-in because it writes outside the project. A container is
 * disposable so that is cheap there; a host is not, which is the caller's call
 * to make, not this script's.
 *
 * Authentication is deliberately NOT repaired. It cannot be: a ChatGPT login is
 * an interactive browser flow, and anything else means handing this script a
 * credential. What it can do is say exactly which of the three routes is open.
 */

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const { resolveCodex } = require('./run-review.js');
const { CONFIG_PATH, readConfig } = require('./config-core.js');
const { validate } = require('./config.js');
const { hookCommand } = require('./setup-auto.js');

const FIX = process.argv.includes('--fix');

const results = [];
const ok = (name, detail) => results.push({ state: 'OK', name, detail });
const ng = (name, detail, hint) => results.push({ state: 'NG', name, detail, hint });
const warn = (name, detail, hint) => results.push({ state: '--', name, detail, hint });

/** Containers are disposable, so installing into one is a different decision than installing onto a host. */
function inContainer() {
  if (existsSync('/.dockerenv')) return true;
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) return true;
  try {
    return require('node:fs').readFileSync('/proc/1/cgroup', 'utf8').includes('docker');
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
}

/**
 * npm ships as a .cmd shim on Windows, which spawnSync cannot launch without a
 * shell, so a bare "npm" lookup reports it missing on a machine that has it.
 * Resolve the real path off PATH instead. npm is the only route to installing
 * the CLI, so a false "missing" here would strand every container.
 */
function findNpm() {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm'];
  for (const dir of (process.env.PATH ?? '').split(require('node:path').delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function npmRun(npm, args, opts = {}) {
  // A .cmd shim needs a shell; the arguments here are all literals we wrote, so
  // there is nothing user-supplied for a shell to reinterpret.
  const isShim = npm.toLowerCase().endsWith('.cmd');
  return isShim
    ? spawnSync(`"${npm}" ${args.join(' ')}`, { encoding: 'utf8', shell: true, ...opts })
    : run(npm, args, opts);
}

function checkNode() {
  ok('node', process.version);
  const npm = findNpm();
  if (!npm) {
    warn('npm', '見つかりません', 'codex CLI を自動インストールできません');
    return null;
  }
  const v = npmRun(npm, ['--version']);
  if (v.status === 0) {
    ok('npm', `${(v.stdout ?? '').trim()} (${npm})`);
    return npm;
  }
  warn('npm', '実行できません', 'codex CLI を自動インストールできません');
  return null;
}

function checkCodex(npm) {
  let codex = resolveCodex();
  if (!codex && FIX && npm) {
    process.stderr.write('codex-review: codex CLI をインストールしています (npm i -g @openai/codex)...\n');
    const install = npmRun(npm, ['install', '-g', '@openai/codex'], { stdio: 'inherit' });
    if (install.status === 0) codex = resolveCodex();
  }

  if (codex) {
    const v = run(codex, ['--version']);
    ok('codex CLI', `${v.stdout.trim() || '不明'} (${codex})`);
    return codex;
  }
  ng(
    'codex CLI',
    '見つかりません',
    FIX ? 'インストールに失敗しました。npm と通信環境を確認してください' : '`--fix` を付けて再実行するか、`npm i -g @openai/codex` を実行してください'
  );
  return null;
}

function checkAuth(codex) {
  if (!codex) return false;
  const status = run(codex, ['login', 'status']);
  // `login status` exits 0 whether or not you are logged in — the answer is only
  // in the text. Checking the exit code here would report everyone as logged in.
  const text = `${status.stdout ?? ''}${status.stderr ?? ''}`;
  if (/logged in/i.test(text) && !/not logged in/i.test(text)) {
    ok('認証', text.trim().split('\n')[0]);
    return true;
  }
  ng('認証', '未認証', [
    '次のいずれかで認証する（自動化はできない）:',
    '  1. ホストの ~/.codex をコンテナに mount し、CODEX_HOME をそこへ向ける',
    '     （最も手間がないが、認証情報をコンテナへ渡すことになる）',
    '  2. codex login  … 対話ログイン（ブラウザが必要）',
    '  3. printenv OPENAI_API_KEY | codex login --with-api-key  … API キー課金の場合',
  ].join('\n'));
  return false;
}

function checkConfig() {
  if (!existsSync(CONFIG_PATH)) {
    warn('設定', '未作成', 'setup-auto.js が Codex 本体設定の継承で作成します');
    return;
  }
  try {
    validate(readConfig({ strict: true }));
    ok('設定', CONFIG_PATH);
  } catch (error) {
    ng(
      '設定',
      `${CONFIG_PATH} が不正です: ${error.message}`,
      'JSON自体が壊れている場合は config.js --reset でバックアップ後に初期化してください'
    );
  }
}

function checkHooks() {
  const git = run('git', ['rev-parse', '--show-toplevel']);
  const root = git.status === 0 ? git.stdout.trim() : process.cwd();
  const localSettings = join(root, '.claude', 'settings.local.json');
  const candidates = [
    localSettings,
    join(root, '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.json'),
  ];
  // `matcher: null` means the event must be registered without a matcher —
  // UserPromptSubmit and Stop do not support one, and Claude Code silently
  // ignores it there. PreToolUse must carry exactly the tool list the guard
  // covers, or it would either miss writes or fire on every tool call.
  const required = {
    UserPromptSubmit: { script: 'mark-prompt.js', matcher: null },
    PreToolUse: { script: 'worktree-guard.js', matcher: 'Edit|Write|NotebookEdit' },
    Stop: { script: 'stop-hook.js', matcher: null },
  };
  let expectedCommands;
  try {
    expectedCommands = Object.fromEntries(
      Object.entries(required).map(([eventName, { script }]) => [
        eventName,
        hookCommand(join(__dirname, script)),
      ])
    );
  } catch (error) {
    ng(
      'hooks',
      `hookコマンドを生成できません: ${error.message}`,
      'スキルをWindows shellで展開されないパスへ移してから setup-auto.js を実行してください'
    );
    return;
  }
  const found = Object.fromEntries(Object.keys(required).map((eventName) => [eventName, []]));
  const conflicts = [];
  const armed = existsSync(join(root, '.codex-review-auto'));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const settings = JSON.parse(require('node:fs').readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('ルートは JSON オブジェクトである必要があります');
      }
      const hooks = settings.hooks ?? {};
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
        throw new Error('hooks は JSON オブジェクトである必要があります');
      }
      for (const [eventName, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) throw new Error(`hooks.${eventName} は配列である必要があります`);
        for (const group of groups) {
          if (
            !group ||
            typeof group !== 'object' ||
            Array.isArray(group) ||
            !Array.isArray(group.hooks)
          ) {
            throw new Error(`hooks.${eventName} に不正な要素があります`);
          }
          for (const handler of group.hooks) {
            if (!handler || typeof handler !== 'object') continue;
            const values = [
              typeof handler.command === 'string' ? handler.command : '',
              ...(Array.isArray(handler.args) ? handler.args.map(String) : []),
            ].map((value) => value.replace(/\\/g, '/'));
            for (const [requiredEvent, { script, matcher }] of Object.entries(required)) {
              if (!values.some((value) => value.includes(`/codex-review/scripts/${script}`))) continue;
              const matcherIsExpected =
                matcher === null
                  ? !Object.prototype.hasOwnProperty.call(group, 'matcher')
                  : group.matcher === matcher;
              const isExpected =
                path === localSettings &&
                eventName === requiredEvent &&
                matcherIsExpected &&
                handler.type === 'command' &&
                handler.command === expectedCommands[requiredEvent] &&
                handler.args === undefined &&
                (handler.async === undefined || handler.async === false) &&
                Number.isFinite(handler.timeout) &&
                handler.timeout >= 30;
              if (isExpected) found[requiredEvent].push(path);
              else conflicts.push(`${path}: ${eventName} -> ${script}`);
            }
          }
        }
      }
    } catch (error) {
      const detail = `${path} を読めません: ${error.message}`;
      const hint = 'JSON 構文を修正してから setup-auto.js を再実行してください';
      if (armed) ng('hooks', detail, hint);
      else warn('hooks', detail, hint);
      return;
    }
  }

  for (const [eventName, locations] of Object.entries(found)) {
    if (locations.length > 1) conflicts.push(`${eventName} が ${locations.length} 件重複`);
  }
  if (conflicts.length) {
    const detail = `競合または旧登録を検出: ${conflicts.join(' / ')}`;
    const hint =
      '旧方式のhookを移行する場合は setup-auto.js --migrate-legacy-hooks を実行してください';
    if (armed) ng('hooks', detail, hint);
    else warn('hooks', detail, hint);
    return;
  }

  const missing = Object.entries(required)
    .filter(([eventName]) => found[eventName].length === 0)
    .map(([, { script }]) => script);
  if (missing.length === 0) {
    ok('hooks', 'UserPromptSubmit / PreToolUse / Stop を確認');
  } else if (armed) {
    ng(
      'hooks',
      `${missing.join(' / ')} が未登録`,
      'node .claude/skills/codex-review/scripts/setup-auto.js を対象リポジトリで再実行してください'
    );
  } else {
    warn(
      'hooks',
      `${missing.join(' / ')} が未登録`,
      'node .claude/skills/codex-review/scripts/setup-auto.js を対象リポジトリで実行してください'
    );
  }
}

function checkGit() {
  const r = run('git', ['rev-parse', '--show-toplevel']);
  if (r.status === 0) ok('git リポジトリ', r.stdout.trim());
  else ng('git リポジトリ', 'ここは git リポジトリではありません', 'レビュー対象のリポジトリで実行してください');
}

function main() {
  const where = inContainer() ? 'コンテナ' : 'ホスト';
  process.stdout.write(`codex-review 環境チェック（${where} / home: ${homedir()}）\n\n`);

  const npm = checkNode();
  const codex = checkCodex(npm);
  checkAuth(codex);
  checkConfig();
  checkHooks();
  checkGit();

  for (const r of results) {
    process.stdout.write(`  [${r.state}] ${r.name}: ${r.detail}\n`);
    if (r.hint) {
      for (const line of r.hint.split('\n')) process.stdout.write(`        ${line}\n`);
    }
  }

  const blocked = results.filter((r) => r.state === 'NG');
  process.stdout.write('\n');
  if (blocked.length === 0) {
    process.stdout.write('READY: レビューを実行できます\n');
    return 0;
  }
  process.stdout.write(`NOT_READY: ${blocked.map((r) => r.name).join(' / ')} を解決してください\n`);
  if (!FIX && blocked.some((r) => r.name === 'codex CLI')) {
    process.stdout.write('  `node doctor.js --fix` で codex CLI の導入を試せます\n');
  }
  return 1;
}

process.exit(main());
