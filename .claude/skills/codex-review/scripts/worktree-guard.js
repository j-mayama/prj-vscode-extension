#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook: keeps a session's first write out of the shared checkout.
 *
 * mark-prompt.js asks the model to move into its own worktree, but asking is not
 * a guarantee — the model may skip it, or decide a prompt is read-only and start
 * editing anyway. This hook is the deterministic half: it inspects the write
 * target itself and denies the call while the session is still in the shared
 * checkout, so the move happens before the first byte lands rather than after.
 *
 * Scope, deliberately: only tools that name their target file (Edit / Write /
 * NotebookEdit). Bash is not covered. Deciding whether an arbitrary shell string
 * writes, and where, means parsing shell — and a regex that guesses wrong either
 * blocks `git status` or waves through `sed -i`. A wrong guard is worse than a
 * declared gap, so the gap is declared instead (SKILL.md / auto-loop.md). Once
 * the session is in its worktree the cwd moves with it, so relative-path shell
 * writes land in the worktree anyway; the uncovered case is an absolute path
 * back into the shared checkout.
 *
 * Failure policy: allow. This hook runs before every edit in every configured
 * project, and a guard that errors closed would make the repository unwritable
 * over a git hiccup. It says so via systemMessage rather than failing silently,
 * because a guard that quietly stopped guarding looks exactly like a safe tree.
 */

const { readFileSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

const {
  OPT_OUT_FILE,
  WORKTREE_RELATIVE,
  dirtyEntries,
  isEnabled,
  isInside,
  isLinkedWorktree,
  isOptedOut,
  mainRoot,
  registeredWorktree,
  toPosix,
  worktreeName,
  worktreePath,
} = require('./worktree-core.js');

// Kept identical to the matcher setup-auto.js registers. A tool listed here but
// missing from the matcher would never reach this hook, and the docs would be
// describing a guard that does not run.
const GUARDED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function targetOf(event) {
  const input = event.tool_input;
  if (!input || typeof input !== 'object') return null;
  const value = input.file_path ?? input.notebook_path;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function enterInstruction(cwd, main, sessionId) {
  const existing = registeredWorktree(cwd, main, sessionId);
  if (existing) {
    // EnterWorktree refuses `name` for a worktree that already exists, and a
    // resumed session must land back in the one holding its work.
    return [
      'このセッション専用のworktreeは作成済みです。次のツールを実行して移動してください:',
      `  EnterWorktree(path: "${toPosix(existing.path)}")`,
    ].join('\n');
  }
  return [
    'このセッション専用のworktreeを作成して移動してください:',
    `  EnterWorktree(name: "${worktreeName(sessionId)}")`,
    `  作成先: ${toPosix(worktreePath(main, sessionId))}`,
  ].join('\n');
}

function dirtyReason(main, dirty) {
  return [
    'このリポジトリは codex-review のworktree分離が有効ですが、',
    '共有作業ツリーに未コミットの変更が残っているため、自動で分離できません。',
    '',
    'worktreeはHEADから作られるため、ここで分離すると次の未コミット変更は',
    '共有作業ツリーへ取り残され、このセッションからは見えなくなります:',
    ...dirty.slice(0, 20).map((line) => `  ${line}`),
    ...(dirty.length > 20 ? [`  ... 他 ${dirty.length - 20} 件`] : []),
    '',
    'stash / reset / checkout / コピーによる移送は、利用者の変更を壊すため行いません。',
    'ユーザーに次のどちらかを確認してください:',
    '  1. 上の変更をコミットしてから、あらためて実装を指示する',
    `  2. このリポジトリでは分離しない（${toPosix(join(main, OPT_OUT_FILE))} を作成する）`,
    '',
    'どちらか決まるまでファイルを変更しないでください。',
  ].join('\n');
}

function isolateReason(cwd, main, sessionId, target) {
  return [
    `${toPosix(target)} は複数セッションが共有する作業ツリーの中にあります。`,
    'このリポジトリでは codex-review のworktree分離が有効なため、',
    '共有作業ツリーへの書き込みを拒否しました（並行セッションの変更を上書きしないため）。',
    '',
    enterInstruction(cwd, main, sessionId),
    '',
    '移動後はこの書き込みをそのまま再実行してください。',
    'レビュー・自動コミットも、移動先のworktree内で通常どおり動作します。',
  ].join('\n');
}

function main() {
  let event = {};
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    allow();
  }

  if (!GUARDED_TOOLS.has(event.tool_name)) allow();

  const target = targetOf(event);
  if (!target) allow();

  const startDir = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = event.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;

  // Not a repo / no git: nothing to isolate.
  const shared = mainRoot(startDir);

  if (!isEnabled(shared) || isOptedOut(shared)) allow();

  // Already isolated. Do not nest another worktree inside this one.
  if (isLinkedWorktree(startDir)) allow();

  const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(startDir, target);

  // Outside the shared checkout entirely — not this hook's business.
  if (!isInside(shared, absoluteTarget)) allow();

  // Writes aimed into any worktree are the outcome we want, not a violation.
  if (isInside(join(shared, ...WORKTREE_RELATIVE.split('/')), absoluteTarget)) allow();

  // Setup and opt-out live in the shared checkout by definition, so writing them
  // there is the intended act, not a violation. Derived with path.relative rather
  // than a string slice: on Windows the two paths can differ in case, and a slice
  // would silently mis-key the comparison.
  const relativeTarget = toPosix(relative(shared, absoluteTarget));
  if ([OPT_OUT_FILE, '.gitignore', '.worktreeinclude'].includes(relativeTarget)) allow();
  if (relativeTarget.startsWith('.claude/')) allow();

  if (!sessionId) {
    deny(
      [
        'session_id を取得できないため、このセッション専用のworktreeを特定できません。',
        '共有作業ツリーへの書き込みを拒否しました。',
        `分離せずに進める場合は ${toPosix(join(shared, OPT_OUT_FILE))} を作成するようユーザーへ確認してください。`,
      ].join('\n')
    );
  }

  const dirty = dirtyEntries(shared);
  if (dirty.length) deny(dirtyReason(shared, dirty));

  deny(isolateReason(startDir, shared, sessionId, absoluteTarget));
}

try {
  main();
} catch (err) {
  // Allow, but never silently: a guard that stopped guarding must not be
  // indistinguishable from a tree that needed no guarding.
  process.stdout.write(
    JSON.stringify({
      systemMessage: `codex-review: worktreeガードがエラーのため、分離を確認せず書き込みを許可しました (${err.message})`,
    })
  );
  process.exit(0);
}
