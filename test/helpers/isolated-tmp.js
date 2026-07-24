// Give the REQUIRING TEST PROCESS its own temp root.
//
// `lib/v1/input/temp.js` sweeps every `ocr-job-*` directory under `os.tmpdir()`
// that is not in its own in-process `active` set (WR-10, recovering dirs
// orphaned by a SIGKILL). Its doc comment states the precondition plainly:
// "Safe because the process is single-instance per container."
//
// Production honours that. The TEST environment violates it: `node --test` runs
// each test FILE in its own process, in parallel, all sharing the host's
// /tmp — so the sweep in one file's process deletes temp dirs owned by another
// file's process. That produced a real intermittent failure:
//
//   not ok 260 - drainAndCancel: drains registered temp dirs on mid-job SIGTERM
//   error: "ENOENT: no such file or directory, open '/tmp/ocr-job-RmklRA/page-1.png'"
//
// — a directory that had just been created by mkdtemp, deleted between the
// create and the very next write. Confirmed by instrumenting the sweep: on every
// suite run, test/temp.test.js's process deleted `ocr-job-*` dirs it did not own.
//
// Requiring this module FIRST (before anything that touches temp dirs) points
// TMPDIR at a private directory, restoring the single-instance precondition
// per process. `os.tmpdir()` reads the environment on each call, and temp.js
// calls it per operation, so no import-order trap beyond "require me first".
//
// Deliberately NOT a production change: the sweep's behaviour is correct for the
// deployment it documents, and weakening it would hand back the disk-fill
// failure WR-10 closed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-root-'));
process.env.TMPDIR = root;

// Best-effort: leave nothing behind. The test process may also exit via a
// signal, in which case this is skipped — these live under the OS temp dir and
// are named distinctly, so they are cheap to identify if that happens.
process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // never let cleanup fail a passing run
  }
});

module.exports = { root };
