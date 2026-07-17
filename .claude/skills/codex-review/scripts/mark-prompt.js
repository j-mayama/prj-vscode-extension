#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook: records when the instruction was given, and asks the
 * session to move into its own worktree before it edits anything.
 *
 * The mode has to follow the person, not the job. Deciding it when the review
 * finally runs gets it wrong every time an instruction straddles a boundary —
 * ask at 17:50, wait out a twenty-minute implementation, and the review lands
 * at 18:10 and quietly stops asking, while the person who is still sitting there
 * waiting never sees the dialog. The instruction is the moment they were here.
 *
 * The worktree half is advisory by necessity: EnterWorktree is a model-callable
 * tool, and a hook cannot invoke it. So this hook states the requirement at the
 * one moment the model is certain to read it — alongside the prompt — and
 * worktree-guard.js enforces it deterministically if the model writes anyway.
 * Advice first, enforcement second: being told up front is what keeps the
 * isolation from costing a denied tool call every time.
 *
 * Writes the timestamp per repository and Claude session. Never fails loudly:
 * this hook runs on every prompt in every configured project, and a hiccup here
 * must not cost a turn.
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const { renameAtomic } = require('./file-core.js');
const {
  STATE_DIR,
  claimPath,
  ensureStateDir,
  readState,
  withStateLock,
  writeState,
} = require('./state-core.js');
const {
  OPT_OUT_FILE,
  dirtyEntries,
  isEnabled,
  isLinkedWorktree,
  isOptedOut,
  mainRoot,
  registeredWorktree,
  toPosix,
  worktreeName,
  worktreePath,
} = require('./worktree-core.js');

function stateKey(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * What to tell the model about isolation, or null when there is nothing to say.
 *
 * Deliberately does not try to guess whether this prompt will edit files.
 * Classifying intent from prompt text is not deterministic, and guessing "read
 * only" wrong is exactly the failure this feature exists to prevent. Instead the
 * model is told the rule and the trigger ("before your first edit"), and the
 * decision stays where it is observable: an actual write, caught by the guard.
 * A question that never writes therefore never creates a worktree.
 */
function worktreeContext(startDir, sessionId) {
  const shared = mainRoot(startDir);
  if (!isEnabled(shared) || isOptedOut(shared)) return null;
  // Already isolated — say nothing rather than spend context every turn.
  if (isLinkedWorktree(startDir)) return null;
  if (!sessionId) return null;

  const dirty = dirtyEntries(shared);
  if (dirty.length) {
    return [
      '[codex-review] このリポジトリはセッションごとのworktree分離が有効ですが、',
      '共有作業ツリーに未コミット変更があるため自動で分離できません。',
      'ファイルを変更する前に、次をユーザーへ確認してください:',
      '  1. 未コミット変更をコミットしてから実装を指示し直す',
      `  2. このリポジトリでは分離しない（${toPosix(join(shared, OPT_OUT_FILE))} を作成する）`,
      'stash / reset / checkout / コピーによる移送は行わないでください。',
      '調査・質問だけならこのまま進めて構いません。',
    ].join('\n');
  }

  const existing = registeredWorktree(startDir, shared, sessionId);
  const move = existing
    ? `  EnterWorktree(path: "${toPosix(existing.path)}")   ← このセッションの既存worktree`
    : `  EnterWorktree(name: "${worktreeName(sessionId)}")`;

  return [
    '[codex-review] このリポジトリは、実装を伴うセッションを専用ブランチ＋worktreeへ分離します。',
    '同じプロジェクトで並行する別セッションとファイルを奪い合わないための構成です。',
    '',
    '**このセッションで最初にファイルを変更する前に**、次を実行して移動してください:',
    move,
    '',
    '- 調査・質問だけで終わる場合はworktreeを作らなくて構いません',
    '- 移動せずに共有作業ツリーへ書き込もうとすると、PreToolUseフックが拒否します',
    '- 移動後はレビュー・自動コミットもそのworktree内で通常どおり動作します',
    '- push / merge / worktreeの削除は行いません。完了報告にブランチとコミットを残してください',
  ].join('\n');
}

function releaseScheduledRetry(root) {
  const initial = readState(root);
  if (typeof initial.retry !== 'string' || !/^[0-9a-f]{64}$/.test(initial.retry)) return;

  withStateLock(root, () => {
    const state = readState(root, { strict: true });
    if (typeof state.retry !== 'string' || !/^[0-9a-f]{64}$/.test(state.retry)) return;
    try {
      unlinkSync(claimPath(root, state.retry));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const updated = { ...state };
    delete updated.retry;
    writeState(root, updated);
  });
}

function main() {
  let event = {};
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    event = {};
  }

  // event.cwd first, CLAUDE_PROJECT_DIR only as a fallback. Once a session moves
  // into its worktree, cwd moves with it, while CLAUDE_PROJECT_DIR is documented
  // only as "the project root" with no stated value inside a worktree. Preferring
  // it risks keying this session's state to the shared checkout it just left. In
  // the ordinary case both resolve to the same repository root anyway.
  const startDir = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  const sessionId = event.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const rootKey = stateKey(root.toLowerCase());
  const sessionSuffix = sessionId ? `.${stateKey(sessionId)}` : '';
  const target = join(STATE_DIR, `${rootKey}${sessionSuffix}.prompt.json`);

  // Invalidate the previous instruction before any operation that can fail. If
  // retry release, directory setup or the new write fails, stop-hook.js must
  // fall back to the current clock instead of reusing another schedule period.
  try {
    unlinkSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  ensureStateDir();
  releaseScheduledRetry(root);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ root, session_id: sessionId, at: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 }
    );
    renameAtomic(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }

  // Emitted last, and in its own try: the isolation notice is valuable, but not
  // so valuable that failing to build it should cost the instruction timestamp
  // that was just written successfully.
  try {
    const context = worktreeContext(startDir, sessionId);
    if (context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: context,
          },
        })
      );
    }
  } catch {
    // worktree-guard.js still denies the write, so isolation holds even when the
    // advisory half is unavailable. Staying silent here beats a broken prompt.
  }
}

try {
  main();
} catch {
  // Not a repo, no git, unwritable state dir — none of it is worth interrupting
  // the user's prompt over. The review just falls back to the clock.
}
process.exit(0);
