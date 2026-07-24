const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createJobTempDir,
  cleanupJobTempDir,
  drainAllTempDirs,
  sweepOrphanedTempDirs,
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

// WR-10 — the ONE shutdown case no in-process handler can catch: SIGKILL (OOM
// killer, `docker kill`, host reboot, grace-window expiry) leaves every live
// ocr-job-* dir on disk with its input PDF. Without a boot sweep they
// accumulate until /tmp fills and mkdtemp — and therefore every input job —
// starts failing. The registry is in-process, so only a filesystem scan at boot
// can reclaim them.
test('sweepOrphanedTempDirs: removes ocr-job-* dirs left by a previous process', async (t) => {
  // Simulate two dirs orphaned by an earlier, SIGKILLed process: created
  // directly on disk with the module's prefix, absent from the live registry.
  const orphanA = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-job-'));
  const orphanB = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-job-'));
  fs.writeFileSync(path.join(orphanA, 'input.pdf'), 'leaked payload');
  t.after(() => {
    for (const d of [orphanA, orphanB]) fs.rmSync(d, { recursive: true, force: true });
  });

  assert.equal(_activeDirsForTest().length, 0, 'orphans are NOT in the in-process registry');

  const removed = await sweepOrphanedTempDirs();

  assert.ok(removed >= 2, `swept at least the two orphans (removed=${removed})`);
  assert.ok(!fs.existsSync(orphanA), 'orphan A removed, along with its leaked input.pdf');
  assert.ok(!fs.existsSync(orphanB), 'orphan B removed');
});

test('sweepOrphanedTempDirs: never deletes a dir this process currently owns', async (t) => {
  const mine = await createJobTempDir();
  fs.writeFileSync(path.join(mine, 'input.pdf'), 'in flight');
  t.after(() => drainAllTempDirs());

  await sweepOrphanedTempDirs();

  assert.ok(fs.existsSync(mine), 'an in-flight job\'s temp dir must survive the sweep');
  assert.ok(_activeDirsForTest().includes(mine), 'and stay registered');
});

test('sweepOrphanedTempDirs: leaves unrelated tmpdir entries alone', async (t) => {
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'not-ours-'));
  t.after(() => fs.rmSync(unrelated, { recursive: true, force: true }));

  await sweepOrphanedTempDirs();

  assert.ok(fs.existsSync(unrelated), 'only the ocr-job- prefix is swept');
});
