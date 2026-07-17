#!/usr/bin/env node
'use strict';

/**
 * Commits exactly the reviewed file list after verifying that the worktree still
 * matches the fingerprint captured for the final Codex review.
 *
 * Usage:
 *   node commit-reviewed.js --expected <fingerprint> --message <message> -- <file>...
 */

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, readlinkSync } = require('node:fs');
const { isAbsolute, relative, resolve } = require('node:path');

const MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function die(message) {
  process.stderr.write(`codex-review: ${message}\n`);
  process.exit(1);
}

function parseArgs(args) {
  const separator = args.indexOf('--');
  if (separator === -1) throw new Error('ファイル一覧の前に -- を指定してください');
  const options = args.slice(0, separator);
  const files = args.slice(separator + 1);
  let expected = null;
  let message = null;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--expected' || option === '--message') {
      const value = options[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${option}には値が必要です`);
      if (option === '--expected') expected = value;
      else message = value;
      index += 1;
      continue;
    }
    throw new Error(`未対応のオプションです: ${option}`);
  }
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('--expectedには最終レビューの64桁fingerprintを指定してください');
  }
  if (!message || message.trim() === '') throw new Error('--messageを指定してください');
  if (files.length === 0) throw new Error('コミット対象ファイルを1件以上指定してください');
  return { expected, message, files };
}

function normalizeFiles(root, files) {
  const seen = new Set();
  const normalized = [];
  for (const input of files) {
    if (!input || isAbsolute(input)) throw new Error(`相対ファイルパスを指定してください: ${input}`);
    const absolute = resolve(root, input);
    const rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error(`リポジトリ直下のファイルを指定してください: ${input}`);
    }
    const path = rel.replace(/\\/g, '/');
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(path);
  }
  return normalized;
}

function fileSnapshot(root, files) {
  const snapshot = {};
  for (const file of files) {
    const absolute = resolve(root, file);
    try {
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        throw new Error(`ディレクトリではなく個別ファイルを指定してください: ${file}`);
      }
      const hash = createHash('sha256');
      if (stat.isSymbolicLink()) hash.update(`symlink:${readlinkSync(absolute)}`);
      else if (stat.isFile()) hash.update(readFileSync(absolute));
      else throw new Error(`通常ファイルまたはsymlinkではありません: ${file}`);
      snapshot[file] = hash.digest('hex');
    } catch (error) {
      if (error.code === 'ENOENT') snapshot[file] = null;
      else throw error;
    }
  }
  return snapshot;
}

function reviewedFingerprint(root) {
  const hook = resolve(__dirname, 'stop-hook.js');
  return execFileSync(process.execPath, [hook, '--print'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  }).trim();
}

function stagedFiles(root) {
  const output = git(['diff', '--cached', '--name-only', '-z'], root);
  return output.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
}

function unexpectedStaged(root, allowed) {
  return stagedFiles(root).filter((path) =>
    !allowed.has(process.platform === 'win32' ? path.toLowerCase() : path));
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const files = normalizeFiles(root, input.files);
  const allowed = new Set(files.map((path) =>
    process.platform === 'win32' ? path.toLowerCase() : path));
  const before = fileSnapshot(root, files);
  if (reviewedFingerprint(root) !== input.expected) {
    throw new Error('最終レビュー後に作業ツリーが変わっているためコミットしません');
  }
  const existingUnexpected = unexpectedStaged(root, allowed);
  if (existingUnexpected.length > 0) {
    throw new Error(`レビュー対象外のステージ済みファイルがあるためコミットしません: ${existingUnexpected.join(', ')}`);
  }

  git(['add', '-A', '--', ...files], root);
  const after = fileSnapshot(root, files);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('ステージ中にコミット対象が変わったためコミットしません');
  }

  const unexpected = unexpectedStaged(root, allowed);
  if (unexpected.length > 0) {
    throw new Error(`レビュー対象外のステージ済みファイルがあるためコミットしません: ${unexpected.join(', ')}`);
  }

  try {
    git(['diff', '--cached', '--quiet', '--', ...files], root);
    process.stdout.write('NO_CHANGES\n');
    return 0;
  } catch (error) {
    if (error.status !== 1) throw error;
  }

  git(['commit', '-m', input.message], root, { stdio: 'inherit' });
  const commit = git(['rev-parse', 'HEAD'], root).trim();
  process.stdout.write(`COMMITTED ${commit}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  die(error.stderr?.trim() || error.message);
}
