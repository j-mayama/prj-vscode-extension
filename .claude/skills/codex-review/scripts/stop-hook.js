#!/usr/bin/env node
'use strict';

/**
 * Stop hook for the codex-review skill.
 *
 * Decides one thing only: does the current working tree still need a Codex
 * review? When it does, the hook blocks the turn from ending and tells Claude
 * to run the skill. The review itself, the selection dialog and the fixes all
 * live in the skill, so the review logic has a single home.
 *
 * Modes:
 *   (no args)     Hook mode. Reads the Stop event JSON on stdin and prints a
 *                 block decision on stdout when a review is due.
 *   --print       Prints the current diff fingerprint (empty when clean). The
 *                 skill captures this before handing the tree to Codex.
 *   --mark <fp>   Records <fp> as reviewed, but only while the tree still
 *                 matches it. The skill runs this once its review loop finishes.
 *   --state-path  Prints the path of this repo's unattended state file, so the
 *                 skill never has to guess at the key.
 *
 * Opt-in per repository: hook mode does nothing unless FLAG_FILE sits in the
 * repository root.
 *
 * Why --mark takes a fingerprint. A review runs for minutes, and the tree can
 * move underneath it — another session sharing this checkout, or the same
 * session editing on. Marking "whatever the tree is now" would record changes
 * Codex never read as reviewed, and the hook would then skip them for good.
 * Marking the snapshot that was actually reviewed, and refusing when it no
 * longer matches, fails toward re-reviewing rather than toward silence.
 *
 * Loop safety. The Stop event carries no "a stop hook already fired" flag, so
 * the guard is self-contained: the hook blocks at most once per distinct diff.
 * A blocked diff is recorded as "attempted" before blocking, so a review that
 * never reports back (crash, missing CLI, expired auth) costs one extra turn
 * instead of trapping the session in a loop.
 *
 * In hook mode every failure path allows the stop: a broken hook must never
 * trap a session. The CLI modes are run by hand, so they surface errors.
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const FLAG_FILE = '.codex-review-auto';
const STATE_DIR = join(homedir(), '.claude', 'codex-review-state');

function allowStop() {
  process.exit(0);
}

function git(args, cwd, input) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // Node caps child output at 1 MiB by default, and `diff HEAD` blows past that
    // on a large refactor — exactly the change that most wants reviewing. Hook mode
    // fails open, so the cap turned into "big diffs skip review, silently".
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * Fingerprints everything a review would look at: tracked edits plus the
 * content of untracked files. Untracked content goes through `git hash-object`
 * rather than being read here, so binaries and large files stay cheap.
 * Returns null when the tree is clean.
 */
function fingerprint(root) {
  const status = git(['status', '--porcelain'], root);

  let tracked;
  try {
    tracked = git(['diff', 'HEAD'], root);
  } catch {
    // No commit yet, so `diff HEAD` has nothing to resolve. Staged files are absent
    // from the untracked list too, so their content would otherwise go unhashed and
    // edits to them would read as "unchanged". Index blob SHAs plus the
    // worktree-vs-index diff cover the same ground.
    tracked = git(['ls-files', '-s'], root) + git(['diff'], root);
  }

  // `-c core.quotePath=false` keeps non-ASCII names literal. git would otherwise
  // C-quote them, and while `hash-object --stdin-paths` does decode that quoting,
  // relying on the round-trip buys nothing here — the paths only have to reach
  // hash-object and be stable between runs.
  const untracked = git(
    ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'],
    root
  );
  const untrackedHashes = untracked.trim()
    ? git(['hash-object', '--stdin-paths'], root, untracked)
    : '';

  if (!status.trim() && !tracked.trim() && !untracked.trim()) return null;

  return createHash('sha256')
    .update(status)
    .update(tracked)
    .update(untracked)
    .update(untrackedHashes)
    .digest('hex');
}

function stateKey(root) {
  return createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
}

function statePath(root) {
  return join(STATE_DIR, `${stateKey(root)}.json`);
}

/**
 * One file per (repo, diff) that some session has already blocked on. Created
 * with an exclusive flag so the create itself is the claim: read-then-write
 * would let two sessions sharing a checkout both pass the check and both launch
 * a review over the same files.
 */
function claimPath(root, fp) {
  return join(STATE_DIR, `${stateKey(root)}.${fp.slice(0, 16)}.claim`);
}

/** Drops this repo's claims once its tree is reviewed, so later diffs can claim again. */
function clearClaims(root) {
  const prefix = `${stateKey(root)}.`;
  let entries = [];
  try {
    entries = readdirSync(STATE_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.claim')) continue;
    try {
      unlinkSync(join(STATE_DIR, name));
    } catch {
      /* another session got there first */
    }
  }
}

function readState(root) {
  try {
    return JSON.parse(readFileSync(statePath(root), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(root, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const target = statePath(root);
  // Sessions sharing a checkout can land here at the same moment. Write to a
  // private file and rename, so a concurrent reader sees the old state or the
  // new one but never a half-written file.
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ root, ...state }, null, 2)}\n`);
  renameSync(tmp, target);
}

function blockReason(root) {
  // Forward slashes so the path can be pasted into any shell as-is.
  const self = __filename.replace(/\\/g, '/');
  return [
    'この作業ツリーには、まだ Codex レビューを通していない変更があります',
    `（${FLAG_FILE} により自動レビューが有効になっています）。`,
    '',
    'codex-review スキルを起動し、未コミット差分のレビューを実行してください。',
    '指摘はダイアログでユーザーに採否を選ばせ、採用された指摘だけを修正すること。',
    '',
    'レビューを始める前に、対象の差分を控えること:',
    `  node "${self}" --print`,
    '',
    'レビューのループが終わったら、控えた値を渡して記録すること:',
    `  node "${self}" --mark <fingerprint>`,
    '',
    '記録を拒否された場合は、レビュー中に作業ツリーが変わっている。現在の差分で再レビューすること。',
    'レビューを実行できない場合（CLI 未導入・未認証など）は、その理由をユーザーに報告してください。',
    `自動レビューを止めたい場合は、${join(root, FLAG_FILE)} を削除するようユーザーに伝えてください。`,
  ].join('\n');
}

const ARGS = process.argv.slice(2);
const MARK_INDEX = ARGS.indexOf('--mark');
const IS_MARK = MARK_INDEX !== -1;
const IS_PRINT = ARGS.includes('--print');
const IS_STATE_PATH = ARGS.includes('--state-path');
const IS_CLI = IS_MARK || IS_PRINT || IS_STATE_PATH;

function main() {
  let event = {};
  if (!IS_CLI) {
    try {
      event = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      event = {};
    }
  }

  const startDir = process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();

  let root;
  try {
    root = git(['rev-parse', '--show-toplevel'], startDir).trim();
  } catch (err) {
    // Not a repo (or no git at all). This hook is registered globally, so that is
    // an ordinary state for most directories — not something to report. Only the
    // hand-run CLI modes, which were pointed here on purpose, should complain.
    if (IS_CLI) throw err;
    allowStop();
  }

  if (IS_STATE_PATH) {
    // The skill has no way to derive the key on its own, and a guessed filename
    // would be written once and never found again.
    process.stdout.write(`${join(STATE_DIR, `${stateKey(root)}.unattended.json`)}\n`);
    return;
  }

  // Check the opt-in before fingerprinting. This hook is meant to be registered
  // globally, so every repo that has not opted in pays for whatever runs below —
  // and fingerprinting hashes every untracked file, which is not free.
  if (!IS_CLI && !existsSync(join(root, FLAG_FILE))) allowStop();

  const current = fingerprint(root);

  if (IS_PRINT) {
    process.stdout.write(`${current ?? ''}\n`);
    return;
  }

  if (IS_MARK) {
    const expected = ARGS[MARK_INDEX + 1];

    // Marking a clean tree is a no-op rather than an error: the skill may run
    // right after the changes were committed.
    if (current === null) {
      process.stdout.write('codex-review: 差分がないため記録しませんでした\n');
      return;
    }
    if (!expected || expected.startsWith('--')) {
      process.stdout.write(
        'codex-review: レビュー対象の fingerprint が未指定です。\n' +
          '  レビュー前に `--print` で取得した値を `--mark <fingerprint>` に渡してください。\n'
      );
      process.exitCode = 1;
      return;
    }
    if (expected !== current) {
      process.stdout.write(
        'codex-review: 記録しませんでした（レビュー実行中に作業ツリーが変わっています）。\n' +
          `  レビューした差分: ${expected.slice(0, 12)}\n` +
          `  現在の差分:       ${current.slice(0, 12)}\n` +
          '  Codex が読んでいない変更をレビュー済みにしないため、記録を拒否しました。\n' +
          '  現在の差分を対象に、もう一度レビューしてください。\n' +
          '  （同じ作業ツリーを別セッションが触った場合にも起きます）\n'
      );
      process.exitCode = 1;
      return;
    }

    writeState(root, { ...readState(root), reviewed: current });
    clearClaims(root);
    process.stdout.write(`codex-review: レビュー済みとして記録しました (${current.slice(0, 12)})\n`);
    return;
  }

  if (current === null) allowStop();
  if (readState(root).reviewed === current) allowStop();

  // Claim before blocking. Whoever creates the file owns this diff's review; a
  // second session stopping on the same diff finds it taken and lets its turn end.
  // This is also the loop guard: a review that never reports back leaves the claim
  // behind, so the next turn passes instead of blocking again.
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    writeFileSync(claimPath(root, current), `${process.pid}\n`, { flag: 'wx' });
  } catch (err) {
    // EEXIST is the expected outcome — someone else owns this diff's review.
    // Anything else (permissions, full disk) means the claim never happened, and
    // swallowing it here would skip the review without a word.
    if (err.code !== 'EEXIST') throw err;
    allowStop();
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(root) }));
}

try {
  main();
} catch (err) {
  // The CLI modes are run by hand, so their failures should be visible.
  if (IS_CLI) {
    process.stderr.write(`codex-review: ${err.message}\n`);
    process.exit(1);
  }
  // Hook mode allows the stop no matter what — a broken hook must never trap a
  // session — but says so. Failing open silently is how a skipped review looks
  // exactly like a clean one.
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        `codex-review: フックがエラーのため、レビューを確認せず停止を許可しました (${err.message})`,
    })
  );
  process.exit(0);
}
