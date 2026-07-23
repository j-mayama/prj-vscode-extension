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
 * Scope: tools that name their target file (Edit / Write / NotebookEdit), plus
 * Bash as a whole. An arbitrary shell string can hide writes behind redirects,
 * variables, subshells or another script, so Bash is never guessed to be
 * read-only while the session is still in the shared checkout. Move first, then
 * both read-only and mutating commands run normally in the session worktree.
 *
 * Failure policy: allow. This hook runs before every edit in every configured
 * project, and a guard that errors closed would make the repository unwritable
 * over a git hiccup. It says so via systemMessage rather than failing silently,
 * because a guard that quietly stopped guarding looks exactly like a safe tree.
 */

const { readFileSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

// The one migration this skill offers, named here so the denial and the fix
// arrive together. Nothing runs it automatically: it needs --confirm.
const WIP_SCRIPT = resolve(__dirname, 'commit-shared-wip.js');

const {
  FLAG_FILE,
  OPT_OUT_FILE,
  WORKTREE_RELATIVE,
  canonicalPath,
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
const GUARDED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash']);

/**
 * The complete set of shared-checkout paths a session may still write, spelled
 * out one file at a time.
 *
 * Each of these is a file whose *only* meaningful location is the shared
 * checkout: writing it inside a worktree either does nothing (nobody reads it
 * there) or is lost when the worktree is thrown away. Everything else — source,
 * documentation, and the rest of `.claude/` — belongs to the isolated worktree,
 * because those are exactly the files two sessions overwrite for each other.
 *
 * This used to be `.claude/` wholesale, on the reasoning that `.claude/` is
 * configuration. It is not: `.claude/skills/`, `.claude/agents/` and
 * `.claude/commands/` are ordinary tracked project files, and repositories whose
 * product *is* a skill kept the guard switched off for the only files they
 * actually edit. `.claude/settings.json` is tracked too, and a shared write to
 * it is the plain lost-update this hook exists to stop.
 *
 * Compared as whole paths, never as prefixes: a prefix match is how a list of
 * five files silently becomes a subtree again.
 */
const SHARED_WRITABLE = new Set([
  // Isolation's on/off switches. They are read from the shared checkout by
  // definition, and denying them would leave no way to turn isolation off.
  FLAG_FILE,
  OPT_OUT_FILE,
  // What setup-auto.js appends to: the ignore lines that keep nested worktrees
  // out of git's status, and the list of files a new worktree inherits.
  '.gitignore',
  '.worktreeinclude',
  // Where the hooks are registered. Gitignored and machine-local, and copied
  // into each worktree by `.worktreeinclude` — so an edit made inside a worktree
  // never reaches the shared checkout that every later session starts from.
  '.claude/settings.local.json',
]);

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
  if (event.tool_name === 'Bash') return null;
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
    'ユーザーに次のいずれかを確認してください:',
    '  1. 上の変更を現在のブランチへコミットしてから分離する（下のスクリプトで実行できます）',
    '  2. 自分でコミットしてから、あらためて実装を指示する',
    `  3. このリポジトリでは分離しない（${toPosix(join(main, OPT_OUT_FILE))} を作成する）`,
    '',
    '1の場合は、まず次で対象の全件と確認用fingerprintを表示してください（HEAD・index・作業ファイルは不変）:',
    `  node "${toPosix(WIP_SCRIPT)}" --plan`,
    '  → 表示された全件をユーザーへ提示して同意を得てから',
    `     node "${toPosix(WIP_SCRIPT)}" --confirm <fingerprint>`,
    '  → 未追跡ファイルはコミットされません。取り消し用コマンドも表示されます',
    '',
    'いずれか決まるまでファイルを変更しないでください。',
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

  const isBash = event.tool_name === 'Bash';
  const target = targetOf(event);
  if (!isBash && !target) allow();

  const startDir = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = event.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;

  // Not a repo / no git: nothing to isolate.
  const shared = mainRoot(startDir);

  if (!isEnabled(shared) || isOptedOut(shared)) allow();

  // Already isolated. Do not nest another worktree inside this one.
  if (isLinkedWorktree(startDir)) allow();

  if (!sessionId) {
    deny(
      [
        'session_id を取得できないため、このセッション専用のworktreeを特定できません。',
        '共有作業ツリーでのBash・書き込みを拒否しました。',
        `分離せずに進める場合は ${toPosix(join(shared, OPT_OUT_FILE))} を作成するようユーザーへ確認してください。`,
      ].join('\n')
    );
  }

  if (isBash) {
    const dirty = dirtyEntries(shared, { untracked: false });
    if (dirty.length) deny(dirtyReason(shared, dirty));
    deny(isolateReason(startDir, shared, sessionId, shared));
  }

  // Canonicalized on both sides before any comparison. `shared` comes from git
  // and the target from the tool call, and on Windows those two routinely spell
  // the same directory differently (8.3 short names, symlinks, subst drives).
  // Comparing the raw strings answers "outside the checkout" for a path that is
  // plainly inside it, and this guard would then allow the very write it exists
  // to stop — silently.
  const canonicalShared = canonicalPath(shared);
  const absoluteTarget = canonicalPath(isAbsolute(target) ? target : resolve(startDir, target));

  // Outside the shared checkout entirely — not this hook's business.
  if (!isInside(canonicalShared, absoluteTarget)) allow();

  // Writes aimed into any worktree are the outcome we want, not a violation.
  if (isInside(join(canonicalShared, ...WORKTREE_RELATIVE.split('/')), absoluteTarget)) allow();

  // Setup and opt-out live in the shared checkout by definition, so writing them
  // there is the intended act, not a violation. Derived with path.relative rather
  // than a string slice: on Windows the two paths can differ in case, and a slice
  // would silently mis-key the comparison. Compared case-insensitively there for
  // the same reason — `.Claude/settings.local.json` is the same file, and denying
  // it over spelling would block a write this guard means to allow.
  const relativeTarget = toPosix(relative(canonicalShared, absoluteTarget));
  const key = process.platform === 'win32' ? relativeTarget.toLowerCase() : relativeTarget;
  if (SHARED_WRITABLE.has(key)) allow();

  const dirty = dirtyEntries(shared, { untracked: false });
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
