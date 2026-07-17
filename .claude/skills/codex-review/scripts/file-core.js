#!/usr/bin/env node
'use strict';

const { existsSync, renameSync } = require('node:fs');

/**
 * Atomically replaces a file while tolerating a short Windows sharing-denial
 * window. The destination is never unlinked first, so readers see either the
 * old complete file or the new complete file.
 */
function renameAtomic(tmp, target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      renameSync(tmp, target);
      return;
    } catch (error) {
      if (
        !['EACCES', 'EBUSY', 'EPERM'].includes(error.code) ||
        !existsSync(tmp) ||
        attempt === 19
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

module.exports = { renameAtomic };
