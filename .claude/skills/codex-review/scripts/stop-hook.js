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
 *   --state-path  Read-only lookup of this repo's existing unattended state
 *                 path. Prints an empty line when the branch is uninitialized.
 *   --pending     Read-only display of unattended findings and decisions.
 *   --prepare-pending
 *                 Initializes branch-local identity and prints pending JSON for
 *                 a review workflow that may later append or replace it.
 *   --adopt-legacy-pending
 *                 Explicitly moves legacy repository-wide pending state to the
 *                 current branch after the user has confirmed its ownership.
 *   --append-pending <file>
 *                 Validates and atomically appends findings from a JSON file.
 *   --replace-pending <file>
 *                 Validates and atomically replaces the pending state.
 *   --finalize-pending <file>
 *                 Atomically binds append/replace pending state and the reviewed
 *                 marker to the same worktree fingerprint.
 *   --mode        Prints the mode captured for the current instruction.
 *
 * Opt-in per repository: hook mode does nothing unless FLAG_FILE sits in the
 * repository root.
 *
 * Why finalization takes a fingerprint. A review runs for minutes, and the tree
 * can move underneath it — another session sharing this checkout, or the same
 * session editing on. Updating carryovers or marking "whatever the tree is now"
 * would apply a stale review to changes Codex never read. Binding both outcomes
 * to the reviewed snapshot, and refusing when it no longer matches, fails
 * toward re-reviewing rather than toward silence. `--mark` remains as a
 * low-level compatibility operation; the skill uses `--finalize-pending`.
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
const { createHash, randomUUID } = require('node:crypto');
const {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');

const { DEFAULTS, readConfig } = require('./config-core.js');
const { renameAtomic } = require('./file-core.js');
const { currentMode } = require('./schedule.js');
const {
  STATE_DIR,
  claimPath,
  clearClaimsUnlocked,
  ensureStateDir,
  readState,
  stateKey,
  withStateLock,
  writeState,
} = require('./state-core.js');

const FLAG_FILE = '.codex-review-auto';
const SETUP_LOCK_FILE = '.codex-review-setup.lock';

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

function sessionKey(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function branchRegistryPath(root) {
  return join(STATE_DIR, `${stateKey(root)}.branches.json`);
}

function currentBranchDescriptor(root) {
  try {
    const ref = git(['symbolic-ref', '--quiet', 'HEAD'], root).trim();
    let legacyReflogFile = null;
    try {
      const commonDir = resolve(root, git(['rev-parse', '--git-common-dir'], root).trim());
      const reflogPath = join(commonDir, 'logs', ...ref.split('/'));
      const reflogStat = statSync(reflogPath);
      // Used only to migrate a development-version registry. New identities
      // live in branch config and do not depend on mutable reflog files.
      legacyReflogFile =
        `${reflogStat.dev}:${reflogStat.ino}:${reflogStat.birthtimeMs}`;
    } catch {
      // Reflogs can be disabled, expired or not created yet.
    }
    return { kind: 'branch', ref, legacyReflogFile };
  } catch {
    try {
      return {
        kind: 'detached',
        head: git(['rev-parse', '--verify', 'HEAD'], root).trim(),
      };
    } catch {
      throw new Error('現在のGitブランチまたはHEADを識別できません');
    }
  }
}

function normalizeBranchRegistry(value, source) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !Array.isArray(value.branches)
  ) {
    throw new Error(`${source} はversion 1のブランチ状態JSONにしてください`);
  }

  const ids = new Set();
  const refs = new Set();
  for (const [index, branch] of value.branches.entries()) {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
      throw new Error(`${source} のbranches[${index}]はJSONオブジェクトにしてください`);
    }
    if (typeof branch.id !== 'string' || !/^[0-9a-f]{12}$/.test(branch.id)) {
      throw new Error(`${source} のbranches[${index}].idが不正です`);
    }
    if (
      typeof branch.ref !== 'string' ||
      !branch.ref.startsWith('refs/heads/') ||
      branch.ref.length <= 'refs/heads/'.length
    ) {
      throw new Error(`${source} のbranches[${index}].refが不正です`);
    }
    if (
      branch.reflog_file !== undefined &&
      branch.reflog_file !== null &&
      typeof branch.reflog_file !== 'string'
    ) {
      throw new Error(
        `${source} のbranches[${index}].reflog_fileは文字列またはnullにしてください`
      );
    }
    if (ids.has(branch.id) || refs.has(branch.ref)) {
      throw new Error(`${source} のブランチIDまたはrefが重複しています`);
    }
    ids.add(branch.id);
    refs.add(branch.ref);
  }
  return {
    version: 1,
    branches: value.branches.map((branch) => ({
      id: branch.id,
      ref: branch.ref,
      // `reflog_file` was used by an unreleased development version. Retain it
      // only long enough to bind that entry to the new branch-config identity.
      legacy_reflog_file: branch.reflog_file ?? null,
    })),
  };
}

function readBranchRegistry(root) {
  const target = branchRegistryPath(root);
  if (!existsSync(target)) return { version: 1, branches: [] };
  return normalizeBranchRegistry(
    JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, '')),
    target
  );
}

function writeBranchRegistry(root, registry) {
  ensureStateDir();
  const target = branchRegistryPath(root);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const persisted = {
    version: 1,
    branches: registry.branches.map((branch) => ({
      id: branch.id,
      ref: branch.ref,
      ...(branch.legacy_reflog_file
        ? { reflog_file: branch.legacy_reflog_file }
        : {}),
    })),
  };
  try {
    writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameAtomic(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }
}

function branchConfigKey(ref) {
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    throw new Error(`ブランチrefが不正です: ${ref}`);
  }
  return `branch.${ref.slice(prefix.length)}.codexReviewId`;
}

function readBranchConfigId(root, ref) {
  let output;
  try {
    output = git(['config', '--local', '--get-all', branchConfigKey(ref)], root).trim();
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
  const values = output.split(/\r?\n/).filter(Boolean);
  if (values.length !== 1 || !/^[0-9a-f]{12}$/.test(values[0])) {
    throw new Error(
      `${branchConfigKey(ref)} は12桁の16進IDを1件だけ設定してください`
    );
  }
  return values[0];
}

function writeBranchConfigId(root, ref, id) {
  git(
    ['config', '--local', '--replace-all', branchConfigKey(ref), id],
    root
  );
}

function refExists(root, ref) {
  try {
    git(['show-ref', '--verify', '--quiet', ref], root);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function branchKey(root) {
  const descriptor = currentBranchDescriptor(root);
  if (descriptor.kind === 'detached') {
    return createHash('sha256')
      .update(`detached:${descriptor.head}`)
      .digest('hex')
      .slice(0, 12);
  }

  const registry = branchRegistryPath(root);
  return withFileLock(`${registry}.lock`, () => {
    const value = readBranchRegistry(root);
    const sameRef = value.branches.find((branch) => branch.ref === descriptor.ref);
    const configuredId = readBranchConfigId(root, descriptor.ref);
    if (configuredId) {
      const byId = value.branches.find((branch) => branch.id === configuredId);
      if (byId?.ref === descriptor.ref) return configuredId;

      const previousRefStillOwnsId =
        byId &&
        refExists(root, byId.ref) &&
        readBranchConfigId(root, byId.ref) === configuredId;
      if (byId && !previousRefStillOwnsId) {
        // `git branch -m` moves the complete branch config section, including
        // our namespaced ID. A newly recreated old ref may already exist, so
        // distinguish rename from `git branch -c` by checking which ref still
        // owns the ID rather than checking ref existence alone.
        if (sameRef && sameRef !== byId) {
          value.branches = value.branches.filter((branch) => branch !== sameRef);
        }
        byId.ref = descriptor.ref;
        delete byId.legacy_reflog_file;
        writeBranchRegistry(root, value);
        return configuredId;
      }

      if (!byId) {
        if (sameRef) {
          value.branches = value.branches.filter((branch) => branch !== sameRef);
        }
        value.branches.push({ id: configuredId, ref: descriptor.ref });
        writeBranchRegistry(root, value);
        return configuredId;
      }
      // A live branch already owns this ID, normally because `git branch -c`
      // copied its config. Give the current branch a fresh identity.
    } else {
      const legacy = value.branches.find(
        (branch) =>
          branch.legacy_reflog_file &&
          branch.legacy_reflog_file === descriptor.legacyReflogFile
      );
      if (legacy) {
        if (sameRef && sameRef !== legacy) {
          value.branches = value.branches.filter((branch) => branch !== sameRef);
        }
        legacy.ref = descriptor.ref;
        delete legacy.legacy_reflog_file;
        writeBranchConfigId(root, descriptor.ref, legacy.id);
        writeBranchRegistry(root, value);
        return legacy.id;
      }
    }

    if (sameRef) {
      // No matching branch-config identity remains, so this ref was deleted and
      // recreated (or its namespaced config was deliberately removed).
      value.branches = value.branches.filter((branch) => branch !== sameRef);
    }
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    writeBranchConfigId(root, descriptor.ref, id);
    value.branches.push({ id, ref: descriptor.ref });
    writeBranchRegistry(root, value);
    return id;
  }, 'ブランチ状態');
}

function branchKeyReadOnly(root) {
  const descriptor = currentBranchDescriptor(root);
  if (descriptor.kind === 'detached') {
    return createHash('sha256')
      .update(`detached:${descriptor.head}`)
      .digest('hex')
      .slice(0, 12);
  }

  const value = readBranchRegistry(root);
  const configuredId = readBranchConfigId(root, descriptor.ref);
  if (configuredId) {
    const byId = value.branches.find((branch) => branch.id === configuredId);
    if (byId?.ref === descriptor.ref) return configuredId;

    const previousRefStillOwnsId =
      byId &&
      refExists(root, byId.ref) &&
      readBranchConfigId(root, byId.ref) === configuredId;
    // `git branch -c` copies branch config. Until a mutating review operation
    // assigns a fresh ID, displaying the source branch's pending state here
    // would associate findings with the wrong branch.
    if (previousRefStillOwnsId) return null;

    // A rename moves branch config before the registry is updated. The config
    // ID is already the durable identity, so it is safe to use without writing.
    return configuredId;
  }

  const legacy = value.branches.find(
    (branch) =>
      branch.legacy_reflog_file &&
      branch.legacy_reflog_file === descriptor.legacyReflogFile
  );
  return legacy?.id ?? null;
}

function unattendedPath(root) {
  return join(STATE_DIR, `${stateKey(root)}.${branchKey(root)}.unattended.json`);
}

function unattendedPathReadOnly(root) {
  const key = branchKeyReadOnly(root);
  return key ? join(STATE_DIR, `${stateKey(root)}.${key}.unattended.json`) : null;
}

function legacyUnattendedPath(root) {
  return join(STATE_DIR, `${stateKey(root)}.unattended.json`);
}

function emptyPending() {
  return { deferred: [], decisions: [] };
}

function normalizePending(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} のルートは JSON オブジェクトにしてください`);
  }
  const result = emptyPending();
  for (const key of ['deferred', 'decisions']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) throw new Error(`${source} の ${key} は配列にしてください`);
    for (const [index, item] of value[key].entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`${source} の ${key}[${index}] は JSON オブジェクトにしてください`);
      }
      const requiredStrings = key === 'deferred'
        ? ['severity', 'title', 'file', 'description', 'suggestion', 'recorded_at']
        : ['topic', 'chose', 'because', 'recorded_at'];
      for (const field of requiredStrings) {
        if (typeof item[field] !== 'string' || item[field].trim() === '') {
          throw new Error(`${source} の ${key}[${index}].${field} は空でない文字列にしてください`);
        }
      }
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          item.recorded_at
        ) ||
        Number.isNaN(Date.parse(item.recorded_at))
      ) {
        throw new Error(`${source} の ${key}[${index}].recorded_at はISO 8601日時にしてください`);
      }
      if (key === 'deferred') {
        if (!['P0', 'P1', 'P2', 'P3'].includes(item.severity)) {
          throw new Error(`${source} の deferred[${index}].severity はP0〜P3にしてください`);
        }
        if (!Number.isInteger(item.line) || item.line < 0) {
          throw new Error(`${source} の deferred[${index}].line は0以上の整数にしてください`);
        }
      } else if (
        !Array.isArray(item.alternatives) ||
        item.alternatives.some((alternative) => typeof alternative !== 'string')
      ) {
        throw new Error(`${source} の decisions[${index}].alternatives は文字列配列にしてください`);
      }
    }
    result[key] = value[key];
  }
  return result;
}

function actionablePending(pending) {
  return {
    ...pending,
    deferred: pending.deferred.filter((item) => item.severity !== 'P3'),
  };
}

function readPending(root, strict = false, target = unattendedPath(root)) {
  if (!existsSync(target)) return emptyPending();
  try {
    return normalizePending(
      JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, '')),
      target
    );
  } catch (error) {
    if (strict) throw error;
    return { ...emptyPending(), error: `持ち越しファイルを読めません: ${error.message}` };
  }
}

function writePending(root, pending, target = unattendedPath(root)) {
  ensureStateDir();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameAtomic(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }
}

const STALE_LOCK_MS = 5 * 60 * 1000;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileLockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value?.owner !== 'codex-review-state' ||
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

function setupLockIsTracked(root, relativePath = SETUP_LOCK_FILE) {
  try {
    git(['ls-files', '--error-unmatch', '--', relativePath], root);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
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
    throw new Error(`所有を確認できないsetup cleanup lockを保持して中止します: ${cleanupLock}`);
  }
  try {
    const current = statSync(lock);
    if (
      sameFile(claim, current) &&
      Date.now() - claim.mtimeMs > STALE_LOCK_MS &&
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

function setupIsActive(root) {
  const lock = join(root, SETUP_LOCK_FILE);
  const cleanupLock = `${lock}.cleanup`;
  if (existsSync(cleanupLock)) finishSetupLockCleanup(root, lock, cleanupLock);
  if (!existsSync(lock)) return false;
  if (setupLockIsTracked(root)) {
    throw new Error(`git追跡済みのsetup lockを削除せず停止します: ${lock}`);
  }
  const owner = setupLockOwner(lock);
  if (!owner) {
    throw new Error(`所有を確認できないsetup lockを削除せず停止します: ${lock}`);
  }
  const stat = statSync(lock);
  if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS || processIsAlive(owner.pid)) {
    return true;
  }
  try {
    linkSync(lock, cleanupLock);
  } catch (error) {
    if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
  }
  if (existsSync(cleanupLock)) finishSetupLockCleanup(root, lock, cleanupLock);
  return existsSync(lock);
}

function finishFileLockCleanup(lock, cleanupLock) {
  let claim;
  try {
    claim = statSync(cleanupLock);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const owner = fileLockOwner(cleanupLock);
  if (!owner) {
    throw new Error(`所有を確認できないcleanup lockを保持して中止します: ${cleanupLock}`);
  }

  try {
    const current = statSync(lock);
    // The cleanup path is a hard link to the exact stale lock inode. Never
    // remove a replacement lock that another process created meanwhile.
    if (
      sameFile(claim, current) &&
      Date.now() - claim.mtimeMs > STALE_LOCK_MS &&
      !processIsAlive(owner.pid)
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

function releaseFileLock(lock, token) {
  try {
    const current = JSON.parse(readFileSync(lock, 'utf8'));
    if (current.token === token) unlinkSync(lock);
  } catch {
    // A stale-lock cleanup may already have removed or replaced it.
  }
}

function withFileLock(lock, action, label) {
  ensureStateDir();
  const cleanupLock = `${lock}.cleanup`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(cleanupLock)) {
      finishFileLockCleanup(lock, cleanupLock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      writeFileSync(
        lock,
        `${JSON.stringify({
          owner: 'codex-review-state',
          version: 1,
          token,
          pid: process.pid,
          at: new Date().toISOString(),
        })}\n`,
        { flag: 'wx', mode: 0o600 }
      );
      acquired = true;
      // A delayed stale cleaner may have linked the old path immediately before
      // this create. Do not enter the critical section while that claim exists.
      if (existsSync(cleanupLock)) {
        releaseFileLock(lock, token);
        acquired = false;
        finishFileLockCleanup(lock, cleanupLock);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          try {
            // Creating a hard link is an atomic claim on this exact lock inode.
            // Helpers can safely finish an abandoned cleanup because inode
            // comparison prevents them from deleting a replacement lock.
            linkSync(lock, cleanupLock);
          } catch (cleanupError) {
            if (!['EEXIST', 'ENOENT'].includes(cleanupError.code)) throw cleanupError;
          }
          finishFileLockCleanup(lock, cleanupLock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (!acquired) throw new Error(`${label}の更新ロックを10秒以内に取得できませんでした`);

  try {
    return action();
  } finally {
    releaseFileLock(lock, token);
  }
}

function withPendingLock(root, action, target = unattendedPath(root)) {
  return withFileLock(`${target}.lock`, action, '持ち越しファイル');
}

function adoptLegacyPending(root) {
  const legacy = legacyUnattendedPath(root);
  if (!existsSync(legacy)) return null;
  if (currentBranchDescriptor(root).kind !== 'branch') {
    throw new Error('旧形式の持ち越しは名前付きブランチへ移行してください');
  }
  return withFileLock(`${legacy}.lock`, () => {
    if (!existsSync(legacy)) return null;
    const target = unattendedPath(root);
    return withPendingLock(root, () => {
      if (!existsSync(legacy)) return null;
      const legacyPending = normalizePending(
        JSON.parse(readFileSync(legacy, 'utf8').replace(/^\uFEFF/, '')),
        legacy
      );
      const current = readPending(root, true, target);
      writePending(root, {
        deferred: appendUnique(
          actionablePending(current).deferred,
          actionablePending(legacyPending).deferred
        ),
        decisions: appendUnique(current.decisions, legacyPending.decisions),
      }, target);
      unlinkSync(legacy);
      return target;
    }, target);
  }, '旧持ち越しファイル');
}

function pendingSnapshot(root, target) {
  const { error = null, ...pending } = target
    ? readPending(root, false, target)
    : emptyPending();
  const legacyPath = legacyUnattendedPath(root);
  let legacy = null;
  if (existsSync(legacyPath)) {
    const { error: legacyError = null, ...legacyPending } =
      readPending(root, false, legacyPath);
    legacy = {
      path: legacyPath,
      error: legacyError,
      revision: legacyError ? null : pendingRevision(legacyPending),
      ...actionablePending(legacyPending),
    };
  }
  return {
    path: target,
    error,
    revision: error ? null : pendingRevision(pending),
    ...actionablePending(pending),
    legacy,
  };
}

function canonical(value, omitRecordedAt = false) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, omitRecordedAt)).join(',')}]`;
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value)
    .filter((key) => !omitRecordedAt || key !== 'recorded_at')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key], omitRecordedAt)}`)
    .join(',')}}`;
}

function pendingRevision(pending) {
  return createHash('sha256').update(canonical(pending)).digest('hex');
}

function appendUnique(current, additions) {
  const stableKey = (item) => {
    const identity = { ...item };
    delete identity.recorded_at;
    // A single finding can move as edits are applied. Treat its non-location
    // fields as the stable identity so a new report can replace stale locators.
    if (Object.prototype.hasOwnProperty.call(identity, 'severity')) delete identity.line;
    return canonical(identity);
  };
  const exactKey = (item) => {
    const identity = { ...item };
    delete identity.recorded_at;
    return canonical(identity);
  };
  const replacedStableKeys = new Set(additions.map(stableKey));
  const seen = new Set();
  const result = [];
  // When a later round reports the same stable finding, its addition group is
  // the newest snapshot. Replace the older group so the locator is current.
  // Deduplicate that newest group with the exact key, which retains separate
  // findings when otherwise identical text appears at multiple line numbers.
  for (const item of [
    ...current.filter((entry) => !replacedStableKeys.has(stableKey(entry))),
    ...additions,
  ]) {
    const key = exactKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function pendingInput(args, index, option) {
  const inputFile = args[index + 1];
  if (!inputFile || inputFile.startsWith('--')) {
    throw new Error(`${option} には入力JSONファイルを指定してください`);
  }
  const value = JSON.parse(readFileSync(inputFile, 'utf8').replace(/^\uFEFF/, ''));
  const pending = actionablePending(normalizePending(value, inputFile));
  return {
    pending,
    provided: {
      deferred: Object.prototype.hasOwnProperty.call(value, 'deferred'),
      decisions: Object.prototype.hasOwnProperty.call(value, 'decisions'),
    },
    fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : null,
    revision: typeof value.revision === 'string' ? value.revision : null,
    strategy: typeof value.strategy === 'string' ? value.strategy : null,
    targetPath: typeof value.path === 'string' ? value.path : null,
  };
}

function restorePending(root, target, existed, previous) {
  if (existed) {
    writePending(root, previous, target);
    return;
  }
  try {
    unlinkSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * When the instruction was given, as recorded by the UserPromptSubmit hook.
 * Falls back to now — a missing record only means the mode is decided a little
 * later than it should be, which is better than refusing to run.
 */
function promptTime(root, sessionId, explicitSessionKey = null) {
  try {
    const key = explicitSessionKey || (sessionId ? sessionKey(sessionId) : null);
    const suffix = key ? `.${key}` : '';
    const j = JSON.parse(
      readFileSync(join(STATE_DIR, `${stateKey(root)}${suffix}.prompt.json`), 'utf8')
    );
    const at = new Date(j.at);
    return Number.isNaN(at.getTime()) ? new Date() : at;
  } catch {
    return new Date();
  }
}

/**
 * The mode in force for this repo: decided from when the instruction was given,
 * not from when the review happens to reach this point.
 */
function effectiveMode(root, sessionId, explicitSessionKey = null) {
  const config = readConfig();
  const { mode, reason } = currentMode(config, promptTime(root, sessionId, explicitSessionKey));
  const away = mode === null ? config.unattended?.enabled === true : mode === 'away';
  const workRounds = Number.isInteger(config.rounds?.work) && config.rounds.work > 0
    ? config.rounds.work
    : DEFAULTS.rounds.work;
  const awayRounds = Number.isInteger(config.rounds?.away) && config.rounds.away > 0
    ? config.rounds.away
    : DEFAULTS.rounds.away;
  // Severity handling is a product policy, not a per-machine preference.
  // Ignore malformed or hand-edited config here so P0/P1/P2 cannot be skipped.
  const autoFix = [...DEFAULTS.unattended.auto_fix];
  return {
    away,
    rounds: away ? awayRounds : workRounds,
    autoFix,
    reason: mode === null ? '手動設定' : reason,
  };
}

function blockReason(root, mode, sessionId) {
  // Forward slashes so the path can be pasted into any shell as-is.
  const self = __filename.replace(/\\/g, '/');
  const handling = mode.away
    ? [
        `現在は離席モード（${mode.reason}）。AskUserQuestion は使わないこと。`,
        `${mode.autoFix.join('/')} は必ず修正し、P3 は対象外として修正も持ち越しもしないこと。`,
        `レビューは最大 ${mode.rounds} 回。確定後はレビュー対象を自動コミットし、pushはしないこと。`,
      ]
    : [
        `現在は通常モード（${mode.reason}）。`,
        'P0/P1/P2 は選択確認なしで必ず修正し、P3 は対象外として修正も持ち越しもしないこと。',
        `レビューは最大 ${mode.rounds} 回。確定後はレビュー対象を自動コミットし、pushはしないこと。`,
      ];
  return [
    'この作業ツリーには、まだ Codex レビューを通していない変更があります',
    `（${FLAG_FILE} により自動レビューが有効になっています）。`,
    '',
    'codex-review スキルを起動し、未コミット差分のレビューを実行してください。',
    ...handling,
    '',
    '現在の指示時刻に対応するモードを次のコマンドで取得すること:',
    `  node "${self}" --mode${sessionId ? ` --session-key ${sessionKey(sessionId)}` : ''}`,
    '',
    'レビューを始める前に、対象の差分を控えること:',
    `  node "${self}" --print`,
    '持ち越しのpath / revisionは次で初期化・取得すること:',
    `  node "${self}" --prepare-pending`,
    '',
    'レビューのループが終わったら、スキルのStep 7に従い、控えたfingerprintを含むJSONを',
    '`--finalize-pending`へ渡して持ち越しとレビュー済み記録を同時に確定すること。',
    '',
    '確定を拒否された場合は、レビュー中に作業ツリー・ブランチ・pendingのいずれかが変わっている。',
    '現在の差分と最新pendingを読み直して再レビューすること。',
    'レビューを実行できない場合（CLI 未導入・未認証など）は、その理由をユーザーに報告してください。',
    `自動レビューを止めたい場合は、${join(root, FLAG_FILE)} を削除するようユーザーに伝えてください。`,
  ].join('\n');
}

const ARGS = process.argv.slice(2);
const MARK_INDEX = ARGS.indexOf('--mark');
const IS_MARK = MARK_INDEX !== -1;
const IS_PRINT = ARGS.includes('--print');
const IS_STATE_PATH = ARGS.includes('--state-path');
const IS_PENDING = ARGS.includes('--pending');
const IS_PREPARE_PENDING = ARGS.includes('--prepare-pending');
const IS_ADOPT_LEGACY_PENDING = ARGS.includes('--adopt-legacy-pending');
const APPEND_PENDING_INDEX = ARGS.indexOf('--append-pending');
const REPLACE_PENDING_INDEX = ARGS.indexOf('--replace-pending');
const FINALIZE_PENDING_INDEX = ARGS.indexOf('--finalize-pending');
const IS_APPEND_PENDING = APPEND_PENDING_INDEX !== -1;
const IS_REPLACE_PENDING = REPLACE_PENDING_INDEX !== -1;
const IS_FINALIZE_PENDING = FINALIZE_PENDING_INDEX !== -1;
const IS_MODE = ARGS.includes('--mode');
const RETRY_INDEX = ARGS.indexOf('--retry');
const IS_RETRY = RETRY_INDEX !== -1;
const SESSION_KEY_INDEX = ARGS.indexOf('--session-key');
const IS_CLI = ARGS.length > 0;

function validateCliArgs() {
  if (!IS_CLI) return;
  const operations = [
    IS_MARK,
    IS_PRINT,
    IS_STATE_PATH,
    IS_PENDING,
    IS_PREPARE_PENDING,
    IS_ADOPT_LEGACY_PENDING,
    IS_APPEND_PENDING,
    IS_REPLACE_PENDING,
    IS_FINALIZE_PENDING,
    IS_MODE,
    IS_RETRY,
  ].filter(Boolean).length;
  if (operations !== 1) throw new Error('CLIモードは操作を1つだけ指定してください');

  let expectedLength = 1;
  if (
    IS_MARK ||
    IS_APPEND_PENDING ||
    IS_REPLACE_PENDING ||
    IS_FINALIZE_PENDING ||
    IS_RETRY
  ) {
    expectedLength = 2;
  }
  if (IS_MODE && SESSION_KEY_INDEX !== -1) expectedLength = 3;
  if (ARGS.length !== expectedLength) {
    throw new Error(`未対応または余分な引数があります: ${ARGS.join(' ')}`);
  }
  if (SESSION_KEY_INDEX !== -1 && !IS_MODE) {
    throw new Error('--session-key は --mode と一緒に指定してください');
  }
}

function main() {
  validateCliArgs();
  let event = {};
  if (!IS_CLI) {
    try {
      event = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      event = {};
    }
  }

  // event.cwd first, CLAUDE_PROJECT_DIR only as a fallback. A session that moved
  // into its own worktree must have *that* tree reviewed and marked; the docs
  // define CLAUDE_PROJECT_DIR only as "the project root" and never state what it
  // becomes inside a worktree, so preferring it could review the shared checkout
  // the session left behind — and record the worktree's diff as reviewed. Outside
  // a worktree both resolve to the same root, so nothing else changes.
  const startDir = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = event.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const explicitSessionKey = SESSION_KEY_INDEX === -1 ? null : ARGS[SESSION_KEY_INDEX + 1];
  if (
    SESSION_KEY_INDEX !== -1 &&
    (!explicitSessionKey || !/^[a-f0-9]{16}$/.test(explicitSessionKey))
  ) {
    throw new Error('--session-key にはStop hookが提示した16桁のキーを指定してください');
  }

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

  if (IS_MODE) {
    const m = effectiveMode(root, sessionId, explicitSessionKey);
    process.stdout.write(`${m.away ? '離席モード' : '通常モード'}（${m.reason}）\n`);
    process.stdout.write(
      `  指摘の処理: 聞かない（${m.autoFix.join('/')} は必須修正、P3 は対象外）\n`
    );
    process.stdout.write(`  レビュー上限: ${m.rounds} 回\n`);
    process.stdout.write('  自動コミット: ON（レビュー確定後、pushなし）\n');
    return;
  }

  if (IS_STATE_PATH) {
    process.stdout.write(`${unattendedPathReadOnly(root) ?? ''}\n`);
    return;
  }

  if (IS_PENDING) {
    process.stdout.write(
      `${JSON.stringify(pendingSnapshot(root, unattendedPathReadOnly(root)), null, 2)}\n`
    );
    return;
  }

  if (IS_PREPARE_PENDING) {
    process.stdout.write(
      `${JSON.stringify(pendingSnapshot(root, unattendedPath(root)), null, 2)}\n`
    );
    return;
  }

  if (IS_ADOPT_LEGACY_PENDING) {
    const target = adoptLegacyPending(root);
    process.stdout.write(
      target
        ? `codex-review: 旧形式の持ち越しを現在のブランチへ移行しました: ${target}\n`
        : 'codex-review: 旧形式の持ち越しはありません\n'
    );
    return;
  }

  if (IS_APPEND_PENDING) {
    const input = pendingInput(ARGS, APPEND_PENDING_INDEX, '--append-pending');
    if (!input.targetPath) {
      throw new Error('--append-pending の入力には --prepare-pending で得た path が必要です');
    }
    const target = unattendedPath(root);
    if (input.targetPath !== target) {
      throw new Error(
        'レビュー開始後にブランチが切り替わっています。元のブランチで --prepare-pending からやり直してください'
      );
    }
    const pending = withPendingLock(root, () => {
      const current = readPending(root, true, target);
      const merged = {
        deferred: appendUnique(actionablePending(current).deferred, input.pending.deferred),
        decisions: appendUnique(current.decisions, input.pending.decisions),
      };
      writePending(root, merged, target);
      return merged;
    }, target);
    process.stdout.write(
      `codex-review: 持ち越しを保存しました (deferred: ${pending.deferred.length}, decisions: ${pending.decisions.length})\n`
    );
    return;
  }

  if (IS_RETRY) {
    const expected = ARGS[RETRY_INDEX + 1];
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error('--retry にはレビュー前に控えた64桁のfingerprintを指定してください');
    }
    const current = fingerprint(root);
    if (current !== expected) {
      throw new Error('作業ツリーが変わっているため、古いfingerprintの再試行を予約できません');
    }
    withStateLock(root, () => {
      const state = readState(root, { strict: true });
      const updated = { ...state, retry: expected };
      if (updated.reviewed === expected) delete updated.reviewed;
      writeState(root, updated);
    });
    process.stdout.write(
      'codex-review: 次のユーザー指示時に同じ差分を再レビューするよう予約しました\n'
    );
    return;
  }

  if (IS_FINALIZE_PENDING) {
    const input = pendingInput(ARGS, FINALIZE_PENDING_INDEX, '--finalize-pending');
    if (!['append', 'replace'].includes(input.strategy)) {
      throw new Error('--finalize-pending の入力strategyはappendまたはreplaceにしてください');
    }
    if (!input.fingerprint || !/^[0-9a-f]{64}$/.test(input.fingerprint)) {
      throw new Error('--finalize-pending の入力には最後にレビューしたfingerprintが必要です');
    }
    if (!input.targetPath) {
      throw new Error('--finalize-pending の入力には --prepare-pending で得た path が必要です');
    }
    if (input.strategy === 'replace' && !input.revision) {
      throw new Error(
        'replace方式の--finalize-pendingには --prepare-pending で得た revision が必要です'
      );
    }

    const target = unattendedPath(root);
    if (input.targetPath !== target) {
      throw new Error(
        'レビュー開始後にブランチが切り替わっています。元のブランチで --prepare-pending からやり直してください'
      );
    }

    const updated = withPendingLock(root, () => {
      const existed = existsSync(target);
      const currentPending = readPending(root, true, target);
      if (
        input.strategy === 'replace' &&
        pendingRevision(currentPending) !== input.revision
      ) {
        throw new Error(
          '持ち越しが別セッションで更新されました。--prepare-pending からやり直してください'
        );
      }
      if (fingerprint(root) !== input.fingerprint) {
        throw new Error(
          'レビュー後に作業ツリーが変わっています。持ち越しもレビュー済み記録も更新しません'
        );
      }

      const replacement = input.strategy === 'append'
        ? {
            deferred: appendUnique(
              actionablePending(currentPending).deferred,
              input.pending.deferred
            ),
            decisions: appendUnique(currentPending.decisions, input.pending.decisions),
          }
        : {
            deferred: input.provided.deferred
              ? input.pending.deferred
              : actionablePending(currentPending).deferred,
            decisions: input.provided.decisions
              ? input.pending.decisions
              : currentPending.decisions,
          };

      writePending(root, replacement, target);
      try {
        // Recheck after preparing the pending update, then record both outcomes
        // while the pending lock prevents another carryover writer from
        // interleaving. If either check/state update fails, restore pending.
        if (fingerprint(root) !== input.fingerprint) {
          throw new Error(
            '持ち越し更新中に作業ツリーが変わったため、更新を取り消しました'
          );
        }
        withStateLock(root, () => {
          if (fingerprint(root) !== input.fingerprint) {
            throw new Error(
              'レビュー済み記録の直前に作業ツリーが変わったため、更新を取り消しました'
            );
          }
          const state = readState(root, { strict: true });
          if (state.retry === input.fingerprint) {
            throw new Error(
              'この差分は持ち越し保存失敗からの再試行予約中です。次のユーザー指示で再レビューしてください'
            );
          }
          clearClaimsUnlocked(root);
          writeState(root, { ...state, reviewed: input.fingerprint });
        });
      } catch (error) {
        restorePending(root, target, existed, currentPending);
        throw error;
      }
      return replacement;
    }, target);

    process.stdout.write(
      `codex-review: 持ち越しとレビュー済み記録を確定しました (${input.fingerprint.slice(0, 12)}, deferred: ${updated.deferred.length}, decisions: ${updated.decisions.length})\n`
    );
    return;
  }

  if (IS_REPLACE_PENDING) {
    const input = pendingInput(ARGS, REPLACE_PENDING_INDEX, '--replace-pending');
    if (!input.revision) {
      throw new Error('--replace-pending の入力には --prepare-pending で得た revision が必要です');
    }
    if (!input.targetPath) {
      throw new Error('--replace-pending の入力には --prepare-pending で得た path が必要です');
    }
    const target = unattendedPath(root);
    if (input.targetPath !== target) {
      throw new Error(
        '持ち越しを読んだブランチから切り替わっています。元のブランチで --prepare-pending からやり直してください'
      );
    }
    const updated = withPendingLock(root, () => {
      // Refuse to erase a malformed or concurrently updated existing file.
      const current = readPending(root, true, target);
      if (pendingRevision(current) !== input.revision) {
        throw new Error('持ち越しが別セッションで更新されました。--prepare-pending からやり直してください');
      }
      const replacement = {
        deferred: input.provided.deferred
          ? input.pending.deferred
          : actionablePending(current).deferred,
        decisions: input.provided.decisions ? input.pending.decisions : current.decisions,
      };
      writePending(root, replacement, target);
      return replacement;
    }, target);
    process.stdout.write(
      `codex-review: 持ち越しを更新しました (deferred: ${updated.deferred.length}, decisions: ${updated.decisions.length})\n`
    );
    return;
  }

  // Check the opt-in before fingerprinting. This hook is meant to be registered
  // globally, so every repo that has not opted in pays for whatever runs below —
  // and fingerprinting hashes every untracked file, which is not free.
  // The clock does not decide whether to review — only how. Work hours mean the
  // findings go through a dialog and the loop gets more rounds; away hours mean
  // it decides for itself with fewer. Either way an unreviewed diff gets looked
  // at, which is the whole point of arming the flag.
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

    withStateLock(root, () => {
      const state = readState(root, { strict: true });
      if (state.retry === current) {
        throw new Error(
          'この差分は持ち越し保存失敗からの再試行予約中です。次のユーザー指示で再レビューしてください'
        );
      }
      clearClaimsUnlocked(root);
      writeState(root, { ...state, reviewed: current });
    });
    process.stdout.write(`codex-review: レビュー済みとして記録しました (${current.slice(0, 12)})\n`);
    return;
  }

  if (current === null) allowStop();
  const claimed = withStateLock(root, () => {
    // setup-auto.js holds this project lock while enabling/disabling and clears
    // abandoned claims before releasing it. Recheck inside the state lock so a
    // Stop hook that started just before setup cannot recreate a claim afterward.
    if (
      !existsSync(join(root, FLAG_FILE)) ||
      setupIsActive(root)
    ) {
      return false;
    }
    if (readState(root).reviewed === current) return false;

    // Claim before blocking. Whoever creates the file owns this diff's review; a
    // second session stopping on the same diff finds it taken and lets its turn end.
    // This is also the loop guard: a review that never reports back leaves the claim
    // behind, so the next turn passes instead of blocking again.
    try {
      writeFileSync(claimPath(root, current), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  });
  if (!claimed) allowStop();

  const mode = effectiveMode(root, sessionId);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(root, mode, sessionId) }));
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
