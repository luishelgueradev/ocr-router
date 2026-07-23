const { LRUCache } = require('lru-cache');
const { intFromEnv } = require('./env');

const JOB_TTL_MS = 60 * 60 * 1000;
// WR-07 fix — intFromEnv validates the env var at boot. Previously
// `Number('not-a-number') || 500` silently downgraded a typo to the default
// with no log line. intFromEnv throws a clear error on a non-integer, on
// non-positive values, and falls back to the documented default only when
// the var is unset/empty.
const JOB_MAX = intFromEnv('JOB_STORE_MAX', 500);

const store = new LRUCache({ max: JOB_MAX, ttl: JOB_TTL_MS, ttlAutopurge: true });

function nowIso() {
  return new Date().toISOString();
}

function create(jobId, meta) {
  if (store.size >= JOB_MAX) return { full: true };
  const created_at = nowIso();
  const expires_at = new Date(Date.now() + JOB_TTL_MS).toISOString();
  store.set(jobId, {
    job_id: jobId,
    status: 'queued',
    created_at,
    expires_at,
    ...meta,
  });
  return { full: false };
}

function get(id) {
  return store.get(id) || null;
}

function setProcessing(id) {
  const job = store.get(id);
  if (job) {
    job.status = 'processing';
    job.started_at = nowIso();
  }
}

// WR-04 fix — once a job reaches a terminal state (succeeded or failed) it is
// marked `finalized: true` and subsequent complete()/fail() calls become no-ops.
// This closes the shutdown race: `drainAndCancel` marks a processing job as
// `failed{shutdown_timeout}`, but the worker that owns that job is not aborted
// (axios receives no abort signal). If the worker's HTTP call resolves AFTER
// drainAndCancel returns, the old code would overwrite the shutdown status
// back to `succeeded`, making the poller see a "succeeded" job that no one
// promised would deliver and under-counting `timed_out` in shutdown_complete.
function complete(id, result) {
  const job = store.get(id);
  if (job && !job.finalized) {
    job.status = 'succeeded';
    job.completed_at = nowIso();
    job.result = result;
    job.finalized = true;
  }
}

function fail(id, error) {
  const job = store.get(id);
  if (job && !job.finalized) {
    job.status = 'failed';
    job.completed_at = nowIso();
    job.error = error;
    job.finalized = true;
  }
}

function iterateAll() {
  return store.values();   // lru-cache 11 Generator<V>; yields live job objects
}

// WR-08 — test-only escape hatch. Test 5 in test/shutdown.test.js (and any
// future test that inserts records into the real singleton) uses t.after()
// to call this helper, preventing leaked records from polluting subsequent
// tests that iterate the store.
function _clearForTest() {
  store.clear();
}

module.exports = { create, get, setProcessing, complete, fail, iterateAll, _clearForTest };
