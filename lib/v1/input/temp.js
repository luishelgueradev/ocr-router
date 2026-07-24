// INP-08 / D-07 / Pitfall 2 — per-job temp-dir registry with guaranteed cleanup.
//
// This is the single most important safety property of the input pipeline: the
// intermediate page files a job writes MUST be removed on success, on error,
// AND on a mid-job SIGTERM. The happy-path `finally` covers success/error, but a
// job killed mid-raster by graceful shutdown may never run its `finally` before
// the process exits — so every temp dir is also tracked in a module-level Set
// that `shutdown.js drainAndCancel` drains on SIGTERM (Pitfall 2, the #1 leak
// vector). All removals use `force:true` → double-cleanup is a harmless no-op.

const os = require('node:os');
const path = require('node:path');
const { mkdtemp, rm, readdir } = require('node:fs/promises');

// The live set of temp dirs owned by in-flight jobs. Module-level singleton so
// shutdown.js can drain it without threading state through the worker.
const active = new Set();

// Every dir this module creates is `os.tmpdir()/ocr-job-XXXXXX`, so the prefix
// is also how a fresh process recognizes dirs orphaned by a previous one.
const TEMP_PREFIX = 'ocr-job-';

/**
 * Create a fresh per-job temp dir under os.tmpdir() and register it.
 * @returns {Promise<string>} absolute path to the created dir
 */
async function createJobTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  active.add(dir);
  return dir;
}

/**
 * Boot-time sweep of temp dirs orphaned by a PREVIOUS process (WR-10).
 *
 * The `active` registry is purely in-process, so the one shutdown case no
 * in-process handler can ever catch — SIGKILL from the OOM killer, `docker
 * kill`, a host reboot, or the shutdown grace window expiring — leaves every
 * live `ocr-job-*` dir on disk with its input PDF, permanently. On a long-lived
 * container with a small /tmp those accumulate until the disk fills, at which
 * point `mkdtemp` fails and EVERY input job dies. Sweeping at boot is the only
 * place this can be recovered.
 *
 * Safe because the process is single-instance per container. If that ever
 * changes, gate each candidate on an mtime older than CAPS.MAX_JOB_MS so a
 * concurrent instance's in-flight dirs are not deleted out from under it.
 *
 * Best-effort throughout: a sweep failure must never prevent startup.
 *
 * @returns {Promise<number>} how many orphaned dirs were removed
 */
async function sweepOrphanedTempDirs() {
  const base = os.tmpdir();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return 0; // unreadable tmpdir — nothing we can do, and not a boot blocker
  }

  const orphans = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(TEMP_PREFIX))
    .map((e) => path.join(base, e.name))
    // Never touch a dir this process already owns.
    .filter((dir) => !active.has(dir));

  const results = await Promise.allSettled(
    orphans.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  return results.filter((r) => r.status === 'fulfilled').length;
}

/**
 * Deregister and recursively remove a single job's temp dir. Idempotent:
 * calling it twice (or after the shutdown drain already removed it) does not
 * throw thanks to `force:true`.
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function cleanupJobTempDir(dir) {
  active.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Best-effort removal of every temp dir registered at call time. Called from
 * shutdown.js AFTER the job drain (CR-04). Uses allSettled so one failing rm
 * never blocks the others.
 *
 * Deregisters exactly the dirs it snapshotted rather than `active.clear()`ing:
 * a `clear()` would also drop any dir registered DURING the await, losing track
 * of it forever and leaking it on the subsequent exit.
 *
 * @returns {Promise<number>} how many dirs were drained
 */
async function drainAllTempDirs() {
  const snapshot = [...active];
  await Promise.allSettled(
    snapshot.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  for (const dir of snapshot) active.delete(dir);
  return snapshot.length;
}

// Test-only introspection of the registry (non-load-bearing).
function _activeDirsForTest() {
  return [...active];
}

module.exports = {
  createJobTempDir,
  cleanupJobTempDir,
  drainAllTempDirs,
  sweepOrphanedTempDirs,
  _activeDirsForTest,
};
