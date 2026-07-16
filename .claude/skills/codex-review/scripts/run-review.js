#!/usr/bin/env node
'use strict';

/**
 * Runs `codex exec review` for the codex-review skill, and runs it again when a
 * rate limit kills the attempt.
 *
 * Codex already retries 429s inside a single run — the built-in provider ships
 * with 4 HTTP retries and 5 stream retries — and those counts cannot be raised:
 * overriding `model_providers.openai.*` is rejected ("Built-in providers cannot
 * be overridden"). Its backoff is measured in seconds, which clears a transient
 * 429 but not a usage window. So the longer wait has to live out here: when
 * Codex gives up with "exceeded retry limit, last status: 429", sleep and run
 * the whole review again.
 *
 * Usage:
 *   node run-review.js --out <file> [--uncommitted | --base <branch> | --commit <sha>]
 *
 * Config comes from ~/.claude/codex-review.config.json:
 *   model, effort, mode          which model to review with
 *   timeout_minutes              per-attempt ceiling (default 15)
 *   retry.max_attempts           total attempts including the first (default 3)
 *   retry.wait_seconds           backoff between attempts (default [60, 300, 900])
 *
 * Exit 0 when a review completes, 1 otherwise. Progress goes to stderr so stdout
 * stays free for the summary line.
 */

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { delimiter, join } = require('node:path');

const CONFIG_PATH = join(homedir(), '.claude', 'codex-review.config.json');

const DEFAULTS = {
  timeout_minutes: 15,
  retry: { max_attempts: 3, wait_seconds: [60, 300, 900] },
};

/**
 * Signatures of a run that died on rate limiting rather than on a real problem.
 * The first is the exact message Codex prints once its own retries run out; the
 * rest are there so a reworded message still gets a retry instead of being
 * reported to the user as a broken review.
 */
const RATE_LIMIT_PATTERNS = [
  /exceeded retry limit/i,
  /429/,
  /too many requests/i,
  /rate.?limit/i,
  /usage limit/i,
  /quota/i,
];

const log = (msg) => process.stderr.write(`${msg}\n`);

function sleepSync(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // No config yet: the skill's setup step writes it. Model flags are simply
    // omitted, which falls back to whatever ~/.codex/config.toml says.
  }
  const retry = { ...DEFAULTS.retry, ...(raw.retry ?? {}) };
  return { ...DEFAULTS, ...raw, retry };
}

/**
 * Resolves a real executable — never a bare name for a shell to look up, and
 * never a .cmd shim. The arguments include a branch name and an output path; a
 * shell would re-parse both, so a metacharacter could start a second command and
 * a space could split one argument in two. Node also refuses to spawn .cmd/.bat
 * without a shell, so a shim is not a usable target either.
 *
 * Order: a real binary on PATH, the binary vendored behind npm's shim, then the
 * one bundled with the VS Code extension.
 */
const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'codex.exe' : 'codex';

function resolveCodex() {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    const full = join(dir, BIN_NAME);
    if (existsSync(full)) return full;
  }

  // `npm i -g @openai/codex` puts a shim on PATH and the real binary under its
  // node_modules. Dig it out rather than going through the shim.
  for (const dir of pathDirs) {
    const shim = IS_WIN ? join(dir, 'codex.cmd') : null;
    if (shim && !existsSync(shim)) continue;
    const vendored = findFile(join(dir, 'node_modules', '@openai'), BIN_NAME, 0, 8);
    if (vendored) return vendored;
  }

  const roots = [
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-insiders', 'extensions'),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const m = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(name);
      if (m) candidates.push({ dir: join(root, name), version: m[1] });
    }
  }
  // Compare parsed versions across both roots. Sorting whole paths would weigh
  // ".vscode" against ".vscode-insiders" before ever reaching the version.
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  for (const { dir } of candidates) {
    const exe = findFile(join(dir, 'bin'), BIN_NAME);
    if (exe) return exe;
  }
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findFile(dir, target, depth = 0, maxDepth = 4) {
  if (depth > maxDepth || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isFile() && name === target) return full;
    if (s.isDirectory()) {
      const hit = findFile(full, target, depth + 1, maxDepth);
      if (hit) return hit;
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = { scope: null, outFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--out':
        out.outFile = argv[++i];
        break;
      case '--uncommitted':
        out.scope = ['--uncommitted'];
        break;
      case '--base':
        out.scope = ['--base', argv[++i]];
        break;
      case '--commit':
        out.scope = ['--commit', argv[++i]];
        break;
      default:
        break;
    }
  }
  return out;
}

function isRateLimited(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Returns an error message when the scope names a ref that does not resolve. */
function checkRef(scope) {
  if (!scope || scope[0] === '--uncommitted') return null;
  const [flag, value] = scope;
  const rev = flag === '--commit' ? `${value}^{commit}` : value;
  const run = spawnSync('git', ['rev-parse', '--verify', '--quiet', rev], {
    encoding: 'utf8',
    shell: false,
  });
  if (run.status === 0) return null;
  return flag === '--commit'
    ? `コミット '${value}' が見つかりません`
    : `ブランチ '${value}' が見つかりません`;
}

function main() {
  const { scope, outFile } = parseArgs(process.argv.slice(2));
  if (!outFile) {
    log('使い方: node run-review.js --out <file> [--uncommitted | --base <branch> | --commit <sha>]');
    return 1;
  }

  const codex = resolveCodex();
  if (!codex) {
    log('codex CLI が見つかりません。');
    log('  スタンドアロン CLI: npm i -g @openai/codex');
    log('  または VS Code 拡張「Codex – OpenAI」を導入してください。');
    return 1;
  }

  // Codex exits 0 when the base/commit does not resolve — it just writes "that
  // branch does not exist" into the output file. That reads downstream as a
  // review that found nothing, i.e. a clean bill of health for code nobody read.
  // Check the ref here instead, before spending a call on it.
  const badRef = checkRef(scope);
  if (badRef) {
    process.stdout.write(`NG: ${badRef}\n`);
    return 1;
  }

  const config = readConfig();
  const args = ['exec', 'review', ...(scope ?? ['--uncommitted'])];
  if (config.mode !== 'inherit' && config.model) {
    args.push('-m', config.model);
    if (config.effort) args.push('-c', `model_reasoning_effort="${config.effort}"`);
  }
  // Reviews read; they never write. The default is workspace-write, so this is
  // not optional.
  args.push('-c', 'sandbox_mode="read-only"');
  args.push('-o', outFile);

  const attempts = Math.max(1, config.retry.max_attempts);
  const waits = config.retry.wait_seconds ?? [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    log(`codex-review: レビュー実行 (${attempt}/${attempts})`);
    const run = spawnSync(codex, args, {
      encoding: 'utf8',
      // No shell: args carry a branch name and an output path, and a shell would
      // re-parse both.
      shell: false,
      timeout: config.timeout_minutes * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
    });

    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

    if (run.status === 0) {
      process.stdout.write(`OK: レビューが完了しました (${attempt}/${attempts} 回目)\n`);
      return 0;
    }

    if (run.error?.code === 'ETIMEDOUT' || run.signal) {
      log(`codex-review: ${config.timeout_minutes} 分で打ち切りました。`);
      // A timeout is not a rate limit; retrying the same slow review usually just
      // burns the same time again.
      process.stdout.write('NG: タイムアウトしました。timeout_minutes を延ばすか effort を下げてください\n');
      return 1;
    }

    if (!isRateLimited(output)) {
      log(output.trim().split('\n').slice(-15).join('\n'));
      process.stdout.write('NG: レビューが失敗しました（レート制限以外の理由）\n');
      return 1;
    }

    const wait = waits[attempt - 1] ?? waits[waits.length - 1] ?? 60;
    if (attempt === attempts) {
      process.stdout.write(
        `NG: レート制限のため ${attempts} 回試行して諦めました。時間をおいて再実行してください\n`
      );
      return 1;
    }
    log(`codex-review: レート制限を検知しました。${wait} 秒待って再試行します`);
    sleepSync(wait);
  }
  return 1;
}

// doctor.js reuses the resolver. Two copies of "where is codex" would drift.
module.exports = { resolveCodex, readConfig, CONFIG_PATH };

if (require.main === module) process.exit(main());
