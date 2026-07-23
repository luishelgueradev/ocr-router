const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createJobTempDir,
  cleanupJobTempDir,
  drainAllTempDirs,
  _activeDirsForTest,
} = require('../lib/v1/input/temp');

// INP-08 / D-07 / Pitfall 2 — the per-job temp-dir registry. This is the #1
// leak vector: temp files must be removed on success, on error, AND on a
// mid-job SIGTERM (via the shutdown drain). These tests use the REAL fs on the
// host (no subprocess needed) and always drain in t.after so the module-level
// registry singleton never leaks state into another test file.

test('createJobTempDir: creates a real ocr-job- dir under os.tmpdir() and registers it', async (t) => {
  t.after(() => drainAllTempDirs());
  const dir = await createJobTempDir();

  assert.ok(fs.existsSync(dir), 'temp dir exists on disk');
  assert.equal(path.dirname(dir), os.tmpdir(), 'created under os.tmpdir()');
  assert.ok(path.basename(dir).startsWith('ocr-job-'), 'uses the ocr-job- prefix');
  assert.ok(_activeDirsForTest().includes(dir), 'registered in the active set');
});

test('cleanupJobTempDir: deregisters + deletes from disk, and is idempotent', async (t) => {
  t.after(() => drainAllTempDirs());
  const dir = await createJobTempDir();
  // Drop a file inside to prove recursive removal.
  fs.writeFileSync(path.join(dir, 'page-1.png'), 'x');
  assert.ok(fs.existsSync(dir));

  await cleanupJobTempDir(dir);
  assert.ok(!fs.existsSync(dir), 'dir removed from disk (recursive)');
  assert.ok(!_activeDirsForTest().includes(dir), 'removed from the active set');

  // Second call must not throw (force:true idempotency).
  await assert.doesNotReject(cleanupJobTempDir(dir), 'double cleanup is a no-op');
});

test('drainAllTempDirs: deletes every registered dir and empties the registry', async () => {
  const a = await createJobTempDir();
  const b = await createJobTempDir();
  fs.writeFileSync(path.join(a, 'f'), 'x');
  assert.ok(fs.existsSync(a) && fs.existsSync(b));

  await drainAllTempDirs();

  assert.ok(!fs.existsSync(a), 'dir a drained');
  assert.ok(!fs.existsSync(b), 'dir b drained');
  assert.equal(_activeDirsForTest().length, 0, 'registry emptied');
});

test('drainAllTempDirs: best-effort — a missing dir does not throw', async (t) => {
  t.after(() => drainAllTempDirs());
  const dir = await createJobTempDir();
  // Remove it out-of-band so the drain hits a non-existent path.
  fs.rmSync(dir, { recursive: true, force: true });

  await assert.doesNotReject(drainAllTempDirs(), 'drain tolerates already-gone dirs');
  assert.equal(_activeDirsForTest().length, 0, 'registry still emptied');
});
