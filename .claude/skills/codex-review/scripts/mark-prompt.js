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
const { join, resolve } = require('node:path');

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
  currentBranch,
  dirtyEntries,
  isEnabled,
  isLinkedWorktree,
  isOptedOut,
  mainRoot,
  readMergeTargets,
  registeredWorktree,
  toPosix,
  worktreeName,
  worktreePath,
  writeMergeTarget,
} = require('./worktree-core.js');

// Offered to the user as the one non-destructive way out of a dirty shared
// checkout. Never run from here: it requires --confirm, and the decision to
// commit on someone's branch is theirs.
const WIP_SCRIPT = resolve(__dirname, 'commit-shared-wip.js');

function stateKey(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The single recorded target for this worktree, or null when there is no usable one. */
function recordedTarget(shared, name) {
  const values = readMergeTargets(shared, name);
  return values.length === 1 ? values[0] : null;
}

/**
 * The branch this session's work has to come back to: recorded the first time,
 * only read afterwards.
 *
 * The write happens exactly once — while the worktree does not exist yet, which
 * is the only moment the shared checkout is guaranteed to be on the branch the
 * worktree is about to be cut from.
 *
 * Once it exists, this must never write again, and that is not a micro-
 * optimisation. A *resumed* session runs this hook from the shared checkout, not
 * from its worktree — that is precisely why worktreeContext() has an
 * `EnterWorktree(path:)` branch at all. So "the session is isolated" cannot be
 * inferred from the cwd, and re-recording here would quietly retarget the
 * worktree onto wherever the checkout drifted to since. Worse, it would move the
 * record and the current branch together, so merge-reviewed.js's comparison
 * would agree and merge reviewed work into an unrelated branch reporting
 * success. The existence of the worktree is the durable fact; the cwd is not.
 */
function mergeTarget(shared, sessionId, existing) {
  const name = worktreeName(sessionId);
  if (existing) return recordedTarget(shared, name);

  // Detached: there is no branch for reviewed work to return to. Recording the
  // bare sha would name a target no merge can update. currentBranch() also keeps
  // a same-named tag from turning the record into `heads/<name>`.
  const branch = currentBranch(shared);
  if (!branch) return null;
  writeMergeTarget(shared, name, branch);
  return branch;
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

  // Untracked files can safely stay in the shared checkout. A session worktree
  // starts from HEAD, so it will neither see nor commit them; merge-reviewed.js
  // preserves them and handles a same-path collision without overwriting their
  // contents. Tracked edits still have to stop isolation because leaving those
  // behind would silently change the task's starting point.
  const dirty = dirtyEntries(shared, { untracked: false });
  if (dirty.length) {
    return [
      '[codex-review] このリポジトリはセッションごとのworktree分離が有効ですが、',
      '共有作業ツリーに未コミット変更があるため自動で分離できません。',
      'ファイルを変更する前に、次をユーザーへ確認してください:',
      '  1. その未コミット変更を現在のブランチへコミットしてから分離する',
      `     → 対象の確認: node "${toPosix(WIP_SCRIPT)}" --plan`,
      `     → 同意を得てから: node "${toPosix(WIP_SCRIPT)}" --confirm <fingerprint>`,
      '  2. ユーザー自身がコミットしてから、あらためて実装を指示し直す',
      `  3. このリポジトリでは分離しない（${toPosix(join(shared, OPT_OUT_FILE))} を作成する）`,
      'stash / reset / checkout / コピーによる移送は行わないでください。',
      '調査・質問だけならこのまま進めて構いません。',
    ].join('\n');
  }

  const existing = registeredWorktree(startDir, shared, sessionId);
  const move = existing
    ? `  EnterWorktree(path: "${toPosix(existing.path)}")   ← このセッションの既存worktree`
    : `  EnterWorktree(name: "${worktreeName(sessionId)}")`;

  let target = null;
  try {
    target = mergeTarget(shared, sessionId, existing);
  } catch {
    // Best effort, deliberately. This hook runs on every prompt and must not
    // cost the user a turn. merge-reviewed.js refuses to merge without a record
    // and prints how to restore it, so the failure surfaces where it can be
    // acted on rather than being guessed at.
    //
    // Read back rather than reporting "not recorded": an earlier prompt may have
    // recorded successfully, and merge would then use that. Saying no merge will
    // happen when one will is the kind of wrong that gets believed.
    try {
      target = recordedTarget(shared, worktreeName(sessionId));
    } catch {
      // Nothing readable either — the notice below states that honestly.
    }
  }

  return [
    '[codex-review] このリポジトリは、実装を伴うセッションを専用ブランチ＋worktreeへ分離します。',
    '同じプロジェクトで並行する別セッションとファイルを奪い合わないための構成です。',
    '',
    '**このセッションで最初にBashを使うか、ファイルを変更する前に**、次を実行して移動してください:',
    move,
    '',
    '- ツールを使わない調査・質問だけならworktreeを作らなくて構いません',
    '- 移動せずに共有作業ツリーでBashや書き込みを行うと、PreToolUseフックが拒否します',
    '- 移動後はレビュー・自動コミットもそのworktree内で通常どおり動作します',
    target
      ? `- レビューと自動コミットのあと、${target}（このworktreeの統合先として記録済み）へmergeします`
        + '（pushとworktreeの削除は行いません）'
      : '- 統合先を記録できなかったため、レビュー後のmergeは行われません'
        + '（共有チェックアウトがdetached HEADの場合など。pushとworktreeの削除も行いません）',
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
